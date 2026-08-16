# DSH 插件生态兼容方案

> 在 Polaris 中嵌入 Cordis 运行时，直接加载运行 `@deepseek-ai/dsh-*` 插件。
> 与现有 Polaris 插件系统（plugin.json + MCP server）并行共存。

## 1. 背景

### 1.1 为什么要兼容 DSH 插件

DSH（DeepSeek Harness）拥有 **219 个 npm 包**，全部以 `@deepseek-ai/` 前缀发布在 npm 上，基于 Cordis 框架（v4.0.1）构建了完整的"一切皆插件"生态。其核心能力：

- `@deepseek-ai/dsh-tool-cordis`：Agent 运行时自省 + 动态定义/挂载插件（Polaris 没有的能力）
- `@deepseek-ai/dsh-mcp-client`：MCP 客户端桥接（Polaris 已有等效）
- `@deepseek-ai/dsh-tool-bash` / `@deepseek-ai/dsh-tool-fs`：模型-facing 工具
- `@deepseek-ai/dsh-client-ui-*`：UI 组件（slot 注册、ConversationNode 渲染器）
- `@deepseek-ai/dsh-agent-loop` / `@deepseek-ai/dsh-workflow`：agent 循环与工作流引擎

### 1.2 兼容性分级

| 级别 | 范围 | 可行性 |
|---|---|---|
| MCP 互通 | 任何通过 MCP server 暴露能力的插件 | ✅ 已实现（Polaris 已有完整 MCP 客户端） |
| Level 1 | 纯前端 Cordis 插件（不依赖后端能力） | ✅ 可行（嵌入 Cordis 运行时即可） |
| Level 2 | 依赖 DSH 服务接口的插件（tools/shell/fs/llm/agent 等） | ⚠️ 需桥接每个接口到 Polaris 后端 |
| Level 3 | 全部 219 个包 | ❌ 不现实（工程量 = 重写 DSH 大部分） |

### 1.3 设计原则

- **不替代**现有 Polaris 插件系统（plugin.json + MCP server），**并行共存**
- **渐进式**：先验证纯前端 Cordis 插件，再桥接核心服务接口
- **按需桥接**：只桥接 Polaris 已有的能力，DSH 独有的能力（sandbox/workflow/jobs）暂不实现，插件降级
- **MCP 优先**：DSH 的 MCP 类插件走 Polaris 现有 MCP 路径，不走 Cordis 路径

## 2. DSH 插件形态

### 2.1 标准 Cordis Plugin

```ts
import { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'          // 插件名（Cordis 加载器用）
export const inject = ['tools', 'shell']  // 声明依赖哪些 ctx 服务

export function apply(ctx: Context) {    // 插件入口
  // 注册工具
  ctx.tools.register(defineTool({ ... }))

  // 监听事件
  ctx.on('agent/pre-step', async (..., next) => { ... })

  // 可逆效应
  ctx.effect(() => {
    // 注册逻辑
    return () => { /* 清理逻辑 */ }
  })
}
```

### 2.2 依赖结构

```
@deepseek-ai/dsh-tool-bash
  peerDependencies:
    @deepseek-ai/cordis           ← Cordis 框架（必须）
    @deepseek-ai/dsh-tools        ← 工具注册表接口
    @deepseek-ai/dsh-shell        ← shell 能力接口
    @deepseek-ai/dsh-agent        ← agent 接口
    @deepseek-ai/dsh-llm          ← LLM 接口
    @deepseek-ai/dsh-sandbox      ← 沙箱接口（可选）
    @deepseek-ai/dsh-jobs         ← 后台任务接口（可选）
    ... 共 12 个 peerDep
```

### 2.3 插件分类

| 分类 | 特点 | 示例 |
|---|---|---|
| **Service Definition** | 纯接口定义，无实现 | `dsh-fs`、`dsh-shell`、`dsh-compaction` |
| **Service Provider** | 实现接口，依赖后端能力 | `dsh-fs-local`、`dsh-bash-local`、`dsh-compaction-basic` |
| **Consumer** | 消费接口，面向模型或 UI | `dsh-tool-fs`、`dsh-tool-bash`、`dsh-tool-workflow` |
| **UI Plugin** | 纯前端，注册 slot/ConversationNode | `dsh-client-ui-*` |
| **Bridge** | 适配外部协议 | `dsh-mcp-client`、`dsh-hooks-claude-code` |

