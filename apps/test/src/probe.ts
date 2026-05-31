import { Workspace, LocalFilesystem } from '@mastra/core/workspace';
import { MastraVirtualFileSystem } from 'mastra-virtual-fs';

const SKILL_MD = `---
name: research-agent
description: 对照测试 skill，需要系统调研时使用，至少20字以上的描述文本。
---
# body
`;

async function probe(label: string, fs: any, skillRoot: string) {
  const ws = new Workspace({ filesystem: fs, skills: [skillRoot] });
  const api = ws.skills!;
  console.log(`\n######## ${label} ########`);
  console.log('list =', JSON.stringify(await api.list()));
  const sk = await api.get('research-agent');
  console.log('skill.references =', JSON.stringify(sk?.references));
  console.log('listReferences =', JSON.stringify(await api.listReferences('research-agent')));
  console.log('readdir(references, recursive).name 形态 =',
    JSON.stringify((await fs.readdir(`${skillRoot}/references`, { recursive: true })).map((e: any) => e.name)));
  for (const p of ['method.md', 'references/method.md', '调研方法.md', 'sub/nested.md', 'references/sub/nested.md']) {
    const r = await api.getReference('research-agent', p);
    console.log(`getReference(${JSON.stringify(p)}) =>`, r === null ? 'null' : JSON.stringify(r.trim()));
  }
}

async function main() {
  // A) 真实 LocalFilesystem(磁盘),作为行为基准
  const fsDir = '/tmp/lfs-skill';
  await probe('LocalFilesystem (磁盘基准)', new LocalFilesystem({ basePath: fsDir }), `${fsDir}/skills/research-agent`);

  // B) 我们的虚拟 FS,seed 相同内容
  const mem = new MastraVirtualFileSystem();
  mem.seedSkill('/skills/research-agent', SKILL_MD, {
    'method.md': 'ascii ref content',
    '调研方法.md': 'cn ref content',
    'sub/nested.md': 'nested',
  });
  await probe('MastraVirtualFileSystem (内存)', mem, '/skills/research-agent');
}

main().catch(e => { console.error(e); process.exit(1); });
