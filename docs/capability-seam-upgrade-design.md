# Capability Seam 升级设计：Polaris 插件生态「一切皆插件」改造

> 基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 capability seam 设计思想，结合 Polaris 现有插件系统进行升级设计。

## 1. 背景与设计目标

### 1.1 当前状态

Polaris 已有完善的**进程外插件机制**（plugin.json + MCP server + 面板 JS），但**内置能力是硬编码的**：

| 能力 | 当前实现 | 是否可被插件替换 |
|---|---|---|
| shell 执行 | `SimpleAI` 内的 `BashTool` | ❌ |
| 文件系统 | `SimpleAI` 内的 `ReadFileTool`/`WriteFileTool`/`EditFileTool`/`SearchFilesTool`/`GlobTool` | ❌ |
| 压缩 | `src/utils/messageCompactor.ts` | ❌ |
| 会话存储 | `src/stores/sessionStoreManager.ts` + Rust `dialogStorage` | ❌ |
| subagent | `dispatchService.ts` + `dispatch_agent` 工具 | ❌ |
| AI 引擎 | `AIEngine trait` + `registry` | ✅ 已有 seam（`EngineId::Custom`） |
| provider 配置 | `PluginEngineProviderConfigContribution` | ✅ 已有 seam |
| MCP 工具 | `mcp_config_service.rs` + `McpClientPool` | ✅ 已有 seam |
| 面板 | `pluginPanelRegistry` + `panel.entry` | ✅ 已有 seam |
| 聊天卡片 | `chatCardRegistry` + `mcpServerId` + `tools` 匹配 | ✅ 已有 seam |

### 1.2 设计目标

1. **内置能力可替换**：插件可以声明 Provider 覆盖默认的 shell/fs/compaction/subagent 实现
2. **MCP 生态互通**：任何 DSH 或第三方 MCP server 零改动可被 Polaris 消费
3. **向后兼容**：默认实现保持当前行为，现有插件不受影响
4. **渐进式**：分 3 个 Phase，每个 Phase 独立可交付

### 1.3 设计原则

- **Seam 先行**：先定义抽象接口，再实现默认 Provider，最后开放给插件
- **MCP 作为事实协议层**：跨进程能力统一走 MCP，进程内能力走 Rust trait
- **声明式覆盖**：插件通过 `manifest.json` 声明式替换能力，而非编程式注册
- **零行为变更**：没有插件覆盖时，系统行为完全不变

