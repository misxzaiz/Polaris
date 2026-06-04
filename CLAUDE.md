# Polaris — Claude Code 项目指南

> 本文件供 Claude Code 等 AI 工具快速理解项目架构、约定和开发流程。

## 项目概述

Polaris 是 Claude Code CLI 的非官方桌面 GUI 客户端，基于 Tauri 2.x (Rust) + React 19 + TypeScript + Vite 构建。提供 AI 对话、多会话管理、文件浏览、Git 操作、定时任务、Todo/需求管理、终端模拟等功能。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端框架 | React 19 + TypeScript 5.8 (strict mode) |
| 桌面壳 | Tauri 2.x (Rust, tokio async runtime) |
| 状态管理 | Zustand 5 (25+ stores) |
| 样式 | Tailwind CSS 3.4, 暗色主题，CSS 变量驱动 |
| 编辑器 | CodeMirror 6 (多语言支持) |
| Markdown | marked + react-markdown + rehype-highlight + KaTeX + Mermaid |
| 终端 | xterm.js 5 |
| 虚拟滚动 | react-virtuoso 4 |
| i18n | i18next (zh-CN 主语言, en-US) |
| 构建工具 | Vite 7 (前端), Cargo (后端) |
| Git 操作 | git2 (Rust libgit2 bindings) |
| 测试 | Vitest 4 + Testing Library + fast-check (property-based) |
| 代码规范 | ESLint 9 (flat config), Conventional Commits |

## 构建与开发命令

```bash
# 前端开发 (仅 Vite，无 Tauri)
pnpm run dev

# Tauri 开发 (含 Rust 后端，跳过 MCP 二进制构建)
pnpm run tauri:dev
pnpm run tauri:dev:win          # Windows 专用

# 构建
pnpm run build                   # 前端: tsc + vite build
pnpm run tauri:build             # 完整构建 (含 MCP 二进制)

# 测试
pnpm run test                    # Vitest watch 模式
pnpm run test:run                # 单次运行
pnpm run test:coverage           # 覆盖率报告

# 代码质量
pnpm run lint                    # ESLint 检查
pnpm run lint:fix                # ESLint 自动修复
pnpm run security:audit          # 安全审计
```

## 项目结构

