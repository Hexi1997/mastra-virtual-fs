/**
 * 离线 smoke 测试(零依赖,纯 node:assert) —— `npm test` 跑它。
 *
 * 覆盖两层:
 *   1. 单元:MastraVirtualFileSystem 各方法的行为与 Node 风格错误码。
 *   2. 集成:把 seed 进去的 skill 通过真实 `Workspace.skills` 读出来。
 *
 * 全程离线,不需要任何 API key。任一断言失败 → 退出码 1。
 */
import assert from 'node:assert/strict';
import { Workspace } from '@mastra/core/workspace';
import { MastraVirtualFileSystem } from '../src/index.js';

let passed = 0;
const cases: Array<[string, () => Promise<void> | void]> = [];
function test(name: string, fn: () => Promise<void> | void) {
  cases.push([name, fn]);
}

/** 断言一个 async 调用抛出带指定 Node 错误码的错误 */
async function rejectsWithCode(fn: () => Promise<unknown>, code: string) {
  await assert.rejects(fn, (err: NodeJS.ErrnoException) => {
    assert.equal(err.code, code, `期望错误码 ${code},实际 ${err.code}`);
    return true;
  });
}

// ── 单元:读写往返 + encoding 契约 ────────────────────────────────────────
test('writeFile/readFile 往返;encoding 决定 string vs Buffer', async () => {
  const fs = new MastraVirtualFileSystem();
  await fs.writeFile('/a/b.txt', 'hello', { recursive: true });
  assert.equal(await fs.readFile('/a/b.txt', { encoding: 'utf-8' }), 'hello');
  const buf = await fs.readFile('/a/b.txt');
  assert.ok(Buffer.isBuffer(buf), '不带 encoding 应返回 Buffer');
  assert.equal(buf.toString('utf-8'), 'hello');
});

// ── 单元:路径规整 ────────────────────────────────────────────────────────
test('路径规整:. / .. / 尾斜杠 指向同一文件', async () => {
  const fs = new MastraVirtualFileSystem({ seed: { '/x/y.txt': 'v' } });
  assert.equal(await fs.readFile('/x/./y.txt', { encoding: 'utf-8' }), 'v');
  assert.equal(await fs.readFile('/x/z/../y.txt', { encoding: 'utf-8' }), 'v');
  assert.equal(await fs.readFile('x/y.txt', { encoding: 'utf-8' }), 'v');
});

// ── 单元:错误码 ──────────────────────────────────────────────────────────
test('读取不存在的文件 → ENOENT', async () => {
  const fs = new MastraVirtualFileSystem();
  await rejectsWithCode(() => fs.readFile('/nope.txt'), 'ENOENT');
});

test('把目录当文件读 → EISDIR', async () => {
  const fs = new MastraVirtualFileSystem();
  await fs.mkdir('/d', { recursive: true });
  await rejectsWithCode(() => fs.readFile('/d'), 'EISDIR');
});

test('overwrite:false 写已存在文件 → EEXIST', async () => {
  const fs = new MastraVirtualFileSystem({ seed: { '/f.txt': 'a' } });
  await rejectsWithCode(() => fs.writeFile('/f.txt', 'b', { overwrite: false }), 'EEXIST');
});

test('writeFile 默认自动建父目录(对齐 LocalFilesystem);recursive:false 才要求父目录已存在', async () => {
  const fs = new MastraVirtualFileSystem();
  // 默认(不传 recursive):自动 mkdir -p —— workspace 的 write_file 工具不传 recursive,
  // 且描述承诺 "Creates parent directories if needed",这是 LocalFilesystem 的实际行为
  await fs.writeFile('/auto/x.txt', 'v');
  assert.equal(await fs.readFile('/auto/x.txt', { encoding: 'utf-8' }), 'v');
  // 显式 recursive:false:父目录缺失 → ENOENT(DirectoryNotFoundError)
  await rejectsWithCode(() => fs.writeFile('/missing/x.txt', 'v', { recursive: false }), 'ENOENT');
});

