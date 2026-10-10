# ZCode 对标 Polaris 优化点分析 v2（现状复查 + 新维度）

> 状态：增量核查稿。基于 v1 报告（`plans/zcode-benchmark-optimization.md`，2026-10-10 凌晨产出）做落地复查，并新增 ZCode 上轮未覆盖的治理维度。
> 对照基准：`temp/ZCode`（AI 编程工作台 monorepo，Electron + Web + Agent CLI）
> 核查方式：直接读 Polaris 当前源码（`src-tauri/src`、`src/`、`package.json`）与 ZCode 治理文件（AGENTS.md / DESIGN.md / architecture-policy.yaml / knip.json / scripts/）。
> 结论基调：**v1 的工程治理缺口仍 100% 未落地**；健康检查并行化是唯一已修复的 P0；同时发现 4 个 v1 未覆盖的新优化维度（spec 先行、provider 单权威、UI 设计规范、前端大文件清单）。

---

## 〇、v1 建议落地复查

| v1 工作项 | 优先级 | 当前状态 | 证据 |
|---|---|---|---|
| typecheck + cargo check 进 CI/本地 | P0 | **未落地**。scripts 仍无 typecheck；无 clippy 门槛 | `package.json` scripts 仅 dev/build/tauri/lint/security:audit |
| 启动性能：health_check 串行 spawn | P0 | **已修复** ✅。`health_check` 已是 async 版，注释明确「并行 spawn 子进程，O(max) 非 O(sum)」 | `src-tauri/src/lib.rs:484` `health_status_async` |
| 启动性能：假进度蒙板 / mermaid 静态引入 / Google Fonts | P0 | **未落地**。mermaid 仍在 vite manualChunks 拆成 mermaid-core 独立 chunk（首帧仍重）；未发现 ConnectingOverlay 真实进度 | `vite.config.ts:135-143` |
| architecture-check（maxFileLines + --changed） | P1 | **未落地**。无脚本、无 policy 文件 | scripts 无 architecture；repo 无 architecture-policy.yaml |
| husky + lint-staged | P1 | **未落地**。无 `.husky` 目录 | 根目录无 .husky |
| knip | P1 | **未落地**。无 knip.json、scripts 无 knip | 根目录无 knip.json |
| 广播事件必填 reason | P1 | 部分。session-v2 Reconcile 方向对，但未见统一 enforce | 需进一步在 session-v2 内核查 |
| 中断安全护栏（stop expected id + 幂等） | P2 | **未落地**。`ai_engine.rs` 无 expected/idempot 逻辑 | grep ai_engine.rs 无命中 |
| 命令层→cap 总线迁移 | P2 | **部分推进**。RouterBus 已装配 cap.ai.chat（含 form_submit/skip 等动作）、cap.bash、cap.todo；但 `src-tauri/src/commands/` 仍 40 个文件 | `services/router/ai_chat_capability.rs`、`bash_capability.rs` |
| cap.form 主进程装配 | P2 | **已落袋** ✅。`services/form_flow.rs` 存在，cap.ai.chat 的 form_submit/form_skip/form_template_save 动作直接调用 | `ai_chat_capability.rs:275/365/424` |
| 协议运行时校验（zod/schema） | P2 | **未落地**。AIEvent 前后端对齐但无 schema | grep 无 zod/schema 校验层 |
| 日志分级（debug 不落盘 / warn 限频） | P2 | 未强制落地 | `utils/logger` 存在，缺分级强制 |
| 巨型 store/文件拆分 | P3 | **未动**。browser.rs 仍 3977 行、createConversationStore.ts 仍 2535 行；**新增** ipc.rs 2686 行 | 下方清单 |
| UI hooks 访问层门面 | P3 | 未落地。store 仍 56 个平铺 | `src/stores` 56 个条目 |

**核心结论**：v1 报告过了大半天，只有 2 项 P0/P2 落地（health_check 并行、cap.form）。工程治理空白没有改善——这本身说明 **Polaris 缺的不是分析，而是把规范变成可执行门槛的执行力**。

---

## 一、新增：ZCode 治理三板斧（v1 未充分展开）

ZCode 的可执行治理 = **3 个文件 + 3 个脚本门槛**，这是它「规范能落地」的根因：

