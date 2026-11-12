# 需求登记：Git 与版本管理域插件化（真外移 + 删除内置）

> 状态：**已登记 · 待评审 · 未实施**（用户 2026-11-11 口述为「下一个需求」）
> 登记日期：2026-11-11 · 工作分支：`main`
> 本次动作：仅登记需求，**未改动任何代码**；实施须另经批准（AGENTS.md §二.4、core-slimdown §9）。
> 关联文档：`plans/git-plugin-ui-implementation-spec.md`（2026-11-11 UI/交互实施规范 · GLM 执行版）、`plans/git-plugin-ui-interaction-prototype.html`（配套高保真原型）、`plans/git-plugin-ui-prototype-check.js`（原型回归脚本）、`plans/git-plugin-ui-prototype-analysis.md`（2026-11-11 UI 原型与四条宿主关系缺口分析，§4 六问的细化结论）、`docs/git-plugin-extraction-plan.md`（2026-08 方案）、`plans/core-slimdown-plugin-extraction-plan.md` §4.3（不拆定案）、`plans/git-panel-master-plan.md`:82（单 cap.git 定案）、`plans/git-backlog-r6-spec.md`（R6 欠账）、`AGENTS.md` §3.2 / §五（cap 清单与功能路由原则）。

---

## 1. 需求原文与目标

用户原话：**「在功能不变，甚至做得更好的情况下，实现 Git 与版本管理插件，并删除内置的 Git 与版本管理。」**

拆解为三条硬要求，验收时逐条判定：

| # | 要求 | 判定口径 |
|---|---|---|
| R1 | 功能不变 | 迁移前后功能等价，逐项回归；不允许能力缺失、行为降级、性能显著退化 |
| R2 | 甚至做得更好 | 允许并鼓励增强，但不得牺牲 R1；「更好」必须是评审时列明、可验收的具体项，不接受笼统表述 |
| R3 | 实现插件 + 删除内置 | 插件仓落位 + 主仓真删码；**不接受「插件作轻量入口、内置保留」的折中**（该折中正是 2026-08 的结局） |

---

## 2. 与既有定案的冲突（本需求的核心）

| 时间 | 出处 | 结论 |
|---|---|---|
| 2026-08-16 | `docs/git-plugin-extraction-plan.md` | 已落地 `polaris-git` 外部插件 + 主项目 Phase 0 解耦；但实施中修正为：外部插件面板是独立 ESM blob，**无法 import 主仓 `@/` 路径**，故内置 GitPanel 保留（更完整：branch/rebase/stash/tags/PR）、后端 git2 不动，外部插件仅作轻量独立入口。 |
| 2026-11-06 | `plans/core-slimdown-plugin-extraction-plan.md` §4.3 | Git 域列入**明确不拆清单**（~25k 行），理由：cap.git 是 bus 静态注册的 AI 核心工具；GitPanel 深耦合编辑器（gutter/blame/changeNavigator 扩展点）；git-panel P0-P3 演进中。仅标「远期观察项：待系列收尾、编辑器扩展贡献点开放后再评估**仅拆 UI**」。 |
| 2026-11-11 | 本需求 | 要求完整插件承接 + 删除内置，且功能不变甚至更好 —— **推翻上述两条结论，也不止于「仅拆 UI」**。 |

**唯一权威约束（AGENTS.md §二.2）**：本需求生效后，§4.3 的 Git 行与 2026-08 方案「保留内置」的结论必须同步修订并指向本文件，不可两份矛盾文档并存。**评审批准前，既有不拆定案仍然有效**，本文件只是需求登记，不构成实施授权。

---

## 3. 删除范围基线（2026-11-11 工作区实测）

按功能域聚合（口径同《按功能模块代码量统计》）：**150 文件 / 40,358 总行 / 31,602 有效代码行**，其中前端 23,416、后端 8,186，含 44 个测试文件 9,599 行。

主要构成（实施 spec 须逐文件复核，不直接以此数字作承诺书）：

