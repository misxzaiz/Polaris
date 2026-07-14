# 下一代上下文压缩方案（Next-Gen Context Compaction）

> 状态：规划中（2026-07-15）
> 关联：`docs/adr/0005-simpleai-hybrid-context-compaction.md`（后端混合式压缩 ADR，Proposed）
> 关联：本次已实施的「压缩交接」`src/services/contextCompactHandoff.ts`

## 一、问题回顾与当前基线

用户最初的 `400: input prompt token len 291514 + max_new_tokens 32000 > 262144` 报错，
揭示了上下文压缩的**三重断裂**：

1. **时机断裂**：压缩触发线按标称窗口（1M）估算，实际上游中转站只认 256K → 触发太晚。
2. **死锁断裂**：原地压缩需把整段历史发给模型求摘要，但历史已超窗 → 压缩请求自身 400。
3. **质量断裂**：单次区间摘要丢失工具语义、thinking、决策链；多次摘要累积失真。

本次实施的「压缩交接」解决了 2（开新会话式交接，新会话开局近空）和部分 3（结构化
briefing + sanitizeBriefing 后处理），但 1 和「原地继续」场景仍未解决。

当前三套压缩机制现状：

| 机制 | 位置 | 触发 | 调 LLM | 关键局限 |
|---|---|---|---|---|
| 前端 messageCompactor | `messageCompactor.ts` | Virtuoso 可视区 | 否 | 纯渲染裁剪，与 token 无关 |
| SimpleAI auto-compact | `compact.rs` + `chat_loop.rs` | last_input≥window×0.75 | 是 | 单次区间摘要，大原文超窗仍死锁；同会话内 |
| Claude CLI compact | CLI 黑盒 | /compact 或 autoCompact | CLI 内部 | Polaris 无注入点；窗口错配仍 400 |
| **压缩交接（本次）** | `contextCompactHandoff.ts` | 用户手动一键 | 是 | 开新会话式，绕开死锁，但改变用户习惯 |

## 二、下一代目标

下一代压缩需同时满足：

1. **不改变用户习惯**：默认原地继续，不开新会话、不改 conversationId、不删历史。
2. **不死锁**：即便历史远超窗口，压缩动作本身也能完成（不要求一次读全）。
3. **不丢关键信息**：保留最近工具链完整、决策链可追溯、旧历史可按需回查。
4. **触发准确**：按真实窗口而非标称估算，提前在安全边界压缩。
5. **失败非破坏**：网络/鉴权/超窗失败绝不删除历史，可回滚。
6. **可移植**：三种 wire protocol（OpenAI Chat / Anthropic / Responses）同语义。

## 三、核心方案：三层自适应压缩 + 滚动分段摘要

### 3.1 三层模型上下文（继承 ADR 0005 D2）

压缩后的模型上下文由三部分组成：

```
Pinned Bootstrap Context      ← 永不压缩：system/persona/项目指令/Skill 索引
+ Structured Handoff Briefing ← 旧历史的结构化摘要（内部 user-role block）
+ Token-Budgeted Recent Exact Turns ← 最近 N 个完整回合原始结构
```

关键约束（ADR 0005 已论证）：
- briefing 作为**内部 user-role 上下文消息**，不提升为 system（避免提示注入升权）。
- recent tail 保留完整 `TurnGroup`（user + assistant text/tool_calls + tool results），
  不切断 tool_call 与 tool_result 配对。
- pinned context 在会话创建时记录 `bootstrap_end` 边界，不再用「index 0」隐式假设。

### 3.2 滚动分段摘要（解决死锁的核心创新）

ADR 0005 未明确「briefing 本身超窗怎么办」。本方案补充：**briefing 生成采用滚动
分段摘要（rolling segment summarization），而非一次性喂全文**。

```
源会话历史（可能 300K+）
  │
  ├─ 按 TurnGroup 切成 N 段（每段 < 0.6 × 真实窗口）
  │     段1 ─► 摘要1 ┐
  │     段2 ─► 摘要2 ┤  （每段摘要时，把上一段摘要作为前缀上下文滚动带入）
  │     段3 ─► 摘要3 ┤  → 保证跨段决策链连续
  │     ...          ┘
  │
  └─ 合并所有段摘要 ─► 按结构化 schema 产出最终 briefing
```

每次摘要请求只发一段（< 窗口），**永不撞窗口**。滚动带入上一段摘要保证跨段连续性。
这是「交接式压缩」中 agent 自行分段 Read 的等价物，但落地在后端 Polaris 侧，
不依赖 agent 的 Read 工具，可移植到所有引擎。

> 注：本次「压缩交接」已用「驱动真实 agent 会话，让它自行 Read 存档分段」实现了
> 等价语义。滚动分段是后端原地压缩场景下的对应实现。

### 3.3 触发改为「下一次请求大小」预算（ADR 0005 D5）

删除累计 `UsageAccumulator.total_input` 触发。每次发送前估算最终 wire request 大小：

```
usable_input_budget = context_window − reserved_output_tokens − safety_margin
soft_threshold  = 75% × budget   （安全 turn 边界自动压缩）
hard_threshold  = 90% × budget   （下一请求前必须压缩或阻塞）
target_after    = 45%~55% budget （压缩后回落目标）
```

**窗口来源改为真实窗口**：profile.context_window 优先，但增加「中转站实测窗口」
配置项，解决 1M 标称 vs 256K 实际的错配（本次报错根因）。

### 3.4 本地恢复档案（ADR 0005 D3）

自动压缩的旧历史写入应用数据目录（非工作区）：

```
<DataRoot>/simple-ai/context-checkpoints/<stable-conversation-id>/
  manifest.json
  checkpoint-0001.jsonl   ← 被归档的完整原始内部消息
  checkpoint-0002.jsonl
```

