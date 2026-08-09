# 引擎适配器进程化方案 —— 可行性分析

## 目标

> 以后加任何新 AI 引擎，只需写一个插件包（包含引擎特有逻辑），**不需要改 Polaris 核心**。

## 方案核心

让插件包携带一个**可执行的适配器进程**（JS/TS/Python/Rust 均可），Polaris 核心新增一个一次性的通用 `PluginProcessEngine`，通过 stdin/stdout JSONRPC 与适配器进程通信，适配器进程负责与底层引擎 CLI 交互。

```
Polaris Core ←―stdin/stdout JSONRPC―→ 插件适配器进程 ←―CLI interplay―→ 引擎 (omp/pi/xxx)
```

---

## ✅ 方案可行性（正面证据）

### 1. `AIEvent` 天然可序列化 —— 省掉事件翻译层

`src-tauri/src/models/ai_event.rs:1532`：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AIEvent { ... }   // 26 个变体
```

**含义**：适配器进程只需把引擎事件翻译成标准 AIEvent JSON 逐行写回 stdout，Rust 侧 `serde_json::from_str::<AIEvent>()` 直接反序列化，再推给 `event_callback`。**Rust 侧零事件类型改动**，协议是"传输 AIEvent 序列化结果"，而非"定义新事件格式"。

### 2. 已有同类进程通信先例

- `simple_ai/mcp/client.rs` 已有 stdio JSONRPC 客户端（`JsonRpcRequest/Response` + id 关联 + pending map）
- MCP server 本身就是 stdio 进程通信范式
- 插件服务（`contributes.services`）已支持 spawn 进程

这些可复用，不是从零造轮子。

### 3. 生命周期管理可复用

`SessionManager`（`src-tauri/src/ai/session.rs`）已封装：
- 会话注册/别名映射/移除
- `kill_process`（Windows `taskkill /T /F` 杀进程树，Unix `kill -9`）
- `send_input`（stdin 发送器）

`PluginProcessEngine` 可直接复用，无需重写。

### 4. 仅需一次性 Rust 基建

`Impl AIEngine` 需实现 5 个方法（`registry.rs` 的 MockEngine 为最小参考）：
- `start_session` → spawn 适配器 → 发 JSONRPC → 读事件流
- `continue_session`
- `interrupt`
- `send_input`（复用 SessionManager）
- `active_session_count` / `has_active_session`（复用 SessionManager）

---

## ⚠️ 需要解决的问题（分析出的风险）

### 问题 1：适配器进程的"进程生命周期"与"引擎 CLI 生命周期"解耦

**现状的隐含假设**：`PluginEngineRunner` 每轮 kill+respawn 引擎 CLI，进程生命周期 = 一轮对话。

**适配器模式的两种模型**：

- **模型 A（每轮一个适配器进程）**：简单，但每轮 spawn + 解析器初始化开销；且适配器进程死了引擎也死。
- **模型 B（常驻适配器进程，内部管理引擎 CLI 生命周期）**：复杂，需处理适配器进程崩溃、重连；但效率高、可保留状态。

**决策**：首版用**模型 A**（每轮 spawn 一个适配器进程，进程内 spawn 引擎 CLI，结束后一起退出）。与现状 `PluginEngineRunner` 语义对齐，风险最低。模型 B 留作后续优化。

### 问题 2：session_id 的"临时 ID → 真实 ID"映射

现状 OMP 是"新会话自动生成 id 且不回传，靠扫描落盘文件"。适配器进程接管后，**真实 id 的解析逻辑落到适配器进程里**，Rust 侧无从得知。

**方案**：适配器进程在完成一次会话后，通过一个专用返回字段上报真实 session id：

```json
{"event":"session_started","session_id":"<真实id>","resume_token":"<续聊需要的token/path>"}
```

Rust 侧 `PluginProcessEngine` 把 `resume_token` 存起来（仿照 `session_paths` 持久化），续聊时回传给适配器进程。**续聊策略完全由插件决定**，这正是目标。

### 问题 3：事件流的"半同步"协议设计

适配器进程既要回传事件流（异步、持续），又要响应请求（同步、有 id）。需要清晰的帧协议。

**方案**：借鉴 MCP，用**行分隔 JSONL**（每行一个完整 JSON）：

| 方向 | 帧类型 | 示例 |
|------|--------|------|
| Polaris→适配器 | `request` | `{"id":1,"method":"start_session","params":{...}}` |
| Polaris→适配器 | `notification`（无需响应） | `{"method":"shutdown"}` |
| 适配器→Polaris | `event`（AIEvent 透传） | `{"event":"ai_event","data":{...AIEvent JSON...}}` |
| 适配器→Polaris | `response`（请求的同步结果） | `{"id":1,"result":{"session_id":"..."}}` |
| 适配器→Polaris | `error` | `{"id":1,"error":{"code":-1,"message":"..."}}` |

事件流与响应流混在同一 stdout，靠 `has "id"` vs `has "event"` 区分。Rust 侧用单线程 reader 循环，按帧类型分发。

### 问题 4：Adapter 的 runtime 依赖

插件适配器进程需要 runtime（node/python 等）。需在 manifest 声明：

```json
"adapter": {
  "entry": "engine.js",
  "runtime": "node",        // 或 "python3" / "deno" / 空（直接可执行）
  "protocol": "engine-v1"
}
```

**风险**：如果引擎 CLI 本身是 node 生态（omp/pi 都是），插件适配器也用 node 合理；但若用户没装 node，适配器无法启动。需在 manifest 声明 + 引擎不可用时给出明确提示（复用 `unavailable_reason`）。

### 问题 5：MCP 桥接的归属

现状 MCP 桥接由 `PluginEngineRunner` 通过 PiExtension 策略注入。适配器化后，**MCP 桥接逻辑也应移到适配器进程**（适配器进程最了解引擎如何消费 MCP）。

但现状 `mcp_bridge.rs` 的 `EXTENSION_SOURCE`（JS 源码）是 Pi/OMP 共用的。**建议**：适配器化后，MCP 桥接由适配器进程自行处理，Rust 侧只把 `mcp_servers` 列表通过 start_session params 传给适配器。`mcp_bridge.rs` 保留给旧 `PluginEngineRunner`（Pi 风格）用。

### 问题 6：向后兼容

现有 omp 引擎走 `PluginEngineRunner`（编译进核心）。引入 `PluginProcessEngine` 后，**不能破坏现有 omp**。

**方案**：`register_plugin_engine` 时判断——manifest 声明 `adapter` 用 `PluginProcessEngine`，否则用 `PluginEngineRunner`。两套并存，旧 omp 插件继续用 `PluginEngineRunner`，新引擎用 `PluginProcessEngine`。迁移 omp 到适配器是后续单独任务。

---

## 改动清单（Polaris 核心，一次性）

| # | 改动 | 位置 | 量级 |
|---|------|------|------|
| 1 | 新增 `PluginProcessEngine`（impl AIEngine） | `src-tauri/src/ai/engine/plugin_process_engine.rs` | ~250 行 |
| 2 | 新增 `adapter` 字段到 `PluginEngineConfig` | `src-tauri/src/ai/traits.rs` | ~20 行 |
| 3 | 新增 `adapter` 字段到 manifest 类型 | `src-tauri/src/models/plugin.rs` | ~15 行 |
| 4 | 前端 manifest 类型加 `adapter` | `src/plugin-system/types.ts` | ~10 行 |
| 5 | `register_plugin_engine` 分流（adapter vs runner） | `src-tauri/src/ai/registry.rs` | ~10 行 |
| 6 | 事件帧协议解析（JSONL 分发） | `plugin_process_engine.rs` 内 | 含在 #1 |

**Polaris 核心改动：约 300 行，一次性，之后零改。**

---

## 插件包样板（一个引擎 = 一个目录）

```
omp-engine/
├── plugin.json          # 声明 adapter + engines
├── engine.js            # 适配器进程入口
└── engine/              # （可选）引擎 CLI 相关辅助
```

`plugin.json`：
```json
{
  "id": "omp-engine",
  "contributes": {
    "engines": [{
      "id": "omp",
      "name": "Oh My Pi",
      "adapter": {
        "entry": "engine.js",
        "runtime": "node",
        "protocol": "engine-v1"
      },
      "cli": { "command": "omp", "installGuide": "..." }
    }]
  }
}
```

---

## ⚠️ 复审发现的关键问题（实测验证）

### AIEvent 的 serde 重复 `type` 字段问题

**实测发现**（`/tmp/aievent_probe` 独立 Rust 项目验证）：

`AIEvent` 声明 `#[serde(tag = "type")]`，但 `ToolCallStartEvent`/`ToolCallEndEvent`/`UsageEvent` 等 **tuple-variant 内部也带 `#[serde(rename = "type")]` 的 `event_type` 字段**。这导致：

