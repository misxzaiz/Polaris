# Pi Agent 集成方案与实施记录

## 1. 背景与定位

**Pi**（`@earendil-works/pi-coding-agent`，CLI 命令 `pi`）是 earendil-works 出品的终端编码 agent harness，与 Polaris 已接入的 claude-code / codex / mimo / simple-ai 同类。本方案将 pi 作为**第五个后端 AI 引擎**接入 Polaris。

## 2. 协议选型与实测验证（已完成）

pi 提供三种程序化接入：SDK（Node-only）/ RPC（stdin-stdout 双向 JSONL）/ JSON 事件流（单向）。

**本机实测结论**（2026-07-30，pi 已 `npm i -g` 安装）：

| 验证项 | 命令 | 结果 |
|--------|------|------|
| 进程启动 / help | `pi --help` | OK，参数齐全 |
| RPC 握手 | `pi --mode rpc --no-session --offline` + `get_state` | 返回 `{"type":"response","id":..,"command":"get_state","success":true,"data":{model,thinkingLevel,sessionId,...}}` |
| 模型列表 | `get_available_models` | 返回完整模型数组（claude/gpt/gemini/grok/deepseek 等，每项含 id/name/api/provider/baseUrl/cost/contextWindow） |
| 事件流 | 发 `prompt` 命令 | 立即 ack `success:true`，随后异步流 `agent_start`→`turn_start`→`message_start`(user)→`message_end`(user)；LLM 调用因 --offline+无 key 未触发，但协议层 100% 通 |

**选型决定：RPC 模式（`--mode rpc`）**。
- 理由：双向 JSONL，支持 steer/abort/get_state/new_session/fork 等富命令，远超 claude-code 的单向 stream-json。
- 协议要点：
  - 严格 JSONL，LF `\n` 唯一分隔；**不能用 Node readline**（它额外切 U+2028/U+2029）——Rust 侧按 `\n` split 即可。
  - 三类消息：命令（stdin）/ 响应（stdout，`type:"response"`+`command`+`success`+`data`）/ 事件（stdout，异步，`type:"agent_start"` 等）。
  - 命令可选 `id`，响应回带相同 `id`。
  - 文本增量：`message_update` + `assistantMessageEvent.type=="text_delta"` + `.delta`。
  - 工具：`tool_execution_start/update/end`（含 toolCallId/toolName/args/result/isError）。

## 3. 接入点地图（全部已 file:line 核实）

### 3.1 后端（Rust）

| 接入点 | 文件:行 | 改动 |
|--------|---------|------|
| EngineId 枚举 | `src-tauri/src/ai/traits.rs:34-45` | 加 `Pi` 变体（`#[serde(rename="pi")]`） |
| EngineId::parse | `traits.rs:58-61` | 加 `"pi" => Some(Self::Pi)` |
| EngineId::as_str | `traits.rs:71-74` | 加 `Self::Pi => "pi"` |
| EngineId::display_name | `traits.rs:81-84` | 加 `Self::Pi => "Pi"` |
| EngineId::all | `traits.rs:89-94` | 加 `EngineId::Pi` |
| 引擎实现 | `src-tauri/src/ai/engine/pi.rs`（新建） | `PiEngine` 实现 `AIEngine` trait |
| 事件解析 | `src-tauri/src/ai/engine/pi_parser.rs`（新建） | pi RPC 事件 → `StreamEvent`/`AIEvent` 归一化 |
| engine mod 声明 | `src-tauri/src/ai/engine/mod.rs` | `mod pi; pub use pi::PiEngine;` |
| 引擎注册 | `src-tauri/src/lib.rs:502-511` 与 `1052-1055` | 各加 `engine_registry.register(ai::PiEngine::new(config.clone()));` |
| 配置侧 | `src-tauri/src/models/config.rs:61` | 已 `pub use crate::ai::EngineId`（SoT 已统一，无需另改） |

