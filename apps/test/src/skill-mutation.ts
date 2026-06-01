/**
 * 测试:`new Agent(...)` 之后、`agent.generate(...)`(异步)期间或之后修改 skill 内容,
 *       agent 还能不能读到「最新」的 skill?
 *
 * 背景(读 @mastra/core 源码得到的真实机制,见 chunk-FBQWISYN.js):
 *   - agent.generate() 在 stepNumber===0 时,会调用 `workspace.skills.maybeRefresh()`。
 *   - maybeRefresh 只有在「skills 路径变了」或「#isSkillsPathStale() 为真」时才重新发现 skill。
 *   - 陈旧判定比较的是 *skill 目录* 的 mtime 和上次发现时间。
 *
 *   本 SDK 的 MastraVirtualFileSystem 默认开启 `directoryMtimeFollowsContents`:
 *   reseed SKILL.md 会把所在目录及各级父目录的 mtime 顶到当下,于是上面的陈旧判定
 *   会判定「需要重新发现」=> 下一次 generate 默认就能读到新的 SKILL.md。
 *
 *   => 结论:
 *       (A) 默认配置:reseed SKILL.md 后,下一次 generate(maybeRefresh)能读到新的
 *           instructions/description;references 本来就每次现读,也是最新。
 *       (B) 若把 directoryMtimeFollowsContents 置 false(贴近 POSIX/LocalFilesystem):
 *           改写 SKILL.md 内容不再自动触发重新发现 => instructions 读不到新内容
 *           (references 仍每次现读);此时可用 workspace.skills.refresh() 或
 *           建 Workspace 时传 checkSkillFileMtime:true 来热更新 SKILL.md。
 *
 *   时序要点:陈旧判定有 2s 冷却(STALENESS_CHECK_COOLDOWN),且用「严格大于」比较
 *   mtime 与上次发现时间。所以本脚本在两次 maybeRefresh 之间先等过 2s 再 reseed,
 *   保证新 mtime 严格新于上次发现时间(真实 agent.generate 第一轮本就耗时数秒,天然满足)。
 *
 * 本脚本「不需要 API key」就能跑:它直接调用 agent.generate 内部用到的同一套
 * workspace.skills API(maybeRefresh / get / getReference),用断言把上述行为钉死。
 * 另带一个可选的「真·两轮 agent.generate」段落(设置 MODEL+key 后自动启用)。
 *
 * 运行:
 *   pnpm --filter mastra-virtual-fs build && pnpm --filter mastra-virtual-fs-test exec tsx src/skill-mutation.ts
 *   或在 apps/test 下:pnpm exec tsx src/skill-mutation.ts
 *   (可选真实模型:RUN_LIVE_AGENT=1 pnpm exec tsx src/skill-mutation.ts)
 */
import 'dotenv/config';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { Agent } from '@mastra/core/agent';
import { Workspace } from '@mastra/core/workspace';
import { MastraVirtualFileSystem } from 'mastra-virtual-fs';

const SKILL_DIR = '/skills/weather-reporter';
const SKILL_NAME = 'weather-reporter';

// ── 两个版本的 skill 内容:v1 用「三行格式」,v2 改成「四行格式 + 新分级」 ──────────
function skillMd(version: 'v1' | 'v2'): string {
  const fmt =
    version === 'v1'
      ? '输出必须是【三行】:城市天气 / 气温 / 建议。'
      : '输出必须是【四行】:城市天气 / 气温 / 风力 / 建议。';
  return `---
name: ${SKILL_NAME}
description: 天气播报 skill(${version})。当用户询问天气、气温、穿衣建议时使用。
---

# Weather Reporter Skill (${version})

${fmt}
穿衣分级见 \`references/穿衣指南.md\`。
SKILL_VERSION_MARKER=${version}
`;
}

function referenceMd(version: 'v1' | 'v2'): string {
  return version === 'v1'
    ? `# 穿衣指南 (v1)\n\n- ≥ 28℃:短袖\n- < 10℃:厚外套\nREF_VERSION_MARKER=v1\n`
    : `# 穿衣指南 (v2)\n\n- ≥ 30℃:短袖+防晒\n- 15~29℃:长袖\n- < 15℃:厚外套+围巾\nREF_VERSION_MARKER=v2\n`;
}