```rust
// 序列化结果（重复 type）：
{"type":"tool_call_start","type":"tool_call_start","session_id":"s1",...}
// 反序列化报错：
Error("duplicate field `type`", ...)
```

**结论**：适配器**不能直接发送 tuple-variant 形式的 AIEvent JSON** 让 Rust `serde_json::from_str` 反序列化。

**但**：验证表明，**struct-variant 形式的 AIEvent JSON 可以正常序列化/反序列化**（`assistant_message`、`error`、`session_end`、`thinking` 等），因为 `type` 标签由 enum 统一控制，无重复。

**解决方案**：协议层用 `"event":"ai_event"` 标记 + 结构化字段，`PluginProcessEngine` 收到后**手动构造** AIEvent（而非直接反序列化）。对 tuple-variant 变体（tool_call_start/end、usage）用构造器手动组装。

---

## 确认的协议（复审定稿）

### 帧格式（stdout/stderr JSONL，每行一个完整 JSON）

**Polaris → 适配器**（请求）：
```json
{"id":1,"method":"start_session","params":{...}}
{"id":1,"method":"continue_session","params":{...}}
{"id":1,"method":"interrupt","params":{...}}
```

**适配器 → Polaris**（事件帧，带 `"event":"ai_event"` 标记）：
```json
{"event":"ai_event","type":"assistant_message","session_id":"s1","content":"hi","is_delta":true}
{"event":"ai_event","type":"tool_call_start","session_id":"s1","tool":"bash","args":{"cmd":"ls"},"call_id":"c1"}
{"event":"ai_event","type":"tool_call_end","session_id":"s1","tool":"bash","success":true,"result":"output","call_id":"c1"}
{"event":"ai_event","type":"error","session_id":"s1","error":"engine failed"}
{"event":"ai_event","type":"session_end","session_id":"s1"}
```

