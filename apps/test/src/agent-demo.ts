/**
 * Agent Demo:把虚拟文件系统(MastraVirtualFileSystem)挂到一个真实 Agent 上,
 * 让 agent 在对话中自动发现并激活 skill、读取 references。
 *
 * 运行前:
 *   1. cp .env.example .env
 *   2. 在 .env 里设置 MODEL(完整 magic string)和对应 provider 的 API key
 *      例如:MODEL=openai/gpt-4o-mini                     + OPENAI_API_KEY
 *            MODEL=anthropic/claude-3-5-sonnet-latest     + ANTHROPIC_API_KEY
 *            MODEL=openrouter/openai/gpt-4o-mini          + OPENROUTER_API_KEY
 *   3. pnpm agent
 *
 * 对比文件系统:默认用本 SDK 的 MastraVirtualFileSystem(内存);
 *   加 USE_LOCAL_FS=1 改用 Mastra 官方 LocalFilesystem 读磁盘 apps/test/workspace,
 *   两者 skill 内容一致 —— 自己跑几次对比模型表现:
 *     pnpm agent                  # 虚拟 FS
 *     USE_LOCAL_FS=1 pnpm agent   # 磁盘 FS
 *
 * 关键点:
 *   - Agent 的 `workspace` 字段(agent/types.d.ts)接受任意 Workspace;
 *     配了 skills 后,Mastra 会自动把 skill 工具注入 agent,并在系统消息里
 *     列出可用 skills。agent 读取 skill/reference 时,底层全部走我们的虚拟 FS。
 *   - 模型用 Mastra 的 magic string `provider/model`(provider 可带多段,如
 *     openrouter/openai/gpt-4o-mini)。Mastra 内置 122+ provider,每个 provider
 *     有自己的 key 环境变量;运行时按 MODEL 的 provider 自动选对应的 key。
 */
import 'dotenv/config';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Agent } from '@mastra/core/agent';
import { Workspace, LocalFilesystem } from '@mastra/core/workspace';
import { MastraVirtualFileSystem } from 'mastra-virtual-fs';

// 切换文件系统:USE_LOCAL_FS=1 → Mastra 官方 LocalFilesystem(读磁盘 apps/test/workspace);
// 默认 → 本 SDK 的 MastraVirtualFileSystem(内存,字符串 seed)。两者内容一致,方便你自己对比。
const USE_LOCAL_FS = false;

// MODEL 是完整 magic string。
const MODEL = process.env.MODEL ?? '';
// magic string 的第一段是 provider id(openai / anthropic / openrouter ...)。
const PROVIDER_ID = MODEL.split('/')[0];

/**
 * 解析某 provider 需要的 API key 环境变量名。
 * 优先读 Mastra 自带的 provider 注册表(覆盖全部内置 provider);拿不到则回退到小表。
 */
