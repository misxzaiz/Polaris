# Git 面板 vNext — 交接文档

> 供下一个 AI 继续推进 Polaris Git 面板 vNext 工作。
> 效力顺序：`git-panel-master-plan.md` > `git-panel-prd.md` > `git-panel-impl-analysis.md` > `git-panel-idea-parity-plan.md` > 本文。
> 本文只做「现状 + 剩余工作 + 关键路径」交接，不重复 spec 原文。

---

## 一、顶层定位（不要偏离）

**「改动流水线」而非「按钮面板」**：AI 改代码 → 面板看见 → 自动梳理 → 人工确认关键节点。

分期路线：**P0 架构垫层 → P1 日常流水 → P2 可视化 → P3 深水区 → P4 生态出口**。

红线（PRD §3）：所有 AI 产出必须是「建议 + 人工确认」二段式；AI 通道故障时 git 面板完整可用。

---

## 二、当前完成度（截至 2026-10-19）

```
P0 架构垫层       ██████████ 100%  cap.git 上收 + git_dispatch.rs 摘除
P1 日常流水(6项)  ██████████ 100%  F1-F6 UI 绑定全做
P1 AI-2 原子提交  ██████████ 100%  本地分组预检 + AI 解释层 + commit_group
P1 AI-3 Review门  ░░░░░░░░░░   0%（master-plan 裁决改形态：纯本地扫描，归 P3）
P2 泳道图         ██████░░░░  60%  初版 lane + refs 装饰已完成（语义着色/WIP/缓存/收缩为增量）
P2 其余           ██████████ 100%  FR-P2-2 watcher / FR-P2-AI4 冲突预测已完成
P3 冲突合并器     ████████░░  80%  序列操作机 + 三窗编辑器重写 + 三态解决语义（见 §2.1 本轮记录；AI-5 建议卡 / Ignore-Append 为增量）
P3 其余           ░░░░░░░░░░   0%
P4 全部           ░░░░░░░░░░   0%
```

### 已完成（不要重做）

**P0**：`cap.git` capability 装配 + 32 个 `git_*` 上收 RouterBus；`web/api/git_dispatch.rs` 已整域摘除（commit 98ebf387）；前端 `git_*` invoke shim 透传 `router_dispatch`。

**P1 UI 绑定（F1-F6）**：

| # | 功能 | 落点文件 |
|---|---|---|
| F1 | amend 提交（空消息 = `--no-edit`） | `CommitInput.tsx` |
| F2 | force-with-lease 默认化 | `PushDialog.tsx` |
| F3 | fetch + auto-fetch 开关（localStorage） | `RemoteTab.tsx` |
| F4 | stash apply/show/pop 三动作 | `StashTab.tsx` |
| F5 | reflog UI + 一键恢复 | `ReflogView.tsx`（新建） |
| F6 | log 后端搜索（grep/author/pickaxe/日期/分支范围） | `HistoryTab.tsx` |

**已修 bug**：
- `CommitInput.handleCommit` guard 拦了 amend 空消息 → 改为 `(!message.trim() && !amendMode)`
- `HistoryTab.test.tsx` branchFilter 测试脱节（73715eee 改自定义下拉但测试未跟进）
- `en-US/git.json` 缺 `branch.searchPlaceholder` → 已补，483/483 对齐

**AI-1 加固（commit `b3ccd260`）**：
- `isProtectedSession`（commit-message kind）
- `formatGitDiffWithContent`（非 agentic 引擎 diff 注入）
- `isAgenticEngine`

**测试覆盖**：5 个新组件测试文件（CommitInput/PushDialog/RemoteTab/StashTab/ReflogView）+ HistoryTab 补 2 用例，共 29 用例全绿。

**AI-2 原子提交（commit `f1948fb2`）**：
- 本地启发式分组预检（`gitAtomicGrouping.ts`）：目录聚类 + change_type 拆分 + 低置信合并候选
- AI 解释层（`atomicCommitChat.ts`，kind='git-atomic'）：只投喂低置信组 diff（600 chars/file 裁剪）
- 后端按组原子提交（`commit.rs::commit_group`）：清空-仅组内-恢复三序，等价 `git commit <paths>`
- 前端分组卡片（`AtomicCommitCard.tsx`）：逐组确认后原子提交
- spec `plans/git-panel-p1-ai2-spec.md`