test('错误是 @mastra/core 的类型化错误类(core 工具包装层用 instanceof 判断)', async () => {
  const { FileNotFoundError, DirectoryNotFoundError } = await import('@mastra/core/workspace');
  const fs = new MastraVirtualFileSystem();
  await assert.rejects(() => fs.readFile('/nope.txt'), (err: unknown) => err instanceof FileNotFoundError);
  await assert.rejects(
    () => fs.writeFile('/missing/x.txt', 'v', { recursive: false }),
    (err: unknown) => err instanceof DirectoryNotFoundError,
  );
});

test('writeFile expectedMtime 不一致 → ESTALE(StaleFileError,edit 工具的写冲突检测)', async () => {
  const fs = new MastraVirtualFileSystem();
  await fs.writeFile('/doc.md', 'v1');
  const staleMtime = new Date(0);
  await rejectsWithCode(
    () => fs.writeFile('/doc.md', 'v2', { expectedMtime: staleMtime } as never),
    'ESTALE',
  );
  // mtime 一致则放行
  const current = (await fs.stat('/doc.md')).modifiedAt;
  await fs.writeFile('/doc.md', 'v2', { expectedMtime: current } as never);
  assert.equal(await fs.readFile('/doc.md', { encoding: 'utf-8' }), 'v2');
});

// ── 单元:只读模式 ────────────────────────────────────────────────────────
test('readOnly:true 时所有写操作 → EACCES,读仍可用', async () => {
  const fs = new MastraVirtualFileSystem({ readOnly: true, seed: { '/r.txt': 'v' } });
  assert.equal(await fs.readFile('/r.txt', { encoding: 'utf-8' }), 'v');
  await rejectsWithCode(() => fs.writeFile('/r.txt', 'x'), 'EACCES');
  await rejectsWithCode(() => fs.deleteFile('/r.txt'), 'EACCES');
  await rejectsWithCode(() => fs.mkdir('/d'), 'EACCES');
});

// ── 单元:目录列举(递归 name = 相对子路径) ──────────────────────────────
test('readdir 非递归=basename,递归=相对子路径', async () => {
  const fs = new MastraVirtualFileSystem();
  fs.seedFile('/p/a.md', '1');
  fs.seedFile('/p/sub/b.md', '2');

  const flat = (await fs.readdir('/p')).map(e => e.name).sort();
  assert.deepEqual(flat, ['a.md', 'sub']);

  const deep = (await fs.readdir('/p', { recursive: true }))
    .filter(e => e.type === 'file')
    .map(e => e.name)
    .sort();
  assert.deepEqual(deep, ['a.md', 'sub/b.md']);
});

test('readdir 的 extension 过滤', async () => {
  const fs = new MastraVirtualFileSystem();
  fs.seedFile('/p/a.md', '1').seedFile('/p/b.txt', '2');
  const names = (await fs.readdir('/p', { extension: 'md' })).map(e => e.name);
  assert.deepEqual(names, ['a.md']);
});

// ── 单元:copy / move / delete(force) ────────────────────────────────────
test('copyFile / moveFile / deleteFile(force)', async () => {
  const fs = new MastraVirtualFileSystem({ seed: { '/s.txt': 'data' } });
  await fs.copyFile('/s.txt', '/c.txt');
  assert.equal(await fs.readFile('/c.txt', { encoding: 'utf-8' }), 'data');

  await fs.moveFile('/s.txt', '/m.txt');
  assert.equal(await fs.exists('/s.txt'), false);
  assert.equal(await fs.readFile('/m.txt', { encoding: 'utf-8' }), 'data');

  await fs.deleteFile('/already-gone.txt', { force: true }); // force:不抛
  await rejectsWithCode(() => fs.deleteFile('/already-gone.txt'), 'ENOENT');
});

// ── 单元:rmdir 非空保护 ──────────────────────────────────────────────────
test('rmdir 非空 → ENOTEMPTY;recursive 可清空', async () => {
  const fs = new MastraVirtualFileSystem();
  fs.seedFile('/dir/inner/x.txt', 'v');
  await rejectsWithCode(() => fs.rmdir('/dir'), 'ENOTEMPTY');
  await fs.rmdir('/dir', { recursive: true });
  assert.equal(await fs.exists('/dir'), false);
  assert.equal(await fs.exists('/dir/inner/x.txt'), false);
});