function resolveApiKeyEnvVar(provider: string): string | undefined {
  const FALLBACK: Record<string, string> = {
    openrouter: 'OPENROUTER_API_KEY',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_API_KEY',
    groq: 'GROQ_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    xai: 'XAI_API_KEY',
    cerebras: 'CEREBRAS_API_KEY',
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

// ── 1) 要"传过去"的 skill 内容(SKILL.md + references) ───────────────────
const SKILL_MD = `---
name: weather-reporter
description: 一个天气播报 skill。当用户询问任意城市的天气、气温、是否下雨、穿衣建议时使用此 skill，按规定格式输出。
---

# Weather Reporter Skill

当你需要播报天气时,严格遵循以下规则:

1. 输出格式必须是三行(下面 <> 里的内容要替换成实际值,不要照抄占位符):
   - 第一行:\`【<城市名>】天气:<晴/多云/雨...>\`(例如:【上海】天气:晴)
   - 第二行:\`气温:<最低>~<最高>℃\`
   - 第三行:\`建议:<一句话穿衣/出行建议>\`
2. 穿衣建议的分级标准见 \`references/穿衣指南.md\`,必须据此给建议。
3. 如果用户没给城市,先反问城市,不要编造。
`;

const REFERENCES: Record<string, string> = {
  '穿衣指南.md': `# 穿衣指南(按最高气温)

- ≥ 28℃:短袖、短裤,注意防晒
- 18~27℃:长袖 T 恤或薄外套
- 10~17℃:外套 + 长裤
- < 10℃:厚外套、保暖,注意添衣
`,
};

async function main() {
  const keyEnvVar = resolveApiKeyEnvVar(PROVIDER_ID);
  if (keyEnvVar && !process.env[keyEnvVar]) {
    console.error(
      `❌ MODEL=${MODEL}(provider: ${PROVIDER_ID})需要环境变量 ${keyEnvVar}。\n` +
        `   请先 \`cp .env.example .env\`,填入 ${keyEnvVar}(或换一个 MODEL)。`,
    );
    process.exit(1);
  }
  console.log(`🧩 MODEL = ${MODEL}(provider: ${PROVIDER_ID}${keyEnvVar ? `, key: ${keyEnvVar}` : ''})`);

  // ── 2) 建 FS + 挂 skill(按 USE_LOCAL_FS 切换实现,skill 内容两者一致) ──────
  let workspace: Workspace;
  if (USE_LOCAL_FS) {
    const workspaceDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'workspace');
    console.log(`📁 FS = LocalFilesystem(磁盘:${workspaceDir})`);
    workspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: workspaceDir }),
      skills: [join(workspaceDir, 'skills', 'weather-reporter')],
    });
  } else {
    console.log('🧠 FS = MastraVirtualFileSystem(内存,字符串 seed)');
    const filesystem = new MastraVirtualFileSystem({ debug: true });
    filesystem.seedSkill('/skills/weather-reporter', SKILL_MD, REFERENCES);
    workspace = new Workspace({ filesystem, skills: ['/skills/weather-reporter'] });
  }

  // 自检:确认 skill 能被读出来
  const listed = await workspace.skills!.list();
  console.log('✅ workspace 已加载 skills:', listed.map(s => s.name));
  console.log('');

  // ── 3) 创建 Agent,把 workspace 挂上去 ─────────────────────────────────
  const agent = new Agent({
    id: 'weather-agent',
    name: 'weather-agent',
    instructions: '你是天气播报助手。',
    model: MODEL,
    workspace,
  });

  // ── 4) 发起对话,观察 agent 自动激活 skill + 读 reference ────────────────
  const userMsg = '合肥今天最高气温 12℃,最低 6℃,晴。帮我播报天气。';
  console.log('🧑 用户:', userMsg);
  console.log('—— 以下日志中的 [MastraVirtualFileSystem] 行,证明读取走的是虚拟 FS ——\n');

  // maxSteps 要给足:agent 需要「激活 skill → 读 reference → 收尾输出」多步;
  // 步数太少会在工具调用中途用尽,导致没有最终文本(res.text 为空)。
  const res = await agent.generate(userMsg, { maxSteps: 12 });

  const r = res as any;
  const text = (res.text ?? '').trim();

  // 工具调用轨迹:兼容不同版本的字段形态(toolName/args,或嵌套在 .payload 下)。
  const toolCalls: any[] =
    r.toolCalls ?? (r.steps ?? []).flatMap((s: any) => s.toolCalls ?? []);

  if (text) {
    console.log('\n🤖 助手:\n' + res.text);
  } else {
    // 关键:没有最终文本时,把原因暴露出来,而不是静默空白。
    console.log('\n⚠️ 助手没有产出最终文本。诊断信息:');
    console.log('  finishReason :', r.finishReason ?? '(unknown)');
    console.log('  steps        :', (r.steps ?? []).length);
    console.log('  toolCalls    :', toolCalls.length);
    if (r.error) console.log('  error        :', r.error?.message ?? r.error);
    console.log(
      '  提示:finishReason 为 tool-calls/length 时,通常是 maxSteps 用尽,或模型只产出工具调用而没收尾;\n' +
        '       若 error 非空,则是生成过程本身报错(模型/网络/工具)。',
    );
  }

  if (process.env.DEBUG_TOOLCALLS && toolCalls[0]) {
    console.log('\n[DEBUG] toolCalls[0] keys =', Object.keys(toolCalls[0]));
    console.log('[DEBUG] toolCalls[0] =', JSON.stringify(toolCalls[0], null, 2));
  }
  if (toolCalls.length) {
    console.log('\n🔧 工具调用轨迹:');
    for (const tc of toolCalls) {
      const name = tc.toolName ?? tc.payload?.toolName ?? tc.name ?? '(unknown-tool)';
      const input = tc.args ?? tc.input ?? tc.payload?.args ?? tc.payload?.input ?? {};
      console.log('  -', name, JSON.stringify(input));
    }
  }
  console.log('\n✅ Agent demo 完成。');
}

main().catch(err => {
  console.error('Agent demo 失败:', err);
  process.exit(1);
});
