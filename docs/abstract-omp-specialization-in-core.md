# OMP 特化逻辑抽象方案

## 背景

OMP（Oh My Pi）引擎通过插件系统动态注册（`EngineId::Custom("omp")`），其运行器 `PluginEngineRunner` 编译在 Polaris 核心中。部分特化逻辑在 Rust 侧硬编码，随着引擎种类增多，应当将引擎间差异抽象为声明式策略。

## 现状分析

### 已是声明式（manifest 驱动，无需改动）

| 策略 | 声明字段 | 声明值 |
|------|---------|-------|
| `--resume` 续聊标志风格 | `sessionFlags: "omp"` | 枚举 `SessionFlags::Omp` |
| models.yml 格式 | `providerConfig.format: "yaml"` | 枚举 `ProviderConfigFormat::Yaml` |
| PiExtension MCP 桥接 | `mcpConsumption: "pi-extension"` | 枚举 `McpConsumptionStrategy::PiExtension` |

### 与 Pi 共用的通用代码（不可移走）

| 文件 | 内容 | 原因 |
|------|------|------|
| `pi_parser.rs` | PiRpcLine 解析 + normalize_tool_name + 用量提取 + build_prompt/abort 命令 | 双引擎共用 |
| `mcp_bridge.rs` | EXTENSION_SOURCE JS 源码 + write_extension_bridge | Pi + OMP 共用 |
| `history_plugin.rs` | PluginHistoryProvider + parse_plugin_metadata | 通用历史查询 |

### OMP 独有特化（可抽象）

共有 **3 处**特化点，集中在 `plugin_engine.rs` 中：

---

## 改动点

### 改动点 1：`SessionFlags` 枚举重命名（纯语义，不改行为）

**现状**：`traits.rs` 中枚举名 `SessionFlags::Omp` 和 `SessionFlags::Pi` 以引擎名命名，当第三种引擎使用不同风格时名称不表意。

**改法**：改为描述性名称：

```rust
pub enum SessionFlags {
    /// 使用 --session-id（新会话）/ --session（恢复）—— Pi 风格
    IdBased,
    /// 无需指定 session-id（新会话）/ --resume --file-path（恢复）—— OMP 风格
    ResumeFileBased,
}
```

**涉及文件**：
- `src-tauri/src/ai/traits.rs` — 枚举定义 + 默认值
- `src-tauri/src/ai/engine/plugin_engine.rs` — `build_command()` 匹配分支
- `src-tauri/src/models/plugin.rs` — 前端 manifest 透传（`session_flags: Option<String>`）
- 前端 `src/plugin-system/types.ts` — 类型定义

**影响**：纯改名，行为不变。`"omp"` 字符串仍可做反序列化别名。

---

### 改动点 2：`session_paths` 持久化 → 抽象为 `SessionResumeStrategy` trait

**现状**：`plugin_engine.rs` 的 `PluginEngineRunner` 内含约 120 行 OMP 独有逻辑：

| 区域 | 行号 | 功能 |
|------|------|------|
| `session_paths: Arc<Mutex<HashMap>>` | 56-57 | 跨进程生命周期持久映射 |
| `session_paths_file` | 58-59 | 持久化文件路径 |
| `new()` 中加载 | 70-101 | 从磁盘加载映射 |
| `session_paths_file_path()` | 108-111 | 计算持久化文件路径 |
| `find_latest_session_file()` | 393-408 | 扫描落盘目录找最新 session 文件 |
| `spawn_event_reader` 中 agent_end 后捕获 | 784-809 | 会话结束后映射+持久化 |
| `continue_session` 中读取 | 1034-1047 | 续聊时从映射读真实 id |

**这些逻辑只对 `session_flags == ResumeFileBased` 的引擎有意义**。对 `IdBased` 引擎，续聊直接用 `--session <id>` 精确匹配，不需要扫描文件。

**改法**：在 `PluginEngineConfig` 中新增可选的 `session_resume_config` 字段：

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionResumeDeclConfig {
    /// 是否启用 session_paths 映射（OMP 风格：引擎不回传 session id，需扫描落盘文件）
    pub capture_session_file: bool,
    /// 落盘文件命名格式（用于路径解析，如 "<timestamp>_<uuid>.jsonl"）
    /// 仅当 capture_session_file=true 时生效
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_pattern: Option<String>,
}
```

在 `PluginEngineConfig` 中新增：

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub session_resume: Option<SessionResumeDeclConfig>,
```

**PluginEngineRunner 中**：