// ── 单元:stat / getInfo ──────────────────────────────────────────────────
test('stat 返回 file/directory 元数据,getInfo 暴露实例信息', async () => {
  const fs = new MastraVirtualFileSystem({ id: 'fixed-id', seed: { '/f.txt': 'abc' } });
  const st = await fs.stat('/f.txt');
  assert.equal(st.type, 'file');
  assert.equal(st.size, 3);
  assert.equal((await fs.stat('/')).type, 'directory');

  const info = fs.getInfo();
  assert.equal(info.id, 'fixed-id');
  assert.equal(info.provider, 'in-memory');
  assert.equal(fs.isReady(), true);
});

// ── 单元:looseReferenceLookup —— 兼容模型把引用挂错根 ───────────────────────
test('looseReferenceLookup 默认开:挂错根的相对引用能兜底命中', async () => {
  const fs = new MastraVirtualFileSystem();
  fs.seedFile('/skills/weather/references/穿衣指南.md', 'GUIDE');
  // 模型用相对路径 references/穿衣指南.md → 上游规整成根下 /references/穿衣指南.md
  assert.equal(await fs.exists('/references/穿衣指南.md'), true);
  assert.equal(await fs.readFile('/references/穿衣指南.md', { encoding: 'utf-8' }), 'GUIDE');
  assert.equal((await fs.stat('/references/穿衣指南.md')).type, 'file');
});

test('looseReferenceLookup:false 时严格 ENOENT(与 LocalFilesystem 一致)', async () => {
  const fs = new MastraVirtualFileSystem({ looseReferenceLookup: false });
  fs.seedFile('/skills/weather/references/穿衣指南.md', 'G');
  await rejectsWithCode(() => fs.readFile('/references/穿衣指南.md'), 'ENOENT');
  assert.equal(await fs.exists('/references/穿衣指南.md'), false);
});

test('兜底要求唯一:多个 skill 同名引用 → 歧义,不兜底', async () => {
  const fs = new MastraVirtualFileSystem();
  fs.seedFile('/skills/a/references/x.md', '1');
  fs.seedFile('/skills/b/references/x.md', '2');
  await rejectsWithCode(() => fs.readFile('/references/x.md'), 'ENOENT');
});

test('兜底不改变"目录存在、仅文件缺失"的语义', async () => {
  const fs = new MastraVirtualFileSystem();
  fs.seedFile('/skills/a/references/x.md', '1');
  // /skills/a 是真实目录:读 /skills/a/x.md 应 ENOENT,而不是兜底到 references/x.md
  await rejectsWithCode(() => fs.readFile('/skills/a/x.md'), 'ENOENT');
});

// ── 集成:Workspace.skills 通过虚拟 FS 读 seed 进去的 skill ────────────────
test('集成:Workspace.skills 读取 seed 的 skill 与 reference', async () => {
  const SKILL_MD = [
    '---',
    'name: research-agent',
    'description: 一个用于系统调研的 skill,至少二十字以上的描述文本满足校验。',
    '---',
    '# body',
  ].join('\n');

  const fs = new MastraVirtualFileSystem();
  fs.seedSkill('/skills/research-agent', SKILL_MD, {
    'method.md': 'ascii ref content',
    '调研方法.md': 'cn ref content',
    'sub/nested.md': 'nested content',
  });

  const ws = new Workspace({ filesystem: fs, skills: ['/skills/research-agent'] });
  const skills = ws.skills;
  assert.ok(skills, 'workspace.skills 应已初始化');

  const list = await skills.list();
  assert.ok(list.some(s => s.name === 'research-agent'), 'list() 应包含 research-agent');

  const skill = await skills.get('research-agent');
  assert.ok(skill, 'get() 应返回 skill');
  assert.equal(skill!.name, 'research-agent');

  // 契约:getReference 的 refPath 必须带 'references/' 前缀,且支持中文/嵌套
  assert.equal(
    (await skills.getReference('research-agent', 'references/调研方法.md'))?.trim(),
    'cn ref content',
  );
  assert.equal(
    (await skills.getReference('research-agent', 'references/sub/nested.md'))?.trim(),
    'nested content',
  );
  // 不带前缀 → null
  assert.equal(await skills.getReference('research-agent', 'method.md'), null);
});