## 2. 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        Polaris 应用                              │
├──────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────┐    │
│  │                 Capability Seam 层                        │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │    │
│  │  │ Shell    │  │ FileSystem│  │ Compaction│  │ SubAgent │  │    │
│  │  │::trait   │  │ ::trait  │  │ ::trait  │  │ ::trait  │  │    │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  │    │
│  └───────┼─────────────┼─────────────┼─────────────┼────────┘    │
│          │             │             │             │              │
│  ┌───────▼─────────────▼─────────────▼─────────────▼────────┐    │
│  │                   Provider 注册表                          │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │    │
│  │  │ Shell    │  │ FS       │  │ Compaction│  │ SubAgent │  │    │
│  │  │ 默认     │  │ 默认     │  │ 默认     │  │ 默认     │  │    │
│  │  │ (Rust)   │  │ (Rust)   │  │ (Rust)   │  │ (Rust)   │  │    │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │    │
│  │  ┌──────────┐  ┌──────────┐                               │    │
│  │  │ 插件Shell │  │ 插件FS   │  ← 插件可声明覆盖              │    │
│  │  │ (MCP)    │  │ (MCP)    │                               │    │
│  │  └──────────┘  └──────────┘                               │    │
│  └──────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                      Consumer 层                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │ 模型-facing   │  │ 面板 UI     │  │ 聊天卡片     │           │
│  │ 工具 (SimpleAI│  │ (React)     │  │ (React)     │           │
│  │ / PluginEngine)│  │             │  │             │           │
│  └──────────────┘  └──────────────┘  └──────────────┘           │
└──────────────────────────────────────────────────────────────────┘
```

## 3. Phase 1：MCP 统一化（1-2 周）

### 3.1 目标

把所有内置能力封装为 MCP server，让 SimpleAI 通过统一的 MCP client 消费工具，从而实现：
- 工具可被外部 MCP server 替换
- SimpleAI 的 `ToolRegistry` 不再需要硬编码内置工具
- DSH 生态的 MCP 插件零改动可用

### 3.2 现状分析

SimpleAI 的 `ToolRegistry` 目前通过 `with_builtins()` 硬编码注册了 11 个工具：

```rust
// src-tauri/src/ai/engine/simple_ai/tools/mod.rs - 当前
pub(super) fn with_builtins() -> Self {
    let mut tools: Vec<Box<dyn Tool>> = vec![
        Box::new(BashTool),        // shell 执行
        Box::new(ReadFileTool),    // 读文件
        Box::new(WriteFileTool),   // 写文件
        Box::new(ListDirectoryTool), // 列目录
        Box::new(EditFileTool),    // 编辑文件
        Box::new(SearchFilesTool), // 搜索文件内容
        Box::new(GlobTool),        // 文件匹配
        Box::new(ApplyPatchTool),  // 应用补丁
        Box::new(UpdatePlanTool),  // 更新计划
        Box::new(ReadSkillTool),   // 读取 skill
        Box::new(DispatchAgentTool), // 派发子代理
    ];
    // ...
}
```

这些工具走的是**直接函数调用**，不是 MCP 协议。替换方案是让它们走 `McpClientPool` 统一路由。

### 3.3 设计

#### 3.3.1 内置 MCP server 重构

将每个内置工具组封装为独立的 MCP server 进程，或通过 **in-process MCP 网关**（避免子进程开销）：

```
方案 A（推荐）：双层 MCP 网关
┌──────────────────────────────────────────────┐
│  SimpleAI                                     │
│  ┌──────────────────────────────────────────┐│
│  │  ToolRegistry                            ││
│  │  ┌────────────────────────────────────┐  ││
│  │  │  McpClientPool（统一路由层）          │  ││
│  │  │  mcp__polaris-bash__bash            │  ││
│  │  │  mcp__polaris-fs__read_file         │  ││
│  │  │  mcp__polaris-fs__write_file        │  ││
│  │  │  mcp__polaris-plan__update_plan     │  ││
│  │  │  mcp__polaris-subagent__dispatch    │  ││
│  │  └────────────────────────────────────┘  ││
│  └──────────────────────────────────────────┘│
│                    │                          │
│                    ▼                          │
│  ┌──────────────────────────────────────────┐│
│  │  In-process MCP 网关                      ││
│  │  （实现 MCP 协议内部路由，不启动子进程）     ││
│  │  分派到: bash() / fs() / plan() / ...     ││
│  └──────────────────────────────────────────┘│
└──────────────────────────────────────────────┘
```

**方案 A 说明**：
- `McpClientPool` 保持现有接口不变
- 新增 `InProcessMcpGateway`：实现 MCP JSON-RPC 协议，但内部路由到现有 Rust 函数
- 内置工具改为 MCP server 注册（`mcp__polaris-bash__bash`），而非 `ToolRegistry` 直接注册
- 外部 MCP server 走子进程（现有行为不变）
- 工具路由完全由 `McpClientPool` 统一管理

#### 3.3.2 工具 MCP 化映射

| 当前工具 | MCP server id | MCP 工具名 | 实现方式 |
|---|---|---|---|
| bash | `polaris-bash` | `bash` | in-process 网关 |
| read_file | `polaris-fs` | `read_file` | in-process 网关 |
| write_file | `polaris-fs` | `write_file` | in-process 网关 |
| edit_file | `polaris-fs` | `edit_file` | in-process 网关 |
| list_directory | `polaris-fs` | `list_directory` | in-process 网关 |
| search_files | `polaris-fs` | `search_files` | in-process 网关 |
| glob | `polaris-fs` | `glob` | in-process 网关 |
| apply_patch | `polaris-fs` | `apply_patch` | in-process 网关 |
| update_plan | `polaris-plan` | `update_plan` | in-process 网关 |
| read_skill | `polaris-skill` | `read_skill` | in-process 网关 |
| dispatch_agent | `polaris-subagent` | `dispatch_agent` | in-process 网关 |
| browser | `polaris-browser` | `browser` | 已有 MCP server |
| computer | `polaris-computer` | `computer` | 已有 MCP server |

#### 3.3.3 插件声明式覆盖

```json
// plugin.json 新增 contributes.toolProviders
{
  "id": "my-custom-shell",
  "contributes": {
    "toolProviders": [
      {
        "capability": "shell",     // 替换 "polaris-bash" server
        "mcpServerId": "my-bash",
        "description": "自定义 shell 执行器，带沙箱"
      },
      {
        "capability": "filesystem", // 替换 "polaris-fs" server
        "mcpServerId": "my-fs",
        "description": "自定义文件系统，带远程存储"
      }
    ],
    "mcpServers": [
      {
        "id": "my-bash",
        "transport": "stdio",
        "command": "node",
        "argsTemplate": ["{{pluginDir}}/mcp/bash-server.js"]
      },
      {
        "id": "my-fs",
        "transport": "stdio",
        "command": "node",
        "argsTemplate": ["{{pluginDir}}/mcp/fs-server.js"]
      }
    ]
  }
}
```

### 3.4 关键变更文件

| 文件 | 变更 |
|---|---|
| `src-tauri/src/ai/engine/simple_ai/tools/mod.rs` | `ToolRegistry::with_builtins()` 改为从 `McpClientPool` 加载默认工具 |
| `src-tauri/src/ai/engine/simple_ai/mcp.rs` | 新增 `McpClientPool` 的内置工具注册机制 |
| `src-tauri/src/ai/engine/simple_ai/tools/` | 每个工具文件保留，但改为 in-process MCP handler 而非 `Tool` trait |
| `src-tauri/src/services/mcp_config_service.rs` | 新增 `BuiltinMcpServerRegistry` 注册内置 MCP server |
| `src-tauri/src/models/plugin.rs` | `PluginManifestContributes` 新增 `tool_providers` 字段 |
| `src/plugin-system/types.ts` | `PluginManifestContributes` 新增 `toolProviders` 类型 |
| `src/plugin-system/registry.ts` | 新增 `registerToolProviders` 方法 |
| `src/plugin-system/mcp.ts` | `listEnabledPluginMcpServers` 考虑 toolProvider 覆盖优先级 |

### 3.5 验收标准

- [ ] `SimpleAI` 内置工具全部通过 MCP 路由（而非 `ToolRegistry` 直接调用）
- [ ] 没有插件时，工具行为完全不变
- [ ] 安装覆盖 `shell` 的插件后，bash 调用走插件 MCP server
- [ ] DSH 生态的 MCP server（如 `mcp-memory`）可直接在 Polaris 中安装使用
- [ ] 回退：卸载插件后自动恢复默认实现

## 4. Phase 2：Capability Seam 抽象（2-3 周）

### 4.1 目标

在 Rust 侧定义核心能力的 trait seam，实现内置能力可替换的架构。

### 4.2 Seam 定义

#### 4.2.1 Shell Seam

```rust
/// shell 能力抽象
/// 
/// 定义 shell 命令执行的核心操作，不依赖具体实现（本地/远程/沙箱）。
#[async_trait]
pub trait ShellCapability: Send + Sync {
    /// 执行 shell 命令，返回 stdout/stderr/exit_code
    async fn execute(&self, command: &str, workdir: Option<&str>, env: Option<HashMap<String, String>>) -> Result<ShellResult>;
    