- **前端**：`components/GitPanel/`（51 文件 / 12,836 有效行）、`components/Diff/`（16 文件 / 1,215）、`stores/gitStore/`、`services/git*.ts`（gitContextService / gitNlQuery / gitAtomicGrouping / gitEditorService / commitMessageChat / atomicCommitChat）、`utils/gitFormat.ts`、`types/git.ts`、`plugin-system/editor/{gitGutter,blameHover,changeNavigator}`、Chat 内 GitSuggestion / ContextChip 等。
- **后端**：`services/git/`（22 文件 / 6,114）、`router/git_capability.rs`（1,362 有效行 / 1,640 总行，router 内最大文件）、`models/git.rs`、`web/api/ipc.rs` 的 `dispatch_git_*` 分支、`lib.rs` 的 git_* 命令注册、`Cargo.toml` 的 git2/libgit2 依赖。
- **视图/宿主耦合**：`viewStore` / `tabStore` / `CenterStage` / `toolSwitcherData` 的 git 字面量、`FileExplorer/GitStatusIndicator`、i18n git 命名空间、errorMapping 的 git.errors.*。

说明：该数字按「路径前缀 + 命名关键词」聚合，包含可能被非 Git 场景复用的 Diff/DiffViewer 等；实际删除清单以实施 spec 的逐文件核对为准，并标注「随域迁出 / 保留宿主 / 通用化救出」三类（参照 B1-6 救出 `snippetService.ts` 的先例）。

---

## 4. 评审前置：必须回答的六个架构问题

1. **`cap.git` 归属**：AGENTS.md §3.2 将 `cap.git` 列为已装配能力（feature 门控），`git-panel-master-plan.md`:82 定「单 cap.git + 能力内二级校验，不拆多 capability」。删除内置后，AI 的 git 工具能力由插件 MCP 提供，还是宿主保留薄 cap 转发？权限 gate、审计链、`aiToolAccess` 门控如何不中断？涉及 cap 契约则须「后端 + 前端 + 插件仓」三处同步。
2. **编辑器扩展点**：gitGutter / blameHover / changeNavigator 现由主仓 `editorExtensionRegistry` 注入，2026-08 结论是 CM6 扩展必须挂在宿主编辑器实例。插件如何提供等价能力？是否需新增「插件贡献 CM6 Extension」契约（本需求 R1 的最硬交界）。
3. **插件面板自包含**：2026-08 实测外部插件无法 import 主仓 `@/`；B2-1 电台 L1 迁移亦实测 41 种 / 95 处 `@/` 别名依赖。完整 GitPanel 如何自包含？需先复用 B2-1 的替代方案结论。
4. **后端引擎与功能等价**：现为 git2/libgit2 + 55 个 tauri 命令；插件侧走 Node 调 git CLI（docs 方案 B）还是 Rust 独立进程？rebase / cherry-pick / 冲突解决 / lane graph / undo 快照等高级能力如何保证不降级（R1）？docs 方案 §5 的 golden test 思路可作为验收起点。
5. **DiffViewer 归属**：可能被 Chat patch 渲染复用；docs 风险表已列此裁定点，删除主仓 Diff 前必须给出结论。
6. **桌面 / Web 双端**：Web-only 模式下插件服务与 git CLI 可用性；若不可用须显式声明，不能以「功能不变」名义掩盖端侧降级。

---

## 5. 验收口径（把 R1/R2 变成可验证项）

- **功能等价回归清单**：以 `docs/git-plugin-extraction-plan.md` §1.1 功能盘点 + `git-panel` P0~P3 + `git-backlog-r6-spec.md` 已交付项为基线，逐项标注「保留 / 增强 / 降级」；**降级项为零**方可合并，人工冒烟覆盖桌面 + Web 双端。
- **门禁**：`pnpm typecheck` / `pnpm lint` / `pnpm test:run`、`cargo check`、`cargo check --no-default-features --bin polaris-web --bin polaris-mcp`（命令门控双方向），对齐 core-slimdown §7。
- **行数对账**：主仓净删除行数与实施 spec 预估一致（±20%），无半拆残留（孤儿组件、死 manifest、死 i18n key、死命令注册、死 cap 注册）。
- **三处同步**：主仓删码 + 插件仓新增并发布（含 `update.json` 热更新链路验证）+ `AGENTS.md` §3.2 cap 清单 / §五 MCP·bin 清单同步。
- **R2 具体化**：评审时明确「更好」的验收项（候选：插件可独立发版/热更新、`--standalone` 独立运行、AI 工具覆盖度、性能不退反进、高级操作体验增强），逐项可测；未被列明的改进不计入 R2。
- **回滚**：主仓删除以单独 commit 落地，插件仓保留前一版本 zip，revert 边界干净（core-slimdown §5）。

---

## 6. 前置与排期（待确认）

