# SimpleAI 代码审查与优化方案

> 审查日期：2026-07-12
> 审查范围：`src-tauri/src/ai/engine/simple_ai/` 全部子模块、tools、MCP、protocol、session、compact、retry、agent
> 当前基线：已实现 Phase 0-4（模块拆分、身份/项目指令/工具注册表/上下文压缩/usage/retry/Agent/MCP/Skill）

---

## 概述

经过完整代码通读，当前 SimpleAI 已远超"轻量备用引擎"定位，具备三协议适配、流式输出、工具注册表、MCP 插件消费、Skill/Agent/Subagent、上下文压缩等完整能力，工具集对标 codex/Claude Code。模块结构和单测覆盖良好。

**核心矛盾**：能力增长速度快于正确性和可靠性工程投入。分析聚焦在并发正确性（最严重）、上下文压缩（高频 bug）、MCP 生命周期（性能与稳定性），以及 HTTP / 工具 / 可观测性的渐进改进项。

---

## 目录

- [P0：会话并发与历史一致性](#p0会话并发与历史一致性)
- [P0：上下文压缩逻辑需修正](#p0上下文压缩逻辑需修正)
- [P0/P1：MCP 生命周期与可靠性](#p0p1mcp-生命周期与可靠性)
- [P1：HTTP 与流式协议](#p1http-与流式协议)
- [P1：工具执行性能与安全](#p1工具执行性能与安全)
- [P1：Agent 与 Subagent](#p1agent-与-subagent)
- [P2：可维护性与可观测性](#p2可维护性与可观测性)
- [推荐实施顺序](#推荐实施顺序)

---

## P0：会话并发与历史一致性

### 1. `continue_session` 存在并发覆盖风险

**文件**：`src-tauri/src/ai/engine/simple_ai/mod.rs:323`

**现状**：续聊逻辑从 session clone 出一份 `messages` → 释放锁 → 后台执行完整对话循环 → 最终整体写回。**不检查 `session.is_running`**，因此同一 session 连续两次 `continue_session` 会出现两个任务从同一历史分叉，最后由最后结束的任务整体覆盖历史。

**后果**：
- 用户第二条消息消失
- 第一轮工具调用结果被覆盖
- UI 显示过的回复不在后端历史中
- 后续续聊"失忆"
- `is_running` 被较早结束任务错误设置为 false

**建议**：为 session 增加串行执行锁或 turn generation。同一 session 一次只允许一个 active turn。新消息到达运行中 session 时返回明确错误或入队。回写历史时校验 turn_id。

---

### 2. 会话创建存在短暂竞态

**文件**：`src-tauri/src/ai/engine/simple_ai/mod.rs:269`

**现状**：session 在 `tokio::spawn` 内插入 map。`start_session` 返回 session ID 后后台任务不保证已经完成插入。如果用户立即点击停止，`interrupt()` 可能暂时找不到 session。

**建议**：采用同步锁（如 `parking_lot::Mutex`）或 pending abort 集合登记中断。长期建议采用专用 session actor。

---

### 3. `SessionEnd` 事件可能重复发送

**涉及文件**：
- `src-tauri/src/ai/engine/simple_ai/chat_loop.rs:128,202,219`
- `src-tauri/src/ai/engine/simple_ai/mod.rs:307,415`

**现状**：`run_chat_loop` 在中断路径发送 `SessionEnd`，外层任务在 `Ok(())` 后又发送一次。

**建议**：统一事件所有权。`run_chat_loop` 只返回 `ChatLoopExit` 枚举，仅由外层发送一次 `SessionEnd`。SessionEnd 增加 reason 字段。

---

### 4. 会话没有回收机制

**文件**：`src-tauri/src/ai/engine/simple_ai/mod.rs:63`

**现状**：所有会话永久保存在 `HashMap<String, SimpleAISession>`，无 remove、无 TTL、无 LRU、无最大数量限制。

**建议**：增加 `last_accessed_at`、最大缓存数（如 50）、空闲 TTL（如 2 小时）、关闭会话时显式 remove。前端历史负责长期存储。

---

## P0：上下文压缩逻辑需修正

### 1. Usage 使用"累计输入 token"会严重高估上下文

**文件**：`src-tauri/src/ai/engine/simple_ai/chat_loop.rs:113,284` + `compact.rs:33`

**现状**：
```rust
usage_acc.add(usage.input_tokens);
```
每轮 API 的 input_tokens 已经包含完整历史。例如第 1 轮 10k、第 2 轮 12k、第 3 轮 14k，实际当前约 14k，但 accumulator 累计到 36k。

**后果**：
- 工具轮数越多越早触发压缩
- 压缩后 accumulator 未重置
- 一旦达到阈值后续每轮都可能再次压缩或删除历史

**建议**：使用最近一轮 input token 判断，而非累计。压缩成功后清零 usage，等待下一轮 API 实际 input_tokens。

---

### 2. 无 usage 的兼容服务不会触发压缩

**现状**：部分 OpenAI 兼容服务不返回 usage。`finish_usage() == None` 时上下文永远不会自动压缩，最终只能等 API 返回 context-length error。

**建议**：增加本地 token 估算兜底。先按 4 字符/token（ASCII）或 2 字符/token（中文）保守估算；工具 schema、参数和 tool result 都必须计入。

---

### 3. 压缩摘要丢失工具调用关键信息

**文件**：`src-tauri/src/ai/engine/simple_ai/compact.rs:215`

**现状**：历史序列化只读取字符串 content，会丢失 `tool_calls`、工具名、参数、tool_call_id、结构化 content、Anthropic content block、成功/失败语义。

**建议**：实现结构化的 `render_message_for_compaction()`，对 assistant 消息输出 tool calls 信息，对 tool 结果输出 call_id 和截断后的内容。

---

### 4. 压缩失败被静默吞掉

**文件**：`src-tauri/src/ai/engine/simple_ai/compact.rs:226`

**现状**：网络失败、鉴权失败、解析失败统一回退删除最早 turn。认证失败时反复请求没有意义，诊断信息不足。

**建议**：区分错误类型——401/403 记录错误并禁用本轮及后续压缩尝试；网络/5xx 允许回退。增加 session 级 `compact_disabled` 标记。

---

## P0/P1：MCP 生命周期与可靠性

### 1. 每次 `run_chat_loop` 都重启全部 MCP server

**文件**：`src-tauri/src/ai/engine/simple_ai/chat_loop.rs:94`

**现状**：在 start_session、continue_session、dispatch_agent 子任务中都调用 `McpClientPool::from_servers()`，每次重新 spawn 子进程、handshake、tools/list。

**后果**：
- 续聊首 token 延迟高
- Subagent 成倍增加子进程数
- 有状态 MCP 无法保持状态
- 插件初始化成本反复支付

**建议**：MCP pool 放入 `SimpleAISession`，session 创建时启动一次，所有 turn 复用。subagent 默认复用父 pool。session 清理时关闭。

---

### 2. `from_servers` 注释说"并发"，实际串行启动

**文件**：`src-tauri/src/ai/engine/simple_ai/mcp/mod.rs:35`

**现状**：普通 `for` + `.await`。8 个 server 各需 1 秒初始化则需 8 秒。

**建议**：使用 `futures_util::stream::iter` + `buffer_unordered(4)` 或 `join_all`。设置独立初始化超时 10～15 秒。

---

### 3. MCP stderr 被管道捕获但无人读取

**文件**：`src-tauri/src/ai/engine/simple_ai/mcp/client.rs:56`

**现状**：`.stderr(Stdio::piped())` 但无人读取。缓冲区填满后子进程可能阻塞。

**建议**：启动独立 stderr reader，按行通过 tracing 输出，限流并对敏感内容脱敏。或使用 `Stdio::null()`。

---

### 4. MCP reader EOF 时 pending 请求等满 10 分钟

**文件**：`src-tauri/src/ai/engine/simple_ai/mcp/client.rs:244`

**现状**：reader EOF 后直接退出，pending 请求只能等 600 秒 timeout。

**建议**：reader 退出时 drain pending map 关闭所有 oneshot sender，标记 server exited 状态，可选监听 `child.wait()` 输出 exit code。

---

### 5. MCP 控制面与生成工具使用同一 600 秒超时

**文件**：`src-tauri/src/ai/engine/simple_ai/mcp/client.rs:25`

**现状**：initialize、tools/list、tools/call 共用 `MCP_CALL_TIMEOUT_SECS=600`。

**建议**：分级超时——initialize 10 秒、tools/list 10 秒、普通 tools/call 60～120 秒、生成类工具通过配置覆盖到 600 秒。同时监听父 session abort。

---

### 6. MCP 工具名可能超出模型供应商限制

**格式**：`mcp__{server_name}__{tool_name}`

**风险**：部分兼容 API 对 function name 有限制（长度、字符集 `[A-Za-z0-9_-]`）。

**建议**：增加规范化与冲突检测，维护 sanitized name → 原 server/tool 映射。重名时追加短 hash。

---

## P1：HTTP 与流式协议

### 1. 每轮请求都创建新的 `reqwest::Client`

**文件**：
- `src-tauri/src/ai/engine/simple_ai/chat_loop.rs:158`
- `src-tauri/src/ai/engine/simple_ai/compact.rs:111`

**现状**：无法复用 TCP 连接、TLS session、connection pool、DNS 缓存。

**建议**：在 `SimpleAIEngine` 持有共享 client。不同 profile 不同 timeout 时使用 `tokio::time::timeout` 包裹或按 timeout 缓存少量 client。

---

### 2. SSE 解析按单行 `data:` 假设，兼容性有限

**文件**：`src-tauri/src/ai/engine/simple_ai/chat_loop.rs:241`

**现状**：按换行切分只接受 `data: {...}`。不接受无空格版本 `data:{...}`，不按空行分割 event，EOF 后不 flush 残留行。

**建议**：抽出独立 `SseDecoder`——支持 `\n`/`\r\n`，按空行完成 event，合并多个 `data:` 字段，允许 `data:` 后无空格，EOF flush。

---

### 3. JSON 解析错误被静默跳过

**现状**：
```rust
let Ok(chunk_json) = serde_json::from_str::<Value>(data) else { continue; };
```
供应商返回错误对象或协议变化时用户最终看到空回复。

**建议**：维护诊断计数 + 首个错误数据截断预览。若整轮无有效 delta 且有解析错误则返回明确协议错误。

---

### 4. 流中断没有重连或"部分结果"语义

**现状**：流中断直接抛错，已推送到前端的 partial token 没有进入 session 历史。UI 看到内容但后续上下文不知。

**建议**：明确策略——将已有 `assistant_content` 写入历史并标记 incomplete，或前端收到 error 事件后明确这段内容不回写。

---

## P1：工具执行性能与安全

### 1. 多个同步文件工具直接阻塞 Tokio worker

**涉及文件**：
- `src-tauri/src/ai/engine/simple_ai/tools/fs.rs`
- `src-tauri/src/ai/engine/simple_ai/tools/search.rs`
- `src-tauri/src/ai/engine/simple_ai/tools/apply_patch.rs`

**现状**：`std::fs` 操作直接在 async task 内执行。bash 已用 `spawn_blocking`，文件搜索未用。

**建议**：search_files、glob、大文件 read/write、apply_patch、递归 skill/agent 扫描放入 `spawn_blocking`。

---

### 2. `search_files` 对每个文件整文件读取

**文件**：`src-tauri/src/ai/engine/simple_ai/tools/search.rs:143`

**现状**：即使文件上限 2MB，仍用 `std::fs::read` + `String::from_utf8`。

**建议**：使用 `BufRead::read_line` 按行读取。达到 200 matches 后立即停止。大仓库可优先调用项目已有搜索服务。

---

### 3. 无明确工作目录边界或沙箱

**现状**：`resolve_path` 接受绝对路径和 `..`，模型可读写工作区外任意路径。

**建议**：提供 profile/session 级策略——`workspace_only`、`allow_absolute_paths`、`allowed_roots`。Shell 同理。

---

### 4. 工具调用串行执行

**文件**：`src-tauri/src/ai/engine/simple_ai/chat_loop.rs:340`

**现状**：模型一轮返回多个工具时逐个串行执行。

**建议**：P2 优化——只读无副作用工具允许并行，写文件/Shell/computer 保持串行。

---

## P1：Agent 与 Subagent

### 1. Agent 工具白名单已实现但未接入

**涉及文件**：
- `src-tauri/src/ai/engine/simple_ai/agent.rs:15`（解析）
- `src-tauri/src/ai/engine/simple_ai/tools/mod.rs:171`（注册表支持）

**现状**：`with_allowed_tools()` 已存在，`run_chat_loop` 未接收 agent allowed tools。agent frontmatter 中 `tools:` 指定不生效。且当前 MCP 工具完全绕过白名单。

**建议**：将 agent policy 作为 session/loop 参数传递。明确 MCP 是否受白名单控制。

---

### 2. Subagent 实际是同步阻塞，不是真正并行

**文件**：`src-tauri/src/ai/engine/simple_ai/tools/agent.rs:103`

**现状**：dispatch_agent 在当前工具调用中直接 await 子循环，父 Agent 需等子 Agent 结束。

**建议**：短期保持同步降低复杂度。若要支持并行需先完成：共享 MCP pool、独立事件归属、统一取消树、并发上限、结果聚合。

---

### 3. 子 Agent 事件与父 UI 语义混杂

**现状**：子 session ID 为 `parent#sub1-agent`，但共用父 event callback。token/tool event 可能进入不可见或错误的 session。

**建议**：增加显式 `AgentRunStart/Delta/End` 事件，父对话只保留一个 agent-run block。

---

## P2：可维护性与可观测性

### 1. 配置散落在 `custom_env` 字符串中

**现状**：`SIMPLE_AI_TIMEOUT_SECS` / `STREAM_IDLE_SECS` / `MAX_TOOL_ROUNDS` / `CONTEXT_WINDOW` / `RETRY_MAX` / `RETRY_BASE_MS` / `DISABLE_SUBAGENT` 等配置无类型校验、前端不可发现、非法值静默回退。

**建议**：集中解析为 `SimpleAIRuntimeConfig` struct，每轮只解析一次，非法值输出 warning。

---

### 2. 文档已落后于实现

**现状**：
- `docs/simple-ai-codex-refactor-plan.md` 仍写 Phase 3 待续，但 usage/retry/compact 已实现
- `plans/simpleai-tools-fix-plan.md` 中的 P0 工具问题大部分已修复

**建议**：拆分为架构文档（现状）和 roadmap（未完成项），关键取舍通过 ADR 记录。

---

### 3. 缺少关键集成测试

**现状**：纯函数单测完善，但异步集成路径缺乏覆盖。

**高风险路径**：
- 连续两次 continue_session
- start 后立即 interrupt
- MCP 子进程异常退出
- SSE 分片跨 chunk / 多 data 行
- 压缩后 usage 重置
- 父中断传播到 subagent
- partial stream error 后历史一致性

**建议**：实现本地 mock HTTP server + mock MCP stdio server 测试完整 loop。

---

## 推荐实施顺序

### 第一批：正确性（2-3 天）
1. Session turn 串行化，禁止并发回写覆盖
2. SessionEnd 统一到外层发送一次
3. 修正 context usage：改为最近一轮 input，非累计
4. 压缩后重置 usage
5. 增加无 usage 时的本地 token 估算
6. 增加会话回收策略

### 第二批：MCP（2-4 天）
1. MCP pool 移入 session，续聊和 subagent 复用
2. server 并发启动
3. initialize/list/call 分级超时
4. 消费 stderr
5. EOF/进程退出立即失败 pending 请求
6. 工具名规范化与冲突检测

### 第三批：性能和协议（2-3 天）
1. 共享 `reqwest::Client`
2. SSE decoder 独立模块化
3. 文件搜索、patch 等迁入 `spawn_blocking`
4. Partial stream 历史策略
5. 错误响应与解析诊断增强

### 第四批：Agent 策略与产品化（2-4 天）
1. 接入 agent 工具白名单
2. 明确 MCP 是否受白名单控制
3. 工作区路径边界策略
4. Subagent 结构化事件
5. Typed runtime config
6. 更新架构文档与 roadmap