    /// 返回当前 shell 类型描述（用于模型上下文注入）
    fn shell_type(&self) -> ShellType;
}

#[derive(Debug, Clone)]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone, Serialize)]
pub enum ShellType {
    GitBash { path: String },
    PowerShell,
    Cmd,
    Sh,
    Custom(String),
}
```

#### 4.2.2 FileSystem Seam

参考 DSH `@deepseek-ai/dsh-fs` 设计：

```rust
/// 文件系统能力抽象
#[async_trait]
pub trait FileSystemCapability: Send + Sync {
    /// 读文件
    async fn read_text(&self, path: &Path, signal: Option<&CancellationToken>) -> Result<String>;
    
    /// 写文件（原子写入）
    async fn write_text(&self, path: &Path, content: &str, signal: Option<&CancellationToken>) -> Result<()>;
    
    /// 编辑文件（文字替换）
    async fn edit_text(&self, path: &Path, old_text: &str, new_text: &str, signal: Option<&CancellationToken>) -> Result<()>;
    
    /// 列目录
    async fn list_directory(&self, path: &Path) -> Result<Vec<FsEntry>>;
    
    /// 文件搜索
    async fn search_files(&self, root: &Path, pattern: &str, signal: Option<&CancellationToken>) -> Result<Vec<SearchMatch>>;
    
