# PRD：Polaris Git 面板 vNext（新一代 AI-Native Git 工作台 · v1）

> 前置文档：`plans/git-panel-idea-parity-plan.md`（IDEA 对标调研与架构路径决策，本文不重复）。
> 本文回答三个新问题：① 结合 Polaris 现有架构怎么做才合适；② 性能怎么设计；③ AI 怎么融入才能体现「新时代优势」而非 gimmick。
> 状态：PRD 原型稿（设计阶段，未实施）。**配套交互原型已就绪：`plans/git-panel-vnext-prototype.html`（自包含单文件，双击打开；含 4 个场景演示 + 评审标注模式）。**
> ⚠️ 经四路对抗分析后，关键裁定以 `plans/git-panel-master-plan.md` 为准（效力顺序：master-plan > 本文 > impl-analysis > parity-plan）。

---

## 0. 一句话定位

**不是把 IDEA 搬进 Polaris，而是：以 IDEA 为 UX 基线，用 Polaris 既有的 cap 总线 + AI 会话基建，做一个「改动流水线」而不是「按钮面板」的 Git 工作台。**

核心叙事转变：IDEA 的 git 面板是「操作台」（用户驱动每一步）；Polaris 的定位是「流水线管家」（AI 改代码 → 面板看见 → 自动梳理 → 人工确认关键节点）。这与人机协作场景（Polaris 是 AI 编程工作台）匹配，也是 IDEA 结构上无法追赶的差异点。

---

## 1. 架构选型（结合本项目的最终裁定）

结合上一轮分析与本次架构核实，裁定如下（推翻项标 ❗）：

| 决策点 | 裁定 | 项目依据 |
|---|---|---|
| 面板位置 | **保持内置**，延续 `GitPanel/` + `gitStore/` slice 模式 | 22 文件 + 10 slice + 完整 vitest 是合格底座；中央 `'git'`/`'diff'` Tab、编辑器 gutter 集成是插件面板宿主给不了的 |
| 操作层 | ❗ **P0 强制先做 `cap.git`**，此前不新增任何功能代码 | 新功能若继续直连 `git_*` 命令，web 分发与 AI/MCP 侧暴露都要二次返工；一次性还掉 `git_dispatch.rs` 双写债 |
| 前端入口 | 新建 `src/services/gitService.ts` 唯一入口，slice 逐步改走 service | AGENTS.md「hooks 优先经 service」； 也是 event 订阅（progress/reflog）的唯一合理落点 |
| AI 调用方式 | **复用 commitMessageChat 模式**：kind 作用域会话（`kind: 'git-<feature>'`，workspace 锁定）+ oneTimeSystemPrompt + 回流 hook | `commitMessageChat.ts` 已验证：绕开 headless 超时/静默兜底问题，用户可追问可换引擎 |
| 危险操作 | 统一走「快照 → 确认卡（含 AI 后果陈述）→ 执行 → 可恢复通知」四步协议 | 见 §3 Undo 网络 |

## 2. 性能设计（预算 + 手段，注意点单列）

### 2.1 性能预算（验收即按此表测）

| 指标 | 预算 | 手段 |
|---|---|---|
| 首次打开 log（中型仓库，≤10k commits） | **p50 < 300ms 出图** | Rust 分页（默认 500/页）；**泳道计算放 Rust 端**（不放前端解析字符图）；refs 装饰与 log 同一次查询返回，避免 N 次往返 |
| 二次打开（HEAD 未变） | **p50 < 80ms** | **增量 log 缓存**：按 `(repo, head_sha, refs_snapshot)` 键持久化到 DataRoot，命中即流式回放；HEAD/refs 变化才重算 frontier |
| 图滚动 1k commits | **60fps，无可感跳跃** | react-virtuoso（现有）；max-lanes=12 截断（git `graph.c` 语义）；折叠线性段选项 |
| status 自动刷新延迟 | AI 写入停止后 **≤ 1s** 面板见到变化 | file_watcher（已存在） debounce 800ms 推 `repo_touched` 事件 → statusSlice 复用 per-path seq 机制刷新；**不轮询** |
| 长任务（push/pull/rebase） | **全程可取消 + 进度可见**，不冻结 UI | cap.git 长任务协议：`taskId` + progress 事件；Rust 侧 `spawn_blocking`，事件经总线推送 |
| 每仓库 git 调用并发 | **同一仓库串行队列**（max=1），排队立即返回 taskId（防 AI 多会话触发调用风暴把 git2 打崩） | cap.git 内置 per-repo FIFO；跨仓库并行 |
| diff 加载 | 复用现状（Web Worker + MAX_EDIT_LENGTH 降级），大文件 >2MB 走「仅统计」 | 已有 `useAsyncDiff` 共享 worker |
| 内存 | log 只保留最近 3 页 + 图数据随组件卸载释放 | slice 内 LRU |

### 2.2 两个必须写进实现的注意点

