/**
 * MastraVirtualFileSystem —— Mastra Workspace 的虚拟(内存)文件系统。
 *
 * Mastra 自带的 `LocalFilesystem` 只能读本机磁盘上的目录。很多场景下我们希望
 * 把内容(例如 skill 的 SKILL.md、references/ 下的文件)直接以字符串/Buffer 的
 * 形式喂给 agent,而不是先落盘。本类实现了 `WorkspaceFilesystem` 接口
 * (通过继承 `MastraFilesystem` 拿到日志 / 生命周期管理),数据全部存在内存的
 * Map 里,因此可以随手 seed 内容。
 *
 * 关键点:Mastra 的 skills 系统是"通过 workspace 的 filesystem"来读取的
 * (官方类型注释原文:All operations are async because they use the workspace
 * filesystem),所以只要把 SKILL.md / references 写进这个虚拟 FS,
 * `workspace.skills.list() / get() / getReference()` 就能正常工作。
 */
import {
  DirectoryNotEmptyError,
  DirectoryNotFoundError,
  FileExistsError,
  FileNotFoundError,
  IsDirectoryError,
  MastraFilesystem,
  NotDirectoryError,
  PermissionError,
  StaleFileError,
} from '@mastra/core/workspace';
import type {
  FileContent,
  FileEntry,
  FileStat,
  ReadOptions,
  WriteOptions,
  ListOptions,
  RemoveOptions,
  CopyOptions,
  FilesystemInfo,
  ProviderStatus,
} from '@mastra/core/workspace';

/** 内存中单个文件的记录 */
interface FileRecord {
  content: Buffer;
  createdAt: Date;
  modifiedAt: Date;
  mimeType?: string;
}

export interface MastraVirtualFileSystemOptions {
  /** 实例 id,默认自动生成 */
  id?: string;
  /** 只读模式:为 true 时所有写操作被拒绝(agent 不会拿到写类工具) */
  readOnly?: boolean;
  /** 打开后会把每一次 fs 调用打到 console.error,便于调试路径解析 */
  debug?: boolean;
  /** 可选:用一组 { 路径: 内容 } 预置初始文件 */
  seed?: Record<string, FileContent>;
  /**
   * 读路径未命中、且看似"挂错根"时,按唯一后缀匹配兜底到真实文件。默认 `true`。
   *
   * 场景:agent 用通用文件工具(file_stat / read_file)读 skill 的 reference 时,
   * 常常只给相对路径 `references/x.md`,被上游规整成根下的 `/references/x.md`,
   * 而真实文件其实在 `/skills/<skill>/references/x.md`。开启后,这类读会兜底命中。
   *
   * 安全约束(避免偏离 LocalFilesystem 的语义):
   *   - 只作用于读(readFile / stat / exists),不动写操作;
   *   - 仅当被读路径的父目录"并不真实存在"时才兜底(父目录存在=只是文件缺失,照常 ENOENT);
   *   - 后缀匹配必须唯一,歧义则不兜底。
   * 想要和真实磁盘 FS 完全一致的严格行为,置为 `false`。
   */
  looseReferenceLookup?: boolean;
  /**
   * 目录的 `modifiedAt` 是否跟随其下文件【内容】的最新修改时间。默认 `true`。
   *
   * 场景:Mastra 的 skills 系统会缓存 SKILL.md(name/description/instructions)。
   * `agent.generate()` 在 step0 调 `skills.maybeRefresh()`,它靠比较「skill 目录的
   * mtime」和「上次发现时间」来决定要不要重新发现 skill。开启本项后,重写(reseed)
   * SKILL.md 会把它所在目录及各级父目录的 `modifiedAt` 顶到当下,于是下一次
   * `generate` 能【默认】读到最新的 SKILL.md —— 无需手动 refresh() 或 checkSkillFileMtime。
   *
   * 注意这是相对真实磁盘的【有意偏离】:POSIX/LocalFilesystem 里,改写已存在文件的
   * 内容不会改变其父目录 mtime(只有新增/删除/改名条目才会)。若需与磁盘 FS 严格一致,
   * 置为 `false`:届时目录 mtime 只在【结构变化】(新增/删除文件、mkdir/rmdir)时更新,
   * 改写已存在文件的内容不再顶起目录 mtime(此时想热更新 SKILL.md 仍可用
   * `workspace.skills.refresh()` 或建 Workspace 时传 `checkSkillFileMtime: true`)。
   */
  directoryMtimeFollowsContents?: boolean;
}

