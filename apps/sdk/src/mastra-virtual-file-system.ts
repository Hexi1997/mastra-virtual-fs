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
import { MastraFilesystem } from '@mastra/core/workspace';
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
}

let counter = 0;

/** 抛出带 Node 风格 code 的错误(消费方通常按 err.code 判断,而非 instanceof) */
function fsError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

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
  #debug: boolean;
  #looseLookup: boolean;

  constructor(options: MastraVirtualFileSystemOptions = {}) {
    super({ name: 'MastraVirtualFileSystem' });
    this.id = options.id ?? `in-memory-fs-${++counter}`;
    this.readOnly = options.readOnly;
    this.#debug = options.debug ?? false;
    this.#looseLookup = options.looseReferenceLookup ?? true;
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

  #assertWritable() {
    if (this.readOnly) throw fsError('EACCES', 'Filesystem is read-only');
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

  /** 确保某路径的所有祖先目录都存在于 #dirs 中 */
  #ensureAncestors(path: string) {
    let dir = parentOf(path);
    while (true) {
      this.#dirs.add(dir);
      if (dir === '/') break;
      dir = parentOf(dir);
    }
  }

  /** 直接写入(不做只读/父目录检查),供 seed 与内部复用 */
  #put(np: string, buf: Buffer, mimeType?: string) {
    const now = new Date();
    const prev = this.#files.get(np);
    this.#ensureAncestors(np);
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
      throw fsError('EISDIR', `EISDIR: illegal operation on a directory, read '${np}'`);
    }
    let rec = this.#files.get(np);
    if (!rec) {
      const alt = this.#looseResolveFile(np);
      if (alt) {
        this.#log('readFile→loose', np, '=>', alt);
        rec = this.#files.get(alt);
      }
    }
    if (!rec) throw fsError('ENOENT', `ENOENT: no such file or directory, open '${np}'`);
    // 契约:指定 encoding 返回 string,否则返回 Buffer(与 LocalFilesystem 一致)
    return options?.encoding ? rec.content.toString(options.encoding) : Buffer.from(rec.content);
  }

  async writeFile(inputPath: string, content: FileContent, options?: WriteOptions): Promise<void> {
    this.#assertWritable();
    const np = normalize(inputPath);
    this.#log('writeFile', np);
    if (this.#dirs.has(np)) {
      throw fsError('EISDIR', `EISDIR: illegal operation on a directory, write '${np}'`);
    }
    if (options?.overwrite === false && this.#files.has(np)) {
      throw fsError('EEXIST', `EEXIST: file already exists, write '${np}'`);
    }
    const parent = parentOf(np);
    if (!options?.recursive && !this.#dirs.has(parent)) {
      throw fsError('ENOENT', `ENOENT: no such directory, write '${np}'`);
    }
    this.#put(np, toBuffer(content), options?.mimeType);
  }

  async appendFile(inputPath: string, content: FileContent): Promise<void> {
    this.#assertWritable();
    const np = normalize(inputPath);
    this.#log('appendFile', np);
    const existing = this.#files.get(np);
    const next = existing ? Buffer.concat([existing.content, toBuffer(content)]) : toBuffer(content);
    this.#put(np, next, existing?.mimeType);
  }

  async deleteFile(inputPath: string, options?: RemoveOptions): Promise<void> {
    this.#assertWritable();
    const np = normalize(inputPath);
    this.#log('deleteFile', np);
    if (this.#dirs.has(np) && !this.#files.has(np)) {
      throw fsError('EISDIR', `EISDIR: illegal operation on a directory, unlink '${np}'`);
    }
    if (!this.#files.has(np)) {
      if (options?.force) return;
      throw fsError('ENOENT', `ENOENT: no such file or directory, unlink '${np}'`);
    }
    this.#files.delete(np);
  }

  async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    this.#assertWritable();
    const s = normalize(src);
    const d = normalize(dest);
    this.#log('copyFile', s, '->', d);
    const rec = this.#files.get(s);
    if (!rec) throw fsError('ENOENT', `ENOENT: no such file or directory, copy '${s}'`);
    if (options?.overwrite === false && this.#files.has(d)) {
      throw fsError('EEXIST', `EEXIST: file already exists, copy '${d}'`);
    }
    this.#put(d, Buffer.from(rec.content), rec.mimeType);
  }

  async moveFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    await this.copyFile(src, dest, options);
    await this.deleteFile(src);
  }

  async mkdir(inputPath: string, options?: { recursive?: boolean }): Promise<void> {
    this.#assertWritable();
    const np = normalize(inputPath);
    this.#log('mkdir', np);
    if (this.#files.has(np)) {
      throw fsError('EEXIST', `EEXIST: file already exists, mkdir '${np}'`);
    }
    if (!options?.recursive && !this.#dirs.has(parentOf(np))) {
      throw fsError('ENOENT', `ENOENT: no such directory, mkdir '${np}'`);
    }
    this.#ensureAncestors(np);
    this.#dirs.add(np);
  }

  async rmdir(inputPath: string, options?: RemoveOptions): Promise<void> {
    this.#assertWritable();
    const np = normalize(inputPath);
    this.#log('rmdir', np);
    if (!this.#dirs.has(np)) {
      if (options?.force) return;
      throw fsError('ENOENT', `ENOENT: no such directory, rmdir '${np}'`);
    }
    const prefix = np === '/' ? '/' : np + '/';
    const children = [
      ...[...this.#files.keys()].filter(p => p.startsWith(prefix)),
      ...[...this.#dirs].filter(p => p !== np && p.startsWith(prefix)),
    ];
    if (children.length > 0 && !options?.recursive) {
      throw fsError('ENOTEMPTY', `ENOTEMPTY: directory not empty, rmdir '${np}'`);
    }
    for (const f of this.#files.keys()) if (f.startsWith(prefix)) this.#files.delete(f);
    for (const d of [...this.#dirs]) if (d !== '/' && (d === np || d.startsWith(prefix))) this.#dirs.delete(d);
  }

  async readdir(inputPath: string, options?: ListOptions): Promise<FileEntry[]> {
    const np = normalize(inputPath);
    this.#log('readdir', np, options ?? '');
    if (this.#files.has(np)) {
      throw fsError('ENOTDIR', `ENOTDIR: not a directory, scandir '${np}'`);
    }
    if (!this.#dirs.has(np)) {
      throw fsError('ENOENT', `ENOENT: no such file or directory, scandir '${np}'`);
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
      return {
        name: basename(np) || '/',
        path: np,
        type: 'directory',
        size: 0,
        createdAt: new Date(0),
        modifiedAt: new Date(0),
      };
    }
    const alt = this.#looseResolveFile(np);
    if (alt) {
      this.#log('stat→loose', np, '=>', alt);
      return this.stat(alt);
    }
    throw fsError('ENOENT', `ENOENT: no such file or directory, stat '${np}'`);
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
    this.status = 'destroyed';
  }
}
