# Polaris 对齐 ZCode：下一步优化路线（分析稿，未实施）

> 状态：规划 · 归属：前端为主 · 日期：2026-10-18
> 方法论：每项先给「证据」（本会话实际核验的源码，不臆测），再给动作与验收。
> 与本次已落地工作（prompt 历史上键召回，commit 1fc1ce07）衔接：同类问题排查中发现的第一批缝隙。

---

## 已完成基线（本次 1fc1ce07）

- prompt 历史：模块化 + cap.kv 持久化 + 发送事务 + IME/修饰键防护（对齐 Z `promptHistory` 三件套）
- 顺带修复一个跨层缺口：`store.sendMessage` 的 boolean 失败信号此前被
  `v2-kernel.ts` / `useActiveSession.ts` 吞掉（现以 `SendResult.ok` 透传）

---

## 优化项清单（按优先级）

### P0-1 AIEvent 协议运行时校验（补最大架构缺口）

**证据**
- Z：`packages/shared/src/zcode-protocol/index.ts` 用 zod 为**全部方法契约/请求响应/事件**提供
  单一来源 schema，UI 与 Agent 共用（约 257 个导出，含废弃词清理机制）。
- P：AGENTS 自认「协议无运行时 schema 校验是已知缺口」；AIEvent 双侧手工对齐
  （`src-tauri/src/models/ai_event.rs` 1868 行 + `src/types/` camelCase）；`package.json` 无 zod/valibot/ajv。
- 实际痛点已多次发生：MCP schema exe 过期、事件 handler 静默错配（eventHandler.test 的防御性用例即土法校验）。

**动作（渐进，不冒进）**
1. 依赖决策：引入 `zod`（倾向），评估点：bundle 体积（可 lazy import 校验器）。
2. 先覆盖**高频流式事件 + session_end/interrupt/tool 三族**（错误高发区）做前端
   parse→fallback：解析失败不崩 UI，降级为 unknown 块 + warn 日志（沿用历史召回服务的
   「失败降级不阻塞」模式）。
3. schema 放 `src/types/aiEvent.schema.ts`，与 `src/types/` camelCase 类型同文件互推（`z.infer`），
   Rust 侧**不重复**——以 Rust 结构体为唯一权威，前端 schema 校验漂移并在 CI 抓。
4. 验收：新增 `eventHandler.schema.test.ts`（畸形 payload fuzz 数例）；网络层入口单点接入。

### P0-2 执行既有 pendingQueue 定稿方案，并核对「重启可恢复」

**证据**
- `plans/pending-queue-optimization-final.md` 已是对照 Z v4 队列（queue.ts / prompt-admission.ts）
  的**定稿**：批次 1 五项（失败保留队首/代际校验/派发互斥/按钮状态机/编辑撤回）。
- 本次事务化改造后 `dispatchNextPending` 的「失败保留」语义与该方案补丁 A 完全互补，
  应一次把它们接上（`sendMessage` 已返回 boolean，实施成本降低）。
- 「保留纯前端内存态」是既定架构决策（不迁后端权威队列）——**重启丢队列/丢草稿**是
  该决策的已知代价，是否补 cap.kv 持久化属于新决策，需先核对再定。

**动作**：按定稿实施批次 1；批次 2 单独评估；「重启恢复」（队列 + `inputDraft` 纯内存，
重启即失）列为**待讨论项**——若用户确认要，走 cap.kv（promptHistoryService 同范式），
不引 localStorage。

### P1-1 中断收尾去超时化（对齐 Z 未吞中断目标）

**证据**
- P：`createConversationStore.ts` interrupt 用 5s `setTimeout` 强制收尾兜底 +
  代际校验防误杀——是 AGENTS「不用超时掩盖同步问题」原则下的已知妥协（记忆
  `ai-chat-interrupt-continue-root-cause` / `simpleai-interrupt-bug-confirmed` 记录过根因）。
- Z 思路：中断调用方与处理方**明确归属**（调用方 = 用户/系统动作，处理方唯一 finalize = session_end），
  幂等消费、不双写、无误杀；busy/running 输入走 `CommandInbox` 串行准入。

**动作**
1. 先读 `eventHandler.interrupt.test.ts` 与后端 `ai_engine.rs` 现状，定位「晚到 stop 不被消费」
   的具体点位（已有记忆，先核对是否复现）。
2. 方向：把 5s 兜底从「纯时间」改为「中断确认事件 + 代数号」——后端 interrupt 消费时
   回执一个一次性 ack 事件，前端收到 ack 即取消兜底；ack 缺失才走兜底。归属唯一：只有
   session_end handler 做 finalize（interrupt 分支不做双 finalize）。
3. 验收：interrupt 幂等/误杀回归用例；两台真机长跑。

### P1-2 ChatInput 增量拆分（易触碰文件优先，克制执行）

**证据**
- Z：composer 完全模块化（`v4/composer/*` 十余个单职责 store/hook + `lib/` 纯函数 + 测试），
  改行为不用碰千行文件。
- P：`ChatInput.tsx` 2010 行（AGENTS 巨型文件清单在列），历史/草稿/队列/建议/语音/优化
  六类逻辑内联；**且是本会话与 pendingQueue 方案反复触碰的热点**——符合 AGENTS
  「只拆新增改动经常触碰的文件」门槛。

**动作（只拆常改区，不动其余）**
1. 建议引擎（`handleInputChange` 中 @/、//、/ 检测 ~600 行 inline）→
   `useSuggestionEngine` hook + 纯函数模块，补单测（触发条件是 bug 高发区）。
2. 历史/草稿随 promptHistory 模块维持现状；队列状态机待 pendingQueue 批次 1 落地后
   顺势收进 `usePendingQueueController`。
3. 验收：`tsc` + 相关 vitest + 一次真机回归；行数降至 <1500。

### P2（远期/低频，记录不动）

- **Lexical 或等价结构化输入**：Z 的 prompt-editor 已支撑 slash 插件、历史 plugin、
  update-tag 语义、拖拽；P textarea 结构表达力有限。成本高，仅在建议引擎拆分后
  评估收益再立项。
- **CI 门槛收紧**：knip（未使用导出）、husky、clippy gate（`-D warnings -A dead_code`）
  ——AGENTS 已有分阶段策略，按节奏推进即可，不重复规划。
- **消息时间线虚拟化对照**：Z v4 ConversationTimeline 做了 virtual history + prefetch；
  P `SessionMessagesView` 除非出现长会话性能投诉，否则不动。

---

## 排序逻辑

1. P0-1 协议校验：把「已知缺口」变「有兜底的缺口」，一次投入长期收益（错误提前到 CI）。
2. P0-2 队列：方案已定稿、本次改动已降低实施成本，属「收割既有规划」。
3. P1-1 中断：根因已知、复现路径在记忆里，风险最高（误杀用户运行）。
4. P1-2 拆分：为后续所有输入框改动降摩擦，但要克制。
5. P2 只登记不立项。

## 图：中断归属（P1-1 目标态）

```
用户/系统中断 ──interrupt──▶ 后端引擎（消费 stop）
     │                              │
     │                     ack(sessionId, 晚到与否均回执，幂等)
     ▼                              ▼
 前端 isInterrupting ──(ack 到达取消 5s 兜底)──▶ 等 session_end
                              （唯一 finalize：finishMessage 一次，dispatchNextPending 一次）
```