    /// 文件 glob
    async fn glob(&self, root: &Path, pattern: &str, signal: Option<&CancellationToken>) -> Result<Vec<PathBuf>>;
    
    /// 应用补丁
    async fn apply_patch(&self, path: &Path, patch: &str, signal: Option<&CancellationToken>) -> Result<()>;
}

#[derive(Debug, Clone)]
pub struct FsEntry {
    pub name: String,
    pub path: PathBuf,
    pub kind: FsEntryKind,
    pub size: Option<u64>,
}

pub enum FsEntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone)]
pub struct SearchMatch {
    pub path: PathBuf,
    pub line: usize,
    pub column: usize,
    pub content: String,
}
```

#### 4.2.3 Compaction Seam

```rust
/// 压缩能力抽象
#[async_trait]
pub trait CompactionCapability: Send + Sync {
    /// 判断是否需要压缩
    async fn should_compact(&self, context: &CompactionContext) -> bool;
    
    /// 执行压缩，返回压缩后的摘要
    async fn compact(&self, context: &CompactionContext) -> Result<CompactionResult>;
}

pub struct CompactionContext {
    pub session_id: String,
    pub message_count: usize,
    pub total_tokens: usize,
    pub max_tokens: usize,
    pub messages: Vec<CompactionMessage>,
}

pub struct CompactionResult {
    pub summary: String,
    pub compressed_count: usize,
    pub saved_tokens: usize,
}
```

#### 4.2.4 SubAgent Seam

```rust
/// 子代理能力抽象
#[async_trait]
pub trait SubAgentCapability: Send + Sync {
    /// 派发子代理任务
    async fn dispatch(&self, task: SubAgentTask) -> Result<SubAgentResult>;
    
    /// 检查子代理状态
    async fn check_status(&self, task_id: &str) -> Result<SubAgentStatus>;
}

pub struct SubAgentTask {
    pub prompt: String,
    pub work_dir: Option<String>,
    pub model: Option<String>,
    pub mcp_servers: Vec<McpServerConfig>,
    pub max_depth: u32,
}

pub struct SubAgentResult {
    pub task_id: String,
    pub output: String,
    pub success: bool,
}
```

### 4.3 Provider 注册表

```rust
/// 能力提供者注册表
/// 
/// 管理每个 capability 的 Provider 链。
/// 默认 Provider = 当前硬编码实现。
/// 插件可声明覆盖 Provider，注册表按优先级选择。
pub struct CapabilityRegistry {
    shell: Vec<CapabilityProvider<dyn ShellCapability>>,
    filesystem: Vec<CapabilityProvider<dyn FileSystemCapability>>,
    compaction: Vec<CapabilityProvider<dyn CompactionCapability>>,
    subagent: Vec<CapabilityProvider<dyn SubAgentCapability>>,
}

/// 能力提供者（带优先级和来源）
pub struct CapabilityProvider<T: ?Sized> {
    pub provider: Arc<T>,
    pub priority: ProviderPriority,
    pub source: ProviderSource,
}

pub enum ProviderPriority {
    /// 默认内置实现
    Builtin,
    /// 插件声明覆盖
    PluginOverrides,
}

