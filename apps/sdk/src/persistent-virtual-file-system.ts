/**
 * PersistentVirtualFileSystem —— 带写穿持久化的虚拟文件系统。
 *
 * 在 MastraVirtualFileSystem（纯内存）之上加一层「写穿」:每个写操作先落内存,
 * 再把结果同步到注入的持久化后端(通常是一张 DB 表)。进程重启后用 `hydrate()`
 * 从持久化读回、seed 进内存即可续用。
 *
 * 读取永远只走内存 —— 持久化是副本,不是读路径;因此没有「写完读不到」的窗口
 * (对比磁盘挂载点上 rename 覆盖对并发读者不原子的经典问题,DB 行级写没有这一窗口)。
 *
 * 一致性模型:
 *   - 持久化任务进 per-instance 串行队列,按入队顺序执行;
 *   - 任务执行时才从内存**现读**该文件的最新内容再 upsert ——
 *     并发对同一文件追加(如多个批次同时 append 一份 trace 日志)时,
 *     无论持久化顺序如何,最终都收敛到内存里的最新值;
 *   - 每个写方法都会 await 本次持久化完成后才返回(写穿,不是异步落盘),
 *     调用方返回即已入库;
 *   - `seedFile` / `seedSkill` / `hydrate` 不触发写穿(它们是水合入口)。
 *
 * 多实例注意:两个进程同时写同一个 scope 时各自内存独立,持久化按后写者收敛;
 * 需要跨进程强一致的场景请在上层做互斥(如任务队列保证一个 scope 只被一个进程处理)。
 */
import { MastraVirtualFileSystem } from './mastra-virtual-file-system.js';
import type { MastraVirtualFileSystemOptions } from './mastra-virtual-file-system.js';
import type { FileContent, WriteOptions, RemoveOptions, CopyOptions } from '@mastra/core/workspace';
import type { VirtualFsPersistence } from './persistence.js';

/** 与基类一致的路径规整:绝对 POSIX、无 . / .. / 尾斜杠 */
function normalizePath(p: string): string {
  if (!p) return '/';
  let path = p.replace(/\\/g, '/');
  if (!path.startsWith('/')) path = '/' + path;
  const stack: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  return '/' + stack.join('/');
}

/** VFS 绝对路径 → 持久化里存的相对路径('/plan.md' → 'plan.md') */
function toStoredPath(np: string): string {
  return np.replace(/^\//, '');
}

export interface PersistentVirtualFileSystemOptions extends MastraVirtualFileSystemOptions {
  /**
   * 持久化作用域(一张表存多个 FS 实例时的分区键)。
   * 例:一次 agent run 一个 scope(runId)、一个项目一个 scope(projectId)。
   */
  scope: string;
  /** 持久化后端。SQL 表用 SqlVirtualFsPersistence,测试用 InMemoryVirtualFsPersistence。 */
  persistence: VirtualFsPersistence;
}

export class PersistentVirtualFileSystem extends MastraVirtualFileSystem {
  readonly scope: string;
  #persistence: VirtualFsPersistence;
  /** 持久化串行队列:保证同一实例的持久化按入队顺序执行(内容在执行时现读) */
  #queue: Promise<void> = Promise.resolve();
  #hydrated = false;

  constructor(options: PersistentVirtualFileSystemOptions) {
    const { scope, persistence, ...base } = options;
    super(base);
    this.scope = scope;
    this.#persistence = persistence;
  }

  /**
   * 从持久化读回全部文件并 seed 进内存(不触发写穿)。幂等:重复调用只水合一次。
   * 推荐用静态工厂 `PersistentVirtualFileSystem.create()` 一步建好。
   */
  async hydrate(): Promise<this> {
    if (this.#hydrated) return this;
    const records = await this.#persistence.load(this.scope);
    for (const rec of records) {
      this.seedFile('/' + rec.path, rec.content, rec.mimeType ?? undefined);
    }
    this.#hydrated = true;
    return this;
  }

  /** 建实例 + 水合,一步到位。 */
  static async create(options: PersistentVirtualFileSystemOptions): Promise<PersistentVirtualFileSystem> {
    return new PersistentVirtualFileSystem(options).hydrate();
  }

  #enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.#queue.catch(() => {}).then(job);
    // 队列自身吞错以免断链;await 侧仍能拿到本次 job 的失败
    this.#queue = next.catch(() => {});
    return next;
  }

  /** 执行时现读内存内容再 upsert;此刻文件已被删则跳过(后续 delete 任务会清行) */
  #persistPut(np: string): Promise<void> {
    return this.#enqueue(async () => {
      let content: string;
      let mimeType: string | undefined;
      try {
        content = (await super.readFile(np, { encoding: 'utf-8' })) as string;
        mimeType = (await super.stat(np)).mimeType;
      } catch {
        return;
      }
      await this.#persistence.upsert(this.scope, toStoredPath(np), content, mimeType);
    });
  }

  override async writeFile(inputPath: string, content: FileContent, options?: WriteOptions): Promise<void> {
    await super.writeFile(inputPath, content, options);
    await this.#persistPut(normalizePath(inputPath));
  }

  override async appendFile(inputPath: string, content: FileContent): Promise<void> {
    await super.appendFile(inputPath, content);
    await this.#persistPut(normalizePath(inputPath));
  }

  override async deleteFile(inputPath: string, options?: RemoveOptions): Promise<void> {
    await super.deleteFile(inputPath, options);
    const np = normalizePath(inputPath);
    await this.#enqueue(() => this.#persistence.remove(this.scope, toStoredPath(np)));
  }

  override async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    await super.copyFile(src, dest, options);
    await this.#persistPut(normalizePath(dest));
  }

  // moveFile 不覆写:基类实现是 this.copyFile + this.deleteFile,都会走到上面的写穿。

  override async rmdir(inputPath: string, options?: RemoveOptions): Promise<void> {
    await super.rmdir(inputPath, options);
    const np = normalizePath(inputPath);
    const prefix = np === '/' ? '' : toStoredPath(np) + '/';
    await this.#enqueue(() => this.#persistence.removeByPrefix(this.scope, prefix));
  }

  /** 等待已入队的持久化全部完成(收尾/测试用;正常路径每次写已 await,无需调用)。 */
  flush(): Promise<void> {
    return this.#queue;
  }

  /** 删除本 scope 的全部持久化数据(内存同时清空)。用于「删除一次 run/一个项目」。 */
  async destroyPersisted(): Promise<void> {
    await this.flush();
    await this.#persistence.removeScope(this.scope);
    await this.destroy();
  }
}
