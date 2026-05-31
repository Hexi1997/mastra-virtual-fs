/**
 * Demo:用自定义的虚拟(内存)文件系统驱动 Mastra Workspace 的 skills。
 *
 * 场景:不想把 skill 落盘,而是把 SKILL.md 内容 + references/ 内容直接"传进去",
 * 让 agent 能像读本地 skill 一样读到它们。
 *
 * 运行:npm run demo
 */
import { Workspace } from '@mastra/core/workspace';
import { MastraVirtualFileSystem } from 'mastra-virtual-fs';

const agentName = 'research-agent';

// 1) 这些就是你"传过去"的内容 ——————————————————————————————
const SKILL_MD = `---
name: ${agentName}
description: 一个做主题调研的 skill,会给出调研步骤并引用参考资料。当用户需要系统性调研某主题时使用。
license: MIT
---

# Research Agent Skill

你是一个严谨的调研助手。执行调研时遵循以下步骤:

1. 先拆解问题,明确要回答的子问题。
2. 按 \`references/调研方法.md\` 里的方法收集信息。
3. 对关键结论做交叉验证(见 \`references/验证清单.md\`)。
4. 输出带引用的结论。
`;

const REFERENCES: Record<string, string> = {
  '调研方法.md': `# 调研方法

- 自上而下:先框架后细节
- 多源交叉:至少 3 个独立来源
- 记录出处:每条结论附链接
`,
  '验证清单.md': `# 验证清单

- [ ] 结论是否有至少 2 个独立来源?
- [ ] 是否区分了事实与观点?
- [ ] 是否标注了时间敏感性?
`,
};

async function main() {
  // 2) 创建虚拟文件系统,并把内容 seed 进去 —————————————————————————
  //    debug: true 会打印每一次底层 fs 调用,方便确认路径解析。
  const filesystem = new MastraVirtualFileSystem({ debug: true });

  // 用绝对路径 seed:'/skills/<agentName>/SKILL.md' + '/skills/<agentName>/references/*'
  filesystem.seedSkill(`/skills/${agentName}`, SKILL_MD, REFERENCES);

  console.log('虚拟 FS 中的文件:');
  for (const p of filesystem.listAllPaths()) console.log('  ', p);
  console.log('');

  // 3) 用这个虚拟 FS 创建 Workspace —————————————————————————————————
  //    skills 用绝对路径,保证无论 Workspace 是否相对 basePath 解析都指向同一处:
  //    path.resolve(任意base, '/skills/x') === '/skills/x'
  const workspace = new Workspace({
    filesystem,
    skills: [`/skills/${agentName}`],
  });
  console.log('');

  // 4) 通过 workspace.skills 读取(底层全部走我们的虚拟 FS)————————————
  const skillsApi = workspace.skills;
  if (!skillsApi) throw new Error('workspace.skills 未初始化');

  console.log('--- skills.list() ---');
  const list = await skillsApi.list();
  console.log(JSON.stringify(list, null, 2));

  console.log('\n--- skills.get("' + agentName + '") ---');
  const skill = await skillsApi.get(agentName);
  if (!skill) {
    console.log('未找到 skill');
  } else {
    console.log('name        :', skill.name);
    console.log('description :', skill.description);
    console.log('references  :', skill.references);
    console.log('instructions:\n' + skill.instructions);
  }

  console.log('\n--- skills.listReferences() ---');
  console.log(await skillsApi.listReferences(agentName));

  // 注意:getReference 的路径是相对 references/ 的,要带 'references/' 前缀
  // (这是 Mastra 的真实契约,已和 LocalFilesystem 对照确认)
  console.log('\n--- skills.getReference("references/调研方法.md") ---');
  console.log(await skillsApi.getReference(agentName, 'references/调研方法.md'));

  // 5) 顺便证明这个 FS 本身的读写能力(agent 写文件也会落到内存)————————
  console.log('\n--- 直接读写虚拟 FS ---');
  await filesystem.writeFile('/notes/todo.txt', 'hello virtual fs', { recursive: true });
  console.log('readFile /notes/todo.txt =>', await filesystem.readFile('/notes/todo.txt', { encoding: 'utf-8' }));
  console.log('readdir /skills/' + agentName + '/references =>',
    (await filesystem.readdir(`/skills/${agentName}/references`)).map(e => `${e.name}(${e.type})`));

  console.log('\n✅ Demo 完成:skills 内容完全来自内存,没有任何磁盘文件。');
}

main().catch(err => {
  console.error('Demo 失败:', err);
  process.exit(1);
});