**EngineId SoT 现状**：memory [[dual-engineid-sync]] 记的"两处 EngineId"已收敛——config.rs 第 61 行 re-export traits.rs 的定义。新增只需改 traits.rs 一处 enum。但 config.rs 里 `default_engine` 仍硬编码 `"claude-code"`（1348/1416 行），不影响新增。

### 3.2 前端（TypeScript）

引擎列表由后端 `AIEngine::metadata()` 动态下发，前端**不硬编码引擎列表**（engineMetadata.ts 注释明确）。仍需核对的派生点：
- `src/types/engineMetadata.ts`：类型定义，无需改（动态消费）。
- `src/utils/engineDisplay.ts` / `engineCapabilities.ts` / `engineHealth.ts`：可能有 switch 分支需补 `case 'pi'`。
- `src/types/config.ts`：EngineId 字符串字面量联合类型，需加 `'pi'`。
- 设置页 i18n：`src/locales/{en-US,zh-CN}/settings.json` 可能需加 pi 显示名。

## 4. 实施计划

### 阶段 A：后端引擎骨架（最小可编译）
1. traits.rs 加 EngineId::Pi（6 处方法）
2. 新建 `pi.rs`：`PiEngine` 结构 + `new()` + trait 方法骨架（is_available 查 `pi --version`，start/continue 用 RPC spawn）
3. 新建 `pi_parser.rs`：pi 事件 → StreamEvent 归一化
4. engine/mod.rs 登记
5. lib.rs 两处注册
6. `cargo check --lib` 验证编译（[[rust-lib-test-env-limit]]：本机只能 check 不能 test）

### 阶段 B：RPC 通信打通
7. PiEngine::start_session：`pi --mode rpc --no-session --provider X --model Y --api-key Z`，stdin 发 `prompt` 命令，stdout 读 JSONL
8. 事件解析：agent_start/turn/message_update(text_delta)/tool_*/agent_end → AIEvent 流
9. continue_session / interrupt（发 `abort` 命令）
10. 本机 `--offline` 协议冒烟（无 key 路径）

### 阶段 C：前端接线
11. config.ts EngineId 联合类型加 'pi'
12. engineDisplay/Capabilities/Health 补 case
13. i18n 显示名
14. 设置页引擎选择下拉出现 pi

### 阶段 D：真机联调（需 API key）
15. 用 ANTHROPIC_API_KEY 跑通真实对话
16. 验证工具调用（read/bash/edit）渲染
17. 验证 steer/abort 交互

## 5. 关键决策

- **模式**：选 RPC 而非 JSON 事件流。RPC 双向能力（steer/abort/get_state/fork）是 claude-code 没有的，值得多写一个 stdin 通道。
- **认证**：pi 支持 env var 和 `~/.pi/agent/auth.json`。Polaris 侧把现有引擎的 API key 配置注入 pi 的 `--api-key` 参数或环境变量即可，复用现有 config.api_key 路径。
- **session 持久化**：用 `--session-dir <DataRoot>/pi-sessions` + `--session-id <id>` 跨进程 resume（已实施，见下文「续聊上下文恢复」）。
- **工具**：pi 内置 read/bash/edit/write，默认开启；首版不禁用（`--no-tools` 不加）。

## 6. 进度