// ── 单元:目录 mtime 跟随内容(directoryMtimeFollowsContents) ───────────────
test('写文件会把各级父目录的 modifiedAt 顶到当下', async () => {
  const fs = new MastraVirtualFileSystem();
  fs.seedFile('/skills/weather/SKILL.md', 'v1');
  const t1 = (await fs.stat('/skills/weather')).modifiedAt.getTime();
  const rootT1 = (await fs.stat('/')).modifiedAt.getTime();
  assert.ok(t1 > 0, '目录 mtime 不应为纪元 0');

  await new Promise(r => setTimeout(r, 5));
  fs.seedFile('/skills/weather/SKILL.md', 'v2'); // 改写已存在文件的内容
  const t2 = (await fs.stat('/skills/weather')).modifiedAt.getTime();
  const rootT2 = (await fs.stat('/')).modifiedAt.getTime();
  assert.ok(t2 > t1, '默认下:改写内容应顶起所在目录 mtime');
  assert.ok(rootT2 > rootT1, '各级祖先(含根)都应被顶起');
});

test('directoryMtimeFollowsContents:false 时,改写内容不顶目录 mtime(贴近 POSIX)', async () => {
  const fs = new MastraVirtualFileSystem({ directoryMtimeFollowsContents: false });
  fs.seedFile('/d/a.md', 'v1');
  const t1 = (await fs.stat('/d')).modifiedAt.getTime();

  await new Promise(r => setTimeout(r, 5));
  fs.seedFile('/d/a.md', 'v2'); // 改写已存在文件 → 不应顶
  assert.equal((await fs.stat('/d')).modifiedAt.getTime(), t1, '改写内容不应改变目录 mtime');

  await new Promise(r => setTimeout(r, 5));
  fs.seedFile('/d/b.md', 'new'); // 新增文件 = 结构变化 → 应顶
  assert.ok((await fs.stat('/d')).modifiedAt.getTime() > t1, '新增条目应顶起目录 mtime');
});

test('删除文件是结构变化:即使 follows:false 也顶起父目录 mtime', async () => {
  const fs = new MastraVirtualFileSystem({ directoryMtimeFollowsContents: false });
  fs.seedFile('/d/a.md', 'x');
  fs.seedFile('/d/b.md', 'y');
  const t1 = (await fs.stat('/d')).modifiedAt.getTime();
  await new Promise(r => setTimeout(r, 5));
  await fs.deleteFile('/d/a.md');
  assert.ok((await fs.stat('/d')).modifiedAt.getTime() > t1, '删除条目应顶起父目录 mtime');
});

// ── 集成:目录 mtime 让 Mastra skills 默认感知 SKILL.md 热更新 ─────────────────
test('集成:reseed SKILL.md 后 maybeRefresh 默认能拉到新 instructions', async () => {
  const md = (v: string) =>
    ['---', 'name: hot-skill', `description: 热更新测试 skill 版本 ${v},描述需要至少二十个字符以满足校验规则。`, '---', `BODY_${v}`].join('\n');
  const fs = new MastraVirtualFileSystem();
  fs.seedSkill('/skills/hot-skill', md('v1'), { 'r.md': 'ref-v1' });
  const ws = new Workspace({ filesystem: fs, skills: ['/skills/hot-skill'] });

  await ws.skills!.maybeRefresh(); // 模拟首次 generate 的 step0
  assert.match((await ws.skills!.get('hot-skill'))!.instructions, /BODY_v1/);

  // 过 2s 陈旧检查冷却,并保证新 mtime 严格新于上次发现时间
  await new Promise(r => setTimeout(r, 2200));
  fs.seedSkill('/skills/hot-skill', md('v2'), { 'r.md': 'ref-v2' });

  await ws.skills!.maybeRefresh(); // 模拟第二次 generate 的 step0
  assert.match((await ws.skills!.get('hot-skill'))!.instructions, /BODY_v2/, '默认应读到新 SKILL.md');
  assert.equal((await ws.skills!.getReference('hot-skill', 'references/r.md'))?.trim(), 'ref-v2');
});

// ── runner ────────────────────────────────────────────────────────────────
async function main() {
  for (const [name, fn] of cases) {
    try {
      await fn();
      passed++;
      console.log(`  ✅ ${name}`);
    } catch (err) {
      console.error(`  ❌ ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }
  const total = cases.length;
  console.log(`\n${passed}/${total} 通过`);
  if (passed !== total) process.exitCode = 1;
}

main();