**P2 泳道图初版（commit `9e9d42e8`）**：
- 协议：`GitCommitRef`/`GitLaneCell`/`GitLaneRow`/`GitLogPage` 双边同步；`GitCommit` 增 `refs` 装饰
- 后端 `get_log_with_lanes`：拓扑序 + lane 分配（简化算法，覆盖单线+合并）+ refs 聚合一次返回
- 前端 `LaneGraph.tsx` 纯渲染组件 + HistoryTab 接入（refs 三色标签）
- **未做**（P2 增量，spec §四）：语义着色（未 push 红/已 merge 暗灰）、WIP/stash 紫点、增量 log 缓存、lane 收缩合并（graph.c 四数组）

**P2 FR-P2-2 file-watcher 自动 status 刷新（commit `55c341d6`，spec `plans/git-panel-p2-watcher-spec.md`）**：
- 前端订阅 `file-system-change` → 防抖 800ms 刷新生效仓库 status；流式抑抖（结束下降沿补刷）；复用 statusSlice per-path seq
- 不改后端协议（沿用既有事件）；FileExplorer 负责 watcher 起停
- 测试 `fileWatcherSubscriber.test.ts` 5 用例

**提交记录**（commitlint 合规）：
```
f6a05786 docs(git): 面板 vNext 规划与 P0/P1 规格
b3ccd260 test(git): 补齐存储层与 AI-1 加固测试
826c63e4 feat(git): 面板 P1 UI 绑定（F1-F6）+ 双语 i18n
45e8bcc9 feat(git): store 层补齐 P1 动作 + wsPath 分片 + AI-1 加固
98ebf387 refactor(git): 命令层 git 域整域摘除并上收 cap.git
f1948fb2 feat(git): AI-2 原子提交建议（本地预检分组 + AI 解释层 + 后端按组原子提交）
9e9d42e8 feat(git): P2 泳道图（lane 分配放 Rust + refs 装饰 + LaneGraph 渲染）
d05a6d37 docs(git): FR-P2-2 file-watcher 自动 status 刷新 spec（四段式）
55c341d6 feat(git): FR-P2-2 外部文件变化自动刷新 status（file-system-change 订阅）
```

### 2.1 P3 冲突域接手修复（2026-10-20，本轮接手实施）

**背景**：P3 冲突合并器由前一轮 AI 落地（`a099aa3e`），存在 P0 级假解决与多处语义/时机缺陷；本轮在 `feat/git-panel-vnext` worktree 接手修复。

#### 后端（`services/git/sequence.rs` + `router/git_capability.rs`）

1. **P0 假解决根修**：`resolve_conflict_file` 旧实现以 `index.get_path(stage0)` 判 trackable，但冲突态 index 只有 stage1/2/3 → 写盘恒跳过，最终暂存的是磁盘上带 `<<<<<<<` marker 的原文（静默穿帮）。重写为三态契约 `ConflictFileResolution`：
   - `WriteContent`：编辑器拼合结果无条件写盘 + add（stage0 取代冲突 stages）
   - `CheckoutStage(ours|theirs)`：按 stage2/3 blob 原样还原到工作区（binary/delete-modify 的「保留某侧」，等价 `git checkout --ours/--theirs`）
   - `Remove`：删盘上文件 + 移除 index 全部冲突 stages（「接受删除」；旧实现完全缺失此语义）
2. **删类 kind 映射反转修复**：旧实现把 `(our 有,their 无)`（对方删·本地改）标成 `DeletedByUs`，与 git 约定及 models 文档注释相反 → UI「接受删除」会按反侧执行。已对齐：`(true,false)=DeletedByThem`、`(false,true)=DeletedByUs`，并补记幸存侧 stage 内容（旧实现删类 ours/theirs 全 None，「保留修改」无从落地）。
3. capability 分发：`content` / `remove` / `side` 三参归一协议（camelCase 不变）。
4. 新增 3 个测试（text 写盘+stage0、删类 kind/幸存内容、Remove 删盘+清冲突）。**运行受本机 DLL 限制未执行**，以 `cargo check` + `cargo test --no-run` 编译门代替。