let counter = 0;

/** 把任意路径规整成绝对、无 . / .. 、无尾斜杠的 POSIX 路径 */
function normalize(p: string): string {
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

/** 取父目录(已规整路径)。parent('/a/b') => '/a';parent('/a') => '/';parent('/') => '/' */
function parentOf(p: string): string {
  if (p === '/') return '/';
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

function basename(p: string): string {
  if (p === '/') return '';
  return p.slice(p.lastIndexOf('/') + 1);
}

function toBuffer(content: FileContent): Buffer {
  if (typeof content === 'string') return Buffer.from(content, 'utf-8');
  if (Buffer.isBuffer(content)) return content;
  return Buffer.from(content);
}

export class MastraVirtualFileSystem extends MastraFilesystem {
  readonly id: string;
  readonly name = 'MastraVirtualFileSystem';
  readonly provider = 'in-memory';
  readonly readOnly?: boolean;
  status: ProviderStatus = 'ready';

  /** 内存里没有磁盘根目录,basePath 留空(接口允许 in-memory FS 不提供 basePath) */
  readonly basePath = undefined;

  #files = new Map<string, FileRecord>();
  #dirs = new Set<string>(['/']);
  /** 目录时间戳(与 #dirs 并行维护);缺失则按纪元 0 处理 */
  #dirTimes = new Map<string, { createdAt: Date; modifiedAt: Date }>();
  #debug: boolean;
  #looseLookup: boolean;
  #dirMtimeFollowsContents: boolean;

  constructor(options: MastraVirtualFileSystemOptions = {}) {
    super({ name: 'MastraVirtualFileSystem' });
    this.id = options.id ?? `in-memory-fs-${++counter}`;
    this.readOnly = options.readOnly;
    this.#debug = options.debug ?? false;
    this.#looseLookup = options.looseReferenceLookup ?? true;
    this.#dirMtimeFollowsContents = options.directoryMtimeFollowsContents ?? true;
    if (options.seed) {
      for (const [path, content] of Object.entries(options.seed)) {
        this.#put(normalize(path), toBuffer(content));
      }
    }
  }

  // ── 内部辅助 ────────────────────────────────────────────────────────────

  #log(op: string, ...args: unknown[]) {
    if (this.#debug) console.error(`[MastraVirtualFileSystem] ${op}`, ...args);
  }

  #assertWritable(operation: string, path: string) {
    // 抛 @mastra/core 的类型化错误:core 的工具包装层用 instanceof 判断(err.code 也同时可用)
    if (this.readOnly) throw new PermissionError(path, `${operation} (filesystem is read-only)`);
  }

  /**
   * 兜底解析(见 looseReferenceLookup 选项):np 未命中时,若其父目录并不真实存在,
   * 在所有文件里找唯一一个以 np 结尾(np 以 '/' 开头,天然按目录边界匹配)的真实路径。
   * 歧义或父目录真实存在 → 返回 undefined(保持 ENOENT 语义)。
   */
  #looseResolveFile(np: string): string | undefined {
    if (!this.#looseLookup || np === '/') return undefined;
    if (this.#dirs.has(parentOf(np))) return undefined;
    let found: string | undefined;
    for (const p of this.#files.keys()) {
      if (p.endsWith(np)) {
        if (found) return undefined; // 多个匹配 → 歧义,不兜底
        found = p;
      }
    }
    return found;
  }

  /**
   * 确保 path 的所有祖先目录都存在于 #dirs 中,并维护它们的时间戳。
   * @param time 本次操作时间
   * @param bump 是否把各级祖先的 modifiedAt 顶到 time(新建目录恒为结构变化 → 总是设;
   *             已存在目录仅在 bump 为真时更新)。
   */
  #ensureAncestors(path: string, time: Date, bump: boolean) {
    let dir = parentOf(path);
    while (true) {
      this.#dirs.add(dir);
      const rec = this.#dirTimes.get(dir);
      if (!rec) this.#dirTimes.set(dir, { createdAt: time, modifiedAt: time });
      else if (bump) rec.modifiedAt = time;
      if (dir === '/') break;
      dir = parentOf(dir);
    }
  }

  /** 直接写入(不做只读/父目录检查),供 seed 与内部复用 */
  #put(np: string, buf: Buffer, mimeType?: string) {
    const now = new Date();
    const prev = this.#files.get(np);
    // 新增文件恒为结构变化;改写已存在文件的内容,按 directoryMtimeFollowsContents 决定是否顶起目录 mtime。
    const bump = !prev || this.#dirMtimeFollowsContents;
    this.#ensureAncestors(np, now, bump);
    this.#files.set(np, {
      content: buf,
      createdAt: prev?.createdAt ?? now,
      modifiedAt: now,
      mimeType,
    });
  }

  // ── 便捷 seed API(对外暴露,方便"传内容过去") ─────────────────────────

  /** 写入单个虚拟文件(自动创建父目录)。返回 this 便于链式调用 */
  seedFile(path: string, content: FileContent, mimeType?: string): this {
    this.#put(normalize(path), toBuffer(content), mimeType);
    return this;
  }

  /**
   * 便捷地 seed 一个 skill。
   * @param skillDir   skill 目录,例如 '/skills/research-agent'
   * @param skillMd    SKILL.md 的完整内容(含 YAML frontmatter)
   * @param references references/ 目录下的文件:{ '调研方法.md': '...', 'sub/x.md': '...' }
   */
  seedSkill(
    skillDir: string,
    skillMd: string,
    references: Record<string, string> = {},
  ): this {
    const dir = normalize(skillDir);
    this.seedFile(`${dir}/SKILL.md`, skillMd);
    for (const [rel, content] of Object.entries(references)) {
      this.seedFile(`${dir}/references/${rel}`, content);
    }
    return this;
  }

  /** 调试用:导出当前所有文件路径 */
  listAllPaths(): string[] {
    return [...this.#files.keys()].sort();
  }

  // ── WorkspaceFilesystem 接口实现 ─────────────────────────────────────────

  async readFile(inputPath: string, options?: ReadOptions): Promise<string | Buffer> {
    const np = normalize(inputPath);
    this.#log('readFile', np, options?.encoding ?? '(buffer)');
    if (this.#dirs.has(np) && !this.#files.has(np)) {
      throw new IsDirectoryError(np);
    }
    let rec = this.#files.get(np);
    if (!rec) {
      const alt = this.#looseResolveFile(np);
      if (alt) {
        this.#log('readFile→loose', np, '=>', alt);
        rec = this.#files.get(alt);
      }
    }
    if (!rec) throw new FileNotFoundError(np);
    // 契约:指定 encoding 返回 string,否则返回 Buffer(与 LocalFilesystem 一致)
    return options?.encoding ? rec.content.toString(options.encoding) : Buffer.from(rec.content);
  }

  async writeFile(inputPath: string, content: FileContent, options?: WriteOptions): Promise<void> {
    this.#assertWritable('writeFile', inputPath);
    const np = normalize(inputPath);
    this.#log('writeFile', np);
    if (this.#dirs.has(np)) {
      throw new IsDirectoryError(np);
    }
    if (options?.overwrite === false && this.#files.has(np)) {
      throw new FileExistsError(np);
    }
    // 对齐 LocalFilesystem:默认(recursive !== false)自动创建父目录 —— workspace 的
    // write_file 工具不传 recursive 且描述承诺 "Creates parent directories if needed",
    // 要求显式 recursive 会让 agent 写新文件时莫名 ENOENT(实测模型会陷入乱试)。
    const parent = parentOf(np);
    if (options?.recursive === false) {
      if (this.#files.has(parent)) throw new NotDirectoryError(parent);
      if (!this.#dirs.has(parent)) throw new DirectoryNotFoundError(parent);
    }
    // 对齐 LocalFilesystem 的写冲突检测:expectedMtime 与当前 mtime 不一致 → StaleFileError
    // (edit 类工具靠它发现「读后被别人改过」;文件不存在则视为新写,不校验)
    const expectedMtime = (options as { expectedMtime?: Date } | undefined)?.expectedMtime;
    if (expectedMtime) {
      const rec = this.#files.get(np);
      if (rec && rec.modifiedAt.getTime() !== expectedMtime.getTime()) {
        throw new StaleFileError(np, expectedMtime, rec.modifiedAt);
      }
    }
    this.#put(np, toBuffer(content), options?.mimeType);
  }

  async appendFile(inputPath: string, content: FileContent): Promise<void> {
    this.#assertWritable('appendFile', inputPath);
    const np = normalize(inputPath);
    this.#log('appendFile', np);
    const existing = this.#files.get(np);
    const next = existing ? Buffer.concat([existing.content, toBuffer(content)]) : toBuffer(content);
    this.#put(np, next, existing?.mimeType);
  }

  async deleteFile(inputPath: string, options?: RemoveOptions): Promise<void> {
    this.#assertWritable('deleteFile', inputPath);
    const np = normalize(inputPath);
    this.#log('deleteFile', np);
    if (this.#dirs.has(np) && !this.#files.has(np)) {
      throw new IsDirectoryError(np);
    }
    if (!this.#files.has(np)) {
      if (options?.force) return;
      throw new FileNotFoundError(np);
    }
    this.#files.delete(np);
    // 删除条目是结构变化:顶起各级父目录 mtime(与 POSIX 一致)
    this.#ensureAncestors(np, new Date(), true);
  }

  async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    this.#assertWritable('copyFile', dest);
    const s = normalize(src);
    const d = normalize(dest);
    this.#log('copyFile', s, '->', d);
    const rec = this.#files.get(s);
    if (!rec) throw new FileNotFoundError(s);
    if (options?.overwrite === false && this.#files.has(d)) {
      throw new FileExistsError(d);
    }
    this.#put(d, Buffer.from(rec.content), rec.mimeType);
  }

  async moveFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    await this.copyFile(src, dest, options);
    await this.deleteFile(src);
  }

  async mkdir(inputPath: string, options?: { recursive?: boolean }): Promise<void> {
    this.#assertWritable('mkdir', inputPath);
    const np = normalize(inputPath);
    this.#log('mkdir', np);
    if (this.#files.has(np)) {
      throw new FileExistsError(np);
    }
    if (!options?.recursive && !this.#dirs.has(parentOf(np))) {
      throw new DirectoryNotFoundError(parentOf(np));
    }
    const now = new Date();
    this.#ensureAncestors(np, now, true); // 新建目录是结构变化 → 顶起各级父目录
    this.#dirs.add(np);
    this.#dirTimes.set(np, { createdAt: now, modifiedAt: now });
  }

  async rmdir(inputPath: string, options?: RemoveOptions): Promise<void> {
    this.#assertWritable('rmdir', inputPath);
    const np = normalize(inputPath);
    this.#log('rmdir', np);
    if (!this.#dirs.has(np)) {
      if (options?.force) return;
      throw new DirectoryNotFoundError(np);
    }
    const prefix = np === '/' ? '/' : np + '/';
    const children = [
      ...[...this.#files.keys()].filter(p => p.startsWith(prefix)),
      ...[...this.#dirs].filter(p => p !== np && p.startsWith(prefix)),
    ];
    if (children.length > 0 && !options?.recursive) {
      throw new DirectoryNotEmptyError(np);
    }
    for (const f of this.#files.keys()) if (f.startsWith(prefix)) this.#files.delete(f);
    for (const d of [...this.#dirs]) {
      if (d !== '/' && (d === np || d.startsWith(prefix))) {
        this.#dirs.delete(d);
        this.#dirTimes.delete(d);
      }
    }
    // 删除目录是结构变化:顶起各级父目录 mtime
    if (np !== '/') this.#ensureAncestors(np, new Date(), true);
  }

  async readdir(inputPath: string, options?: ListOptions): Promise<FileEntry[]> {
    const np = normalize(inputPath);
    this.#log('readdir', np, options ?? '');
    if (this.#files.has(np)) {
      throw new NotDirectoryError(np);
    }
    if (!this.#dirs.has(np)) {
      throw new DirectoryNotFoundError(np);
    }

    const extFilter = options?.extension
      ? (Array.isArray(options.extension) ? options.extension : [options.extension])
      : undefined;
    const matchesExt = (name: string) =>
      !extFilter || extFilter.some(e => name.endsWith(e.startsWith('.') ? e : '.' + e));

    const prefix = np === '/' ? '/' : np + '/';
    const entries = new Map<string, FileEntry>();

    // 与 LocalFilesystem 对齐:
    // - 非递归时 name = basename
    // - 递归时 name = 相对于被读目录的路径(嵌套文件如 'sub/nested.md')
    const consider = (fullPath: string, type: 'file' | 'directory', size: number, name: string) => {
      if (type === 'file' && !matchesExt(basename(fullPath))) return;
      entries.set(fullPath, { name, type, size });
    };

    if (options?.recursive) {
      const maxDepth = options.maxDepth ?? Infinity;
      const rel = (p: string) => p.slice(prefix.length);
      const depthOf = (p: string) => rel(p).split('/').length;
      for (const [p, rec] of this.#files) {
        if (p.startsWith(prefix) && depthOf(p) <= maxDepth) consider(p, 'file', rec.content.length, rel(p));
      }
      for (const d of this.#dirs) {
        if (d !== np && d.startsWith(prefix) && depthOf(d) <= maxDepth) consider(d, 'directory', 0, rel(d));
      }
    } else {
      // 仅直接子项
      for (const [p, rec] of this.#files) {
        if (parentOf(p) === np) consider(p, 'file', rec.content.length, basename(p));
      }
      for (const d of this.#dirs) {
        if (d !== np && parentOf(d) === np) consider(d, 'directory', 0, basename(d));
      }
    }

    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async exists(inputPath: string): Promise<boolean> {
    const np = normalize(inputPath);
    const ok =
      this.#files.has(np) || this.#dirs.has(np) || this.#looseResolveFile(np) !== undefined;
    this.#log('exists', np, '=>', ok);
    return ok;
  }

  async stat(inputPath: string): Promise<FileStat> {
    const np = normalize(inputPath);
    this.#log('stat', np);
    const rec = this.#files.get(np);
    if (rec) {
      return {
        name: basename(np) || '/',
        path: np,
        type: 'file',
        size: rec.content.length,
        createdAt: rec.createdAt,
        modifiedAt: rec.modifiedAt,
        mimeType: rec.mimeType,
      };
    }
    if (this.#dirs.has(np)) {
      const t = this.#dirTimes.get(np);
      return {
        name: basename(np) || '/',
        path: np,
        type: 'directory',
        size: 0,
        // 目录 mtime 跟随其下内容的最新修改时间(见 directoryMtimeFollowsContents),
        // 让 Mastra skills 的「目录陈旧检查」能感知 SKILL.md 的热更新。
        createdAt: t?.createdAt ?? new Date(0),
        modifiedAt: t?.modifiedAt ?? new Date(0),
      };
    }
    const alt = this.#looseResolveFile(np);
    if (alt) {
      this.#log('stat→loose', np, '=>', alt);
      return this.stat(alt);
    }
    throw new FileNotFoundError(np);
  }

  // ── 可选方法 ─────────────────────────────────────────────────────────────

  /** in-memory 没有真实磁盘路径 */
  resolveAbsolutePath(): string | undefined {
    return undefined;
  }

  async realpath(inputPath: string): Promise<string> {
    return normalize(inputPath);
  }

  getInstructions(): string {
    return [
      'This is an in-memory virtual filesystem.',
      'All paths are absolute POSIX paths rooted at "/".',
      'Files live only in memory; there is no underlying disk.',
    ].join(' ');
  }

  isReady(): boolean {
    return this.status === 'ready';
  }

  getInfo(): FilesystemInfo {
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      status: this.status,
      readOnly: this.readOnly,
    };
  }

  async init(): Promise<void> {
    this.status = 'ready';
  }

  async destroy(): Promise<void> {
    this.#files.clear();
    this.#dirs = new Set<string>(['/']);
    this.#dirTimes.clear();
    this.status = 'destroyed';
  }
}