1. **事件不掀翻缓存**：`repo_touched` 只触发「受影响路径/计数」的局部 store 写入，禁止任何「整表刷新」（AGENTS §4.3 已有的 reconcile 纪律，gitStore 不能开例外）。
2. **AI 高频写文件的抖动**：AI 会话流式写文件时 file_watcher 会高频触发——流式期间（kernel session state = streaming）暂停 status 刷新，流式结束再刷新一次。归属判定用 `useKernelSessionState(sessionId)`（与 useCommitMessageSuggestion 同源）。

## 3. AI 能力矩阵（新时代优势的全部落点）

> 调度范式统一：`kind='git-<feature>'` 会话 + 按 workspace 隔离 + 引擎可换 + 结果回流 hook（全部克隆 commitMessageChat 模式，不再赘述）。
> 成本分级策略：**轻任务默认轻引擎**（引擎选择已有 engineMetadataStore），给出「成本档位」标记（⚡轻/⚡⚡重）。

| # | 能力 | 交互与产出 | 调度/成本 | 优先级 |
|---|---|---|---|---|
| AI-1 | 提交信息生成 | （已有，保留）AI 建议条回流 CommitInput | 已上线 | — |
| AI-2 | **原子提交建议**：把一揽子改动拆成语义独立的多个 commit | AI 输入 = 变更清单+diff 摘要 → 输出 = 分组方案卡片（每组：文件集 + 拟 message + 理由）；用户逐组勾选确认才执行（后端按组 stage+commit） | ⚡⚡；kind='git-atomic' | **P1，主打卖点** |
| AI-3 | 提交前 Review 门：提交前异步跑一次 diff 检查（泄漏密钥/调试残留/TODO/缺测试），产出非阻塞“报告卡片” | 不阻塞提交；点击卡片跳文件 | ⚡；kind='git-review'；after-commit 亦可（对齐 IDEA 2025.1 语义） | P1 |
| AI-4 | **冲突预测**：fetch 后对「对方 ahead commits 涉及的文件 ∩ 本地 modified 文件」给出风险清单与解释，并建议先 rebase 还是先提交本地 | 纯后端结构数据 + AI 解释块；不点开不消耗 token（清单是确定计算，前端直接显示） | ⚡⚡ 仅解释部分 | P2 |
| AI-5 | **冲突解决副驾**：合并器每个冲突块给「AI 建议（含理由）」，接受需人工确认；整文件级「AI 一键解决草稿」也一样过确认 | cap.ai；输入给 base/ours/theirs + 周边上下文 | ⚡⚡；kind='git-conflict' | P2（依赖 P3 冲突合并器） |
| AI-6 | 自然语言历史查询：「上周谁动过 X 的逻辑」「这个 bug 是哪个 commit 引入的」 | 输入=结构化 log/blame/diff 搜索结果(非 dump) → AI 归纳为可跳转回答（commit 卡片按钮） | ⚡⚡；kind='git-ask' | P3 |
| AI-7 | 危险操作护航：hard reset / force push / drop commits 确认卡里，AI 陈述「你会失去什么」+ 使用快照的替代建议（如先 stash 到新分支） | ⚡；失败降级为纯文案确认卡（AI 不可用不阻塞操作） | P2 |
| AI-8 | rebase 计划提议：检测 fixup!/squash! 与未 push 分支，建议面板化 rebase TODO 的智能排序 | 纯启发式（本地计算，无 LLM），AI 仅解释为什么这样排 | ⚡/本地 | P3 |

**红线**：所有 AI 产出都是「建议 + 人工确认」二段式，不存在未经确认的写操作路径；AI 通道故障时 git 面板完整可用（当前 AI-1 会话模式已验证该断路设计）。
**Note**：AI-2/AI-5 的「输入裁剪」必须实现：超 token 预算时先用 `formatGitDiffSummary` 摘要、再按文件优先级截断 diff 内容，绝不把全量 diff 推给模型。

## 4. 功能需求（FR，按里程碑分组；细节以 parity plan §四/五为准，此处只录 PRD 级验收键）

### P0 ·cap.git 架构垫层（强制先行）
- FR-P0-1 `cap.git` action 协议覆盖现有 50 个 `git_*` 语义；**casing 逐类型保持现状**（命令参数/ `models/git.rs` = camelCase，`types/git.ts` 现有字段 = snake_case，不做全仓统一——对抗裁决 C3，master-plan §四.4）。
- FR-P0-2 长任务协议：提交即返 `taskId`；progress/done/failed 事件可达前端 store；**可取消**（取消语义：任务级 abort + 状态落库）。
- FR-P0-3 gitService.ts 唯一入口；gitStore 10 slice 改走它。
- 验收：全部现有 vitest 通过 + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 通过 + 面板行为回归不变；**取消重试动作不再受超时截断**（演示 pull 后立即 cancel，留 log 证据）。