**适配器 → Polaris**（响应帧，带 `id`）：
```json
{"id":1,"result":{"session_id":"s1","resume_token":"/x.jsonl"}}
{"id":1,"error":{"code":-1,"message":"engine not found"}}
```

### 解析规则

`PluginProcessEngine` 的 reader 循环：
1. 解析每行 JSON
2. 若 `event == "ai_event"` → 事件帧，手动构造 AIEvent 推给 `event_callback`
3. 若 `id` 存在且 `result` → 请求成功响应（含 session_id / resume_token）
4. 若 `id` 存在且 `error` → 请求失败

### 事件构造（避免 tuple-variant 重复 type 问题）

对 struct-variant 事件（assistant_message/error/thinking/session_end/context_compacted），直接 `serde_json::from_value`。
对 tuple-variant 事件（tool_call_start/end/usage），用构造器手动组装（`ToolCallStartEvent::new` + `with_call_id` 等）。

---

## 结论

**方案可行。** 原文档"省掉事件翻译层"的乐观判断需修正：**不能直接序列化/反序列化 AIEvent**，但可通过"协议帧 + 手动构造"轻松解决（协议已实测验证）。

**主要取舍**：
1. 首版用"每轮一个适配器进程"（模型 A），简单、与现状语义对齐
2. 续聊策略完全下放到适配器进程，Rust 只存 `resume_token` 回传
3. MCP 桥接下放到适配器进程
4. 新旧两套引擎运行器并存，向后兼容

**主要风险**：
- 适配器进程 runtime 依赖（node/python 需用户已装）
- 进程树清理（适配器 + 引擎双层 kill，需 `SessionManager` 的 `taskkill /T` 覆盖）
- 事件流协议稳定性（需明确定义 JSONL 帧 + 错误处理）

## 建议下一步

1. 若方向认可，先定稿协议（帧格式、错误码、session_id 上报）
2. 实现 `PluginProcessEngine` + 一个**样例适配器插件**（先用现有 omp 做验证，但走新路径，不动旧 omp）
3. 验证通过后，再决定是否把 omp 主插件迁移到新路径