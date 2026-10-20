# 规划：Git 面板对标 IDEA · 设计与路线（设计阶段，未实施）

> 目标效果：Git 面板达到 IntelliJ IDEA 的日常使用水准，并在 IDEA 短板处（reflog UI、操作审计、undo 网络、冲突计数合并器等）实现超越。
> 本文为规划/spec 前置文档；实施分期启动时按期补展开 spec。
> 研究来源见文末：IDEA 官方 Help（2026.2）+ What's New 2024.1–2025.3，以及 Sublime Merge / GitKraken / Fork / lazygit / VS Code / GitHub Desktop / mhutchie git-graph 官方资料。
> ⚠️ 调研期 websearch 不可用，全部经 webfetch 直取官方文档；少数点（如 Sublime Merge 搜索操作符全集、GitKraken drag 精细映射）未能逐字核实，文中标注「待现场确认」。

## 一、目标

1. **对齐**：日常 git 流程（看历史、提交、分支、推送拉取、解决冲突、整理历史）达到 IDEA 的 UX 基准。
2. **超越**：在 IDEA 明确缺失或薄弱的 5 处做出差异（见 §三）。
3. **还债**：借迁移把 git 操作层上收 `cap.git`（RouterBus），消掉 `web/api/git_dispatch.rs` 手写双写点，顺带打通 AI/MCP 侧 git 能力。

**非目标（本期不做）**：submodule 管理、GitFlow、LFS、非 GitHub PR 补全、shelve 跨仓库共享。

## 二、路径决策（沿用上轮分析结论）

- **面板保持内置**（`components/GitPanel/` 现有 22 文件 + `gitStore` 10 slice 是合格底座，中央 workbench Tab / 编辑器 gutter 集成是插件面板宿主给不了的）。
- **操作层迁 `cap.git`**（P0）：后端 `services/git/*` 保留，上包 RouterBus capability；前端新增 `src/services/gitService.ts` 作唯一入口（现 gitStore 各 slice 直连 `invoke`，按 AGENTS.md「hooks 优先经 service」收敛）。
- 插件只作 P4 生态出口（GitFlow/worktree/LFS/GitLab PR 类扩展）。

## 三、超越 IDEA 的 five 差异点（做出即领先）

| # | 特性 | IDEA 现状 | 我们的方案 | 依据 |
|---|---|---|---|---|
| 1 | **Reflog UI + 操作流水审计** | IDEA **无 reflog 浏览界面**（YouTrack IDEA-269587 至今 open）；也无产品级操作日志 | ① reflog 视图（log tab 底部开关）一键恢复丢失分支；② 「操作日志」面板记录每次 git 操作+耗时（复用后端 logger，前端只读） | Fork reflog 面板、GitKraken Activity Logs |
| 2 | **Undo 网络（discard 可撤销）** | IDEA discard/reset **无 undo**，只靠 Local History（5 天窗口，非 git 域） | 危险操作（discard/reset hard/checkout 覆盖/interactive rebase）前自动快照到 `<data_root>/git-backups/<ws>/`；通知条可「一键恢复」；删除分支保留 hash 可恢复 | GitKraken undo 覆盖 discard；IDEA 删除分支通知可恢复（值得抄的双保险） |
| 3 | **冲突合并器规范** | IDEA 三窗无未解决计数、无 per-hunk accept 面板 | 采用 **VS Code 3-way Merge Editor 规范**：Left(ours)/Bottom(result)/Right(theirs) + per-conflict 控件 + **剩余未解决计数常驻** + 按 merge/rebase/cherry-pick 区分 current/incoming 语义标签；叠加 Polaris 特色：**AI 辅助解决冲突**（走 cap.ai，IDEA 2024.2 也有 AI resolve，但我们的 AI runtime 更深）+ 上一轮已打通的 AI commit message | VS Code 官方 merge-conflicts docs |
| 4 | **Graph 全家桶语义着色** | IDEA 单色 lane、refs 三色 | commit 节点按语义着色：绿=本地分支内/红=未 push/灰暗=已 merge 进 main（lazygit 语义）；graph 上画 **WIP 节点 + stash 紫点**（GitKraken/Fork 均有，IDEA 无） | lazygit README、GitKraken help |
| 5 | **行级 staging 平权** | IDEA 行级 stage 限于 commit 视图 unified diff | diff 选中行 → 右键 stage/unstage 一等公民（后端 `apply_range` 语义）；操作回显等效 git 命令（Sublime「Real Git」教学哲学） | Sublime Merge docs |

## 四、IDEA 必须对齐的 UX 规范要点（实施时逐条对照）