- [x] 协议调研与本机实测（2026-07-30）
- [x] 接入点地图核实
- [x] 方案文档
- [x] 阶段 A：后端引擎骨架（traits.rs EngineId::Pi 6 处 + pi.rs + pi_parser.rs + mod.rs + ai/mod.rs + lib.rs 两处注册 + config PiCodeConfig + get_pi_cmd）
- [x] 阶段 B：RPC 通信打通（build_command `--mode rpc --no-session` + spawn_event_reader 双向 stdin/stdout + pi 事件归一化 + abort 中断 + health detect_pi）
- [x] 阶段 C：前端接线（config.ts/session.ts EngineId 加 pi + ClaudePathSelector EngineType + engineDisplay VALID_ENGINE_IDS + getEngineDisplayName/FullName + engineCapabilities 选择器 + engineHealth command 类型 + piAvailable/piVersion + AIEngineTab ENGINE_META + CliField + configStore CLI 路径设置 + DispatchSettingsSection ENGINE_OPTIONS + conversationPackager fork 能力 + i18n zh-CN/en-US）
- [x] 新增会话入口支持 pi（NewSessionButton + CreateSessionModal engineOptions 加 pi/Orbit 图标）
- [x] 模型供应商支持 pi（modelProfile ProfileTargetEngine/ALL_ENGINES/isProfileForEngine 加 pi + ModelProviderTab EngineFilter 全 6 项 + ProfileCard 五引擎徽章 + SessionConfigSelector currentEngine pi 分支 + 后端 chat.rs pi 分支注入 customEnv + 按 authType 注入 API key env + i18n filter 补 simple-ai/mimo/pi）
- [x] 编译验证：cargo check --lib 全绿；tsc --noEmit 无 pi 相关错误；4 个前端测试套件 45 测试全通过
- [x] 协议实测：pi --version=0.83.0；RPC get_state/get_available_models/prompt+事件流本机跑通
- [x] 阶段 D：真机联调（需 API key，启动 Tauri 应用选 pi 引擎跑真实对话 + 工具调用渲染 + steer/abort 交互）

## 7. 续聊上下文恢复（已实施）

**问题**：首版 `--no-session` 无状态，`continue_session` kill+respawn 新进程后，pi 对前轮对话一无所知，用户继续对话时丢失上文。

**根因**：`--no-session` 让 pi 不落盘、进程内也不保留跨 prompt 上下文；`SessionOptions.message_history` 字段虽存在但 `continue_chat_inner` 从未填充、`PiEngine` 也未读取。

**方案**：去掉 `--no-session`，改用 pi 原生的 session 持久化 + resume：
- `build_command` 加 `--session-dir <DataRoot>/pi-sessions` + `--session-id <id>`；
- `start_session` 用临时 UUID 作 session-id，pi 创建该 session 并落盘；
- `continue_session` 用从 session 头读回的真实 session-id，pi 从落盘 jsonl resume 恢复上文；
- 每轮仍 kill+respawn 新进程（与 Mimo `--session <id>` 同构），上下文由 pi 的 resume 机制恢复，不依赖进程常驻；
- metadata `resume: true`。

落盘目录为 `<DataRoot>/pi-sessions`，随 DataRoot 迁移而移动。

## 7. 已知限制与后续

- **`--session-dir` 持久化 resume**：已实施（见第 7 节）。session 落盘到 `<DataRoot>/pi-sessions`，`continue_session` 用真实 session-id 让 pi resume。
- **图片附件未接**：pi RPC prompt 命令支持 images 字段，pi.rs 已留 warn 桩，待后续接 ImageAttachment → images。
- **MCP 未接**：pi 用 auth.json + extensions 体系，不走 claude/codex MCP 配置；PreparedMcpConfig 返回空。后续若要让 pi 用 Polaris MCP，需研究 pi extensions 机制。
- **pi_parser 测试未跑**：本机 cargo test --lib 被 simple_ai/tools/skill.rs 的 pre-existing SkillEntry 错误阻塞编译，pi_parser 的 8 个单元测试逻辑已就绪待 skill 修复后运行。
- **RPC 双向能力待挖掘**：当前只用 prompt/abort；pi 的 steer/follow_up/get_state/new_session/fork 等富命令可后续接入（send_input 已能转发任意 JSONL 命令）。
- **认证**：pi 走 env_overrides 注入 API key 环境变量，或用户预跑 `pi /login` 生成 `~/.pi/agent/auth.json`。Polaris 设置页可后续加 pi provider 选择 UI。
