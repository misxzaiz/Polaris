# Codex / DSH 引擎外迁插件化 —— 准备方案分析

> 状态：**仅分析，未实施**。本文是 dsh/codex 引擎从主仓库 Rust 端外迁为插件前的准备清单与耦合点测绘。
> 前置基础：通用插件引擎适配器（`PluginProcessEngine` + engine-v1 协议）**已落地实施**，外部 `dsh-engine` 插件已存在样板。本任务是「让 dsh/codex 真正走插件路径、从主仓库移除原生引擎」。

---

## 0. 背景与策略反转

### 0.1 上一轮策略（2026-08-20）：内置 + 插件并存
记忆 [[engine-externalization-complete]] 记录：原本打算移除内置 4 引擎，但因直接移除 claude-code 导致旧版发行版（D:\app\polaris\，08-16 构建）前端用 pi-rpc 协议给 claude CLI 拼 `--mode rpc` 报错、用户桌面端不能停，遂改为**并存策略**：
- 内置 4 引擎（claude.rs/codex.rs/pi.rs/dsh.rs）全部保留不动
- 插件版用 `-v1` 后缀 id（claude-code-v1/codex-v1/pi-v1）独立注册，`EngineId::parse` 不命中已知变体 → Custom，与内置不冲突

### 0.2 本次策略反转：移除 codex/dsh 原生引擎
用户当前指令明确要求移除 dsh/codex 原生引擎、走插件路径。这是**对并存策略的反转**，仅针对 codex/dsh（claude-code/pi 是否同步移除未明确，本方案先聚焦 codex/dsh）。

### 0.3 当前真实状态（代码实测，2026-08-20）

| 引擎 | Rust 原生实现 | 外部插件适配器 | 真实状态 |
|------|--------------|---------------|---------|
| claude-code | `claude.rs` | claude-code-v1 | 内置+插件并存（本轮不动） |
| codex | `codex.rs` (1262行) + `codex_parser.rs` | codex-v1 | **内置仍在，本轮要移除内置** |
| pi | `pi.rs` | pi-v1 | 内置+插件并存（本轮不动） |
| dsh | `dsh.rs` (2389行) | dsh-engine (engine.mjs) | **内置仍在，本轮要移除内置** |
| omp | 无（走 PluginEngineRunner） | omp-engine | 已外迁（走通用 runner） |

**关键事实**：codex/dsh 的原生 Rust 引擎仍在主仓库 `lib.rs:540,549,1247,1250` 硬编码注册（并存策略所致），外部插件虽已就绪但走的是独立 `-v1`/`deepseek-dsh` id，主仓库默认仍走原生路径。

**本轮任务**：(1) 确认外部 codex/dsh 插件能力对齐 → (2) 从主仓库移除 codex/dsh 原生引擎 → (3) 主仓库通过插件动态注册生效。注意外部插件当前可能用 `-v1` 后缀 id 以避免与内置冲突，移除内置后可考虑改回无后缀 id（需评估历史会话兼容）。

---

## 1. 通用插件引擎基础设施（已就绪，无需再建）

以下基建已全部落地，是「加引擎不改核心」的实现基础：

### 1.1 Rust 端通用适配器运行器
- **`src-tauri/src/ai/engine/plugin_process_engine.rs`** (801行)：engine-v1 JSONL 协议运行器
  - stdin 发 `{"id","method","params"}` 请求，stdout 读 `{"event":"ai_event",...}` 事件帧 + `{"id","result"}` 响应帧
  - 事件帧手动构造 AIEvent（规避 tuple-variant `type` 字段重复问题，见设计文档 §复审定稿）
  - `resume_token` 持久化到 `plugin-sessions/<engine_id>/resume_tokens.json`
  - 模型 A 生命周期：每轮 spawn 适配器进程，适配器内 spawn 引擎 CLI，结束一起退出