// ── 小工具:读 skill 的 instructions 和 reference,提取版本标记 ───────────────────
async function readState(ws: Workspace) {
  const skills = ws.skills!;
  const skill = await skills.get(SKILL_NAME);
  const ref = await skills.getReference(SKILL_NAME, 'references/穿衣指南.md');
  const instrMarker = skill?.instructions?.match(/SKILL_VERSION_MARKER=(\w+)/)?.[1] ?? '(none)';
  const descMarker = skill?.description?.match(/\((v\d)\)/)?.[1] ?? '(none)';
  const refMarker = ref?.match(/REF_VERSION_MARKER=(\w+)/)?.[1] ?? '(none)';
  return { instrMarker, descMarker, refMarker };
}

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}\n     ${detail}`);
}

// ── 场景 A:默认 Workspace(checkSkillFileMtime 未开) ───────────────────────────
async function scenarioDefault() {
  console.log('\n════════ 场景 A:默认 Workspace(directoryMtimeFollowsContents 默认开) ════════');
  const fs = new MastraVirtualFileSystem();
  fs.seedSkill(SKILL_DIR, skillMd('v1'), { '穿衣指南.md': referenceMd('v1') });
  const workspace = new Workspace({ filesystem: fs, skills: [SKILL_DIR] });

  // Agent 真的把 workspace 挂上(workspace.skills 就是 agent.generate 内部用的同一实例)。
  new Agent({
    id: 'weather-agent-a',
    name: 'weather-agent-a',
    instructions: '你是天气播报助手。',
    model: process.env.MODEL || 'openai/gpt-4o-mini', // 不发请求,仅用于构造
    workspace,
  });

  // ── 模拟「第一次 agent.generate」:generate 在 step0 会调 maybeRefresh,这里照做 ──
  await workspace.skills!.maybeRefresh();
  const s1 = await readState(workspace);
  console.log('  首次发现后读取:', s1);
  check(
    'A1 首次读取 = v1',
    s1.instrMarker === 'v1' && s1.refMarker === 'v1',
    `instructions=${s1.instrMarker}, reference=${s1.refMarker}`,
  );

  // ── 在 agent 已初始化、已 generate 过之后,修改 skill 内容(SKILL.md + reference) ──
  // 先等过 2s 冷却,并保证 reseed 的 mtime 严格新于上次发现时间(真实 generate 天然满足)。
  await sleep(2200);
  fs.seedSkill(SKILL_DIR, skillMd('v2'), { '穿衣指南.md': referenceMd('v2') });
  console.log('  >> (等过 2s 冷却后)已把 SKILL.md 和 reference 改成 v2');

  // ── 模拟「第二次 agent.generate」:再次 maybeRefresh,再读 ─────────────────────
  await workspace.skills!.maybeRefresh();
  const s2 = await readState(workspace);
  console.log('  第二次 generate 后读取:', s2);

  check(
    'A2 reference 改动【能】被读到(每次现读)',
    s2.refMarker === 'v2',
    `reference=${s2.refMarker}(期望 v2)`,
  );
  check(
    'A3 SKILL.md 改动【也能】被读到(目录 mtime 跟随内容 → maybeRefresh 重新发现)',
    s2.instrMarker === 'v2' && s2.descMarker === 'v2',
    `instructions=${s2.instrMarker}, description=${s2.descMarker}(期望 v2)`,
  );
}

// ── 场景 B:directoryMtimeFollowsContents:false(贴近 POSIX,改内容不自动热更新) ──
async function scenarioStrict() {
  console.log('\n════════ 场景 B:directoryMtimeFollowsContents: false(严格模式) ════════');
  const fs = new MastraVirtualFileSystem({ directoryMtimeFollowsContents: false });
  fs.seedSkill(SKILL_DIR, skillMd('v1'), { '穿衣指南.md': referenceMd('v1') });
  const workspace = new Workspace({ filesystem: fs, skills: [SKILL_DIR] });

  await workspace.skills!.maybeRefresh();
  const s1 = await readState(workspace);
  check('B1 首次读取 = v1', s1.instrMarker === 'v1', `instructions=${s1.instrMarker}`);

  await sleep(2200);
  fs.seedSkill(SKILL_DIR, skillMd('v2'), { '穿衣指南.md': referenceMd('v2') });
  console.log('  >> (等过 2s 冷却后)已把 SKILL.md 和 reference 改成 v2');

  await workspace.skills!.maybeRefresh();
  const s2 = await readState(workspace);
  console.log('  第二次 generate(maybeRefresh)后读取:', s2);
  check(
    'B2 严格模式:改写 SKILL.md 内容【读不到】(目录 mtime 不跟随内容)',
    s2.instrMarker === 'v1' && s2.descMarker === 'v1',
    `instructions=${s2.instrMarker}, description=${s2.descMarker}(仍是 v1)`,
  );
  check(
    'B3 严格模式:reference 仍【能】读到(getReference 每次现读)',
    s2.refMarker === 'v2',
    `reference=${s2.refMarker}(期望 v2)`,
  );

  // 逃生口:手动 refresh() 强制重新发现 → 读到 v2
  await workspace.skills!.refresh();
  const s3 = await readState(workspace);
  check(
    'B4 严格模式下手动 workspace.skills.refresh() 后 SKILL.md = v2',
    s3.instrMarker === 'v2' && s3.descMarker === 'v2',
    `instructions=${s3.instrMarker}, description=${s3.descMarker}(期望 v2)`,
  );
}

// ── 可选:真·两轮 agent.generate(需 MODEL + 对应 key,且 RUN_LIVE_AGENT=1) ──────
function resolveApiKeyEnvVar(provider: string): string | undefined {
  const FALLBACK: Record<string, string> = {
    openrouter: 'OPENROUTER_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_API_KEY', groq: 'GROQ_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
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

async function scenarioLiveAgent() {
  const MODEL = process.env.MODEL ?? '';
  const provider = MODEL.split('/')[0];
  const keyEnvVar = resolveApiKeyEnvVar(provider);
  if (!MODEL || (keyEnvVar && !process.env[keyEnvVar])) {
    console.log('\n(跳过场景 C:真实模型两轮调用 —— 未配置 MODEL/对应 key)');
    return;
  }
  console.log(`\n════════ 场景 C:真·两轮 agent.generate(MODEL=${MODEL}) ════════`);
  const fs = new MastraVirtualFileSystem();
  fs.seedSkill(SKILL_DIR, skillMd('v1'), { '穿衣指南.md': referenceMd('v1') });
  // 默认配置即可:目录 mtime 跟随内容,第二轮 generate 内部的 maybeRefresh 会拉到 v2
  const workspace = new Workspace({ filesystem: fs, skills: [SKILL_DIR] });
  const agent = new Agent({
    id: 'weather-agent-live', name: 'weather-agent-live',
    instructions: '你是天气播报助手。回答前先用 load_skill 加载 weather-reporter,并严格按它的格式输出。',
    model: MODEL, workspace,
  });

  const q = '合肥今天最高 12℃、最低 6℃、晴、微风。帮我播报。';
  console.log('🧑 第一轮:', q);
  const r1 = await agent.generate(q, { maxSteps: 12 });
  console.log('🤖 第一轮回答:\n' + (r1.text ?? '').trim());

  // 两轮之间修改 skill
  fs.seedSkill(SKILL_DIR, skillMd('v2'), { '穿衣指南.md': referenceMd('v2') });
  console.log('\n  >> 两轮之间把 skill 改成 v2(四行格式)');
  await sleep(2200);

  console.log('🧑 第二轮:', q);
  const r2 = await agent.generate(q, { maxSteps: 12 });
  console.log('🤖 第二轮回答:\n' + (r2.text ?? '').trim());
  console.log('  (观察第二轮是否变成「四行」格式 —— 模型行为非确定性,以场景 A/B 的断言为准)');
}

async function main() {
  await scenarioDefault();
  await scenarioStrict();
  await scenarioLiveAgent();

  console.log('\n════════ 结论 ════════');
  const failed = results.filter(r => !r.pass);
  for (const r of results) console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}`);
  console.log(
    '\n要点:\n' +
      '  • reference 内容:改完【立刻】能读到(getReference 每次现读)。\n' +
      '  • SKILL.md 正文/描述:默认配置下,reseed 后下一次 generate【也能】读到新内容\n' +
      '    (本 SDK 的目录 mtime 默认跟随其下内容 → 触发 maybeRefresh 重新发现)。\n' +
      '  • 若把 directoryMtimeFollowsContents 置 false(贴近 POSIX):改写 SKILL.md 内容不再\n' +
      '    自动热更新,此时用 workspace.skills.refresh() 或建 Workspace 时传 checkSkillFileMtime:true。',
  );
  if (failed.length) {
    console.error(`\n❌ ${failed.length} 项断言未通过`);
    process.exit(1);
  }
  console.log('\n✅ 全部断言通过。');
}

main().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
