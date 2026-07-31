/**
 * PersistentVirtualFileSystem × 真实 Agent 的端到端 demo(需要模型 key):
 *
 *   pnpm agent:persistent
 *
 * 讲一个完整的故事 —— 「调研助理」agent 的两次会话:
 *
 *   会话 1(进程 A):
 *     - seedSkill 挂「调研笔记」skill(SKILL.md + references,内存,不入库)
 *     - agent 回答问题,并按 skill 规定用 workspace 文件工具把结论写进 /notes/
 *       → 这些写操作走【写穿】,返回时已同步到持久化后端
 *
 *   「进程重启」(fsA 消失):
 *     - 用同一个后端 create() 新实例 → 笔记自动水合回来
 *     - skill 是派生数据(真相源在你手里),按约定【每次启动重新 seed】
 *
 *   会话 2(进程 B):
 *     - agent 读回上次的笔记回答「我们上次记了什么」
 *
 * 同时验证契约:后端里只有 /notes/**(写穿产物),没有 /skills/**(seed 不入库)。
 *
 * 运行前:apps/test/.env 里配 MODEL + 对应 provider key(同 pnpm agent)。
 */
import 'dotenv/config';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Agent } from '@mastra/core/agent';
import { Workspace } from '@mastra/core/workspace';
import {
  PersistentVirtualFileSystem,
  InMemoryVirtualFsPersistence,
  type VirtualFsPersistence,
} from 'mastra-virtual-fs';

const MODEL = process.env.MODEL ?? '';
const PROVIDER_ID = MODEL.split('/')[0];

function resolveApiKeyEnvVar(provider: string): string | undefined {
  const FALLBACK: Record<string, string> = {
    openrouter: 'OPENROUTER_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_API_KEY', groq: 'GROQ_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
  };
  try {
    const require = createRequire(import.meta.url);
    const regPath = join(dirname(require.resolve('@mastra/core/package.json')), 'dist', 'provider-registry.json');
    const { providers } = JSON.parse(readFileSync(regPath, 'utf8'));
    return providers?.[provider]?.apiKeyEnvVar ?? FALLBACK[provider];
  } catch {
    return FALLBACK[provider];
  }
}

// ── 「调研笔记」skill:指导 agent 把结论落盘到 /notes/ ─────────────────────
const SKILL_MD = `---
name: research-notes
description: 调研笔记 skill。当用户请你调研/分析/比较某个问题,或询问之前记过的笔记时使用。回答之后必须把结论存档,回看笔记时先读文件。
---

# Research Notes Skill

1. 回答用户的调研问题后,**必须**用文件写入工具把结论保存到 \`notes/<主题>.md\`
   (主题用简短英文 kebab-case,如 notes/http-cache.md)。
2. 笔记格式见 \`references/笔记格式.md\`,严格遵守。
3. 用户问「上次/之前记了什么」时:先用文件列表工具看 notes/ 下有什么,再读出来概括,不要凭记忆编造。
`;

const REFERENCES: Record<string, string> = {
  '笔记格式.md': `# 笔记格式

每份笔记三段,markdown:

## 结论
一句话结论。

## 依据
2-3 条要点。

## 存疑
还不确定的点(没有就写"无")。
`,
};

/** 每次「进程启动」都要做的装配:水合产物 + 重新 seed skill(skill 是派生数据,不入库) */
async function bootWorkspace(persistence: VirtualFsPersistence): Promise<{ fs: PersistentVirtualFileSystem; workspace: Workspace }> {
  const fs = await PersistentVirtualFileSystem.create({ scope: 'research-run-1', persistence });
  fs.seedSkill('/skills/research-notes', SKILL_MD, REFERENCES);
  const workspace = new Workspace({ filesystem: fs, skills: ['/skills/research-notes'] });
  return { fs, workspace };
}