- **`src-tauri/src/ai/engine/plugin_engine.rs`** (1244行)：PiRpc 协议运行器（omp 走这条）
- **`src-tauri/src/ai/traits.rs`**：`PluginEngineConfig` 含 `adapter: Option<PluginEngineAdapterDecl>` + `install_path`
- **`src-tauri/src/ai/registry.rs:123`**：`register_plugin_engine` 分流逻辑 —— 有 `adapter` → `PluginProcessEngine`，无 → `PluginEngineRunner`

### 1.2 协议（engine-v1，已实测定稿）
- Polaris → 适配器：`{"id":1,"method":"start_session|continue_session|interrupt","params":{...}}`
- 适配器 → Polaris（事件）：`{"event":"ai_event","type":"assistant_message|tool_call_start|tool_call_end|usage|error|session_end|thinking","session_id":"...","...":...}`
- 适配器 → Polaris（响应）：`{"id":1,"result":{"session_id":"...","resume_token":"..."}}`
- 续聊令牌完全由适配器决定，Rust 侧只存 `resume_token` 回传

### 1.3 外部样板
- **`Polaris-plugin/plugins/dsh-engine/`**：`plugin.json`（声明 `engines[].adapter`）+ `engine.mjs`（node 适配器）+ `panel.js` + `update.json`
  - `plugin.json` 的 `engines[]` 已正确声明 `adapter: {entry, runtime:"node", protocol:"engine-v1"}`
  - `engine.mjs` 已实现 headless 驱动 + resume token 持久化

**判定**：通用基建层无需改动，外迁 dsh/codex 是「使用」基建而非「扩展」基建。

---

## 2. dsh/codex 在主仓库的耦合点测绘

外迁 = 从主仓库移除原生引擎 + 切换到外部插件。以下是需要处理的全部耦合点（按移除难度排序）：

### 2.1 核心引擎实现（可直接删除）
| 文件 | 行数 | 说明 |
|------|------|------|
| `src-tauri/src/ai/engine/codex.rs` | 1262 | CodexEngine 实现 + CLI 探测 + JSONL 解析 + Windows 环境注入 |
| `src-tauri/src/ai/engine/codex_parser.rs` | ~230 | `CodexEvent` enum + `parse_codex_line` + `codex_event_to_ai_events`（**仅 codex.rs 引用**，纯 codex 专有，可整体删） |
| `src-tauri/src/ai/engine/dsh.rs` | 2389 | DshEngine 实现 + HTTP RPC + WebSocket + Windows Junction 桥接 + `submit_answer` + `prepare_dsh_bridge_standalone` |

- `codex_parser` 经 grep 确认仅被 `codex.rs` 引用，无外部依赖
- `dsh.rs` 内的 `pub fn submit_answer` / `pub fn prepare_dsh_bridge_standalone` 被 `commands/plugin_engine.rs`/`lib.rs` 等调用（见 §2.4），需同步清理调用点

### 2.2 引擎注册点（lib.rs 两处，硬编码）
```
src-tauri/src/lib.rs:540   engine_registry.register(ai::CodexEngine::new(config.clone()));   // Tauri 路径
src-tauri/src/lib.rs:549   engine_registry.register(ai::DshEngine::new(config.clone()));    // Tauri 路径
src-tauri/src/lib.rs:1247  engine_registry.register(ai::CodexEngine::new(config.clone()));   // Web 路径
src-tauri/src/lib.rs:1250  engine_registry.register(ai::DshEngine::new(config.clone()));    // Web 路径
```
- Tauri 和 Web 两条初始化路径都要改
- 删除后 codex/dsh 只能通过「插件安装 → register_plugin_engine」动态注册
- **`EngineId::Codex` 是编译期 enum 变体**（见 §2.3），删引擎后这个变体的去留需决策

### 2.3 EngineId enum 变体（traits.rs）
- `EngineId::Codex` / `EngineId::Custom("dsh")` 是硬编码标识
- codex 用 enum 变体，dsh 用 `Custom("dsh")` 字符串
- 外迁后 codex 若改为 `Custom("codex")`，所有 `EngineId::Codex` match 分支会失配 —— 需逐一审查（见下）

### 2.4 引擎特化逻辑（match 分支，需逐个处理）
这些是 codex/dsh 在核心代码里的特化分支，外迁后要么删除、要么泛化到 `Custom(_)`：