### 1. AGENTS.md —— 给 AI 的行为宪法（Polaris 最缺）
ZCode `AGENTS.md` 是**给 coding agent 的强制性行为规则**，Polaris 侧目前只有 `README.md`（面向人）。关键可移植条款：
- **spec 先行**：「新增或修改行为前，先更新对应 spec；先明确产品规则、状态所有者、接口和验收场景，再实现代码。」
- **唯一权威**：「避免重复状态和多条写入路径。明确唯一所有者、接口、依赖方向、事件顺序与幂等边界，不能用超时掩盖同步问题。」
- **实现与验证绑定**：「必须执行 typecheck 和 lint，报告真实结果，不将已有失败写成通过。」
- **UI 边界**：「组件通过 hooks 访问服务；禁止 UI 直接调用 Repo / Service 引用 Runtime 实现细节；Zustand 状态位于 store/。」

**Polaris 落地**：新建根目录 `AGENTS.md`（Polaris 目前根目录无此文件），把上述条款按 Polaris 实际结构改写（cap 总线 + session-v2 + store 边界）。收益：后续每次 AI 协作都受同一约束，比靠记忆/口头约定可靠一个量级。

### 2. DESIGN.md —— 给 AI 的 UI 宪法（Polaris 缺）
ZCode `DESIGN.md` 明确：「This file is meant for coding agents. When generating or editing UI, follow this file before inventing new visual rules.」并给出**可强制检查的硬约束**（如「UI 组件必须用 text-ui-* 刻度，禁止 text-base / text-[13px]」）——不是风格建议，是 design-system 缺陷。

**Polaris 现状**：无 DESIGN 规范文件（`DES*G*.md` 无命中）；主题有 7 层 88 维度的 `.polaris-theme` 系统（见记忆 `theme-system-10round-research`），但缺面向 AI 的「UI 硬约束」文档。建议补一个轻量 `DESIGN.md`：只写**可检查**的约束（间距刻度 / 主题 token 使用 / 禁止硬编码颜色字号），让 AI 改 UI 时有唯一依据。

### 3. architecture-policy.yaml + architecture-check 脚本 —— 把规范变成退出码
ZCode：`maxFileLines: 400 / maxContractLines: 300 / maxPublicMethods: 12 / forbidCycles / forbidDeepImports / managedOnly`，配合 `scripts/architecture/architecture-check.mjs check|report|baseline:update`，进 `verify:pre-push`。

**Polaris 落地**：可先用**最轻一版**——只做 `maxFileLines` + `--changed` + baseline，不追求 layerOrder/managedOnly 全量。Polaris 当前最大文件已到 3977 行，baseline 直接放进去，门槛只卡「新增/变更」文件，零阵痛起步。

---

## 二、新增：spec 先行 与 provider 单权威（Polaris 可借鉴）

### 1. spec 先行
ZCode 把「先 spec 再实现」写成 AGENTS 规则 + 目录约定。Polaris 有 `plans/`（方案文档），但方案与实现没有绑定关系——没有「改动前先更新对应 spec」的强制。

**Polaris 落地（低成本）**：在 AGENTS.md 写入「行为改动先补 spec（简短），存在 plans/ 下」，并把 `/spec` 命令（Polaris 已有，见记忆 `spec-command-integration`）纳入协作流程。不强求 ZCode 的目录结构，只要**先文档后代码**的次序被约束住。

### 2. provider 单权威
ZCode `packages/provider/src/` 有 `account-provider-service.ts / effective-model-selection.ts / model-selection-config.ts`——**模型/供应商选择收敛到一个服务**。Polaris 有 SimpleAI 的模型供应商配置（`config/provider` 对比），但选择逻辑分散在引擎/命令层。

**Polaris 落地（中成本）**：把「当前生效模型选择」（默认引擎 + 供应商 failover + 用户覆盖）收敛成单一 `ModelSelectionService`，前端读取同一投影，避免多端选择不一致。这同时呼应记忆 `provider-group-failover-plan`（V1-V7 验证矩阵）——两者可合并推进。

---

## 三、新增：前端大文件清单（v1 只列了 3 个，实际 10+）