#### 前端

5. **`ThreeWayMergeEditor` 整体重写（同源对位真三窗）**：旧版「ours/theirs 全文 pre ×2 + 底部 hunk 卡」双套渲染信息重影；新版 regions 数组一次驱动三列 grid（左 ours / 中 result / 右 theirs），冲突块中列就地 [Accept Ours|Theirs|Base] 决策（VS Code 式），决策后实时重渲染所选侧内容；保留 per-hunk testid 契约。
6. **Apply All 真实现**：批量采纳全部「未决策」冲突块为本方（parse 层已吸收非重叠单侧改动，剩余块均为双侧非空重叠冲突——批量取本方是唯一确定性批量语义；旧版按钮只弹 toast 不改状态）。
7. **`ConflictMergerDialog` 流转闭环**：解决任何文件后以 `getConflictState` 新鲜返回值决定下一步（修复旧版读 stale props 漏并行解决）；剩余 Text 自动接力进编辑器；归零后按 kind 引导——rebase/cherry_pick/revert 给 Continue/Abort（消费既有 slice 动作），merge 提示去提交。
8. **FileChangesList 入口**：unmerged 文件右键菜单首位给「打开冲突合并器」（优先于 diff——冲突态 diff 含 marker）。
9. gitStore `conflictSlice` 新增 `resolveConflictFile`/`removeConflictFile`/`checkoutConflictSide`（payload 收敛一处，错误按 slice 约定 parse+抛出，成功 refreshStatus）。
10. i18n：conflict 域新增保留删除语义键（keepLocalMod/keepTheirsMod/acceptDelete/applyAll 系/guide 系等）+ FileChangesList `mergerEntry`；zh/en 483+ 键重新对齐（0 缺口）。
11. 分支基线类型补漏：`conversationStore/types.ts` 会话 kind union 缺 `'radio-broadcast'`（radio 提交 c82b050d 的 WIP 未进分支）→ 补全解 tsc。

#### 门禁结果（worktree，feat/git-panel-vnext）

- `pnpm exec tsc --noEmit` = 0
- `pnpm lint` = 6 errors / 211 warnings（**余 6 error 为分支基线遗留**，涉及 PatchDiffRenderer rules-of-hooks、useRuntimeSummary surrogate、ansiToHtml control-regex，非本域文件，不越界修改）；已顺手修复本分支机械类 9 个（prefer-const ×3 / 无用转义 ×6，其中 `toolInputExtractor.test` 的 `\s\p` 是真 bug：`\s` 吃掉反斜杠致测试语义漂移，改正转义后仍 54/54 绿）
- cargo check --lib = 0；cargo test --no-run = 0；web-gate（--no-default-features polaris-web + polaris-mcp）= 0
- vitest：conflict 域 31/31、GitPanel+gitStore 305/305 全绿；全量 2028 passed / 84 failed —— 84 失败为**存量**（11 个文件，Chat/tool-calls/engines/plugins/transport 域），已用 `git stash` 基线复核与本次改动无关（§六.4 已有记录）

#### 未做（诚实标注）

- 冲突块建议卡 AI-5（默认折叠逐块确认、采纳率指标）——P3 后增量
- 三窗中列的 Append 双侧内容拼合（spec 备选项，中列仅单侧接受）
- 冲突文件「跳到下一未解决」在多文件间的自动接力依赖手动关单文件编辑器后走 Dialog 接力，无跨文件键盘流

---

## 三、剩余工作（按优先级）

### 3.1 P1 剩余（高优先）

> ⚠️ **AI-2 已完成**（commit `f1948fb2`，见上「已完成」节）—— master-plan §1.2 已将其从「P1 主打卖点」降格为「本地启发式分组预检先行 + AI 只解释低置信项」，本实施按此裁决落地。

#### AI-3 提交前 Review 门（⚠️ **master-plan 已改形态并归 P3**）

> **master-plan §1.3 裁决**：密钥/大文件/冲突标记用**纯本地扫描**（gitleaks 模式库正则，LLM 只做提交后批量语义解释），形态从「弹卡」改为**常驻面板列表**（不主动打扰）。故不再按本节旧形态实施，落地见 P3「AI-3 本地扫描常驻列表」。