| 位置 | 内容 | 处理 |
|------|------|------|
| `ai/launcher.rs:159` | `EngineId::Codex => codex_config_args` MCP 注入 | 删除分支（适配器自管 MCP，见设计文档问题5） |
| `commands/chat.rs:440` | `EngineId::Codex => "codex"` profile 引擎名映射 | 删除或归入 Custom |
| `commands/chat.rs:572` | `EngineId::Codex =>` Codex Responses→Chat 代理转换 | **这是 `codex_chat.rs` 的调用点**，代理逻辑需随 codex 外迁或保留为核心代理服务 |
| `commands/chat.rs:2119/2160/2192` | `CodexHistoryProvider::new` 历史读取 | 见 §2.5 |
| `integrations/commands.rs:457` | `provider: EngineId::Codex` 测试断言 | 测试更新 |
| `integrations/commands.rs:620` | `state.switch_engine(&EngineId::Codex)` 测试 | 测试更新 |
| `web/api/chat.rs:199` `web/api/session.rs:59,139` | `CodexHistoryProvider::new` | 见 §2.5 |
| `ai/registry.rs:352,397,408` | 测试用 `EngineId::Codex` | 测试更新 |

### 2.5 Codex 历史提供者（独立于引擎，需决策归属）
- **`src-tauri/src/ai/history_codex.rs`** (~700行)：读取 `~/.codex/sessions/**/rollout-*.jsonl`
- 实现了 `SessionHistoryProvider` trait，被多处调用（chat.rs / web/api/session.rs / dialog_index.rs）
- **特点**：它读的是 Codex CLI 的原生落盘文件，与 `CodexEngine` 运行时是解耦的
- **决策点**：
  - 方案 A：保留 `history_codex.rs` 在核心（作为「读 Codex 原生历史」的工具，引擎外迁不影响历史读取）
  - 方案 B：随 codex 一起外迁到插件（插件提供历史读取能力，通过 `PluginHistoryProvider` 桥接）
  - **建议方案 A**：历史提供者读的是上游 CLI 落盘格式，与 Polaris 引擎实现无关，保留在核心更稳定，避免外迁后历史读取失效

### 2.6 Codex 代理服务（codex_chat.rs）
- **`src-tauri/src/services/proxy/codex_chat.rs`**：Codex Responses API ↔ OpenAI Chat Completions 转换代理
- 被 `services/proxy/handlers.rs` / `proxy/mod.rs` 引用
- 被 `commands/chat.rs:572` 的 `use_codex_proxy = matches!(wire, Some("openai-chat-completions"))` 门控
- **决策点**：
  - 这是供应商协议转换服务，理论上与引擎实现解耦（任何 Responses API 引擎都可能需要）
  - 但外迁后 codex 引擎若不再走核心 start_chat_inner，此代理的调用入口需重新接线到适配器
  - **建议保留**为核心代理服务，适配器进程通过环境变量/参数声明代理端口，由适配器决定是否使用

### 2.7 TS 端引擎文件
- `src/engines/codex/engine.ts` (57行) + `src/engines/codex/session.ts`：继承 `TauriCommandEngine` 的前端封装
- 外迁后后端 codex 引擎消失，TS 端 codex 引擎要么删除、要么改为「插件引擎」前端壳
- 需检查 `src/engines/` 目录其他 codex 文件 + `engine-registry.ts` / `engine-bootstrap.ts` 的注册逻辑

### 2.8 dsh 专属：桥接与问答
- `dsh.rs` 的 `submit_answer`（dsh question/requested 的 `/api/respond` 回复）被 MCP/命令层调用
- `prepare_dsh_bridge_standalone`（Windows Junction 桥接）被 `start_chat_inner` 锁外预检调用
- 外迁后这些逻辑全部移到 `dsh-engine/engine.mjs` 适配器进程内，主仓库调用点删除

---

## 3. 外迁后主仓库的「最小净空」目标