**Log tab**
- 四区布局：Branches 面板 / commit 图 / Changed Files / Commit Details，可折叠。
- Graph 选项：By date/Topo 排序、Show First Parent、No Merges、Long Edges 开关。
- refs 装饰：黄=当前、绿=本地、紫=远程；tag 可显名；>6 refs 折叠。
- 过滤四维：Branch/User/Date/Path + 消息/hash/**正则**搜索框；分支过滤支持 **`branch1..branch2` 范围语法**（review 场景高价值，成本小必做）。
- 多仓库行首彩色竖条标识 commit 属于哪个 root。
- 分页/索引：author-time 默认；merge commit 可看各 parent 单独变更。

**Commit**
- staged/unstaged 分区（已有）；amend 勾选且**可选任意本地非 tip commit**（后端缺 amend 函数）。
- Commit options：Sign-off、Run git hooks（读 .git/hooks）、Author 代提交者。
- Commit 后动作：Commit and Push；Push 对话框 commit 预览 + **force-with-lease 默认化** + Protected branches 禁 force push（配置项）。

**冲突**
- 先弹文件级对话框：每文件 Accept Yours/Theirs/Resolve Manually + **Resolve All Simple Conflicts** 一键；关掉后 Changes 面板出现 "Merge Conflicts" 节点带 Resolve/Abort 工具栏（非阻塞中断链，对齐 §4.2 幂等要求）。
- 三窗：左右只读、**中央可编辑**；per-conflict Accept/Ignore + Append；**Apply All Non-Conflicting Changes** 一键；完成后自动跳下一文件；可反悔单文件解决结果。
- 结束后 merge commit 可 diff-to-parent 回审计（给排障记住「当初怎么解的」）。

**Interactive Rebase**
- 入口：Log 右键 commit `Interactively Rebase from Here`；对话框列出该 commit 之后本分支所有 commit。
- 每行 action：pick/reword(edit 双击)/squash/fixup/drop + 拖拽重排；启动前预览动作图。
- **禁用条件给 hover 原因提示**（多 parent/不在当前分支/protected）。
- `edit` 停点：右下角通知 Continue/Abort；错过可走菜单 Continue rebase。
- 后端方案：`GIT_SEQUENCE_EDITOR` 注入自生成 todo 文件（git2 rebase API 对 -i 不可靠，CLI 是正解）；冲突复用冲突合并器；`--autosquash` 开关。
- 增配超越项：lazygit 式**面板化 TODO**（表格 UI 替代打开编辑器）+ shift+A 式「对旧 commit amend」（后台自动 interactive rebase）。

**分支**
- Branches popup：**Recent（最近 checkout ≤5）置顶** + Favorite star + 按 `/` 前缀目录分组；搜索框。
- 右键富菜单：Checkout、New Branch From、**Checkout and Rebase onto Current**、Merge <所选> Into <Current>、Compare with Current（独立 diff 视图 + Swap Branches）、Rename（含 Unset upstream）、Delete。
- checkout 冲突：**Smart Checkout**（shelve→checkout→unshelve）三选对话（Smart/Force/Stash）——现 Polaris 只做 stash WIP，升级为三选。
- 删除分支通知：显示 hash + View unmerged commits + Restore。
- Update Project（fetch 后）三选：Merge/Rebase/Reset to remote（默认可配置）。
- ahead/behind 角标入状态栏 widget（GitStatusIndicator 已有雏形）。

**编辑器内**
- gutter marker hover 弹**内联前后对照 + Revert + Show Diff**（现有 gitGutter 升级）。
- blame：commit 色块 + hover 跳 commit + **-w/-M/-C 选项** + Annotate Previous Revision + Hide Revision（治格式化 commit 污染）。
- 文件状态着色：Explorer/Tab 按 git status 着色（修补上轮发现的 per-file 缺失）。
- 行内 inline blame 开关。

**多仓库**
- 分支操作可选 In All Repositories；失败建议回滚已成功部分（serde 事务式叙述，与 §4.2 幂等语义对齐）。

## 五、分期路线（细化版）

> 每期独立可验收；涉及协议改动双边（`src/types/git.ts` ↔ `src-tauri/src/models/*`）同步并补字段级测试。

### P0 架构垫层（先行，独立 PR 序列）
- `cap.git` capability（router 目录新模块）：action 协议照搬现有 50 个 `git_*` 语义 + 长任务 `taskId` 进度事件；**不改 UI 行为**。
- `src/services/gitService.ts` 唯一前端入口，gitStore 各 slice 改走 service。
- 消 `web/api/git_dispatch.rs` 手写派发（ipc 层改 cap dispatch）。
- **验收**：`cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 通过；前端全部 vitest 绿；面板行为回归不变。

### P1 高频小功能（1 个 P1 期 ≈ 1~2 个 PR）
| 项 | 后端改动 | 验收 |
|---|---|---|
| amend commit | `commit.rs` 加 amend 参数（git2 CommitBuilder 可实现 amend 任意本地 commit） | amend tip / amend 任意 commit 两条路径各一测试 |
| fetch + auto-fetch | `remote.rs` 加 fetch（CLI）；设置项 `git.autoFetchInterval`（默认 0=关，建议 20min 对齐 IDEA） | 定时器走 scheduler 或前端 interval，带 taskId 进度 |
| stash apply/show/drop 暴露 | 后端 drop 已有 apply 无——补 `stash_apply` + `stash_show` | stash 面板三动作 + preview diff |
| log 搜索 | `log.rs` 加 `search { message, author, hash, path, -S content, regex 开关 }` + `branch1..branch2` 范围 | 各参数单测；UI 过滤条 |
| force-with-lease | `push_branch` 默认改 `--force-with-lease`（用户显式选 raw force 才用 `--force`） | push 对话框文案 + 测试 |
| reflog UI（差异点#1 → 实施靠后拆出亦可） | `log.rs` 加 `get_reflog`（git2 Reflog） | 一键恢复分支（`git branch <name> <sha>` 语义） |

### P2 可视化（Graph 主役）
- **协议扩展**：`GitCommit` 加 `parents: string[]`、`refs: {name, type, target}[]`；`get_log` 返回受限 pageSize（默认 500 + load more）。
- **算法**：初版直接**解析 `git log --graph --oneline --no-color`**（字符坐标最省）；中期照 **git `graph.c` 的 mapping/new_columns/old_mapping 四数组算法自绘 SVG lane**（可画弯线 + 自定义节点）。
- refs 三色 + HEAD/远程标记 + 多仓竖条；语义着色（超越点#4）+ **WIP/stash 节点上图**。
- 性能：分页 + max-lanes 截断（graph.c 已有 `--max-lanes` 语义）+ 隐藏分支；∝ 1k commits 60fps（现有 virtuoso 底座）。

### P3 深水区
1. **冲突解析器**：后端 `parse_conflict_markers(path)`（提取 ours/theirs/base hunks，复用 `similar` 三方 merge）→ 前端三窗合并编辑器（组件复用 `Diff/` 骨架）按 VS Code 规范（超越点#3），挂两形态：独立对话框 + 编辑器内嵌分栏。
2. **Interactive Rebase**：`GIT_SEQUENCE_EDITOR` 方案 + 面板化 TODO（拖拽/squash/fixup/reword/drop）+ edit 停点通知 + autosquash。
3. **Undo 网络**（超越点#2）：危险操作快照 + 通知条恢复 + 操作流水面板。
4. 分支 popup 富化 + Smart Checkout 三选 + Update Project 弹窗。

### P4 生态出口
- cap.git 向 MCP/dispatch 白名单开放（`cargo build --bin polaris-mcp` 重建 schema，注意记忆 polaris-mcp-schema-exe-staleness）。
- 插件示例：GitFlow / worktree 管理器 / GitLab-PR；manifest 三处同步（router/前端/插件仓 `D:\space\base\Polaris-plugin`）+ 17 图标白名单。
- 顺手修上轮发现的漂移：前端 `PluginIconId` 含 `SquareTerminal` 但后端白名单无——插件化前收敛。

## 六、风险清单

1. **协议漂移**（无 runtime schema 校验）：parents/refs/冲突结构必须双边同步 + 字段级测试基线。
2. **feature gate 双向**：新命令沿用 `#[cfg_attr(feature="tauri-app", tauri::command)]` + `#[cfg(feature="git")]`；每期跑 web-only 检查。
3. **CLI 文本解析脆弱**：rebase/cherry-pick/pull 现靠 stdout 解析；graph 初版解析 `--graph` 输出同样脆弱（`--no-color` 必须）。P3 起把关键路径收紧为结构化输出（`--porcelain` / git2）。
4. **serde/中断幂等**：长任务统一 `taskId` 提交-监听归属；aborted 时停止消费派发回调（对齐 simpleai 教训）；**严禁超时兜底**。
5. **巨型文件纪律**：HistoryTab 已 1226 行——Graph/搜索/Rebase 对话框一律**新组件**，不继续膨胀主文件。
6. **调研缺口**：Sublime Merge 搜索操作符全集、GitKraken drag 精细映射未逐字核实（实施 P1 log 搜索 / P2 graph 拖拽前打开软件现场确认即可）。

## 七、里程碑与总验收

- M1 = P0 完成后：架构迁移无行为回归（118 前端测试 + cargo check 系列全绿）。
- M2 = P1+P2 完成后：日常 git 全流程不离开面板；Graph 1k commits 顺畅。
- M3 = P3 完成后：一个真实冲突场景合集手测清单通过（merge/rebase/cherry-pick/stash-pop 四路冲突）+ reflog 恢复演示 + discard 后一键恢复演示。
- 每期 PR 门槛：typecheck + lint + 相关 slice 测试 + （动 Rust 时）cargo check + web-only check。

## 八、研究来源（备查）

- IDEA Help（.md 直取）：log-tab / investigate-changes / commit-and-push-changes / resolve-conflicts / apply-changes-from-one-branch-to-another / edit-project-history / manage-branches / undo-changes / local-history / shelving-and-unshelving / work-with-github-pull-requests / settings-version-control-*。
- IDEA What's New 2024.1 / 2024.2 / 2024.3 / 2025.1–2025.3。
- YouTrack：IDEA-269587（reflog UI open）、IDEA-355832。
- Sublime Merge docs（getting_started / command_palette / getting_merged / faq）；GitKraken help（undo-and-redo / activity-logs / interface / branches / performance）；git-fork.com；lazygit repo + docs/Undoing.md；VS Code docs（sourcecontrol/merge-conflicts、history）；GitHub Desktop docs（cherry-picking / undoing）；mhutchie/vscode-git-graph（lane 算法 + 分页架构参考第一顺位）。
