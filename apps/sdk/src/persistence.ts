/**
 * 持久化契约。
 *
 * SDK 只定义 PersistentVirtualFileSystem 依赖的最小接口 —— **怎么存（哪张表、什么结构、
 * 用什么库）完全是使用方的业务决策**，由使用方实现本接口后注入:
 *
 *   const fs = await PersistentVirtualFileSystem.create({ scope, persistence: myPersistence });
 *
 * SDK 内置的唯一实现是 InMemoryVirtualFsPersistence(纯内存,单测/离线用,零业务假设)。
 * SQL / Redis / 对象存储等实现请写在你的项目里(DB 表结构进你自己的 migration 流程)。
 */

export interface VirtualFsFileRecord {
  path: string;
  content: string;
  mimeType: string | null;
}

/** PersistentVirtualFileSystem 的持久化契约。scope = 分区键(一次 run / 一个项目…)。 */
export interface VirtualFsPersistence {
  /** 水合:取一个 scope 的全部文件 */
  load(scope: string): Promise<VirtualFsFileRecord[]>;
  upsert(scope: string, path: string, content: string, mimeType?: string): Promise<void>;
  remove(scope: string, path: string): Promise<void>;
  /** rmdir recursive:删除 path 以 prefix 开头的全部文件(prefix 形如 'findings/';空串=全部) */
  removeByPrefix(scope: string, prefix: string): Promise<void>;
  /** 删除整个 scope */
  removeScope(scope: string): Promise<void>;
  /** 列出指定 path 在所有 scope 下的内容(如按 manifest.json 列出全部 run)。可选能力。 */
  listByPath?(path: string): Promise<Array<{ scope: string; content: string }>>;
}

/* ────────────────────────── 内存实现(测试用) ────────────────────────── */

export class InMemoryVirtualFsPersistence implements VirtualFsPersistence {
  /** scope → (path → record) */
  #scopes = new Map<string, Map<string, { content: string; mimeType?: string }>>();

  #bucket(scope: string): Map<string, { content: string; mimeType?: string }> {
    let bucket = this.#scopes.get(scope);
    if (!bucket) {
      bucket = new Map();
      this.#scopes.set(scope, bucket);
    }
    return bucket;
  }

  async load(scope: string): Promise<VirtualFsFileRecord[]> {
    return [...this.#bucket(scope).entries()]
      .map(([path, v]) => ({ path, content: v.content, mimeType: v.mimeType ?? null }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async upsert(scope: string, path: string, content: string, mimeType?: string): Promise<void> {
    this.#bucket(scope).set(path, { content, mimeType });
  }

  async remove(scope: string, path: string): Promise<void> {
    this.#bucket(scope).delete(path);
  }

  async removeByPrefix(scope: string, prefix: string): Promise<void> {
    const bucket = this.#bucket(scope);
    for (const path of [...bucket.keys()]) {
      if (path.startsWith(prefix)) bucket.delete(path);
    }
  }

  async removeScope(scope: string): Promise<void> {
    this.#scopes.delete(scope);
  }

  async listByPath(path: string): Promise<Array<{ scope: string; content: string }>> {
    const out: Array<{ scope: string; content: string }> = [];
    for (const [scope, bucket] of this.#scopes) {
      const rec = bucket.get(path);
      if (rec) out.push({ scope, content: rec.content });
    }
    return out;
  }
}
