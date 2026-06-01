/**
 * Agent Change-Skill Demo:真实场景 —— 在 agent.generate() 正在执行的【过程中】修改 skill 内容,
 * 观察这一轮、以及下一轮分别能读到哪个版本。
 *
 * 和 skill-mutation.ts 的区别:那个是「两次 generate 之间」改;这个是「同一次 generate 跑到一半」改
 *   —— 用一个 setTimeout 在 generate 的 await 还挂着(模型正在网络往返)时去 reseed skill。
 *
 * 真实机制(读 @mastra/core 源码得到):
 *   - skill 的「发现 + SKILL.md(name/description/instructions)缓存」只发生在 generate 的第 0 步
 *     (processInputStep 调 maybeRefresh)。所以【本轮跑到一半再改 SKILL.md,本轮 instructions 不变】。
 *   - reference 不缓存:load_skill / 读引用时每次都现读 filesystem.readFile()。所以
 *     【本轮跑到一半改 reference,只要 agent 在"改之后"才去读它,就能读到新内容】。
 *   - 想让 SKILL.md 的改动完全生效,等【下一轮】generate 即可(本 SDK 目录 mtime 默认跟随内容,
 *     下一轮 step0 的 maybeRefresh 会重新发现 → 见 skill-mutation.ts)。
 *
 * 为了不依赖模型措辞,本脚本继承 MastraVirtualFileSystem 记录每一次对 SKILL.md / reference 的
 * readFile:返回的是哪个版本、距 generate 开始多少 ms、发生在"改 skill"之前还是之后。
 *
 * 运行前:cp .env.example .env,设置 MODEL + 对应 key(同 agent-demo)。
 * 运行:pnpm --filter mastra-virtual-fs-test exec tsx src/agent-change-skill-demo.ts
 *   可调:CHANGE_AFTER_MS=700 控制"跑到第几毫秒去改 skill"。
 */
import 'dotenv/config';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { Agent } from '@mastra/core/agent';
import { Workspace } from '@mastra/core/workspace';
import { MastraVirtualFileSystem } from 'mastra-virtual-fs';
import type { ReadOptions } from '@mastra/core/workspace';

const MODEL = process.env.MODEL ?? '';
const PROVIDER_ID = MODEL.split('/')[0];
const SKILL_DIR = '/skills/weather-reporter';
const REF_REL = '穿衣指南.md';
const CHANGE_AFTER_MS = Number(process.env.CHANGE_AFTER_MS ?? 700);

function resolveApiKeyEnvVar(provider: string): string | undefined {
  const FALLBACK: Record<string, string> = {
    openrouter: 'OPENROUTER_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_API_KEY', groq: 'GROQ_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
    mistral: 'MISTRAL_API_KEY', xai: 'XAI_API_KEY', cerebras: 'CEREBRAS_API_KEY',
  };
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('@mastra/core/package.json');
    const regPath = join(dirname(pkgPath), 'dist', 'provider-registry.json');
    const { providers } = JSON.parse(readFileSync(regPath, 'utf8'));
    return providers?.[provider]?.apiKeyEnvVar ?? FALLBACK[provider];
  } catch {
    return FALLBACK[provider];
  }
}

// ── 两个版本的 skill 内容 ──────────────────────────────────────────────────
function skillMd(v: 'v1' | 'v2'): string {
  const fmt =
    v === 'v1'
      ? '输出必须是【三行】:第一行 `【城市】天气:…`,第二行 `气温:…`,第三行 `建议:…`。'
      : '输出必须是【四行】:第一行 `【城市】天气:…`,第二行 `气温:…`,第三行 `风力:…`,第四行 `建议:…`。';
  return `---
name: weather-reporter
description: 天气播报 skill(${v})。当用户询问天气、气温、穿衣建议时使用,按规定格式输出。
---

# Weather Reporter Skill (${v})

${fmt}
穿衣建议必须先读 \`references/${REF_REL}\`,严格按其中的分级给。
SKILL_VERSION_MARKER=${v}
`;
}
function referenceMd(v: 'v1' | 'v2'): string {
  return v === 'v1'
    ? `# 穿衣指南 (v1)\n\n- ≥ 28℃:短袖\n- 10~27℃:外套\n- < 10℃:厚外套\nREF_VERSION_MARKER=v1\n`
    : `# 穿衣指南 (v2)\n\n- ≥ 30℃:短袖+防晒\n- 15~29℃:长袖\n- < 15℃:厚外套+围巾(本版新增"围巾")\nREF_VERSION_MARKER=v2\n`;
}

// ── 记录型虚拟 FS:拦截对 SKILL.md / reference 的 readFile,记下版本与时间 ─────────
interface ReadLog { kind: 'SKILL.md' | 'reference'; version: string; atMs: number; afterChange: boolean }
class RecordingFS extends MastraVirtualFileSystem {
  startAt = 0;          // generate 开始时刻(ms)
  changedAt = Infinity; // skill 被改成 v2 的时刻(ms)
  reads: ReadLog[] = [];

