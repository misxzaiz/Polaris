# C2 thinking 流并入 50ms 缓冲 + 消除 O(n²) 字符串拼接 — 实施 spec

> 2026-11-01 多 agent 投票胜选（112.5/125， plans/perf-ux-round2-plan.md §投票结果）。
> 证据状态：行号在 main@e31c89b2 实读核验；实施时以语义定位为准。

## 一、病灶（5 位评审逐行实证）

- `src/stores/conversationStore/eventHandler.ts:502-505`：case 'thinking' 每 delta 调 `appendThinkingBlock`（对照：text 路径同样逐 delta 调 `appendTextBlock` 但内部有缓冲）；
- `src/stores/conversationStore/createConversationStore.ts:931-961`：`appendThinkingBlock` 每 delta 执行 `set({currentMessage: {...}})` 全量 blocks 数组拷贝 + `content: lastBlock.content + content` **全量字符串重拼（O(n²)，评审定位 ：947-948）** + `streamingUpdateCounter+1`；
- 对照范式（同文件已验证）：text 路径 `appendTextBlock:798` 用闭包级 `_textBuffer` O(1) 追加不触发 Zustand + `STREAM_FLUSH_INTERVAL = 50`（:341）+ 段落边界/超时/首 token 立即 flush（:816-870 一带，含迟到 token 防御 :823-827）；
- `streamRate` 的 set 已自带 100ms 节流（pushStreamDelta tracker），不干扰本方案量化口径；
- 工具路径无流式 delta（`tool_call_start` 一次写全 args，eventHandler.ts:555），不在本例范围。

## 二、修法（与 text 范式严格对称）

1. 新增闭包级 `_thinkingBuffer`：`appendThinkingBlock` 改为 `_thinkingBuffer += content`（O(1)，不触发 set），**原块操纵逻辑整体移入 `_flushThinkingBuffer`**（fold/merge/create currentMessage 逻辑原样保留，仅把入参从每 delta content 改为 flush 时一次性 buffer 内容）。
2. flush 触发点（全部与 text 范式对称）：
   - **首 token 立即**：`!currentMessage` 时立即 flush（首响不延迟）；
   - **50ms 定时**：复用既有定时器/超时保护，一次 flush 先 thinking 后 text（保持块时序）；
   - **类型切换点**：`appendTextBlock` 入口先 `_flushThinkingBuffer()`（其现有 fold 检查随后自然看到已落块的 thinking）；`appendToolCallBlock` 入口同样先 flush thinking（现只 flush text，须补 thinking）；
   - **收束点兜底**：`finishMessage`（session_end/中断统一收束，eventHandler.ts:472 → createConversationStore :414-416 已有 text 兜底）同点补 thinking 兜底 flush——覆盖中断场景（评审确认中断终止统一经 session_end→finishMessage）；
   - **迟到 token 防御（复核员红线）**：`:823-827` 一带 isStreaming=false 后迟到的 thinking delta，须与 `_textBuffer` 同等处理（flush 后追加到最后一条助手消息），不允许静默丢弃。
3. `streamingUpdateCounter` 语义不变：仍由 flush 触发 +1，delta 期间不再逐条 +1。
4. 50ms 丢失窗口语义与 `_textBuffer` 完全对称（已被接受的风险面，注释说明依据）。

## 三、验收（vitest flush 矩阵，本机实跑）

扩展 `src/stores/conversationStore/streamingFlushCadence.test.ts`（+ 按需 `thinkingFold.test.ts`）：

1. 纯 thinking 流：首 delta 立即出块；50ms 窗内多 delta 合并一次 flush（断言 counter 增量/set 次数）；
2. thinking→text 切换：text 首 token 前 thinking 已落块并折叠（现 fold 行为不回归）；
3. text→thinking 交替：块序正确（text 块先落，后续 thinking 为新块）；
4. tool_call 到达前 thinking 先 flush；
5. finishMessage/session_end 兜底：缓冲不丢字（中断场景含在内）；
6. 迟到 token：isStreaming=false 后到达的 thinking 追加到最后消息；
7. 内容完整性：长思考（≥1000 delta）最终内容 === 逐 delta 顺序拼接（O(n²)→O(n) 后零丢失）；
8. 既有 `streamingFlushCadence` / `thinkingFold` / `eventHandler.*` 全部保持绿。

## 四、边界与红线

- 只动 `src/stores/conversationStore/`（预计 createConversationStore.ts + 2 个测试文件）；**零协议触碰**（AIEvent 类型、Rust 侧零改动——若实施中发现必须动 .rs，立即停手上报，视为方案缺陷）；
- 中断幂等语义不得变化（AGENTS.md §4.2）：本例只改「内容何时进 store」，不改任何中断判定/归属；
- 提交拆分（commitlint 合规）：①`docs(plans)` 本 spec；②`perf(chat)` 缓冲实现+测试；③ 如有语义需文档同步再补 docs。工作树内提交，git status 干净收工；
- 注释用中文写根因与依据（AGENTS.md 原则 5），说明 50ms 窗口与 _textBuffer 对称性。

## 五、门禁

```bash
pnpm exec tsc --noEmit          # 前端门槛
pnpm lint                        # 0 error（存量 warning 口径不变）
pnpm exec vitest run src/stores/conversationStore   # 快速门禁
pnpm test:run                    # 全量终门（2443 基线）
```

Rust 门禁说明：本例零 .rs 改动，以 `git diff main...HEAD --stat` 无 `src-tauri/` 文件为准，不重跑 cargo（主仓 rust 未触碰）。