## 3. 架构设计

### 3.1 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│  Polaris 应用（Tauri）                                            │
├──────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────┐        │
│  │  Polaris 插件系统（现有）                              │        │
│  │  plugin.json + MCP server + 面板 JS                  │        │
│  └──────────────────────────────────────────────────────┘        │
│                                                                │
│  ┌──────────────────────────────────────────────────────┐        │
│  │  DSH 插件兼容层（新增）                              │        │
│  │                                                        │        │
│  │  ┌──────────────────────────────────────────────────┐  │        │
│  │  │  Cordis 运行时（@deepseek-ai/cordis）             │  │        │
│  │  │  - Context 实例                                   │  │        │
│  │  │  - 插件加载器（动态 import + apply）              │  │        │
│  │  │  - 可逆效应管理                                  │  │        │
│  │  └──────────────────────┬───────────────────────────┘  │        │
│  │                         │                               │        │
│  │  ┌──────────────────────▼───────────────────────────┐  │        │
│  │  │  DSH 服务桥接层                                   │  │        │
│  │  │  ctx.tools  →  Polaris ToolRegistry + McpClientPool│  │        │
│  │  │  ctx.shell  →  Rust ShellCapability trait         │  │        │
│  │  │  ctx.fs     →  Rust FileSystemCapability trait    │  │        │
│  │  │  ctx.llm    →  AIEngine trait + SimpleAIEngine    │  │        │
│  │  │  ctx.agent  →  SessionManager                     │  │        │
│  │  │  ...                                              │  │        │
│  │  └──────────────────────────────────────────────────┘  │        │
│  └──────────────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 Cordis 运行时

```ts
// src/dsh-compat/cordisHost.ts

import { Context } from '@deepseek-ai/cordis'
import type { PolarisPluginManifest } from '@/plugin-system/types'

/**
 * Polaris 内的 Cordis 运行时宿主。
 *
 * 管理一个 Cordis Context 实例，负责加载/卸载 DSH 插件。
 * 每个安装的 DSH 插件在此 Context 中挂载并管理生命周期。
 */
export class CordisHost {
  private ctx: Context
  private loadedPlugins = new Map<string, { dispose: () => void }>()

  constructor() {
    this.ctx = new Context()
    this.registerPolarisServices()
  }

  /**
   * 注册 Polaris 实现的 DSH 服务接口到 ctx。
   * 每个服务接口对应一个 @deepseek-ai/dsh-* 包的定义。
   */
  private registerPolarisServices() {
    // ctx.tools → Polaris ToolRegistry 桥接
    this.ctx.provide('tools', new PolarisToolBridge())
    // ctx.shell → Rust ShellCapability 桥接
    this.ctx.provide('shell', new PolarisShellBridge())
    // ctx.fs → Rust FileSystemCapability 桥接
    this.ctx.provide('fs', new PolarisFsBridge())
    // ... 更多服务按需桥接
  }

  /**
   * 加载一个 DSH 插件。
   * 动态 import 插件模块，调用其 apply(ctx)，注册可逆效应。
   */
  async loadPlugin(pluginId: string, modulePath: string): Promise<void> {
    const mod = await import(modulePath)
    const name = mod.name ?? pluginId
    const disposer = this.ctx.effect(() => {
      mod.apply(this.ctx)
      return () => { /* 清理逻辑 */ }
    })
    this.loadedPlugins.set(pluginId, { dispose: disposer })
  }

  /**
   * 卸载一个 DSH 插件。
   * 触发 Cordis 的可逆效应，自动清理所有注册。
   */
  unloadPlugin(pluginId: string): void {
    const plugin = this.loadedPlugins.get(pluginId)
    if (plugin) {
      plugin.dispose()
      this.loadedPlugins.delete(pluginId)
    }
  }
}
```

### 3.3 服务桥接模式

