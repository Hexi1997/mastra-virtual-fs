/**
 * PersistentVirtualFileSystem 离线测试(零依赖,纯 node:assert)。
 *
 * 覆盖:
 *   1. 写穿:write/append/delete/copy/move/rmdir 之后持久化与内存一致
 *   2. 水合:新实例 hydrate 后读到旧实例写入的内容
 *   3. 并发追加同一文件收敛到最新值
 *   4. destroyPersisted 清空 scope
 *   5. seedFile 不触发写穿(水合入口契约)
 */
import assert from 'node:assert/strict';
import {
  PersistentVirtualFileSystem,
  InMemoryVirtualFsPersistence,
} from '../src/index.js';

let passed = 0;
const cases: Array<[string, () => Promise<void> | void]> = [];
function test(name: string, fn: () => Promise<void> | void) {
  cases.push([name, fn]);
}

test('写穿:各写操作后持久化与内存一致', async () => {
  const persistence = new InMemoryVirtualFsPersistence();
  const fs = await PersistentVirtualFileSystem.create({ scope: 'run-1', persistence });

  await fs.writeFile('/plan.md', '- [ ] batch-01', { recursive: true });
  await fs.appendFile('/trace.jsonl', '{"a":1}\n');
  await fs.appendFile('/trace.jsonl', '{"b":2}\n');
  await fs.writeFile('/findings/data/batch-01.jsonl', '{"r":1}\n', { recursive: true });
  await fs.copyFile('/plan.md', '/plan.bak');
  await fs.moveFile('/plan.bak', '/archive/plan.bak', { recursive: true } as never).catch(async () => {
    // moveFile 需要目标父目录存在时,先建目录再移
    await fs.mkdir('/archive', { recursive: true });
    await fs.moveFile('/plan.bak', '/archive/plan.bak');
  });

  const rows = await persistence.load('run-1');
  const byPath = new Map(rows.map(r => [r.path, r.content]));
  assert.equal(byPath.get('plan.md'), '- [ ] batch-01');
  assert.equal(byPath.get('trace.jsonl'), '{"a":1}\n{"b":2}\n');
  assert.equal(byPath.get('findings/data/batch-01.jsonl'), '{"r":1}\n');
  assert.equal(byPath.get('archive/plan.bak'), '- [ ] batch-01');
  assert.ok(!byPath.has('plan.bak'), 'move 后源文件的持久化行应被删除');

  await fs.deleteFile('/plan.md');
  const after = await persistence.load('run-1');
  assert.ok(!after.some(r => r.path === 'plan.md'), 'delete 后持久化行应被删除');

  await fs.rmdir('/findings', { recursive: true });
  const afterRmdir = await persistence.load('run-1');
  assert.ok(!afterRmdir.some(r => r.path.startsWith('findings/')), 'rmdir 后前缀行应被删除');
});

test('水合:新实例读到旧实例的全部内容', async () => {
  const persistence = new InMemoryVirtualFsPersistence();
  const a = await PersistentVirtualFileSystem.create({ scope: 'run-2', persistence });
  await a.writeFile('/source.md', '正文内容', { recursive: true });
  await a.writeFile('/findings/batch-01.md', '### R1', { recursive: true });

  const b = await PersistentVirtualFileSystem.create({ scope: 'run-2', persistence });
  assert.equal(await b.readFile('/source.md', { encoding: 'utf-8' }), '正文内容');
  assert.equal(await b.readFile('/findings/batch-01.md', { encoding: 'utf-8' }), '### R1');
  const entries = await b.readdir('/', { recursive: true });
  assert.deepEqual(
    entries.filter(e => e.type === 'file').map(e => e.name).sort(),
    ['findings/batch-01.md', 'source.md'],
  );
});

test('scope 隔离:不同 scope 的数据互不可见', async () => {
  const persistence = new InMemoryVirtualFsPersistence();
  const a = await PersistentVirtualFileSystem.create({ scope: 'run-a', persistence });
  const b = await PersistentVirtualFileSystem.create({ scope: 'run-b', persistence });
  await a.writeFile('/x.md', 'A', { recursive: true });
  await b.writeFile('/x.md', 'B', { recursive: true });
  assert.equal((await persistence.load('run-a'))[0]!.content, 'A');
  assert.equal((await persistence.load('run-b'))[0]!.content, 'B');
});

test('并发追加同一文件:持久化收敛到内存最新值', async () => {
  const persistence = new InMemoryVirtualFsPersistence();
  const fs = await PersistentVirtualFileSystem.create({ scope: 'run-3', persistence });
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => fs.appendFile('/trace.jsonl', `{"i":${i}}\n`)),
  );
  await fs.flush();
  const mem = (await fs.readFile('/trace.jsonl', { encoding: 'utf-8' })) as string;
  const persisted = (await persistence.load('run-3')).find(r => r.path === 'trace.jsonl')!.content;
  assert.equal(persisted, mem, '持久化必须与内存一致');
  assert.equal(mem.split('\n').filter(Boolean).length, 20, '20 次追加一条不丢');
});

test('destroyPersisted 清空 scope', async () => {
  const persistence = new InMemoryVirtualFsPersistence();
  const fs = await PersistentVirtualFileSystem.create({ scope: 'run-4', persistence });
  await fs.writeFile('/a.md', 'x', { recursive: true });
  await fs.destroyPersisted();
  assert.deepEqual(await persistence.load('run-4'), []);
});

test('seedFile 不触发写穿(水合入口契约)', async () => {
  const persistence = new InMemoryVirtualFsPersistence();
  const fs = new PersistentVirtualFileSystem({ scope: 'run-5', persistence });
  fs.seedFile('/seeded.md', '只进内存');
  await fs.flush();
  assert.deepEqual(await persistence.load('run-5'), [], 'seed 不该产生持久化行');
  assert.equal(await fs.readFile('/seeded.md', { encoding: 'utf-8' }), '只进内存');
});

test('listByPath:跨 scope 按路径列内容(列表页场景)', async () => {
  const persistence = new InMemoryVirtualFsPersistence();
  for (const scope of ['r1', 'r2']) {
    const fs = await PersistentVirtualFileSystem.create({ scope, persistence });
    await fs.writeFile('/manifest.json', `{"runId":"${scope}"}`, { recursive: true });
  }
  const rows = await persistence.listByPath('manifest.json');
  assert.deepEqual(rows.map(r => r.scope).sort(), ['r1', 'r2']);
});

for (const [name, fn] of cases) {
  try {
    await fn();
    passed += 1;
    console.log(`✔ ${name}`);
  } catch (err) {
    console.error(`✖ ${name}`);
    console.error(err);
    process.exit(1);
  }
}
console.log(`\n${passed}/${cases.length} passed`);