pub enum ProviderSource {
    Builtin,
    Plugin { plugin_id: String, manifest_version: String },
}
```

### 4.4 插件声明式 Provider 覆盖

```json
// plugin.json 新增 contributes.providers
{
  "id": "my-sandbox-shell",
  "contributes": {
    "providers": {
      "shell": {
        "capability": "shell",
        "mcpServerId": "sandbox-shell",        // 关联到 mcpServers 中同 id 的条目
        "description": "沙箱化的 shell 执行器"
      },
      "filesystem": {
        "capability": "filesystem",
        "mcpServerId": "s3-fs",
        "description": "S3 远程文件系统"
      }
    },
    "mcpServers": [
      {
        "id": "sandbox-shell",
        "transport": "stdio",
        "command": "node",
        "argsTemplate": ["{{pluginDir}}/mcp/sandbox-shell.js"]
      },
      {
        "id": "s3-fs",
        "transport": "stdio",
        "command": "node",
        "argsTemplate": ["{{pluginDir}}/mcp/s3-fs.js"]
      }
    ]
  }
}
```

### 4.5 Consumer 适配

Consumer 层（模型-facing 工具 / UI）通过 seam 调用，不依赖具体 Provider：

```rust
// SimpleAI 的 bash 工具改为通过 seam 调用
// 之前：
// let output = run_bash(command, ...);
// 
// 之后：
// let shell = ctx.capabilities.shell();
// let result = shell.execute(command, ...).await;
```

**Consumer 适配清单**：

| Consumer | 当前直接调用 | 改为通过 seam |
|---|---|---|
| `BashTool::execute()` | `run_bash()` 函数 | `ShellCapability::execute()` |
| `ReadFileTool::execute()` | `std::fs::read_to_string()` | `FileSystemCapability::read_text()` |
| `WriteFileTool::execute()` | `std::fs::write()` | `FileSystemCapability::write_text()` |
| `EditFileTool::execute()` | 文件读+替换+写 | `FileSystemCapability::edit_text()` |
| `Compaction` | `messageCompactor.ts` | `CompactionCapability::compact()` |
| `DispatchAgentTool` | `dispatchService.ts` | `SubAgentCapability::dispatch()` |

### 4.6 关键变更文件

| 文件 | 变更 |
|---|---|
| `src-tauri/src/ai/traits.rs` | 新增 `ShellCapability` / `FileSystemCapability` / `CompactionCapability` / `SubAgentCapability` trait |
| `src-tauri/src/capabilities/` | 新目录：`mod.rs` + `shell.rs` + `filesystem.rs` + `compaction.rs` + `subagent.rs` + `registry.rs` |
| `src-tauri/src/ai/engine/simple_ai/tools/bash.rs` | `BashTool::execute` 改为通过 `ShellCapability` seam |
| `src-tauri/src/ai/engine/simple_ai/tools/fs.rs` | 各 fs 工具改为通过 `FileSystemCapability` seam |
| `src-tauri/src/ai/engine/simple_ai/tools/agent.rs` | `DispatchAgentTool` 改为通过 `SubAgentCapability` seam |
| `src-tauri/src/services/plugin_service.rs` | 新增 `install_provider` / `uninstall_provider` |
| `src-tauri/src/models/plugin.rs` | `PluginManifestContributes` 新增 `providers` 字段 |
| `src/plugin-system/types.ts` | 新增 `PluginProviderContribution` 类型 |
| `src/plugin-system/registry.ts` | 新增 `registerProvider` / `getProvider` 方法 |

### 4.7 验收标准

- [ ] 4 个 seam trait 定义完整，包含核心方法
- [ ] 默认 Provider 行为与当前硬编码实现完全一致（通过测试断言）
- [ ] 插件可声明 `providers.shell` 覆盖默认 shell 实现
- [ ] 插件 Provider 通过 MCP server 通信（MCP 子进程 = 外部 Provider）
- [ ] 卸载插件后自动恢复默认 Provider
- [ ] 多个插件声明覆盖同一能力时，按优先级规则选择

## 5. Phase 3：UI Slot + 运行时自省（未来，2-3 周）

### 5.1 目标

升级 UI 扩展点模型，实现运行时插件树自省能力。

### 5.2 UI Slot 模型

借鉴 DSH `ui-layout` 的 slot 注册模型：

```typescript
// 当前：固定 panelType 列表
interface PluginViewContribution {
  area: 'activityBar'
  panelType: string  // 全局唯一字符串
  order: number       // 排序
}