```ts
// src/dsh-compat/bridges/tools.ts

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { pluginRegistry } from '@/plugin-system/registry'

/**
 * DSH ctx.tools 接口的 Polaris 桥接实现。
 *
 * 把 DSH 插件的 ctx.tools.register() 调用桥接到
 * Polaris 的 ToolRegistry（最终走 McpClientPool 或 SimpleAI 的 ToolRegistry）。
 */
export class PolarisToolBridge {
  register(tool: ToolDefinition): void {
    // DSH 插件的工具 → Polaris 的工具注册
    // 走 McpClientPool 的 tool_specs 路由
    // 或注册到 SimpleAI 的 ToolRegistry
  }

  unregister(name: string): void {
    // 清理工具注册
  }

  get(name: string): ToolDefinition | undefined {
    return pluginRegistry.listToolProviderContributions()
      .find(p => p.capability === name) as any
  }
}
```

### 3.4 插件安装流程

```
用户安装 DSH 插件（npm 包）
  ↓
检测 package.json 是否有 @deepseek-ai/cordis peerDep
  ↓
是 → 标记为 DSH 插件
  ↓
npm install <package> 到 .polaris/plugins-dsh/
  ↓
CordisHost.loadPlugin(pluginId, path)
  ↓
动态 import() → 模块导出 name/inject/apply
  ↓
检查 inject 中的服务依赖是否已注册到 ctx
  ↓
全部就绪 → 调 apply(ctx) → 插件注册效应
  ↓
有未就绪依赖 → 挂起，等依赖就绪后激活
  ↓
插件卸载 → CordisHost.unloadPlugin() → 可逆效应自动清理
```

### 3.5 与现有插件系统的协作

```
┌──────────────────────────────────────────────────────────────┐
│  插件安装入口                                                  │
│  settings → 插件 → Install from npm / Install from directory │
│                              │                                │
│                    ┌─────────▼──────────┐                     │
│                    │ 检测 manifest 类型   │                     │
│                    └────┬─────────┬─────┘                     │
│                         │         │                           │
│               ┌─────────▼──┐  ┌───▼───────────┐              │
│               │ plugin.json│  │ package.json   │              │
│               │ (Polaris)  │  │ (DSH/Cordis)   │              │
│               └─────┬──────┘  └───┬───────────┘              │
│                     │             │                           │
│               ┌─────▼──────┐  ┌───▼───────────┐              │
│               │ 现有路径    │  │ CordisHost    │              │
│               │ MCP/面板/   │  │ 加载 + 桥接    │              │
│               │ 卡片/引擎   │  │ + 可逆注册     │              │
│               └────────────┘  └───────────────┘              │
└──────────────────────────────────────────────────────────────┘
```

## 4. 分阶段实施

### 阶段 1：嵌入 Cordis 运行时 + 加载纯前端 DSH 插件

**目标**：Polaris 前端能加载 `@deepseek-ai/cordis`，创建 ctx，挂载不依赖后端能力的 DSH 插件。

**工作**：
- [ ] `npm install @deepseek-ai/cordis` 到 Polaris 前端
- [ ] 创建 `src/dsh-compat/cordisHost.ts`：Context 初始化 + 插件加载/卸载
- [ ] 创建 `src/dsh-compat/bridges/`：服务桥接层
- [ ] 实现 `PolarisToolBridge`（桥接到 Polaris ToolRegistry 和 McpClientPool）
- [ ] 实现 `PolarisSystemPromptBridge`（桥接到 prompt 构建）
- [ ] 安装检测：检测 `package.json` 的 `@deepseek-ai/cordis` peerDep 标记为 DSH 插件
- [ ] 插件设置页：显示 DSH 插件的加载状态

**验证 demo**：
- [ ] 安装 `@deepseek-ai/dsh-tool-cordis`（自省工具，只读 ctx 状态，无后端依赖）
- [ ] 在 Chat 中调用 `cordis_inspect` 查看当前 ctx 注册的服务列表
- [ ] 卸载后效果消失（验证可逆效应）

**预估**：3-5 天

### 阶段 2：桥接核心能力（shell/fs）

**目标**：让依赖 `ctx.shell`、`ctx.fs` 的 DSH Consumer 插件可用。