### P1 · 日常流水（高频补漏 + AI-2/AI-3）
- FR-P1-x 对齐 IDEA 平价清单：amend（含 amend 任意本地 commit）、fetch + 可配置 auto-fetch（默认关，推荐 20min）、stash apply/show/log 搜索（含 regex/`branch1..branch2`）、force-with-lease 默认、reflog UI 及一键恢复。
- FR-P1-AI2 原子提交建议（见 §3）验收：一次含 2+ 独立改动的场景下，AI 分组卡片逐组勾选 → 产出的 commits 用 `git log --stat` 抽查组内文件与 message 语义一致。
- FR-P1-AI3 Review 门验收：提交后 15s 内出现非阻塞报告；无 token 消耗在未提交场景。
- 验收性能：§2.1 表全达标。

### P2 · 可视化 + 安全网（Graph 主役 + Undo 网络 + AI-4/AI-7）
- FR-P2-1 泳道图：Rust 计算 lane（`graph.c` mapping 算法接手）、refs 三色、HEAD/远程标记、语义着色（已 push？已进 main？）、WIP/stash 节点上图。
- FR-P2-2 file-watcher 驱动的自动 status 刷新（debounce + streaming 抑制）。
- FR-P2-3 Undo 网络：discard / reset hard / checkout 覆盖 / interactive rebase 前快照入 DataRoot；危险操作后就地通知条可一键恢复（含删除分支保留 hash）。
- FR-P2-4 操作流水面板（GitKraken Activity Log 等价）。
- FR-P2-AI4 冲突预测清单卡片挂 fetch 入口。验收：构造 2 仓库分叉场景，清单文件集与人工比对一致。

### P3 · 深水区（冲突合并器 + Interactive Rebase + AI-5/AI-6/AI-8）
- FR-P3-1 冲突合并器（VS Code 规范三窗 + per-conflict 控件 + 未解决计数 + current/incoming 语义标签随 merge/rebase/cherry-pick 变化）；独立对话框 + 编辑器内嵌两形态；「解决后直接进 staging」。
- FR-P3-2 面板化 Interactive Rebase TODO（拖拽 + action 菜单 + 预览 + edit 停点通知 + autosquash）。
- FR-P3-AI5 冲突块 AI 建议卡（默认折叠、逐块确认）。验收：人为构造 5 冲突文件场景，AI 建议块人工确认采纳率 ≥ 60% 即达标（不要求完美）。
- FR-P3-AI6 时间线问答卡片（跳 commit）。

### P4 · 生态出口
- cap.git 进 MCP/dispatch 白名单（记得 `cargo build --bin polaris-mcp`）；插件示例：worktree 管理器 / GitFlow / GitLab PR；顺修 `SquareTerminal` 前后端白名单漂移。

## 5. 布局原型（线框，Workbench 形态）

```
┌──────────────┬──────────────────────────────────────┬────────────────────┐
│ Branches     │  [搜索 | Branch▾ User▾ Path▾ 正则]   │  Changed Files     │
│ ⭐favorite   │  ╭──────────────────────────────────╮│  ┌ 未暂存 (3)      │
│ recent≤5     │  │ ●● lane graph + refs 装饰          ││  ├ 已暂存 (2)      │
│ local        │  │  语义色: 未push 红 / 已merge 暗灰   ││  ├ 冲突 (1) ⚠️     │
│ remote(group)│  │  WIP 节点 / stash 紫点             ││  └ AI-2 分组建议卡 │
│ tags         │  ╰──────────────────────────────────╯│      (可跳每组)    │
│ reflog 入口  │  ← load more (500/页)                │  Commit Details    │
│              ├──────────────────────────────────────┤  + AI-3 review 卡  │
│              │  ↓ Commit Input [AI 建议▾][amend]    │  + 操作流水(可抽)   │
│              │     冲突时: [Merge Conflicts 节点 ⚠2] │                    │
└──────────────┴──────────────────────────────────────┴────────────────────┘
   冲突文件行 → 打开三窗合并器(base|result|theirs) + 每块 [AI 建议▾] + 未解决计数常驻
```

## 6. 指标（上线后衡量）

- **性能**：§2.1 预算表逐项通过（提供 bench 记录）。
- **AI 效能**：AI-1/AI-2 message 采用率；AI-3 报告点击率；AI-5 建议采纳率。
- **安全**：危险操作快照覆盖率 100%（任何 hard 路径都先快照才算达成）。
- **架构**：git_dispatch.rs 删除为 P0 验收硬指标。

## 7. 不做（本轮明确排除）

- submodule / GitFlow / LFS / shelve 共享 / 非 GitHub PR 补全（维持 parity plan 口径，可入插件生态）。
- AI 自动执行任何写操作（红线）。
- 前前端字符级 graph 解析长期方案（初版可用，但 Rust lane 计算是硬目标）。
- diff 处理管线重做（现有 worker + myers + 降级充分，只续用）。

## 8. 与既有文档关系

- `plans/git-panel-idea-parity-plan.md` = 调研与对标基线（不废弃，引用为准）。
- 本文 = PRD 仲裁版（架构结合 + 性能 + AI 矩阵）。两文冲突时以本文裁定为准。
- 后续若评审通过，按期拆 P 期实施 spec（沿用 tool-switcher spec 的 目标/契约/验收/不做 四段式）。