```rust
// 只在 manifest 声明 capture_session_file=true 时初始化 session_paths
let (session_paths, session_paths_file) = if config.session_resume
    .as_ref()
    .map(|c| c.capture_session_file)
    .unwrap_or(false)
{
    // 现有逻辑：加载持久化映射
    (loaded_map, Some(path))
} else {
    (HashMap::new(), None)
};
```

`spawn_event_reader` 中 agent_end 后的捕获逻辑同理：

```rust
if self.config.session_resume
    .as_ref()
    .map(|c| c.capture_session_file)
    .unwrap_or(false)
{
    // 现有扫描+持久化逻辑
}
```

**涉及文件**：
- `src-tauri/src/ai/traits.rs` — 新增 `SessionResumeDeclConfig`（或在 `PluginEngineConfig` 中加字段）
- `src-tauri/src/ai/engine/plugin_engine.rs` — 条件门控
- `src-tauri/src/models/plugin.rs` — manifest 透传新字段
- 前端 `src/plugin-system/types.ts` — 类型定义

**影响**：
- 默认值 `None`（`capture_session_file` 默认 `false`），现有引擎不受影响
- `omp-engine` 插件 manifest 需声明 `"sessionResume": { "captureSessionFile": true }`
- 约 120 行代码从"OMP 硬编码"变为"按配置启用"

---

### 改动点 3：`render_models_yaml` → 抽象为 `ProviderConfigFormat::Yaml` 的分支

**现状**：`plugin_engine.rs:573-609` 的 `render_models_yaml` 是 OMP 专用的 YAML 模板渲染。`write_provider_config` 中已按 `format: Yaml | Json` 分发。

**判断**：这其实已经是声明式策略——`format: "yaml"` 已由 manifest 声明，方法名 `render_models_yaml` 比 `render_omp_models_yaml` 更通用。**只需确认命名中立即可，无需抽象**（目前不在 `pub` 接口，函数名已足够通用）。

现有代码状态：**OK，无需改动**。

---

### 改动点 4：`pi_parser.rs` 中 `#[allow(dead_code)]` 的 `id` 字段

**现状**：`PiRpcLine` 结构体有一个 `id` 字段标了 `#[allow(dead_code)]`，保留供将来按 id 关联请求/响应。

**判断**：这是**真正的死代码标记**（但保留意图明确，不删）。

---

## 插件 manifest 改动（omp-engine）

现有 `plugin.json` 需新增字段：

```json
{
  "id": "omp-engine",
  "contributes": {
    "engines": [{
      "id": "omp",
      "sessionFlags": "omp",
      "sessionResume": {
        "captureSessionFile": true
      },
      "providerConfig": {
        "format": "yaml",
        ...
      }
    }]
  }
}
```

无需改动前端 `registry.ts`/`types.ts`（已有 `session_flags` 透传，新增 `session_resume` 做类似透传即可）。

---

## 改动汇总

| # | 改动 | 文件 | 行数 | 风险 |
|---|------|------|------|------|
| 1 | `SessionFlags::Omp/Pi` → `SessionFlags::ResumeFileBased/IdBased` | traits.rs + plugin_engine.rs + plugin.rs + types.ts | ~30 | 低（纯改名，反序列化别名兼容） |
| 2 | 新增 `SessionResumeDeclConfig` + `plugin_engine.rs` 条件门控 | traits.rs + plugin_engine.rs + plugin.rs + types.ts | ~30 新增 + 10 门控 | 中（需验证 `None` 时行为不变） |
| 3 | omp-engine 插件 manifest 声明 `sessionResume` | Polaris-plugin 仓库 | ~5 | 低 |
| 4 | 确认 `render_models_yaml` 命名中立 | — | 0 | 无需改动 |

**总计净变化**：约 +60 行 / -5 行（重命名 + 策略结构体 + 门控条件）。

---

## 验证

1. `cargo check --lib` 通过（参见 [[rust-lib-test-env-limit]]）
2. 默认 `session_resume: None` 时 `capture_session_file` 为 `false`，`session_paths` 映射为空 HashMap，`spawn_event_reader` 不执行扫描/持久化逻辑
3. 声明 `capture_session_file: true` 时行为与当前一致
4. Pi 引擎（`SessionFlags::IdBased`，`session_resume: None`）续聊行为不受影响
5. OMP 引擎续聊回归测试通过

---

## 实施建议

建议分两步走：

1. **Phase 1**（先做）：改动点 1（重命名 `SessionFlags`） + 改动点 2（新增策略 + 门控）
2. **Phase 2**（后做）：更新 omp-engine 插件 manifest 声明 `sessionResume`