移除完成后，主仓库应达到：
1. `src-tauri/src/ai/engine/` 下无 `codex.rs` / `codex_parser.rs` / `dsh.rs`
2. `lib.rs` 无 `CodexEngine::new` / `DshEngine::new` 注册行
3. `ai/mod.rs` 无 `mod codex` / `mod dsh` / `pub use ...CodexEngine/DshEngine`
4. launcher/chat/integrations 无 `EngineId::Codex` 特化分支（归入 Custom 或删除）
5. `EngineId::Codex` enum 变体决策：保留（作为历史会话标识兼容）或删除
6. codex/dsh 引擎通过安装外部插件 → `register_plugin_engine` 动态注册生效

---

## 4. 准备功能清单（让项目支持通过插件实现 dsh/codex）

按依赖顺序，分三组。本阶段**只做主仓库侧的准备与解耦**，不动外部插件实现。

### 准备组 A：清除引擎特化分支（可逆，先做）
目的：让核心代码不再对 codex/dsh 有硬编码依赖，为删除引擎铺路。

- [ ] **A1** launcher.rs：`EngineId::Codex` 的 MCP 注入分支泛化 —— codex 适配器自管 MCP（通过 `mcp_servers` 参数传入），删除 `codex_config_args` 注入分支或归入 Custom
- [ ] **A2** chat.rs:572 的 Codex Responses→Chat 代理调用：确认 `codex_chat` 代理保留为核心服务，接线方式改为「适配器通过参数声明代理端口」
- [ ] **A3** chat.rs:440 / integrations:457,620 / registry.rs 测试：`EngineId::Codex` 断言更新为 `Custom("codex")` 或删除
- [ ] **A4** dialog_index.rs:556,781 的 CodexHistoryProvider 调用：确认 history_codex 保留（方案A），调用点不变

### 准备组 B：引擎注册解耦（移除原生引擎）
目的：从 lib.rs 移除硬编码注册，让 codex/dsh 只能通过插件注册。

- [ ] **B1** lib.rs 两处（Tauri:540,549 / Web:1247,1250）删除 Codex/Dsh 注册行
- [ ] **B2** `ai/engine/mod.rs` 移除 `mod codex` / `mod dsh` / `pub use CodexEngine/DshEngine`
- [ ] **B3** `ai/mod.rs:30,32` 移除 `pub use CodexEngine` / `pub use DshEngine`；`ai/mod.rs:41` 的 `CodexHistoryProvider` 保留（方案A）
- [ ] **B4** 删除 `codex.rs` / `codex_parser.rs` / `dsh.rs` 三个文件
- [ ] **B5** 清理 dsh.rs 的 `submit_answer` / `prepare_dsh_bridge_standalone` 在 commands/plugin_engine.rs、lib.rs 等的调用点
- [ ] **B6** `EngineId::Codex` enum 变体决策：保留（历史会话兼容）+ `parse_any` 仍识别 "codex" 字符串映射到 `Custom("codex")`，或直接删除变体
- [ ] **B7** TS 端 `src/engines/codex/` 处理：删除或改为插件引擎前端壳

### 准备组 C：验证与回归
- [ ] **C1** `cargo check --lib` 0 error（受 [[rust-lib-test-env-limit]] 约束，本机只能编译不能跑测试）
- [ ] **C2** `tsc` 0 新错误
- [ ] **C3** 协议测试：engine-v1 适配器事件帧解析测试全绿（plugin_process_engine.rs 已有 13 个测试）
- [ ] **C4** 安装外部 dsh-engine 插件 → 验证 `register_plugin_engine` 走 PluginProcessEngine 路径 → 引擎可用
- [ ] **C5** codex 外部插件就绪后同上验证

---

## 5. 关键决策点（需确认后再实施）