```
polaris/
├── src/                          # 前端源码 (React + TypeScript)
│   ├── ai-runtime/               # AI 运行时抽象层
│   │   ├── base/                 #   CLI 引擎基类、会话基类
│   │   ├── tools/                #   工具实现
│   │   ├── types/                #   工具类型定义
│   │   ├── engine.ts             #   引擎接口
│   │   ├── engine-registry.ts    #   引擎注册表
│   │   ├── event-bus.ts          #   事件总线 (单例，命名空间隔离)
│   │   ├── event.ts              #   事件类型定义 (判别联合 AIEvent)
│   │   ├── session.ts            #   会话管理
│   │   └── task.ts               #   任务管理
│   │
│   ├── assistant/                # 内置 AI 助手模块 (编排引擎)
│   │   ├── components/           #   AssistantChat, AssistantPanel 等
│   │   ├── core/                 #   AssistantEngine, ClaudeCodeSessionManager
│   │   ├── store/                #   assistantStore (Zustand)
│   │   └── types/                #   助手类型定义
│   │
│   ├── components/               # React UI 组件 (22 个目录)
│   │   ├── Chat/                 #   聊天界面 + 输入框 (@引用/代码片段)
│   │   ├── Editor/               #   CodeMirror 6 编辑器
│   │   ├── FileExplorer/         #   文件浏览器 (Git 集成)
│   │   ├── GitPanel/             #   Git 操作面板
│   │   ├── Mcp/                  #   MCP 配置 UI
│   │   ├── Scheduler/            #   定时任务 UI
│   │   ├── Session/              #   会话管理 UI
│   │   ├── Settings/             #   设置页面
│   │   ├── Terminal/             #   xterm.js 终端
│   │   ├── TodoPanel/            #   Todo 管理 UI
│   │   ├── RequirementPanel/     #   需求管理 UI
│   │   └── ...                   #   其他组件
│   │
│   ├── core/                     # 核心业务逻辑
│   │   ├── engine-bootstrap.ts   #   引擎引导
│   │   ├── tool-bootstrap.ts     #   工具引导
│   │   └── models/               #   核心数据模型
│   │
│   ├── engines/                  # AI 引擎适配器
│   │   ├── claude-code/          #   Claude Code CLI 引擎
│   │   └── openai-protocol/      #   OpenAI 兼容 API 引擎
│   │
│   ├── hooks/                    # 自定义 React Hooks (16 个)
│   ├── i18n/                     # i18next 配置
│   ├── locales/                  # 翻译文件 (zh-CN, en-US, 各 19 命名空间)
│   ├── services/                 # 服务层
│   │   ├── tauri/                #   Tauri IPC 包装 (chatService, configService 等)
│   │   ├── workspaceReference.ts #   @引用解析 + 工作区 prompt 生成
│   │   ├── eventRouter.ts        #   事件路由
│   │   └── ...                   #   其他服务
│   │
│   ├── stores/                   # Zustand 状态管理 (25+ stores)
│   │   ├── conversationStore/    #   对话状态 (核心，含 sendMessage 管道)
│   │   ├── gitStore/             #   Git 状态 (slices: branch, commit, status 等)
│   │   └── ...                   #   其他 stores
│   │
│   ├── types/                    # TypeScript 类型定义 (25 个文件)
│   └── utils/                    # 工具函数 (cache, clipboard, markdown, logger 等)
│
├── src-tauri/                    # 后端源码 (Rust + Tauri)
│   ├── src/
│   │   ├── main.rs               # 应用入口
│   │   ├── lib.rs                # 主库 (应用初始化)
│   │   ├── ai/                   # AI 引擎集成 (Rust)
│   │   │   ├── engine/claude.rs  #   Claude 引擎适配器 (47KB)
│   │   │   ├── event_parser.rs   #   SSE 事件解析 (26KB)
│   │   │   ├── session.rs        #   会话管理
│   │   │   └── traits.rs         #   引擎 trait 定义
│   │   │
│   │   ├── commands/             # Tauri IPC 命令处理 (22 个文件)
│   │   │   ├── chat.rs           #   聊天命令 (60KB)
│   │   │   ├── git.rs            #   Git 命令
│   │   │   ├── scheduler.rs      #   定时任务命令
│   │   │   └── ...
│   │   │
│   │   ├── services/             # 后端服务
│   │   │   ├── git/              #   Git 操作 (branch, commit, diff, rebase 等)
│   │   │   ├── scheduler/        #   调度器 (存储、协议)
│   │   │   ├── todo_mcp_server.rs          # Todo MCP Server
│   │   │   ├── requirements_mcp_server.rs  # 需求 MCP Server
│   │   │   ├── scheduler_mcp_server.rs     # 调度器 MCP Server
│   │   │   ├── unified_*_repository.rs     # 统一数据层 (todo/requirement/scheduler)
│   │   │   └── ...
│   │   │
│   │   ├── models/               # Rust 数据模型 (13 个文件)
│   │   ├── integrations/         # 外部集成 (QQ Bot, 飞书, 钉钉桥接)
│   │   │   └── manager.rs        #   集成管理器 (84KB, 项目最大文件)
│   │   │
│   │   └── bin/                  # 独立 MCP Server 二进制入口
│   │       ├── polaris_todo_mcp.rs
│   │       ├── polaris_requirements_mcp.rs
│   │       └── polaris_scheduler_mcp.rs
│   │
│   └── Cargo.toml                # 应用、Web 入口和内置 MCP Server 二进制目标
│
├── docs/                         # 项目文档
├── docs-site/                    # VitePress 文档站
├── .polaris/                     # 应用运行数据 (MCP 配置、任务历史、todos)
└── .claude/                      # Claude Code 配置 (仅 settings)
```

## 代码约定

### TypeScript (前端)