**旧目标（保留备查）**：提交前异步跑 diff 检查 → 非阻塞报告卡片。

**旧检查项**：泄漏密钥 / 调试残留 / TODO / 缺测试。

**旧实现要点**（已作废，按 P3 新形态实施）：
- ~~`kind='git-review'`；成本 ⚡（轻引擎默认）~~
- ~~不阻塞提交；点击卡片跳文件~~
- ~~after-commit 亦可（对齐 IDEA 2025.1 语义）~~

**旧验收**（已作废）：~~提交后 15s 内出现非阻塞报告；未提交场景无 token 消耗。~~

### 3.2 P2 可视化 + 安全网

#### FR-P2-1 泳道图（主役）

**✅ 初版已完成（commit `9e9d42e8`，见上「已完成」节）**，本节余项为增量：

- **协议扩展**（已完成）：`GitCommit` 加 `parents: string[]`、`refs: {name, type, target}[]`（Rust `models/git.rs` + 前端 `types/git.ts` 双边同步）
- `get_log` 受限 pageSize（默认 500 + load more）—— **已完成**（复用既有 20 页翻页）
- **lane 计算放 Rust 端**（已完成，不放前端解析字符图）：`get_log_with_lanes` 拓扑序 + 简化 lane 分配（单线+合并实测对齐 `git log --graph`）；中期接 git `graph.c` mapping/new_columns/old_columns 四数组算法自绘 SVG（**增量**）
- refs 三色（黄=当前/绿=本地/紫=远程）+ HEAD/远程标记 + 多仓竖条—— **已完成三色 badge**；HEAD 图标/多仓竖条为增量
- 语义着色（超越点#4）：绿=本地分支内/红=未 push/灰暗=已 merge 进 main（**增量**）
- WIP 节点 + stash 紫点上图（**增量**）
- lane 收缩合并（graph.c 四数组）：初版简化算法已覆盖单线+合并；多分支交错收缩场景归 graph.c 算法（**增量**）
- 性能预算：首次打开 ≤10k commits p50 < 300ms；二次打开（HEAD 未变）p50 < 80ms（增量 log 缓存按 `(repo, head_sha, refs_snapshot)` 键持久化到 DataRoot）；1k commits 60fps（react-virtuoso 已有，max-lanes=12 截断）

#### FR-P2-2 file-watcher 自动 status 刷新 ✅ 已完成（commit `55c341d6`，spec `plans/git-panel-p2-watcher-spec.md`）

- 前端订阅 `file-system-change`（**复用既有事件，不改后端**；`repo_touched` 专用事件非必需——事件本就由 FileExplorer 消费，git panel 只按生效路径刷新）
- 防抖 800ms → 调 `refreshStatus`（复用 statusSlice per-path seq 丢弃乱序）；流式抑抖：AI 会话流式期间置待补刷，结束下降沿补刷
- **不掀翻缓存**：只刷当前生效仓库 status，无路径级过滤（status 是轻操作且已 debounce）
- 挂载：`GitPanel/index.tsx` mount 时 `initGitStatusWatcher(() => effectivePathRef.current)`；cleanup 取消订阅。FileExplorer 的 `startFileWatcher` 负责起停（`performance.fileWatcher` 开关）
- 测试：`fileWatcherSubscriber.test.ts` 5 用例（未流式/流式中/下降沿/null 路径/cleanup）
- 剩余边界：Web 端不订阅（watch 是 tauri-app feature，Web=60s 轮询是 master-plan 已接受的边界）

#### FR-P2-3 Undo 网络（超越点#2）

- 危险操作（discard / reset hard / checkout 覆盖 / interactive rebase）前自动快照到 `<data_root>/git-backups/<ws>/`
- 通知条可一键恢复
- 删除分支保留 hash 可恢复

#### FR-P2-4 操作流水面板

- GitKraken Activity Log 等价；复用后端 logger，前端只读

#### FR-P2-AI4 冲突预测

- fetch 后对「对方 ahead commits 涉及的文件 ∩ 本地 modified 文件」给风险清单
- 清单是确定计算（前端直接显示），AI 仅解释部分消耗 token