**工作**：
- [ ] 实现 `PolarisShellBridge`（桥接到 Rust `ShellCapability` trait，经 Tauri IPC）
- [ ] 实现 `PolarisFsBridge`（桥接到 Rust `FileSystemCapability` trait，经 Tauri IPC）
- [ ] 为 `@deepseek-ai/dsh-shell` 的 `Shell` 接口写 TS 类型声明
- [ ] 为 `@deepseek-ai/dsh-fs` 的 `FileSystem` 接口写 TS 类型声明
- [ ] 验证 DSH 插件的 `ctx.shell.execute()` 调用经桥接到达 Rust 实现

**验证 demo**：
- [ ] 安装 `@deepseek-ai/dsh-tool-bash`（DSH 的 bash 工具，通过 ctx.shell 调用）
- [ ] 让 AI 执行 shell 命令 → 走 Polaris 的 ShellCapability 实现
- [ ] 安装 `@deepseek-ai/dsh-tool-fs`（DSH 的文件工具，通过 ctx.fs 调用）
- [ ] 让 AI 读写文件 → 走 Polaris 的 FileSystemCapability 实现

**预估**：3-5 天

### 阶段 3：桥接 LLM/Agent/Session

**目标**：让依赖 `ctx.llm`、`ctx.agent`、`ctx.session` 的 DSH 插件可用。

**工作**：
- [ ] 实现 `PolarisLlmBridge`（桥接到 `AIEngine` trait + `SimpleAIEngine`，经 Tauri IPC）
- [ ] 实现 `PolarisAgentBridge`（桥接到 `SessionManager`）
- [ ] 实现 `PolarisSessionBridge`（桥接到 `dialogStorage`）
- [ ] 为 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-session` 写 TS 类型声明
- [ ] 验证 DSH 插件的 LLM 流式请求经桥接到达 Polaris 引擎

**验证 demo**：
- [ ] 安装 `@deepseek-ai/dsh-agent-loop`（DSH 的 agent 循环，通过 ctx.agent 驱动）
- [ ] 在 Polaris 中用 DSH 的 agent loop 替代 SimpleAI 的 chat_loop
- [ ] 验证流式输出、工具调用、中断等基本功能

**预估**：5-8 天

### 阶段 4：按需补齐剩余能力

**目标**：按需桥接 `ctx.compaction`、`ctx.subagent`、`ctx.web`、`ctx.systemPrompt` 等剩余接口。

**工作**：
- [ ] 实现 `PolarisCompactionBridge`（桥接到 Rust `CompactionCapability` trait）
- [ ] 实现 `PolarisSubAgentBridge`（桥接到 Rust `SubAgentCapability` trait）
- [ ] 实现 `PolarisWebBridge`（桥接到 Polaris 的 `WebFetch`/`WebSearch` 服务）
- [ ] 实现 `PolarisStorageBridge`（桥接到 localStorage/IndexedDB）
- [ ] 实现 `PolarisSettingsBridge`（桥接到 Polaris 配置系统）

**不做**（Polaris 无等效能力，插件降级）：
- `ctx.sandbox`（Landlock 仅 Linux，Polaris 无沙箱等效）
- `ctx.workflow`（Polaris 无工作流引擎等效）
- `ctx.jobs`（Polaris 无后台任务调度等效）
- `ctx.goal`（Polaris 无目标管理系统等效）
- `ctx.schedule`（Polaris 无会话调度等效）

**验证 demo**：
- [ ] 安装 `@deepseek-ai/dsh-compaction-basic`（DSH 压缩引擎，通过 ctx.compaction 调用）
- [ ] 验证压缩行为与 Polaris 内置一致
- [ ] 安装 `@deepseek-ai/dsh-tool-subagent`（DSH 子代理工具，通过 ctx.subagent 调用）
- [ ] 验证子代理派发与 Polaris 内置一致

**预估**：5-7 天

## 5. 服务桥接接口定义

### 5.1 ctx.tools 桥接

```ts
// 对应的 @deepseek-ai/dsh-tools 接口
interface DshToolRegistry {
  register(tool: ToolDefinition, options?: { disposer?: () => void }): void
  unregister(name: string): void
  get(name: string): ToolDefinition | undefined
  guard(predicate: (tool: ToolDefinition) => boolean): void
  restrict(predicate: (tool: ToolDefinition) => boolean): void
}

