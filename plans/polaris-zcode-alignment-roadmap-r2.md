# Polaris 对齐 ZCode：下一步优化路线 R2（换批清单，未实施）

> 状态：规划 · 日期：2026-10-18
> 与 R1（`polaris-zcode-alignment-roadmap.md`：协议校验/队列/中断/拆分）并列备选，两轮不重复。
> 标准：每项先给本会话核验的源码证据，再给动作与验收；证据不足处如实标注「核验不足」。

---

## R2-1 发送上下文解析去重（AGENTS「provider 单权威」的起始步）

**证据（本次逐行核验）**
- `createConversationStore.ts` 中 sendMessage 与 continueChat 各自维护一份完全相同的
  Profile/模型五步解析块：`resolveEffectiveProfileId → resolveEffectiveProfileMode →
  isProfileModeWithoutProfile → normalizeModelForProfile → effectiveProfile 决定官方端点`
  —— 两处重复出现在 L2070–L2095 与 L2278–L2300（每个 ~30 行 × 2）。注释还互相引用
  「与 sendMessage 路径一致」，即靠**人肉同步**保一致。
- 反例基准：Z 的 `packages/provider` + `packages/model-option-map` 把这类解析收成
  单一权威包，多入口只读。
- 风险：改 Profile 规则必须改两处；漏一处 = continueChat 静默走错端点（AI 行为级 bug，
  无报错）。这是 R1 已修的「kernel 吞 boolean」同款问题模式：**多写路径靠约定不靠类型**。

**动作**
1. 抽 `resolveSendModelContext(storeSnapshot, sessionConfig)` 到
   `src/services/`（或 conversationStoreUtils），返回
   `{ engine, modelProfileId, profileMode, resolvedModel, ... }`；
2. sendMessage / continueChat / 后续 interrupt 重试等入口统一消费，一次测试两处受益；
3. 直接为该函数补 Table 驱动单测（官方哨兵 / 会话覆盖 / 别名归一 / 未选 Profile 三态）。

**验收**：`tsc` + 新增单测绿；两处解析输出完全一致（可用快照断言双路径同输入同输出）。

**规模**：小（~1 天内）。收益/成本比在本清单最高。

---

## R2-2 架构治理工具链补位（knip + pre-push 检查）

**证据**
- Z：`pnpm knip`（knip.json）、`pnpm architecture:check --changed`、
  `pnpm dep:refs --list-exports <file>`、`pnpm verify:pre-push`；
  还把「架构治理」做成了 agent skill（`.agents/skills/architecture-governance`）。
- P：`package.json` scripts 仅 typecheck/test/lint（本会话核验）；
  AGENTS 一节自认「knip/husky 是后续工作项」「clippy 存量治理中」。
- 实际后果：本会话在 Z/P 对照中发现的每类问题（吞 boolean、双份解析、纯内存队列）
  都属于「架构问题靠人审而不是靠机器抓」。

**动作（按 AGENTS 既有分阶段策略落地版）**
1. `knip.json` + `pnpm knip`：先**只出报告**不加门（存量导出多，直接 -D 会误伤预留 API）；
   报告人工分类 → 死代码 allowlist（模块级 `#![allow(dead_code)]` 的 TS 对应物）→ 再收紧。
2. `pnpm verify:pre-push`：lint + typecheck + test:run（存量 85 个环境性失败先钉成
   「已知失败清单」文件，verify 时 diff 新增失败，避免整批绿灯假象）。
3. architecture:check 式「依赖方向检查」暂缓——现有 lint + Code Mode 审查够用，
   教育成本大于收益，挂起。

**验收**：knip 报告产出并把全部发现分类完毕；verify:pre-push 可跑通且只对「新增失败」报警。

---

## R2-3 Rust 测试基建：让 cargo test 真正可用

**证据**
- P：AGENTS 明言「本机 cargo test --lib 不可用（Tauri DLL 启动限制）」，后端测试验证
  实际退化为 `cargo check`（无断言）+ 前端 vitest 代言。这意味着 Rust 侧
  （40 个 commands、RouterBus 十几个 capability、data_root、interrupt 引擎）**零可执行断言**。
- Z：`apps/zcode-cli/packages/*` 各包自带 test 目录（packages/services/test 独立存在），
  核心 runtime 与 UI 宿主解耦后才可能独立测试。
- 方向与 AGENTS「命令门控」一节（polaris-web / polaris-mcp no-default-features 构建）同源：
  已存在 testable 面向上跑通的通道。

**动作（方案级别，需先调研落点）**
1. 调研环节：确认 `cargo test --lib` 失败是「tauri::Builder 初始化 DLL」还是全局符号污染；
   若仅后者，`#[cfg(test)]` 隔离 + feature 门即可，不必拆 crate。
2. 备选：把 `services/router/*`（capability 层，无 tauri 类型）抽为独立 crate
   （`polaris-core`），tauri bin 只做装配——这是 commands/ 旧路径迁移的同一方向目标。
3. 第一批可测对象（纯 Rust、无 IO）：`data_root.rs` 路径解析三态（env > anchor > 默认）、
   `kv_capability` 事务写、`policy_permission` 判定。

**验收**：`cargo test` 至少覆盖上述三个纯逻辑模块；CI 增加 rust-test job（依赖 R2-2 的
verify:pre-push 模式）。

**核验不足声明**：DLL 失败的具体报错本会话未复现，步骤 1 是前提。

---

## R2-4 全局按键注册表（bindings + conflicts）

**证据**
- Z：`packages/ui/src/shortcuts/`——`bindings.ts`（单文件声明全部按键，含 `ArrowUp` 的
  物理键映射）+ `conflicts.ts`（冲突检测把 `ArrowUp` 列入敏感表）。上键这套我们刚修完
  的功能，在 Z 是「注册表注册、冲突预警」的体系一部分。
- P：按键处理分散自管（本会话 grep 证据）：ChatInput、AskQuestionCard、Editor、
  FileSearchModal、ReferencesPanel、SymbolPalette、TerminalRunCommandModal 各写各的
  keydown；全局注册表只有 `Settings/KeyCapture.tsx` 一角。
- 风险：同一按键（尤其 ArrowUp/Escape）在多组件可用时行为取决于 compose 顺序——
  ZCode `editorUpdateTags.ts` 记录的「CRITICAL 优先级吞光标移动」就是这类事故的
  一次性长写。

**动作**
1. 建 `src/utils/keybindings.ts`：现役全局键（含 chat 输入框/面板/编辑器）集中声明 +
  `detectConflict()`；
2. 只收编组件内「preventDefault 的按键」登记（不动行为），先出冲突清单；
3. 冲突清单为零前不强制收编行为（低优先，给仪表盘不 Rush 立法）。

**核验不足声明**：Z conflicts.ts 的具体冲突规则未深读，只确认结构存在。

---

## R2 排序逻辑

R2-1 > R2-2 > R2-3 > R2-4。理由：R2-1 是**已有行为正确性问题**（双份解析迟早漂移）
且最小；R2-2 是治理杠杆（后面每项都受益于失败清单/报告工具）；R2-3 是补最痛的
验证空白但要先调研可行性；R2-4 是预防性仪表盘。