- **优先级**：用户称「下一个需求」；与 core-slimdown 剩余批次（B1-7 Browser、B2-1 电台、B2-2 IM、B2-4 Translate）的先后关系待确认，是否插队由用户裁定。
- **地基前置**（core-slimdown §6）：插件级 hostInvoke 白名单、manifest 校验补齐、Web 模式插件服务管理放行。B2-1 电台 L1 正在趟这条路，其结论应直接复用，避免重复踩坑。
- **演进中状态**：git-panel P0~P3 与 R6 E 组（AI-6 归纳层 / AI-5 agentic / 插件示例）尚有未完项；「演进中」曾是 §4.3 的不拆理由，需确认是否在迁移前收尾或冻结。
- **插件仓现状**：2026-11-11 实测 `D:\space\base\Polaris-plugin\plugins\polaris-git` **目录不存在**（仅有 `gitignore-lens`），2026-08 的外部插件不可直接复用，需新建或重建；插件 id / 命名 / `enabledByDefault` 策略待定（docs 方案 §7 待确认问题 1 仍适用）。
- **折中禁止**：不得重演「插件轻量入口 + 内置保留」；若评审认为 R1 无法在插件形态下满足，应如实回报并回到用户裁定，而不是悄悄降低 R3。

---

## 7. 状态与下一步

- [x] 需求登记（本文件，2026-11-11）
- [x] 在 `core-slimdown-plugin-extraction-plan.md` §4.3 的 Git 行加冲突注记，指向本文件
- [x] UI 原型与宿主契约缺口分析：`plans/git-plugin-ui-prototype-analysis.md`（2026-11-11，仅分析未改码）。§4 六问已细化：cap.git 归属 → 该文 §3/§7.1 的 A/B 边界裁定；编辑器扩展点 → §2.4/H3；面板自包含 → `terminal-desk` 现成范式；DiffViewer 归属 → §2.4/H6；**新增第 7 问：AI kind 会话与回流契约 → §2.2/H2（R1 硬阻塞）**
- [x] UI/交互设计交付（2026-11-11，仅文档与原型，未改生产代码）：`plans/git-plugin-ui-implementation-spec.md`（15 章：四层承载、GP-01~11 交互合同、H1–H6 宿主契约、Phase 0–3 与硬停点、§15 GLM 启动语）、`plans/git-plugin-ui-interaction-prototype.html`（自包含、可离线、模拟数据）、`plans/git-plugin-ui-prototype-check.js`（44 项断言全部通过）。**该规范是 UI 专项稿，不替代 §4 评审通过后的整体实施 spec，也不构成删码授权**；默认基线为方案 A（保留 cap.git + services/git/ 作宿主 SCM 运行时），若改方案 B 须重做数据与双端评审
- [x] 用户裁定（2026-11-12 AskUserQuestion）：①本轮包含删码（插件真宿主验证通过后单独 commit，删除可独立 revert）；②插件能力范围=查询+暂存/提交（Phase 1 写路径），AI 会话/gutter/中央 Tab 留待 H2/H3/H4 契约批次
- [x] 第一批已实施（2026-11-12，范围缩减版）：插件 `plugins/polaris-git` v0.1.0（查询+暂存/提交，真宿主 E2E：shadow 接管/status/diff/历史/分支/stage→commit 落库复核全通过）+ 主仓删内置 GitPanel 面板（63 文件，cap.git/services/git/gitStore/gitEditorService/DiffViewer/编辑器三扩展保留宿主），实施记录/缺口清单/门禁实测见 `plans/git-panel-plugin-extraction-implementation.md`
- [x] 第二批已实施（2026-11-12 用户反馈驱动）：插件 v0.2.0 承接 discard/分支写/远程 fetch-pull-push/stash 写/标签/右键菜单/.gitignore 编辑 + 样式对齐宿主（token 病根修复，见实施记录 §7）；H2/H3/H4 契约仍待批次
- [ ] 后续批次：冲突三方合并器/Interactive Rebase/blame/Reflog/Undo UI（依赖 H4/H3 契约）；R1「功能不变」为分批交付（实施记录 §6 缺口 G1/§7）
- [x] §4.3 注记已修订为「面板已插件化第一批」；`docs/git-plugin-extraction-plan.md`「保留内置」结论已声明失效（详见实施记录 §文档同步）

> 记录人注：本需求与 2026-08、2026-11-06 两次结论直接冲突，**冲突本身是需求的一部分**，不要在实施 spec 里绕开；先把 §4 六问答完，再谈迁移。