- **路径别名**: `@/` 映射到 `./src/`
- **导出**: 全部使用命名导出，不使用 default export
- **状态管理**: Zustand store 格式为 `use<Domain>Store`，状态接口与 store 同文件
- **异步操作模式**: `set({ loading: true })` → try/catch → `set({ error: ... })` 或 `set({ data: ... })`
- **服务层**: `src/services/tauri/` 封装 Tauri `invoke()` 调用，store 不直接调用 `invoke()`
- **类型**: 每个领域一个文件 (`src/types/<domain>.ts`)，barrel re-export
- **组件**: Props 接口与组件同文件，使用 `useTranslation('namespace')` 国际化
- **日志**: 使用 `createLogger('模块名')` (from `src/utils/logger`)，**禁止直接使用 console.log**
- **ESLint 关键规则**:
  - `no-console: error` (仅允许 console.warn/error，logger.ts 例外)
  - `@typescript-eslint/no-explicit-any: warn`
  - `react-hooks/rules-of-hooks: error`
  - 测试文件中放宽 any 和 console 限制

### Rust (后端)

- **IPC 命令**: 每个领域一个文件 (`src-tauri/src/commands/<domain>.rs`)
- **序列化**: struct 使用 `#[serde(rename_all = "camelCase")]` 匹配前端命名
- **错误处理**: 统一使用 `crate::error::AppError` 和 `Result<T>`
- **MCP Server 模式**: JSON-RPC over stdio，tools/list + tools/call，workspace-aware
- **命名**: Rust 侧 snake_case，通过 serde camelCase 与前端对齐

### 通用约定

- **提交规范**: Conventional Commits (`type(scope): subject`)，header 最长 100 字符
- **国际化**: 所有用户可见文本通过 i18n 命名空间管理，zh-CN 为 fallback
- **事件系统**: 单例 EventBus，AIEvent 判别联合类型，所有事件携带 sessionId
- **命名空间 barrel**: 每个目录有 `index.ts` re-export

## 关键架构决策

1. **双引擎架构**: `engines/claude-code/` (CLI 模式) 和 `engines/openai-protocol/` (API 模式)，通过 `engine-registry.ts` 统一管理
2. **MCP Server 独立二进制**: Todo/Requirement/Scheduler 各自编译为独立 exe，通过 stdio JSON-RPC 与 Claude Code 通信
3. **上下文注入三通道**: `--append-system-prompt` (工作区信息) + `--system-prompt` (用户自定义) + `--add-dir` (额外目录)
4. **虚拟滚动 + 消息压缩**: Virtuoso 管理可见区域，离屏消息文本替换为占位符 (messageCompactor)
5. **LRU 缓存体系**: MarkdownRenderCache(20), streamingMdCache(30), highlightCache(50), diagramStates(30)
6. **集成管理器**: QQ Bot / 飞书 / 钉钉桥接统一在 integrations/manager.rs (84KB)

## 已知陷阱

- **不要合并两个 LRU 实现**: `src/utils/cache.ts` (带 TTL) 和 `src/utils/lru-cache.ts` (不带 TTL) 设计意图不同
- **messageCompactor 80% overlap debounce**: 不能删除，否则 compact/hydrate 会振荡
- **_lastCompactionRange 重置**: `setMessagesFromHistory` 加载新会话时必须重置
- **CodeMirror 暗色模式**: 需显式加载主题 CSS
- **integrations/manager.rs 84KB**: 项目最大文件，修改需格外谨慎
- **prompt_config.json**: 已定义模块/预设系统但前端代码未消费，修改时注意不要假设它已被使用
- **ContextMemoryStore**: Rust+TS 侧已实现 CRUD + token 预算管理，但 sendMessage 流程未接入

## CI 流水线

```
commitlint → security audit → lint → test (coverage) → build-check (tsc + vite) → tauri-build
```
- 触发: push/PR 到 main/master
- Node 20, Rust stable
- tauri-build 仅在 push 时运行 (PR 不跑)

## 环境要求

- Node.js >= 18
- Rust >= 1.70
- Claude Code CLI (使用 Claude 引擎时)
- pnpm 包管理器