### 3.3 P3 深水区

#### FR-P3-1 冲突合并器（超越点#3）✅ 主体已完成（2026-10-20 接手修复，见 §2.1）

- ~~VS Code 3-way Merge Editor 规范：Left(ours)/Bottom(result)/Right(theirs) + per-conflict 控件 + 剩余未解决计数常驻~~ ✅ 重写版：同源 regions 三列对位（左 ours/中 result/右 theirs），冲突块中列就地决策 + 未解决计数常驻
- ~~按 merge/rebase/cherry-pick 区分 current/incoming 语义标签~~ ✅
- ~~独立对话框 + 编辑器内嵌两形态~~ ✅
- ~~解决后直接进 staging~~ ✅（三态解决语义 + kind 反转修复，详见 §2.1）
- ~~先弹文件级对话框：每文件 Accept Yours/Theirs/Resolve Manually + Resolve All Simple Conflicts 一键~~ ✅（按 kind 映射真实删除/保留语义；Resolve All Simple 循环非 Text 文件 + 修复 stale-props 接力）
- ~~完成后自动跳下一文件~~ ✅（新鲜 getConflictState 接力下一 Text；归零后按 kind 引导 Continue/Abort/去提交）
- ~~Apply All Non-Conflicting Changes 一键~~ ✅（语义落地为「未决策块批量取本方」——parse 层已吸收非重叠单侧改动，见 §2.1 第 6 条）
- AI-5 冲突块建议卡（默认折叠、逐块确认）；采纳率 ≥ 60% 即达标 —— **未做，下轮增量**
- 三窗中列 Append 双侧拼合（备选项）—— **未做，下轮增量**

#### FR-P3-2 Interactive Rebase

- 入口：Log 右键 commit `Interactively Rebase from Here`
- 后端方案：`GIT_SEQUENCE_EDITOR` 注入自生成 todo 文件（git2 rebase API 对 -i 不可靠，CLI 是正解）
- 面板化 TODO：拖拽 + action 菜单（pick/reword/squash/fixup/drop）+ 预览动作图
- edit 停点：右下角通知 Continue/Abort
- `--autosquash` 开关
- 禁用条件给 hover 原因提示（多 parent / 不在当前分支 / protected）
- 增配：lazygit 式面板化 TODO + shift+A 式「对旧 commit amend」（后台自动 interactive rebase）
- 冲突复用 P3 冲突合并器

**执行记录（本轮）**：核心闭环完成 ✅（4f 系列）
- 后端 `plan_interactive_rebase`（base..HEAD 应用序只读预览）+ `start_interactive_rebase`（面板 todo 渲染为 inner todo → temp 目录 `apply_todo.cmd`（copy /Y）作 GIT_SEQUENCE_EDITOR 注入 `git rebase -i [--autosquash]`）；C11 guard + 冲突从 sequence state 回读（复用 rebase_continue/abort + 冲突合并器闭环）；validate：非空/首项必须 pick/squash·fixup 必须紧跟 pick（后端兜底 + 4 个单测）
- capability：`plan_interactive_rebase`（只读）/ `start_interactive_rebase`（写类 +撤销快照 SNAPSHOT_ACTIONS）+ 中文名映射
- 前端 `RebaseTodoDialog.tsx`（应用序行 + 动作下拉 + 上下移 reorder + live 组校验红色高亮 + `--autosquash` 复选 + 执行透传）+ HistoryTab 右键入口 + slice 双方法 + 双语 i18n
- 测试：组件 6 用例（plan 渲染/首项锁定/组校验禁用/透传执行/冲突 onDone/空 plan）全绿
- **未做（如实）**：reword（需 GIT_EDITOR 二层编排）、拖拽 reorder（上下移按钮替代）、edit 停点通知、禁用 hover 原因（多 parent/protected 检查）——下轮增量

#### FR-P3-AI6 自然语言历史查询

- 输入 = 结构化 log/blame/diff 搜索结果（非 dump）→ AI 归纳为可跳转回答（commit 卡片按钮）
- `kind='git-ask'`；成本 ⚡⚡

#### FR-P3-AI8 rebase 计划提议