  override async readFile(p: string, options?: ReadOptions): Promise<string | Buffer> {
    const res = await super.readFile(p, options);
    const path = String(p);
    const kind = path.endsWith('SKILL.md') ? 'SKILL.md' : path.endsWith(REF_REL) ? 'reference' : undefined;
    if (kind && this.startAt) {
      const text = Buffer.isBuffer(res) ? res.toString('utf-8') : String(res);
      const version = text.match(/_VERSION_MARKER=(\w+)/)?.[1] ?? '(none)';
      const now = Date.now();
      this.reads.push({ kind, version, atMs: now - this.startAt, afterChange: now >= this.changedAt });
    }
    return res;
  }
}

async function main() {
  const keyEnvVar = resolveApiKeyEnvVar(PROVIDER_ID);
  if (!MODEL || (keyEnvVar && !process.env[keyEnvVar])) {
    console.error(
      `❌ 需要 MODEL + 对应 key。请 cp .env.example .env 并填好(同 agent-demo)。\n` +
        `   当前 MODEL=${MODEL || '(空)'}${keyEnvVar ? `,需要 ${keyEnvVar}` : ''}`,
    );
    process.exit(1);
  }
  console.log(`🧩 MODEL=${MODEL};CHANGE_AFTER_MS=${CHANGE_AFTER_MS}`);

  const fs = new RecordingFS({ debug: false });
  fs.seedSkill(SKILL_DIR, skillMd('v1'), { [REF_REL]: referenceMd('v1') });
  const workspace = new Workspace({ filesystem: fs, skills: [SKILL_DIR] });
  const agent = new Agent({
    id: 'weather-agent-change',
    name: 'weather-agent-change',
    instructions: '你是天气播报助手。回答前先用 load_skill 加载 weather-reporter,并严格按它当前的格式输出。',
    model: MODEL,
    workspace,
  });

  const userMsg = '合肥今天最高 12℃、最低 6℃、晴、微风。帮我播报天气。';

  // ─────────────────── 第一轮:generate 跑到一半时改 skill ───────────────────
  console.log('\n════════ 第一轮:generate 进行中修改 skill ════════');
  console.log('🧑 用户:', userMsg);
  fs.reads.length = 0;
  fs.startAt = Date.now();
  fs.changedAt = Infinity;

  // 关键:不 await,先把 generate 跑起来;再用 setTimeout 在它"跑到一半"时改 skill。
  const genPromise = agent.generate(userMsg, { maxSteps: 12 });
  const changeTimer = setTimeout(() => {
    fs.changedAt = Date.now();
    fs.seedSkill(SKILL_DIR, skillMd('v2'), { [REF_REL]: referenceMd('v2') });
    console.log(`🔧 [t=${fs.changedAt - fs.startAt}ms] 运行中:把 skill 改成 v2(四行格式 + reference 新增"围巾")`);
  }, CHANGE_AFTER_MS);

  const r1 = await genPromise;
  clearTimeout(changeTimer);
  console.log('\n🤖 第一轮回答:\n' + (r1.text ?? '').trim());
  printReads('第一轮', fs.reads);

  // ─────────────────── 第二轮:不再改,直接再问一次 ───────────────────
  console.log('\n════════ 第二轮:skill 已是 v2,再问一次(看是否完全切到 v2) ════════');
  // 真实 generate 一轮就好几秒,这里再确保过了陈旧检查的 2s 冷却。
  await sleep(2200);
  fs.reads.length = 0;
  fs.startAt = Date.now();
  fs.changedAt = 0; // 本轮所有读都在"改之后"
  const r2 = await agent.generate(userMsg, { maxSteps: 12 });
  console.log('\n🤖 第二轮回答:\n' + (r2.text ?? '').trim());
  printReads('第二轮', fs.reads);

  console.log('\n════════ 结论 ════════');
  console.log(
    '  • SKILL.md(instructions):在 generate 第 0 步发现时就被缓存,本轮跑到一半再改也【不变】;\n' +
      '    所以第一轮通常仍是旧格式(三行),第二轮才完全切到新格式(四行)。\n' +
      '  • reference:每次现读。第一轮里若 agent 在"改之后"才读引用,就会读到 v2(可能出现"围巾");\n' +
      '    读发生在"改之前"则读到 v1 —— 看上面 reference 行的 [前/后改] 标记即可判断。\n' +
      '  • 想让运行中的 SKILL.md 改动完全生效:等下一轮 generate(本 SDK 目录 mtime 默认跟随内容,\n' +
      '    下一轮 step0 会重新发现)。',
  );
}

function printReads(label: string, reads: ReadLog[]) {
  console.log(`\n🔎 ${label} —— 对 skill 文件的 readFile 轨迹(底层走虚拟 FS):`);
  if (!reads.length) {
    console.log('  (无 —— 模型这轮没有读 skill 文件)');
    return;
  }
  for (const r of reads) {
    const when = r.afterChange ? '改之后' : '改之前';
    console.log(`  - [t=${String(r.atMs).padStart(5)}ms][${when}] ${r.kind.padEnd(9)} → ${r.version}`);
  }
  const refReads = reads.filter(r => r.kind === 'reference');
  if (refReads.length) {
    const after = refReads.filter(r => r.afterChange);
    if (after.length) console.log(`  → reference 在"改之后"被读到 ${after.map(r => r.version).join(',')}(现读,能拿到新内容)`);
  }
}

main().catch(err => {
  console.error('Demo 失败:', err);
  process.exit(1);
});
