# 007 · AIEvent 协议运行时校验（最小可行）spec

> 来源：需求库 needs/007（analyzed，2026-10-31 夜班闭案）。状态：specd，待拍板。
> 所有者：前端单收口（事件泵层）+ 测试资产；**Rust 侧零改动**。

## 目标

填补 AGENTS.md §4.1 点名的「协议无运行时 schema 校验」缺口的最小可行版：改协议时「编译通过但运行时漂移」能被即时捕获。**方向修正（分析定案）**：serde 反序列化默认已拒未知变体（前端→后端天然有门），真空门在**前端接收侧**——TS 类型是手抄的、运行时裸奔，后端新枚举值/漂移字段会静默流入 UI。

## 方案（两层，都不动 Rust）

### 1. 前端 parse guard（单一收口）

- 位置：AIEvent 到达前端的第一站（session-v2 事件泵 / 会话事件消费入口，实施时 grep 确认**唯一**收口位，不散在 UI 组件）。
- 行为：对每个事件的关键枚举字段（ToolCallStatus / TaskStatus / SessionEndReason / PlanStatus / PlanTaskStatus / PlanStageStatus + AIEvent 顶层 kind tag）做字面量表校验；未知值**兜底归 misc/unknown + `logger.warn`（含原始值）**，不抛错不炸 UI——对齐 zcode 引擎 misc kind 既有兜底语义，保证「新后端枚举值不炸旧前端」。
- 必填字段仅校验 id/turnId 级标识（实施时按 AIEvent 结构定最小集），不做全量深校验。

### 2. 双边 parity 测试（漂移即红）

- 真相源：`src-tauri/src/models/ai_event.rs`（7 枚举：ToolCallStatus:17 / TaskStatus:48 / SessionEndReason:352 / PlanStatus:582 / PlanTaskStatus:602 / PlanStageStatus:613 / AIEvent:1599）。
- 做法：一次性导出 Rust 侧序列化样例 fixture（每个枚举每个变体一条最小 JSON，放 `src/__fixtures__/ai-event-parity/`）；vitest 断言前端字面量表与 fixture 集合完全一致。
- 演练验收：故意改前端某枚举字面量 → parity 测试变红（证明门槛有效）。

## 边界（明确不做）

- 不重构 AIEvent 类型体系；不引入 protobuf/JSON Schema；不改 serde 序列化框架；不触碰 AI 引擎中断链路；Rust 侧不加 deny_unknown_fields（破坏向前兼容）。

## 验收（可执行冒烟）

1. `pnpm exec tsc --noEmit` + `pnpm test:run` 全绿（新增 parity 测试 + guard 单测：合法值直通、非法值落 misc、warn 有原始值）。
2. 漂移演练变红→回滚变绿（截图或输出记录在条目）。
3. 冒烟：真实会话跑一轮 AI 对话（含工具调用/计划事件），UI 无回归、日志无新增意外 warn。

## 风险

- 收口点若存在多条事件泵（桌面/Web/zcode 引擎三条流），guard 必须三处共用同一实现（导出单函数），禁止复制粘贴三份字面量表——字面量表单文件导出（`src/types/aiEventGuards.ts`）。
- fixture 生成是一次性人工动作（Rust 测试或手写），协议大改时需同步再生成——在 fixture 头部注明生成来源与日期。