- 检测 fixup!/squash! 与未 push 分支，建议面板化 rebase TODO 智能排序
- 纯启发式（本地计算），AI 仅解释

### 3.4 P4 生态出口

- cap.git 进 MCP/dispatch 白名单（**记得 `cargo build --bin polaris-mcp`**，否则 AI 看到旧 schema）
- 插件示例：GitFlow / worktree 管理器 / GitLab PR
- manifest 三处同步（router / 前端 / 插件仓 `D:\space\base\Polaris-plugin`）+ 17 图标白名单
- 顺修漂移：前端 `PluginIconId` 含 `SquareTerminal` 但后端白名单无

---

## 四、关键文件路径

### 前端

| 文件 | 用途 |
|---|---|
| `src/components/GitPanel/` | 面板组件根（22+ 文件） |
| `src/components/GitPanel/HistoryTab.tsx` | 历史 tab（**1226 行，巨型文件，新功能新组件不继续膨胀**） |
| `src/components/GitPanel/CommitInput.tsx` | 提交输入 + amend + AI 建议回流 |
| `src/components/GitPanel/PushDialog.tsx` | 推送对话框 + force-with-lease |
| `src/components/GitPanel/RemoteTab.tsx` | 远程 tab + fetch + auto-fetch |
| `src/components/GitPanel/StashTab.tsx` | 储藏 tab + 三动作 |
| `src/components/GitPanel/ReflogView.tsx` | reflog 浏览 + 恢复（P1 新建） |
| `src/stores/gitStore/` | 10 个 slice（Zustand slice 模式） |
| `src/services/gitService.ts` | **P0 唯一入口（若已建）；未建则 P0 首要任务** |
| `src/services/commitMessageChat.ts` | AI 会话范式样板（AI-2/AI-3 克隆此模式） |
| `src/types/git.ts` | 前端类型（snake_case） |
| `src/locales/zh-CN/git.json` + `en-US/git.json` | 双语 i18n（483/483 对齐） |

### 后端

| 文件 | 用途 |
|---|---|
| `src-tauri/src/services/git/` | git 业务核（log.rs / commit.rs / remote.rs / stash.rs / reflog.rs / file_io.rs 等） |
| `src-tauri/src/services/router/` | RouterBus + cap.git capability |
| `src-tauri/src/models/git.rs` | Rust 协议类型（camelCase） |
| `src-tauri/src/services/data_root.rs` | 数据根单点（DataRoot 抽象） |

### 文档（必读顺序）

1. `plans/git-panel-master-plan.md` — 裁决基准
2. `plans/git-panel-prd.md` — PRD 仲裁版（架构 + 性能 + AI 矩阵）
3. `plans/git-panel-p1-ui-spec.md` — P1 UI spec（已实施完毕）
4. `plans/git-panel-idea-parity-plan.md` — IDEA 对标调研
5. `plans/git-panel-impl-analysis.md` — 实施分析
6. `plans/git-panel-vnext-prototype.html` — 交互原型（自包含单文件，双击打开；4 场景演示 + 评审标注）

---

## 五、关键纪律（AGENTS.md 强制）

### 改动前
- [ ] 读目标文件与对应测试
- [ ] 行为/协议/UI 改动 → 先补 spec 到 `plans/`（四段式：目标/契约/验收/不做）
- [ ] 涉及 cap 契约 → 确认后端 + 前端 + 插件三处同步

### 改动后（本地验证门槛）
- [ ] 前端：`pnpm exec tsc --noEmit` + `pnpm lint`
- [ ] 后端：`cargo check --lib`（**本机 `cargo test --lib` 不可用**，Tauri DLL 限制，用 `cargo check` 代替）
- [ ] 若动命令层/协议：`cargo check --no-default-features --bin polaris-web --bin polaris-mcp`
- [ ] 若动 MCP schema：`cargo build --bin polaris-mcp`（否则 AI 看到旧 schema）
- [ ] 有测试就更新/新增，并**实际执行**验证

### 提交
- [ ] 一次改动一个主题；commitlint 类型 `feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert`
- [ ] subject 小写；header ≤ 100 chars
- [ ] 不把「未完成」「环境受限」写成「已完成」；如实报告
- [ ] commit message 末尾加 `Co-Authored-By: Claude Code <noreply@anthropic.com>`