// 升级后：slot 注册模型
interface PluginViewContribution {
  area: 'activityBar'
  slot: string        // 目标 slot id（如 "files.panel"）
  mode: 'append' | 'shadow' | 'chain'  
  // append: 追加到 slot 列表末尾
  // shadow: 覆盖 slot 默认渲染（原面板隐藏）
  // chain: 在默认渲染前后链式注入自定义内容
  panelType: string
  order: number
}
```

**shadow 示例**：插件 `my-files` 声明 `slot: "files.panel", mode: "shadow"`，则原文件面板被隐藏，插件面板替代显示。

**chain 示例**：插件 `git-blame` 声明 `slot: "files.panel", mode: "chain"`，则在文件面板的每个文件项旁添加 blame 信息。

### 5.3 运行时自省

```typescript
// 新增 PluginInspector 服务
interface PluginInspector {
  // 列出所有已加载的插件（含内置）
  listPlugins(): PluginInfo[]
  
  // 列出所有已注册的 MCP server
  listMcpServers(): McpServerInfo[]
  
  // 列出所有已注册的 Provider 及其来源
  listProviders(): ProviderInfo[]
  
  // 检查某个 Provider 是否被插件覆盖
  getProvider(capability: string): ProviderInfo
  
  // 触发插件热重载（重新发现+注册）
  reloadPlugins(): Promise<void>
}
```

### 5.4 验收标准

- [ ] `slot` 系统支持 `append` / `shadow` / `chain` 三种模式
- [ ] 插件声明 `shadow` 后，原面板被隐藏
- [ ] 运行时 `PluginInspector` 可查看完整插件树
- [ ] 热重载不影响已建立的会话

## 6. 数据流与交互

### 6.1 插件发现 → 注册 → 使用 流程

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  插件安装     │───▶│  Plugin      │───▶│  Plugin      │
│  (zip/CDN)    │    │  Discovery   │    │  Registry    │
└──────────────┘    └──────────────┘    └──────┬───────┘
                                               │
                    ┌──────────────────────────┼──────────┐
                    │                          │          │
                    ▼                          ▼          ▼
           ┌──────────────┐          ┌──────────────┐
           │  Capability  │          │  MCP Server  │
           │  Registry    │          │  管理器      │
           └──────┬───────┘          └──────┬───────┘
                  │                         │
                  ▼                         ▼
           ┌──────────────┐          ┌──────────────┐
           │  Consumer    │          │  MCP 子进程  │
           │  (seam 调用)  │          │  (stdio)     │
           └──────────────┘          └──────────────┘
```

### 6.2 Provider 选择优先级

```
1. 插件声明覆盖（按 mcpServerId 查找）
   └─ 找到 → 走插件 MCP server
   └─ 未找到 → 报错（声明无效）

2. 默认 Provider（内置实现）
   └─ 使用当前硬编码代码
```

### 6.3 卸载/禁用 回退

```
插件禁用 → CapabilityRegistry 移除该插件 Provider
         → 下一个优先级 Provider 自动生效
         → 没有其他插件 Provider → 回退到默认 Provider
         → Consumer 无需任何变更（通过 seam 调用）
```

## 7. 测试策略

### 7.1 单元测试

| 测试 | 内容 |
|---|---|
| `CapabilityRegistry` 注册/查询/优先级 | 覆盖多 Provider 注册和优先级选择 |
| Seam 默认 Provider 行为 | 断言默认实现与当前代码一致 |
| Provider 切换 | 切换 Provider 后 Consumer 行为不变 |

### 7.2 集成测试

| 测试 | 内容 |
|---|---|
| MCP 工具路由 | 内置工具通过 MCP 网关调用与直接调用结果一致 |
| 插件覆盖 shell | 安装 shell 覆盖插件后，bash 调用走插件 MCP server |
| 卸载恢复 | 卸载插件后自动恢复默认 shell |

### 7.3 兼容性测试

| 测试 | 内容 |
|---|---|
| 现有插件零改动 | 所有已有外部插件（marketplace/blender/zen/relay 等）不受影响 |
| SimpleAI 回归 | 所有内置工具行为不变 |
| 引擎回归 | 所有引擎（Claude Code/Codex/Pi/SimpleAI）行为不变 |

## 8. 风险与缓解