原子写入（tmp → rename）。每个 checkpoint 含 schema version、generation、
bootstrap boundary、briefing、recent-tail boundary、校验值。

后续增加只读工具 `read_context_archive(query, turn_range, tool_name, max_tokens)`，
让模型按需查询旧细节，单次限 4K~8K token，不接受任意路径——既满足「需要时可回查」，
又避免通用 read_file 把整份历史灌回。

### 3.5 只在安全边界压缩（ADR 0005 D6）

常规自动压缩只发生在：
- session idle，准备接受/发送下一条用户消息时；或
- 一个 assistant turn 完整结束后。

禁止在 tool_call 与 tool_result 之间压缩。手动请求在流式中记录为
`pending_manual_compaction`，下一个安全边界执行。

仅当 provider 明确返回 context-length 错误时，进入 `ContextLimitRecovery` 紧急路径：
写 checkpoint → 紧急压缩 → 对原请求重试一次；仍失败交给用户选择，不删历史。

## 四、分阶段实施路径

后端 Rust 重构改动量大，且本机 `cargo test --lib` 能编译但不能运行（Tauri DLL
依赖），只能 `cargo check --lib` 验证。因此分阶段、先验证后启用。

### Phase 0 — 已完成（本次提交）

- ✅ 「压缩交接」功能：手动一键、后台异步、结构化 briefing、sanitizeBriefing 后处理、
  简报作为待发送上下文卡片（不塞输入框）。
- ✅ sendMessage 的 runtimeOverride 机制（静默会话指定配置发送）。
- ✅ 提示词格式硬约束 + 后处理双保险去开场白。

### Phase 1 — 窗口错配修复（可立即实施，纯配置层，零 Rust）

**解决用户最初报错的根因（时机断裂）。**

- ModelProfile 的 `context_window` 增加「中转站实测窗口」字段（区别于标称）。
- SimpleAI 压缩触发线改按实测窗口算，默认 0.75 阈值落在真实窗口的 ~190K（而非 1M 的 75 万）。
- 文档提示用户：连中转站时务必填写真实窗口，避免标称/实际错配。
- 验证：`cargo check --lib`；配置改完即生效，无需重编译引擎。

> 这一项能立刻止血：在窗口快满时提前触发，而不是等到已经超窗才压缩。

### Phase 2 — 滚动分段摘要（后端，核心创新）

- 在 `compact.rs` 新增 `summarize_with_rolling_segments`：当待压区间估算 >
  0.6 × 窗口时，按 TurnGroup 切段，逐段调 `request_summary_once`，滚动带入上段摘要。
- 复用现有 `request_summary_once` / `build_request_body` / `extract_summary_text`。
- 复用 `select_compact_range` 的 TurnGroup 配对对齐逻辑做切段边界。
- 验证：`cargo check --lib` + 单测（纯函数切段/合并可单测）。

> 这一项解决死锁断裂：后端原地压缩也能处理超窗原文。

### Phase 3 — 非破坏失败策略（后端，紧急）

- 移除 `fallback_drop_oldest`（ADR 0005 D9，删除历史的破坏性兜底）。
- context-length 错误专用 `ContextLimitRecovery` 路径：写 checkpoint → 紧急压缩 → 重试一次。
- 失败一律保持原历史，提示重试。
- 验证：`cargo check --lib`。

### Phase 4 — 本地 checkpoint 持久化（后端）

- `<DataRoot>/simple-ai/context-checkpoints/` 目录 + 原子写入。
- manifest.json 跟踪 generation / bootstrap_end / recent_tail_boundary。
- 压缩成功才提交 checkpoint，失败回滚。
- 对话删除时清理对应 checkpoint；启动时清理无主/过期 checkpoint。

### Phase 5 — 三层上下文重建 + 只读回查工具（后端）

- `SimpleAISession` 增加 `bootstrap_end` / `compaction_state` / `stable_conversation_id`。
- 压缩后重建 messages = pinned + briefing(internal user block) + recent tail。
- `read_context_archive` 只读工具：按 turn_range / tool_name 查询旧细节，限 4K~8K token。

### Phase 6 — 自动压缩启用 + 手动入口对齐（后端 + 前端）

- 手动「Condense context」入口先于自动上线（ADR 0005 D7），验证 briefing 质量。
- 自动压缩默认关闭，手动验证稳定后再默认开启。
- 前端时间线插入非对话型「Earlier context condensed」状态标记（可展开看 briefing）。

## 五、与本次「压缩交接」的关系

「压缩交接」（开新会话式）和「下一代原地压缩」是**互补**的两条路径：

- **压缩交接**：用户主动、开新会话、跨引擎、绕开死锁。适合「阶段性收尾、换个引擎继续」。
- **下一代原地压缩**：自动/手动、原地继续、不改变会话身份。适合「长对话无感继续」。

两者共享：结构化 briefing schema、sanitizeBriefing 后处理、滚动分段摘要思想、
`request_summary_once` 基础设施。下一代落地后，压缩交接可复用滚动分段逻辑，
不再依赖「agent 自行 Read」。

## 六、本会话实施范围

本会话已完成 Phase 0。鉴于：

- 后端 Phase 2~6 改动量大、且本机无法运行测试（只能 cargo check）；
- ADR 0005 已是成熟的 528 行设计，无需重复设计；
- 用户已休息，不宜在无验证条件下大改后端引擎核心。

**本会话下一步实施 Phase 1（窗口错配修复，纯配置层、零 Rust、可 cargo check 验证）**，
这是能立刻止血、风险最低、且直击用户最初报错根因的一项。Phase 2~6 留待后续会话
在有完整测试环境时推进，按本规划文档分阶段执行。