| # | 决策 | 建议 | 理由 |
|---|------|------|------|
| D1 | `EngineId::Codex` 变体去留 | 保留变体但 `parse_any` 映射到 Custom("codex")，或保留并让插件注册命中它 | 历史会话 meta 可能存了 `EngineId::Codex`，删除变体会破坏历史反序列化 |
| D2 | `history_codex.rs` 归属 | 保留在主仓库核心 | 读上游 CLI 落盘格式，与引擎实现无关，外迁反而增风险 |
| D3 | `codex_chat.rs` 代理归属 | 保留为核心代理服务 | 协议转换通用，非 codex 专有 |
| D4 | dsh 桥接(Junction修复)归属 | 全部移到 `dsh-engine/engine.mjs` | 适配器进程负责引擎 CLI 全生命周期，桥接天然属于适配器 |
| D5 | dsh `submit_answer` 归属 | 移到适配器 | question/requested 的 /api/respond 回复由适配器进程直接处理 |
| D6 | codex 适配器实现语言 | node（engine.mjs） | 与 dsh-engine 样板一致，复用 engine-v1 协议，codex CLI 本身是 node 生态 |

---

## 6. 外部插件实现预留（本阶段不做，仅记录）

外迁完成后需在 `Polaris-plugin/plugins/` 下实现：

### 6.1 codex-engine 插件（新建）
```
plugins/codex-engine/
├── plugin.json      # contributes.engines[].adapter 声明 engine-v1
├── engine.mjs       # 适配器：spawn `codex exec --json`，JSONL 事件翻译为 AIEvent 帧
├── panel.js         # （可选）Codex 工作区面板
└── update.json
```
适配器需实现：
- `start_session`：spawn `codex exec --json --skip-git-repo-check [-C workdir] [--model m] [--full-auto|...] <message>`
- 读 codex JSONL stdout，翻译 `thread.started`/`item.completed`/`turn.completed`/`turn.failed` 为 engine-v1 事件帧
- `thread.started` 的 thread_id 作为 resume_token 持久化上报
- `continue_session`：`codex exec resume <session_id> <message>`
- `interrupt`：kill 进程
- 处理 Codex 生成图片（`~/.codex/generated_images/<thread_id>/` → markdown）
- Windows GBK 容错解码、持久环境注入（从 codex.rs 移植）

### 6.2 dsh-engine 插件（已存在，需补全）
现有 `dsh-engine/engine.mjs` 是 headless 简化版，外迁后需补全到对齐 `dsh.rs` 完整能力：
- HTTP RPC + WebSocket 事件流模式（headless 仅是降级）
- Windows Junction 桥接（移植 `prepare_dsh_bridge` / `patch_ensure_symlink`）
- question/requested 的 /api/respond 回复（移植 `submit_answer`）
- 完整事件翻译（assistant/chunk text-delta/reasoning-delta、tool/call、approval 等）

---

## 7. 风险提示

1. **历史会话兼容**：已存在的 codex/dsh 历史会话 meta 里存的 `EngineId::Codex` / `Custom("dsh")`，外迁后反序列化不能失败（D1 决策）
2. **EngineId 三处同步**：受 [[dual-engineid-sync]] 约束，后端 traits + config 两个 EngineId 必须同步，删除/改 codex 变体时三处一起改
3. **linter 回滚**：本机环境有 linter 会自动回滚改动，须用 Write+commit 固化（见 perf-features 记录的教训）
4. **Web 编译门控**：受 [[web-only-tauri-command-gate]] 约束，若改动触及 `#[tauri::command]`，`--no-default-features` 编译要加 `#[cfg(feature="tauri-app")]`
5. **dsh 双实例风险**：外迁后若主仓库残留 dsh 进程守护逻辑，可能与适配器进程的 dsh 形成双实例（见 [[dsh-process-lifecycle-fix]]），需彻底清理 `prepare_dsh_bridge_standalone` 调用点

---

## 8. 建议实施顺序

1. **先确认决策 D1-D6**（尤其 D1 EngineId 变体去留）
2. **准备组 A**（清除特化分支，可逆，风险低）
3. **准备组 B**（移除引擎，需 A 完成后无残留引用）
4. **准备组 C** 验证
5. （本阶段之后）外部插件实现：codex-engine 新建 + dsh-engine 补全

准备组 A+B 是「让主仓库不再依赖原生 codex/dsh」的全部工作，完成后项目即支持通过插件实现这两个引擎。