function makeAgent(workspace: Workspace): Agent {
  return new Agent({
    id: 'research-agent',
    name: 'research-agent',
    // 「必须存档」写死在 instructions 里:skill 描述的是怎么存(格式/路径),
    // 而"存不存"是硬性要求——只放在 skill 里,模型可能答完就收工不去激活 skill。
    instructions:
      '你是调研助理。处理调研类问题的流程(缺一步都算没完成):\n' +
      '1. 激活 research-notes skill,按其规范作答;\n' +
      '2. 回答后【必须】用文件写入工具把结论按 skill 规定的格式保存到 notes/<主题>.md;\n' +
      '3. 用户回看笔记时,先列出并读取 notes/ 下的文件再概括。',
    model: MODEL,
    workspace,
  });
}

function printToolCalls(res: unknown): void {
  const r = res as any;
  const steps: any[] = r.steps ?? [];
  console.log('🔧 工具调用与结果:');
  for (const s of steps) {
    const calls: any[] = s.toolCalls ?? [];
    const results: any[] = s.toolResults ?? [];
    for (let i = 0; i < calls.length; i++) {
      const tc = calls[i];
      const name = tc.toolName ?? tc.payload?.toolName ?? tc.name ?? '(unknown)';
      const input = tc.args ?? tc.input ?? tc.payload?.args ?? tc.payload?.input ?? {};
      const tr = results[i];
      const rawOut = tr?.result ?? tr?.output ?? tr?.payload?.result ?? tr?.payload?.output;
      const out = typeof rawOut === 'string' ? rawOut : JSON.stringify(rawOut);
      console.log('   -', name, JSON.stringify(input).slice(0, 100));
      console.log('     ↳', String(out).slice(0, 220));
    }
  }
}

async function main() {
  const keyEnvVar = resolveApiKeyEnvVar(PROVIDER_ID);
  if (!MODEL || (keyEnvVar && !process.env[keyEnvVar])) {
    console.error(`❌ 需要 MODEL 与 ${keyEnvVar ?? '对应 provider key'}(apps/test/.env,同 pnpm agent)。`);
    process.exit(1);
  }
  console.log(`🧩 MODEL = ${MODEL}\n`);

  // 真实项目里换成你的 DB 实现(实现 VirtualFsPersistence 契约即可);demo 用内存实现代替
  const persistence: VirtualFsPersistence = new InMemoryVirtualFsPersistence();

  console.log('━━ 会话 1(进程 A):调研 + 按 skill 存档笔记 ━━━━━━━━━━━━━━━━━');
  const a = await bootWorkspace(persistence);
  console.log('skills:', (await a.workspace.skills!.list()).map(s => s.name));
  const q1 = '简单调研一下:HTTP 强缓存和协商缓存的区别?记得按规范存档笔记。';
  console.log('🧑', q1);
  const res1 = await makeAgent(a.workspace).generate(q1, { maxSteps: 16 });
  console.log('🤖', (res1.text ?? '').trim().slice(0, 400), '\n');
  printToolCalls(res1);

  const persisted = await persistence.load('research-run-1');
  console.log('📀 后端持久化的行(注意:只有写穿产物,没有 seed 的 /skills/**):');
  for (const row of persisted) console.log('   -', row.path, `(${row.content.length}字)`);
  if (!persisted.some(r => r.path.startsWith('notes/'))) {
    console.log('   ⚠️ agent 没有写笔记(模型没调文件工具)——换个模型或重跑一次');
  }

  console.log('\n━━ 「进程重启」:fsA 消失,同一后端水合 + 重新 seed skill ━━━━━━');
  const b = await bootWorkspace(persistence);
  const files = await b.fs.readdir('/', { recursive: true });
  console.log('恢复后的内存文件树:', files.filter(f => f.type === 'file').map(f => f.name));

  console.log('\n━━ 会话 2(进程 B):回看上次的笔记 ━━━━━━━━━━━━━━━━━━━━━━━');
  const q2 = '我们上次记了什么笔记?概括一下。';
  console.log('🧑', q2);
  const res2 = await makeAgent(b.workspace).generate(q2, { maxSteps: 16 });
  console.log('🤖', (res2.text ?? '').trim().slice(0, 400));
  printToolCalls(res2);

  await b.fs.flush();
  console.log('\n✅ persistent agent demo 完成。');
}

main().catch(err => {
  console.error('demo 失败:', err);
  process.exit(1);
});
