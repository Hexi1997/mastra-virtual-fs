# mastra-virtual-fs (monorepo)

pnpm workspace,拆成两个 app:

| 路径 | 包名 | 说明 |
| --- | --- | --- |
| `apps/sdk` | `mastra-virtual-fs` | **SDK**(可发布):Mastra Workspace 的内存虚拟文件系统。含源码 + 单元/集成 smoke 测试。 |
| `apps/test` | `mastra-virtual-fs-test` | **端到端测试 app**(private):通过 `workspace:*` 依赖消费 SDK,把虚拟 FS 挂到真实 `Agent`。 |

`apps/test` 用包名 `import { MastraVirtualFileSystem } from 'mastra-virtual-fs'` 调用 SDK,
经 pnpm workspace 链接解析到 `apps/sdk` 的构建产物(`dist/`)。

## 快速开始

```bash
pnpm install        # 安装 + 链接 workspace 依赖
pnpm test           # 跑 SDK 的 smoke 测试(离线,无需 key)
pnpm demo           # build SDK → 跑端到端 skills demo(离线)
pnpm probe          # build SDK → 与真实 LocalFilesystem 对照
pnpm agent          # build SDK → 跑真实 Agent(需 key,见下)
```

根脚本里 `demo` / `probe` / `agent` 都会**先 build SDK** 再跑 test app(因为 test app 按包名解析到 `dist`)。

## 跑真实 Agent(需要任一 provider 的 key)

```bash
cd apps/test
cp .env.example .env   # 设置 MODEL + 对应 provider 的 key(不限于 OpenRouter)
cd ../.. && pnpm agent
```

## 各 app 文档

- SDK 的 API / 选项(含 `looseReferenceLookup` 兜底机制):见 [`apps/sdk/README.md`](apps/sdk/README.md)。

## 布局

```
.
├── pnpm-workspace.yaml
├── tsconfig.base.json          # 共享 compilerOptions
├── package.json                # 根:private,编排脚本
└── apps/
    ├── sdk/                    # mastra-virtual-fs(可发布)
    │   ├── src/index.ts
    │   ├── src/mastra-virtual-file-system.ts
    │   ├── test/smoke.ts
    │   ├── tsconfig.json / tsconfig.build.json
    │   └── package.json
    └── test/                   # mastra-virtual-fs-test(private)
        ├── src/agent-demo.ts   # 通过 'mastra-virtual-fs' 调用 SDK
        ├── src/skills-demo.ts
        ├── src/probe.ts
        ├── .env.example
        └── package.json
```