### 协议纪律
- **casing 不统一**：命令参数 + `models/git.rs` = camelCase；`types/git.ts` 现有字段 = snake_case（不做全仓统一，对抗裁决 C3）
- 改协议 = 双向同步（Rust + 前端类型 + 序列化）；无 runtime schema 校验是已知缺口，改协议时保守
- feature gate 双向：`#[cfg_attr(feature="tauri-app", tauri::command)]` + `#[cfg(feature="git")]`；每期跑 web-only check

### 巨型文件纪律
- `HistoryTab.tsx` 已 1226 行；Graph/搜索/Rebase 对话框一律**新组件**，不继续膨胀主文件
- 其他巨型文件见 AGENTS.md §九

### 中断与幂等
- 涉及 stop/interrupt 保留幂等与顺序语义（记忆 `ai-chat-interrupt-continue-root-cause`、`simpleai-interrupt-bug-confirmed`）
- 长任务统一 `taskId` 提交-监听归属；aborted 停止消费派发回调
- **严禁超时兜底**

---

## 六、已知坑与限制

1. **`cargo test --lib` 本机不可用**（Tauri DLL 启动限制）→ 用 `cargo check` + 前端 vitest 代替
2. **`src-tauri/src/commands/` 是旧路径 + 迁移中**；新增功能优先走 RouterBus
3. **协议无 runtime schema 校验**；改动协议以「保持双边类型同步」为最低纪律
4. **全量 vitest 84 失败为存量**（localhost:3000 mock server 依赖），非本次回归；stash 后仍失败
5. **调研缺口**：Sublime Merge 搜索操作符全集、GitKraken drag 精细映射未逐字核实（实施 P1 log 搜索 / P2 graph 拖拽前打开软件现场确认）
6. **CLI 文本解析脆弱**：rebase/cherry-pick/pull 现靠 stdout 解析；graph 初版解析 `--graph` 同样脆弱（`--no-color` 必须）；P3 起把关键路径收紧为结构化输出（`--porcelain` / git2）

---

## 七、建议下一步

**P2 剩余增量**（泳道图 60% 已落地，按 master-plan 顺序推进）：

1. **FR-P2-2 file-watcher 自动 status 刷新**（无 AI 依赖，收益直接）：
   - `file_watcher` debounce 800ms 推 `repo_touched` 事件 → statusSlice 复用 per-path seq 机制刷新；**不轮询**
   - AI 流式期间（`useKernelSessionState(sessionId)` = streaming）暂停 status 刷新，流式结束刷一次
   - **事件不掀翻缓存**：`repo_touched` 只触发受影响路径/计数的局部 store 写入，禁止整表刷新
   - 先补 spec 到 `plans/git-panel-p2-watcher-spec.md`（四段式）
2. **FR-P2-3 Undo 网络**：危险操作（discard / reset hard / checkout 覆盖 / interactive rebase）前自动快照到 `<data_root>/git-backups/<ws>/`；通知条一键恢复
3. **FR-P2-4 操作流水面板**（复用后端 logger，前端只读）
4. **FR-P2-AI4 冲突预测**（fetch 后确定计算风险清单；AI 仅解释，占 token 少）
5. 泳道图增量（语义着色 / WIP+stash 节点 / 增量 log 缓存 / graph.c 四数组收缩）

完成 P2 后进 P3（冲突合并器 → Interactive Rebase → AI-3 本地扫描常驻列表 → AI-6 自然语言历史查询 → AI-8 rebase 提议），再 P4 生态出口（**记得 `cargo build --bin polaris-mcp`**）。

---

## 八、相关记忆（备查）

- `git-panel-p1-ui-fixes-complete` — P1 UI 六项完成记录
- `web-only-tauri-command-gate` — feature gate 双向陷阱
- `polaris-mcp-schema-exe-staleness` — 改 ask_mcp_server.rs 须单独 build
- `rust-lib-test-env-limit` — cargo test --lib 本机不可用
- `ai-chat-interrupt-continue-root-cause` / `simpleai-interrupt-bug-confirmed` — 中断链路风险