| 风险 | 级别 | 缓解 |
|---|---|---|
| MCP 化后内置工具性能下降 | 低 | in-process 网关不走子进程，零额外开销 |
| Seam 接口设计不合理导致频繁修改 | 中 | 每个 seam 单独 ADR，参考 DSH 成熟设计 |
| 插件 Provider 声明冲突 | 低 | 先安装先服务，后安装覆盖前安装（可配置） |
| 向后兼容破坏 | 高 | 每个 Phase 都有兼容性测试套件，默认 Provider 行为不变 |
| 第三方 MCP server 安全性 | 中 | 保持现有 `permissions` 声明式权限模型，不扩大信任边界 |

## 9. 与 DSH 的参考对照

| Polaris 新设计 | 参考 DSH 包 | 关键借鉴点 |
|---|---|---|
| `ShellCapability` trait | `dsh-subprocess` + `dsh-shell` | Provider/Consumer 分离，`dsh-bash-local` 默认实现 |
| `FileSystemCapability` trait | `dsh-fs` + `dsh-fs-local` + `dsh-tool-fs` | 四层分离（定义/策略/工具/Provider） |
| `CompactionCapability` trait | `dsh-compaction` + `dsh-compaction-basic` | 定义/Provider 分离，事件驱动 |
| `SubAgentCapability` trait | `dsh-subagent` + spawn/fork provider | Provider 注册表 + 多种后端 |
| `CapabilityRegistry` | `dsh-agent` 的 `ctx.agents` | 注册表管理 Provider 生命周期 |
| in-process MCP 网关 | `dsh-mcp-client` | 同构的 MCP client 接口 |

## 10. 交付物清单

### Phase 1 交付物
- [ ] `InProcessMcpGateway` 实现
- [ ] 内置工具 MCP 化（11 个工具 → 5 个 MCP server）
- [ ] `McpClientPool` 统一路由
- [ ] `plugin.json` 新增 `toolProviders` 字段
- [ ] 前端 `PluginTab.tsx` 显示 Provider 覆盖状态
- [ ] 单元测试 + 集成测试
- [ ] 插件开发指南更新

### Phase 2 交付物
- [ ] 4 个 `CapabilitySeam` trait 定义
- [ ] `CapabilityRegistry` 实现
- [ ] 默认 Provider 实现（从当前代码迁移）
- [ ] 插件 `providers` 声明解析
- [ ] Consumer 适配（工具/UI 通过 seam 调用）
- [ ] 单元测试 + 兼容性测试
- [ ] 架构文档更新

### Phase 3 交付物
- [ ] UI Slot 系统（append/shadow/chain）
- [ ] `PluginInspector` 运行时自省
- [ ] 插件热重载
- [ ] 设计文档 + 迁移指南

## 11. 架构决策记录

### ADR-001：MCP 化不走子进程

**决定**：内置工具 MCP 化使用 in-process 网关，不启动额外子进程。

**背景**：子进程通信有序列化开销和延迟。内置工具的核心能力（bash/fs/compaction）对延迟敏感。

**替代方案**：每个内置工具启动独立子进程 MCP server。拒绝原因：延迟开销不可接受，且增加进程管理复杂度。

### ADR-002：Seam 定义在 Rust 侧，不在 TS 侧

**决定**：Seam trait 在 `src-tauri/src/capabilities/` 中定义，Consumer 在 Rust 侧适配。

**背景**：核心能力（bash/fs/compaction/subagent）的实现和消费都在 Rust 侧（SimpleAI），TS 侧的 Consumer 通过 Tauri command 桥接。

**替代方案**：Seam 定义在 TS 侧，Rust 端通过 IPC 调用。拒绝原因：增加不必要的 IPC 层和序列化开销。

### ADR-003：Provider 优先走 MCP，不引入第二套协议

**决定**：插件声明的 Provider 覆盖通过 MCP server 通信，不引入新的进程间协议。

**背景**：Polaris 已有成熟的 MCP 进程管理（`PluginServiceManager`），MCP 是跨进程能力的事实标准。

**替代方案**：引入新的 Rust trait FFI 或 WASM 插件机制。拒绝原因：增加生态复杂度，与 MCP 统一化方向冲突。MCP 已足够表达 shell/fs 等能力接口。