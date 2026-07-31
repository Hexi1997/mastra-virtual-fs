# mastra-virtual-fs

[![npm version](https://img.shields.io/npm/v/mastra-virtual-fs.svg)](https://www.npmjs.com/package/mastra-virtual-fs)
[![license](https://img.shields.io/npm/l/mastra-virtual-fs.svg)](./LICENSE)
[![types](https://img.shields.io/npm/types/mastra-virtual-fs.svg)](./dist/index.d.ts)

> Mastra Workspace 的**虚拟文件系统** —— 给 agent 一个内存态的沙盒:可写穿持久化到你的 DB、进程重启后恢复续用;也能把 skill 以字符串直接喂给 agent,全程不落盘。

Mastra 的 `Workspace` 默认只带 `LocalFilesystem`(读写本机磁盘)。磁盘沙盒在容器化部署下
有两个老大难:实例没有持久盘(重启即丢)、网络挂载盘上 rename 覆盖对并发读者不原子
(「文件明明在,open 却 ENOENT」)。本包提供两个互补的虚拟 FS,都完整实现 Mastra 的
`WorkspaceFilesystem` 接口、可直接挂给 `new Workspace({ filesystem })`:

- **`PersistentVirtualFileSystem`(主打)** —— agent run 的产物沙盒:读写全走内存(快、无
  rename 窗口),每次写同步「写穿」到你注入的存储后端(DB / Redis / …),进程重启后水合恢复。
  存储契约由你实现(`VirtualFsPersistence`),表结构进你自己的 migration 流程。
- **`MastraVirtualFileSystem`(基座)** —— 纯内存:把 skill 的 `SKILL.md` / `references/`
  以字符串 seed 进去,`workspace.skills` 像读本地 skill 一样读到它们;也可当通用内存 FS。

## 特性

- 🗄️ **写穿持久化** —— `PersistentVirtualFileSystem`:写内存的同时同步到注入的持久化后端(契约由使用方实现,SDK 不含 SQL),重启后水合续用(见「写穿持久化」)。
- 📦 **零落盘** —— skill / reference 以字符串 seed,内容只在内存。
- 🔌 **即插即用** —— 实现完整 `WorkspaceFilesystem` 接口,直接传给 `new Workspace({ filesystem })`;与 workspace 文件工具(read/write/edit/list…)实测兼容。
- 🎯 **与 LocalFilesystem 同语义** —— 抛 `@mastra/core` 的类型化错误(同时带 Node 风格 `err.code`)、`writeFile` 默认自动建父目录、支持 `expectedMtime` 写冲突检测 —— core 工具包装层的 instanceof 判断、读改写保护都正常工作。
- 🧠 **对 agent 健壮** —— 内置 `looseReferenceLookup`,兼容弱模型把 reference 路径"挂错根"的情况(见下)。
- 🟦 **TypeScript 优先** —— 自带类型声明,ESM。

## 两种形态怎么选

| | `MastraVirtualFileSystem`(纯内存) | `PersistentVirtualFileSystem`(写穿持久化) |
| --- | --- | --- |
| 数据在哪 | 只在内存 | 内存 + 同步写穿到你注入的后端(DB / Redis / …) |
| 进程重启后 | 内容丢失 | `create()` 自动从后端水合读回,续用 |
| 读路径 | 内存 | **同样只走内存**(后端不参与读,没有「写完读不到」窗口) |
| 写返回时 | 已在内存 | 已在内存 **且已持久化**(写穿是同步的) |
| 额外依赖 | 无 | 无(后端由你实现 `VirtualFsPersistence` 契约注入,SDK 不含 SQL) |
| 典型场景 | 动态 skill / 一次性上下文 | agent run 的产物沙盒(计划 / 中间结果 / trace / 报告) |

一句话:内容是临时的用纯内存;内容要在进程重启后还在、或要进 DB 可查可审计,用持久化形态。
可运行 demo:`pnpm demo`(纯内存 + skills) / `pnpm demo:persistent`(写穿 + 重启恢复,离线零 key) / `pnpm agent:persistent`(真实 Agent:seed skill + 写产物 + 重启后续聊,需模型 key)。

## 安装

```bash
npm install mastra-virtual-fs @mastra/core
# 或 pnpm add / yarn add
```

`@mastra/core` 是 **peer dependency**,由你的项目提供(`>=1.25.0`)。要求 **Node ≥ 18**,ESM。

## 快速上手

### 持久化沙盒 × 真实 Agent(主打场景)

给 agent 一个「重启不丢」的产物沙盒:skill 每次启动 seed(仅内存,不入库),agent 用
workspace 文件工具写的产物走写穿、返回即已持久化;进程重启后水合恢复、接着用。

```ts
import { Agent } from '@mastra/core/agent';
import { Workspace } from '@mastra/core/workspace';
import { PersistentVirtualFileSystem, type VirtualFsPersistence } from 'mastra-virtual-fs';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// 持久化后端由你实现(这里以 PG 为例;表 agent_vfs_files(scope, path, content, mime_type),
// 建表进你自己的 migration 流程,更多说明见「写穿持久化」)
const persistence: VirtualFsPersistence = {
  async load(scope) {
    const r = await pool.query('SELECT path, content, mime_type FROM agent_vfs_files WHERE scope = $1', [scope]);
    return r.rows.map(x => ({ path: x.path, content: x.content ?? '', mimeType: x.mime_type ?? null }));
  },
  async upsert(scope, path, content, mimeType) {
    await pool.query(
      `INSERT INTO agent_vfs_files (scope, path, content, mime_type) VALUES ($1, $2, $3, $4)
       ON CONFLICT (scope, path) DO UPDATE SET content = $3, mime_type = $4, updated_at = now()`,
      [scope, path, content, mimeType ?? null],
    );
  },
  async remove(scope, path) {
    await pool.query('DELETE FROM agent_vfs_files WHERE scope = $1 AND path = $2', [scope, path]);
  },
  async removeByPrefix(scope, prefix) {
    // position() 而非 LIKE:路径含 %/_/\ 也不用转义
    await pool.query('DELETE FROM agent_vfs_files WHERE scope = $1 AND position($2 IN path) = 1', [scope, prefix]);
  },
  async removeScope(scope) {
    await pool.query('DELETE FROM agent_vfs_files WHERE scope = $1', [scope]);
  },
};

// 每次「进程启动」的装配:create = new + 从后端水合;skill 是派生数据,重启后重新 seed
async function boot() {
  const fs = await PersistentVirtualFileSystem.create({ scope: 'run-42', persistence });
  fs.seedSkill('/skills/research-notes', SKILL_MD, REFERENCES);   // 仅内存,不入库
  return new Workspace({ filesystem: fs, skills: ['/skills/research-notes'] });
}

const makeAgent = (workspace: Workspace) =>
  new Agent({
    id: 'research-agent', name: 'research-agent', model: process.env.MODEL,
    instructions: '你是调研助理。回答调研问题后,必须用文件写入工具把结论按 skill 规范存到 notes/<主题>.md。',
    workspace,
  });

// 会话 1:agent 写的 notes/http-cache.md 走写穿,返回时已在后端里
await makeAgent(await boot()).generate('调研一下 HTTP 强缓存和协商缓存的区别,并存档笔记。', { maxSteps: 16 });

// ……进程重启(内存全丢)……

// 会话 2:同一 scope 再 boot → 笔记从后端水合回来,agent 直接回看
const res = await makeAgent(await boot()).generate('我们上次记了什么笔记?概括一下。', { maxSteps: 16 });
console.log(res.text);   // 基于恢复出来的 notes/http-cache.md 作答
```

完整可运行版(含 SKILL_MD/REFERENCES 定义与工具调用轨迹打印):`pnpm agent:persistent`
(apps/test/src/persistent-agent-demo.ts)。纯机制版(不需要模型 key):`pnpm demo:persistent`。
单测/离线场景可用内置的 `InMemoryVirtualFsPersistence` 顶替 DB 后端(同一契约)。

### 纯内存 seed skill × 真实 Agent

下面是一个可直接运行的端到端示例:把一个「天气播报」skill(`SKILL.md` + 一个 reference)
以字符串 seed 进内存,挂到真实 `Agent` 上;agent 会自动激活 skill、读取 reference,再按
skill 规定的格式回答 —— 全程不落盘。

```ts
import 'dotenv/config';
import { Agent } from '@mastra/core/agent';
import { Workspace } from '@mastra/core/workspace';
import { MastraVirtualFileSystem } from 'mastra-virtual-fs';

// 1) skill 内容:SKILL.md(带 YAML frontmatter)+ references,全是字符串
const SKILL_MD = `---
name: weather-reporter
description: 天气播报 skill。当用户询问城市天气、气温或穿衣建议时使用,按规定格式输出。
---

# Weather Reporter

播报天气时,严格按三行输出:
1. \`【<城市>】天气:<晴/多云/雨…>\`
2. \`气温:<最低>~<最高>℃\`
3. \`建议:<一句话穿衣建议>\`

穿衣建议必须依据 \`references/穿衣指南.md\`。
`;

const REFERENCES = {
  '穿衣指南.md': `# 穿衣指南(按最高气温)
- ≥ 28℃:短袖短裤,注意防晒
- 18~27℃:长袖或薄外套
- 10~17℃:外套 + 长裤
- < 10℃:厚外套保暖
`,
};

// 2) 内存 FS:把 skill + references seed 进去(不落盘)
const filesystem = new MastraVirtualFileSystem();
filesystem.seedSkill('/skills/weather-reporter', SKILL_MD, REFERENCES);

// 3) 用这个 FS 建 Workspace 并挂上 skill
const workspace = new Workspace({
  filesystem,
  skills: ['/skills/weather-reporter'], // 绝对路径最稳妥
});

// 4) 建 Agent,把 workspace 挂上去 —— Mastra 会自动把 skill 工具注入 agent
const agent = new Agent({
  id: 'weather-agent',
  name: 'weather-agent',
  instructions: '你是天气播报助手。回答天气相关问题时,激活并遵循 weather-reporter skill。',
  model: process.env.MODEL, // 需配对应 provider 的 key
  workspace,
});

// 5) 对话:agent 自动激活 skill、读取 references/穿衣指南.md,再按格式播报
const res = await agent.generate('南京今天最高气温 32℃,最低 26℃,晴。帮我播报天气。', {
  maxSteps: 12,
});
console.log(res.text);
```

运行(需要一个模型 API key;`MODEL` 用 Mastra 的 `provider/model` magic string):

```bash
export MODEL=openrouter/openai/gpt-5.5
export OPENROUTER_API_KEY=sk-or-...     # 换 provider 就配对应的 key,如 OPENAI_API_KEY
npx tsx demo.ts                          # 文件含顶层 await,以 ESM 运行
```

预期输出大致如下(内容来自内存里的 skill,穿衣建议来自 reference):

```text
【南京】天气:晴
气温:26~32℃
建议:短袖短裤,注意防晒
```

## 写穿持久化(PersistentVirtualFileSystem)

> 可运行 demo:
> - `pnpm demo:persistent` —— 机制演示(写穿 / 重启水合 / 收尾),离线零 key;
> - `pnpm agent:persistent` —— 真实 Agent 完整故事:seed skill(不入库)→ agent 按 skill 用文件工具写笔记(写穿入库)→「进程重启」→ 水合 + 重新 seed → agent 回看笔记,需模型 key。

内存 FS 的天然短板是进程重启即失忆。`PersistentVirtualFileSystem` 在其上加一层**写穿**:
每个写操作先落内存、再同步交给注入的 `VirtualFsPersistence` 后端;读取仍然只走内存(没有
「写完读不到」的窗口)。重启后 `hydrate()` 从后端读回续用。

**存储怎么落地(哪张表、什么结构、用什么库)完全由使用方决定** —— SDK 只定义契约,
你在自己的项目里实现并传进来;表结构走你自己的 migration 流程,SDK 不含任何 SQL、不执行 DDL。

```ts
import { PersistentVirtualFileSystem, type VirtualFsPersistence } from 'mastra-virtual-fs';

// 1) 在你的项目里实现持久化契约(示例:PG 表 my_vfs_files(scope, path, content, mime_type))
const persistence: VirtualFsPersistence = {
  async load(scope) {
    const r = await db.query('SELECT path, content, mime_type FROM my_vfs_files WHERE scope = $1', [scope]);
    return r.rows.map(x => ({ path: x.path, content: x.content ?? '', mimeType: x.mime_type ?? null }));
  },
  async upsert(scope, path, content, mimeType) {
    await db.query(
      `INSERT INTO my_vfs_files (scope, path, content, mime_type) VALUES ($1,$2,$3,$4)
       ON CONFLICT (scope, path) DO UPDATE SET content = $3, mime_type = $4`,
      [scope, path, content, mimeType ?? null],
    );
  },
  async remove(scope, path) { await db.query('DELETE FROM my_vfs_files WHERE scope=$1 AND path=$2', [scope, path]); },
  // 前缀删除建议用 position() 而非 LIKE:路径含 %/_/\ 时 LIKE 需要转义,position 无此坑
  async removeByPrefix(scope, prefix) {
    await db.query('DELETE FROM my_vfs_files WHERE scope=$1 AND position($2 IN path)=1', [scope, prefix]);
  },
  async removeScope(scope) { await db.query('DELETE FROM my_vfs_files WHERE scope=$1', [scope]); },
};

// 2) 一个 scope(如一次 agent run)一个实例;create = new + hydrate
const fs = await PersistentVirtualFileSystem.create({ scope: 'run-42', persistence });
await fs.writeFile('/plan.md', '- [ ] batch-01', { recursive: true });   // 返回即已持久化
// ……挂 Workspace、跑 agent,与 MastraVirtualFileSystem 用法完全一致

// 收尾
await fs.flush();               // 等在途持久化排空(每次写已 await,通常不需要)
await fs.destroyPersisted();    // 删除该 scope 的全部持久化数据
```

一致性契约:

- 持久化任务进 per-instance 串行队列,执行时**现读**内存最新值再 upsert ——
  并发对同一文件追加(如多批次同时 append trace 日志)最终收敛到内存内容;
- 每个写方法 await 本次持久化完成后才返回(写穿,不是异步落盘);
- `seedFile` / `seedSkill` / `hydrate` 不触发写穿(它们是水合入口);
- 测试/离线场景用内置的 `InMemoryVirtualFsPersistence`(同一契约,纯内存 Map);
- 多进程同时写同一 scope 时各自内存独立、持久化按后写者收敛,需要强一致请在上层做互斥。

## API

### `new MastraVirtualFileSystem(options?)`

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 自动生成 | 实例 id |
| `readOnly` | `boolean` | `false` | 为 `true` 时所有写操作抛 `EACCES`(agent 不会拿到写类工具) |
| `debug` | `boolean` | `false` | 把每一次底层 fs 调用打到 `console.error`,便于调试路径解析 |
| `seed` | `Record<string, FileContent>` | — | 用 `{ 路径: 内容 }` 预置初始文件 |
| `looseReferenceLookup` | `boolean` | `true` | 读路径未命中且看似"挂错根"时,按唯一后缀匹配兜底到真实文件(见下) |
| `directoryMtimeFollowsContents` | `boolean` | `true` | 目录 `modifiedAt` 跟随其下文件内容的最新修改时间,让 reseed SKILL.md 后下一次 `generate` 默认能热更新(见下) |

### 便捷方法

| 方法 | 说明 |
| --- | --- |
| `seedFile(path, content, mimeType?): this` | 写入单个虚拟文件(自动建父目录),返回 `this` 可链式调用 |
| `seedSkill(skillDir, skillMd, references?): this` | 一步 seed 一个 skill(`SKILL.md` + `references/*`) |
| `listAllPaths(): string[]` | 调试用,导出当前所有文件路径 |

### `WorkspaceFilesystem` 方法

标准接口方法,均 async:`readFile` / `writeFile` / `appendFile` / `deleteFile` /
`copyFile` / `moveFile` / `mkdir` / `rmdir` / `readdir` / `exists` / `stat` / `realpath`，
以及 `getInfo` / `isReady` / `init` / `destroy` 等生命周期方法。

错误抛 `@mastra/core/workspace` 的**类型化错误类**(`FileNotFoundError` / `DirectoryNotFoundError` /
`IsDirectoryError` / `NotDirectoryError` / `FileExistsError` / `DirectoryNotEmptyError` /
`PermissionError` / `StaleFileError`),它们同时自带 Node 风格 `err.code`(`ENOENT` / `EISDIR` /
`ENOTDIR` / `EEXIST` / `ENOTEMPTY` / `EACCES` / `ESTALE`)——`instanceof` 与 `err.code` 两种判断都可用。
⚠️ 必须抛类型化错误而不是裸 `Error`:core 的 workspace 工具包装层(读改写保护等)对 stat 结果做
`instanceof FileNotFoundError` 判断,裸 ENOENT 会被当成未知错误重抛,agent 的 write_file 会莫名失败。

### `new PersistentVirtualFileSystem(options)` / `PersistentVirtualFileSystem.create(options)`

继承 `MastraVirtualFileSystem`,基类全部选项可用,额外要求:

| 选项 | 类型 | 说明 |
| --- | --- | --- |
| `scope` | `string` | 持久化分区键(一次 agent run / 一个项目一个 scope) |
| `persistence` | `VirtualFsPersistence` | 存储后端,由使用方实现注入(SDK 不含 SQL、不执行 DDL) |

持久化专有方法:

| 方法 | 说明 |
| --- | --- |
| `hydrate(): Promise<this>` | 从后端读回本 scope 全部文件并 seed 进内存(幂等;`create()` = new + hydrate) |
| `flush(): Promise<void>` | 等在途持久化排空(每个写方法已 await 本次持久化,通常不需要) |
| `destroyPersisted(): Promise<void>` | 删除本 scope 的全部持久化数据并销毁内存实例 |

### `VirtualFsPersistence` 契约

| 方法 | 说明 |
| --- | --- |
| `load(scope)` | 水合:取一个 scope 的全部文件 `{ path, content, mimeType }[]` |
| `upsert(scope, path, content, mimeType?)` | 写/覆盖一个文件 |
| `remove(scope, path)` | 删除一个文件 |
| `removeByPrefix(scope, prefix)` | 删除 path 以 prefix 开头的全部文件(rmdir recursive;空串=全部) |
| `removeScope(scope)` | 删除整个 scope |
| `listByPath?(path)` | 可选:列出某 path 在所有 scope 下的内容(如按 manifest.json 列全部 run) |

内置 `InMemoryVirtualFsPersistence` 实现了同一契约(纯内存 Map),单测/离线场景直接用。

### `looseReferenceLookup`(默认开)

agent 用通用文件工具(`file_stat` / `read_file`)读 skill reference 时,常只给相对路径
`references/x.md`;它会被 Mastra 的挂载层规整成根下的 `/references/x.md`,而真实文件其实在
`/skills/<skill>/references/x.md` —— 于是读取 `ENOENT`、agent 拿不到内容。由于你无法控制终端
用户的 prompt 和模型,这个兜底**默认开启**:读未命中时,若该路径的父目录并不真实存在,就在所有
文件里找**唯一**一个以该路径结尾的真实文件并命中。

安全约束(不偏离 `LocalFilesystem` 语义):

- 只作用于读(`readFile` / `stat` / `exists`),**不动写操作**;
- 仅当被读路径的**父目录不真实存在**时才兜底(父目录存在 = 只是文件缺失,照常 `ENOENT`);
- 后缀匹配必须**唯一**,歧义(多个 skill 同名引用)则不兜底。

因此 `getReference(skill, 'x.md')`(缺 `references/` 前缀,落在已存在的 skill 目录下)仍按契约
返回 `null`,与真实 FS 一致。`debug: true` 时兜底命中会打印 `readFile→loose` / `stat→loose`。
需要与真实磁盘 FS 完全一致的严格行为时,置 `looseReferenceLookup: false`。

### `directoryMtimeFollowsContents`(默认开)

Mastra 的 skills 系统会**缓存** SKILL.md(`name` / `description` / `instructions`)。`agent.generate()`
在第一步会调 `workspace.skills.maybeRefresh()`,它靠比较「skill 目录的 `mtime`」和「上次发现时间」
来决定要不要重新发现 skill。本项**默认开启**:reseed(重写)SKILL.md 会把它所在目录及各级父目录的
`modifiedAt` 顶到当下,于是下一次 `generate` **默认就能读到最新的 SKILL.md**——无需手动 `refresh()`
或 `checkSkillFileMtime`。references 本来就每次现读(`getReference` 直接走 `readFile`),始终最新。

> ⚠️ 时序:陈旧检查有 ~2s 冷却,且按「严格大于」比较 mtime。真实 `agent.generate()` 第一轮本就
> 耗时数秒,天然满足;在同一毫秒内连续 reseed 的极端情况可能漏判。

这是相对真实磁盘的**有意偏离**:POSIX / `LocalFilesystem` 里,改写已存在文件的内容**不会**改变其父
目录 `mtime`(只有新增/删除/改名条目才会)。需要与磁盘 FS 严格一致时,置
`directoryMtimeFollowsContents: false`——届时目录 `mtime` 只在**结构变化**(新增/删除文件、`mkdir` /
`rmdir`)时更新;此时想热更新 SKILL.md 内容,可用 `workspace.skills.refresh()`,或建 `Workspace` 时传
`checkSkillFileMtime: true`。

## skill 缓存与刷新时机(重要)

「改了 skill,agent 什么时候才读到最新?」这取决于 **Mastra 上游的 skills 缓存机制**(与用哪个
filesystem 无关,`LocalFilesystem` 行为一致),分 SKILL.md 与 reference 两种情况。核心规则:

- **发现 + 缓存是懒加载的**:`new Workspace()` / `new Agent()` **不读盘**;直到**第一次 `generate()`
  的第 0 步**(`processInputStep` 调 `skills.maybeRefresh()`)才发现 skill 并缓存
  `name` / `description` / `instructions`。
- **同一次 `generate()` 内只在第 0 步刷新**:后续 step 全程吃这份缓存(`maybeRefresh` 被写死
  `stepNumber === 0`;`load_skill` 还会把 instructions 冻进该轮的 thread state)。
- **reference 不缓存**:`getReference()` 每次都现读 `filesystem.readFile()`,随时最新。

心智模型:

```
new Workspace / new Agent       → 什么都不读,无缓存
第一次 generate 的 step0         → 发现 + 缓存 SKILL.md     ← 缓存就发生在这一刻(不是 new Agent 时)
  同一次 generate 的 step 1..N   → 全程吃缓存(此时改 SKILL.md 当轮不生效)
第二次 generate 的 step0         → 重新判断陈旧;陈旧则重新发现 → 读到最新 SKILL.md
```

| 改动发生的时机 | SKILL.md(instructions/description) | reference |
| --- | --- | --- |
| `new Agent()` 之后、**首个 `generate()` 之前** | ✅ 首个 generate 读到最新(懒加载) | ✅ 最新 |
| **某次 `generate()` 跑到一半**(后续 step) | ❌ 当轮不变(第 0 步已定格) | ✅ 改之后被读到就拿到最新(现读) |
| 两次 `generate()` **之间** | ✅ 下一次 generate 读到最新(靠 `directoryMtimeFollowsContents`,见上) | ✅ 最新 |

实用推论:**只要把修改放在目标 `generate()` 启动之前**(哪怕在 `new Agent()` 之后),那次 generate
就会用上最新 SKILL.md。唯一抓不住的是「已经跑起来的那一次 generate 的后续 step」——这是 Mastra 的
`stepNumber === 0` 限制,FS 这层改不了(真要的话只能在 app 层用 `onStepFinish` 等钩子手动
`workspace.skills.refresh()`,一般没必要)。

## 关键契约 / 易踩的坑

> 以下均已与真实 `LocalFilesystem` 逐项对照验证。

- Mastra 的 skills **完全通过 workspace 的 filesystem 读取**,所以只要实现
  `WorkspaceFilesystem` 接口,skills 就能工作。
- skill 目录结构:`<skillDir>/SKILL.md` + `<skillDir>/references/<相对路径>`,
  目录名是 **`references`(复数)**。
- `getReference(skillName, refPath)` 的 `refPath` **必须带 `references/` 前缀**
  (如 `'references/方法.md'`、`'references/sub/嵌套.md'`),不带前缀返回 `null`。
- 递归 `readdir` 的 `name` 是**相对子路径**(嵌套文件为 `'sub/nested.md'` 而非 basename),
  否则嵌套引用会丢失。
- 路径统一规整为绝对 POSIX 路径(`.` / `..` / 尾斜杠均归一);in-memory FS 的 `basePath` 为 `undefined`。
- `writeFile` **默认自动创建父目录**(`recursive !== false` 即 mkdir -p,与 LocalFilesystem 一致);
  workspace 的 `mastra_workspace_write_file` 工具不传 `recursive` 且描述承诺会建父目录,要求显式
  `recursive: true` 会让 agent 写新文件时收到 ENOENT、陷入乱试。显式 `recursive: false` 才要求父目录已存在。
- `writeFile` 支持 `expectedMtime`(读改写冲突检测):与当前 mtime 不一致 → `StaleFileError`(`ESTALE`)。
- **消费方注意单副本**:错误类的 `instanceof` 判断要求你的项目里只有一份 `@mastra/core`
  (正常从 npm 安装、peer 由项目提供即是如此)。monorepo 里若 SDK 与 app 各解析到不同版本的
  core,会出现「两份错误类、instanceof 恒 false」的双包危害 —— 对齐版本让包管理器去重即可。

## 示例与开发

完整的可运行示例(端到端 skills demo、与 `LocalFilesystem` 的对照 probe、挂到真实 Agent 的
多 provider demo)在仓库的 `apps/test` 里。克隆仓库后:

```bash
pnpm install
pnpm test            # 离线 smoke 测试(单元 + Workspace 集成)
pnpm demo            # seed skill → 通过 workspace.skills 读取
pnpm demo:persistent # 写穿持久化:写产物 → 模拟重启 → 水合恢复(离线)
pnpm agent:persistent# 真实 Agent × 持久化沙盒:seed skill + 写笔记入库 + 重启后回看(需 key)
pnpm agent           # 挂到真实 Agent(需在 apps/test/.env 填任一 provider 的 key)
pnpm mutation        # 离线断言:reseed skill 后的缓存/刷新行为(默认 vs 严格模式)
pnpm change-skill    # 真实 Agent:在 generate 执行【过程中】改 skill,看读取轨迹(需 key)
```

## License

MIT