v1 列了 browser.rs(3977) / createConversationStore.ts(2535) / ai_chat_core.rs(2547) / ChatInput.tsx(2010)。**实测 Polaris 现有 10 个 >1800 行文件**：

| 文件 | 行数 | 备注 |
|---|---|---|
| `src-tauri/src/commands/browser.rs` | 3977 | 仍最大，未拆 |
| `src-tauri/src/web/api/ipc.rs` | 2686 | **v1 未列，新发现**（Web IPC 聚合层） |
| `src-tauri/src/services/ai_chat_core.rs` | 2547 | 未拆 |
| `src/stores/conversationStore/createConversationStore.ts` | 2535 | 未拆 |
| `src-tauri/src/services/ask_listener.rs` | 2384 | 未拆 |
| `src-tauri/src/services/plugin_service.rs` | 2046 | 未拆 |
| `src/components/Chat/input/ChatInput.tsx` | 2010 | 未拆 |
| `src-tauri/src/services/mcp_config_service.rs` | 1893 | v1 未列 |
| `src-tauri/src/integrations/manager.rs` | 1881 | v1 未列 |
| `src-tauri/src/models/ai_event.rs` | 1868 | v1 未列 |

**结论**：不是「几个孤例」，是**系统性超行数**。单纯靠「自觉拆」不可行，必须靠 maxFileLines 门槛 + baseline 渐进收紧逼出拆分优先级（browser.rs / ipc.rs / createConversationStore.ts 三件优先）。

---

## 四、复查后修正/细化的 P0 建议

1. **health_check 已并行化** ✅ —— 启动性能只剩「假进度蒙板 + 首帧体积」两项（见记忆 `startup-performance-analysis`），建议按原清单继续，但收益排序里「health_check 串行」已可从待办中移除。
2. **工程治理门槛仍是最高杠杆**：typecheck script + clippy 门槛 + architecture-check(maxFileLines) + husky/knip，四件都未动，且是 ZCode 与 Polaris 差距的本质。
3. **AGENTS.md + DESIGN.md 补齐**是 v1 未覆盖、成本最低、杠杆最高的新建议（两个文件即可把「给 AI 的行为约束」制度化）。

---

## 建议执行顺序（v2 修订）

| 优先级 | 工作项 | 收益 | 成本 |
|---|---|---|---|
| P0 | 补 `AGENTS.md`（spec 先行 + 唯一权威 + UI 边界，改写自 ZCode） | 每次 AI 协作受同一约束 | 低（1 文件） |
| P0 | `typecheck` script（tsc --noEmit）+ Rust `clippy -D warnings` 进 CI | 类型/静态兜底 | 低 |
| P0 | 启动性能剩余项（蒙板真实进度 + 首帧减重） | 首屏 | 中 |
| P1 | 轻量 architecture-check（maxFileLines 400 + baseline + --changed） | 防巨型文件恶化 | 中 |
| P1 | husky + lint-staged + knip | 提交前门禁 | 低 |
| P1 | 补轻量 `DESIGN.md`（可检查的 UI 硬约束） | 改 UI 有唯一依据 | 低 |
| P2 | provider 单权威 ModelSelectionService（合并 failover 计划） | 多端模型选择一致 | 中 |
| P2 | 中断安全护栏（stop expected id + 幂等） | 防误杀/中断失效 | 中 |
| P2 | 协议运行时校验层（先关键枚举 + 必填） | 防漂移 | 中 |
| P3 | 巨型文件拆分（browser.rs / ipc.rs / createConversationStore.ts 优先） | 可维护性 | 高 |

## 结论

v1 的方向全对，但**执行才是瓶颈**——过半建议（尤其是四个工程治理门槛）在产出后大半天仍原样未动。v2 的最大增量不是新分析，而是：

1. **把 AGENTS.md / DESIGN.md 提到 P0**——它们是「让 AI 自动遵守规范」的自举机制，比任何单项脚本都更能改变 Polaris 的长期工程质量；
2. **承认并定量「系统性超行数」**——10 个 >1800 行文件意味着拆分不能靠自觉，必须靠门槛逼出；
3. **启动性能清单减负**——health_check 并行化已完成，别再重复排期。
