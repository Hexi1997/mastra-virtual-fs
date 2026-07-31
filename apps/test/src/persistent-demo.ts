/**
 * PersistentVirtualFileSystem 端到端 demo(离线,零 API key)。
 *
 *   pnpm demo:persistent
 *
 * 演示三件事:
 *   1. 写穿 —— 每次写操作返回时,内容已同步到持久化后端(这里用内存实现代替 DB,
 *      换成你自己的 VirtualFsPersistence 实现即是真 DB);
 *   2. 重启恢复 —— 「进程重启」后用同一个后端 create() 新实例,hydrate 读回全部内容;
 *   3. 挂 Workspace —— 与纯内存版一样直接当 workspace.filesystem 用。
 */
import { Workspace } from '@mastra/core/workspace';
import {
  PersistentVirtualFileSystem,
  InMemoryVirtualFsPersistence,
  type VirtualFsPersistence,
} from 'mastra-virtual-fs';

// 真实项目里换成你的 DB 实现,例如(PG 伪码):
//   const persistence: VirtualFsPersistence = {
//     load:    (scope)          => db.query('SELECT path, content, mime_type FROM agent_vfs_files WHERE scope=$1', [scope]),
//     upsert:  (scope, p, c, m) => db.query('INSERT ... ON CONFLICT (scope, path) DO UPDATE ...', [scope, p, c, m]),
//     remove:  (scope, p)       => db.query('DELETE ... WHERE scope=$1 AND path=$2', [scope, p]),
//     removeByPrefix: (s, pre)  => db.query('DELETE ... WHERE scope=$1 AND position($2 IN path)=1', [s, pre]),
//     removeScope: (scope)      => db.query('DELETE ... WHERE scope=$1', [scope]),
//   }
const persistence: VirtualFsPersistence = new InMemoryVirtualFsPersistence();

console.log('━━ 1) 「进程 A」:建沙盒、写产物(写穿) ━━━━━━━━━━━━━━━━━━━━');
const fsA = await PersistentVirtualFileSystem.create({ scope: 'run-42', persistence });
await fsA.writeFile('/plan.md', '- [x] batch-01\n- [ ] report\n', { recursive: true });
await fsA.appendFile('/trace.jsonl', '{"event":"batch-01 开始"}\n');
await fsA.appendFile('/trace.jsonl', '{"event":"batch-01 完成"}\n');
await fsA.writeFile('/findings/batch-01.md', '### R1 节奏拖沓(P1)\n', { recursive: true });

console.log('内存里的文件:', fsA.listAllPaths());
console.log('后端里的行  :', (await persistence.load('run-42')).map(r => `${r.path} (${r.content.length}字)`));
console.log('→ 每次写返回时后端已同步,两边必然一致\n');

console.log('━━ 2) 「进程重启」:新实例从后端水合,内容原样恢复 ━━━━━━━━━━━');
// fsA 随进程消失;同一个 scope + 同一个后端,create() 内部 hydrate 读回
const fsB = await PersistentVirtualFileSystem.create({ scope: 'run-42', persistence });
console.log('恢复的文件  :', fsB.listAllPaths());
console.log('plan.md     :', JSON.stringify(await fsB.readFile('/plan.md', { encoding: 'utf-8' })));
console.log('trace.jsonl :', JSON.stringify(await fsB.readFile('/trace.jsonl', { encoding: 'utf-8' })));
console.log('→ 恢复后照常读写,读依旧只走内存\n');

console.log('━━ 3) 挂到 Mastra Workspace(与纯内存版用法一致) ━━━━━━━━━━━━');
const workspace = new Workspace({ filesystem: fsB });
console.log('workspace.filesystem id =', workspace.filesystem?.getInfo().id);
console.log('→ agent 的通用文件工具(read/write/list)即操作这个沙盒\n');

console.log('━━ 4) 收尾:destroyPersisted 删除本 scope 的全部数据 ━━━━━━━━━━');
await fsB.destroyPersisted();
console.log('后端剩余行 :', await persistence.load('run-42'));
console.log('\n✔ demo 完成');