// Polaris 桥接实现
class PolarisToolBridge implements DshToolRegistry {
  register(tool: ToolDefinition, options?: { disposer?: () => void }): void {
    // 映射到 Polaris 的 McpClientPool 或 ToolRegistry
    // 把 DSH 的 ToolDefinition 转换为 Polaris 的 tool spec 格式
  }

  unregister(name: string): void {
    // 从 McpClientPool 移除工具
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }
}
```

### 5.2 ctx.shell 桥接

```ts
// 对应的 @deepseek-ai/dsh-shell 接口
interface DshShell {
  execute(command: string, options?: ShellOptions): Promise<ShellResult>
  readonly type: ShellType
}

// Polaris 桥接实现
class PolarisShellBridge implements DshShell {
  async execute(command: string, options?: ShellOptions): Promise<ShellResult> {
    // 通过 Tauri IPC 调用 Rust ShellCapability::execute()
    // 经 invoke('capability_shell_execute', { command, workdir })
  }

  get type(): ShellType {
    // 返回 detect_shell() 的结果
  }
}
```

### 5.3 ctx.llm 桥接

```ts
// 对应的 @deepseek-ai/dsh-llm 接口（简化版）
interface DshLlm {
  stream(messages: Message[], options?: StreamOptions): AsyncIterable<Chunk>
  complete(messages: Message[], options?: CompleteOptions): Promise<Message>
}

// Polaris 桥接实现
class PolarisLlmBridge implements DshLlm {
  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<Chunk> {
    // 通过 Tauri IPC 调用 AIEngine trait
    // 把 DSH 的 Message 格式转换为 Polaris 的格式
    // 流式响应转换为 AsyncIterable
  }
}
```

## 6. 插件设置页 UI

### 6.1 DSH 插件管理面板

在现有设置页的插件 tab 中，增加 DSH 插件分类：

```
┌──────────────────────────────────────────────────────────────┐
│  设置 → 插件                                                  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Polaris 插件（plugin.json）                           │    │
│  │  ├── demo.shell-override  [启用] [卸载]                │    │
│  │  ├── marketplace              [启用] [卸载]            │    │
│  │  └── ...                                              │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  DSH 插件（Cordis / npm）                             │    │
│  │  ├── @deepseek-ai/dsh-tool-cordis  [加载] [卸载]      │    │
│  │  │    状态: 已加载 | 依赖就绪: 5/5                    │    │
│  │  ├── @deepseek-ai/dsh-tool-bash    [加载] [卸载]      │    │
│  │  │    状态: 挂起 | 依赖就绪: 2/3 (缺: ctx.sandbox)   │    │
│  │  └── [安装 DSH 插件] 输入 npm 包名: ______________   │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  [安装 DSH 插件...]  npm 包名                                 │
└──────────────────────────────────────────────────────────────┘
```

### 6.2 依赖就绪状态

DSH 插件声明 `inject: ['tools', 'shell', 'sandbox']`，Polaris 的 CordisHost 检查：

- 全部就绪 → 自动激活插件
- 部分就绪 → 显示挂起状态，标注缺失依赖
- 核心依赖缺失（tools/shell/fs）→ 提示用户无法使用
- 非核心依赖缺失（sandbox/workflow）→ 提示降级，插件可继续运行

## 7. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| **Cordis 版本兼容**：DSH 用的 `cordis@4.0.1` 是 vendored 版，npm 上可能不同 | 高 | 直接安装 `@deepseek-ai/cordis`（与 DSH 同一来源），版本由 DSH 发布控制 |
| **TypeScript 声明合并冲突**：DSH 插件和 Polaris 都扩展 Cordis Context | 中 | 用 `type {}` side-effect import 隔离，保持两套声明不冲突 |
| **peerDependencies 解析**：DSH 插件的 `@deepseek-ai/dsh-*` peerDep 版本要对齐 | 中 | 在 Polaris 提供这些包的 stub 实现，版本号匹配 DSH 发布版本 |
| **桥接语义差异**：桥接实现可能和 DSH 原版行为有细微差异 | 中 | 阶段 1 先做"能加载"，阶段 2+ 做"行为一致"，测试驱动 |
| **npm 依赖膨胀**：219 个包全装会爆炸 | 低 | 按需安装，只装用户实际使用的 DSH 插件 |
| **安全风险**：Cordis 插件在进程内运行，有权限访问 ctx | 中 | 与 Polaris 现有权限模型一致（permissions 声明式），不扩大信任边界 |

## 8. 与现有 Capability Seam 的关系

之前实施的 P1-P3（toolProviders、CapabilitySeam trait、UI Slot、样式注入）与 DSH 兼容层**不冲突**，而是互补：

```
P1 toolProviders  →  DSH 插件的 ctx.tools 桥接可复用此机制
P2 CapabilitySeam →  DSH 插件的 ctx.shell/fs 桥接到这些 Rust trait
P3 UI Slot        →  DSH 插件的 slot 注册可桥接到 Polaris slot 系统
P3 样式注入       →  DSH 插件的 CSS 注入可复用此机制
```

**统一后的插件能力图谱**：

```
Polaris 插件（plugin.json）        DSH 插件（Cordis）
├── MCP 工具                       ├── ctx.tools 注册
├── 面板 UI                        ├── ctx.layout slot 注册
├── 聊天卡片                       ├── ConversationNode 注册
├── AI 引擎                        ├── ctx.agent + ctx.llm 操作
├── 样式注入                       ├── 样式注入（桥接做）
├── 工具能力覆盖（toolProviders）   ├── ctx.shell/fs 经桥接
└── 后台服务                       └── 无等效（不桥接）
```

## 9. 验收标准

### 阶段 1 验收
- [ ] `@deepseek-ai/cordis` 可作为 npm 依赖安装到 Polaris
- [ ] `CordisHost` 可创建 Context、加载插件、卸载插件（可逆效应）
- [ ] `@deepseek-ai/dsh-tool-cordis` 可加载，`cordis_inspect` 可调用
- [ ] 插件设置页可显示 DSH 插件及其依赖状态
- [ ] 卸载 DSH 插件后，其注册的效应被清理

### 阶段 2 验收
- [ ] `@deepseek-ai/dsh-tool-bash` 可加载，bash 调用经桥接到 Rust ShellCapability
- [ ] `@deepseek-ai/dsh-tool-fs` 可加载，文件操作经桥接到 Rust FileSystemCapability
- [ ] 工具调用结果与 Polaris 内置工具一致（兼容性测试）

### 阶段 3 验收
- [ ] `@deepseek-ai/dsh-agent-loop` 可加载，替代 SimpleAI 的 chat_loop
- [ ] 流式输出、工具调用、中断功能正常
- [ ] 会话持久化正常

### 阶段 4 验收
- [ ] 按需桥接的接口（compaction/subagent/web）行为与 Polaris 内置一致
- [ ] 未桥接接口（sandbox/workflow/jobs）插件降级运行，不崩溃
- [ ] 现有 Polaris 插件不受影响

## 10. 名词对照

| DSH 术语 | 对应 Polaris 概念 |
|---|---|
| Cordis plugin | Cordis 插件（TS 模块，`name/inject/apply`） |
| Context (ctx) | Cordis 上下文（服务仓库 + 事件总线 + 可逆效应） |
| `ctx.effect()` | 可逆注册（注册时返回 disposer，卸载时回滚） |
| `ctx.on()` / `ctx.waterfall()` | 事件监听 / 中间件管线 |
| `ctx.provide(key, service)` | 服务注册 |
| `inject` | 声明依赖（服务就绪后才激活插件） |
| Service Definition | 接口定义（`@deepseek-ai/dsh-*` 包） |
| Service Provider | 接口实现（`@deepseek-ai/dsh-*-local` 包） |
| Consumer | 消费接口的模型工具或 UI |
| `cordis.yml` | DSH 的插件组合声明文件（类似 Polaris 的 `plugin.json`） |
| `dsh.bundle` | npm 包中声明插件的 manifest 字段 |
| slot | UI 可替换区域（sidebar/conversation/details 等） |
| ConversationNode | 聊天消息渲染器注册 |