# Git 历史 tab P1 优化 spec：多选/对比/键盘交互 + 泳道图修复 + 搜索诚信

日期：2026-10-22。来源：`plans/` 前置分析（HistoryTab 全通读结论）。本 spec 只覆盖本轮实施项，3 列折叠等算法级大项单独评估。

## 一、目标（本轮实施）

### P0 正确性
1. **本地搜索伪正确**（HistoryTab 普通模式过滤只作用于已加载页，默认 20 条）：输入 query 时显示「已加载 N 条内过滤 m 条 + 切到全库搜索」提示条，一键切换精确搜索；精确模式显示编译出的过滤器 chips（grep/author/pickaxe/since/range）。
2. **refs kind 死代码**：前端 `kind==='head'` 分支永活（Rust 只发 local/remote/tag）。改为按 `ref.name === 当前分支名` 判定当前分支徽标高亮；同时 refs 徽标 / 图例硬编码色收敛为语义 token（success/danger/info/warning/primary）。
3. **跨页泳道断裂**：泳道按每页窗口（20 条）独立计算，「加载更多」后同一分支换列/断线。修：loadMore 改为**整段重取**（limit=已加载+PAGE_SIZE, skip=0），rows 永远是连续窗口下计算的结果；PAGE_SIZE 20→50 减小频繁整段重取。

### P1 多选与对比（用户主诉求）
4. **历史多选**：`selectedCommits: Set<sha>`；Ctrl/Cmd+点击切换，Shift+点击时间区间（锚点=上次点击行）；Shift+Space 区间；列表有选中时显示操作条：数量 + 「对比选中提交(2个)」+「Cherry-pick」+ 清除。
5. **对比选中两个提交**：后端 `get_diffs` 增加 optional `compareTo`（target tree commit；缺省=HEAD，向后兼容）——tree-to-tree diff，即真正的 A..B 对比。前端 `compareCommits(ws, base, target)`（commitSlice 新 action）。结果**伪装进既有 selectedDetails 通道**渲染（复用 CommitDetailsPane 的文件列表+diff 视图，双变体通用），对比态在 pane 顶部挂 chip（`base..target`）。
6. **批量 Cherry-pick**：选中按拓扑序（旧→新）逐个调用既有单条 cherry_pick（WRITE_GATE 串行；cap 契约不加新动作）；遇到第一个失败中止并如实报告（已应用数/失败原因）。确认框汇总。
7. **键盘 + hover**：↑/↓ 移动焦点行（高亮+滚动跟随），Enter 加载详情，Space/Shift+Space 选择，Esc 清除选择；hover 行内快捷钮：复制 SHA（其余危险动作留右键）。

### P2 顺手小项
8. 泳道绘制：节点 r 3→4、线宽 1.2→1.5、汇入斜线终点对齐节点圆心（修复收口偏出）；merge 行竖线补延续。
9. 语义图例常显（不等 WIP/stash 虚拟行）；loadMore 失败显示错误行 + 重试。
10. i18n zh/en 同步补充。

## 二、非目标（后续单独评估）
- 泳道 ≤3 列折叠放宽（`polaris-git-lanes` 算法内核，风险大，单独 spec）
- 泳道曲线绘制、提交列表虚拟化、HistoryTab 状态收敛 gitStore 分片、reflog 增强

## 三、接口约定（双边同步）

- Rust `diff.rs`：`get_diff(path, base_commit, target_commit: Option<&str>)`；target 缺省 = HEAD（原语义）。mod.rs 透传。
- cap.git `get_diffs`：新增 optional `compareTo` 参数（两处登记不变，action 名不变 → KNOWN_ACTIONS 不动，向后兼容）。
- gitStore `CommitActions.compareCommits(ws, baseSha, targetSha) → Promise<GitDiffEntry[]>`（invoke `git_get_diffs` + `compareTo`）。只读，不进 WRITE_GATE。

## 四、事件顺序与幂等

- 对比只读；cherry-pick 批量 = N 次 reads-free 写，每次独立 git2 操作互不套续，失败即停（保证 index 状态一致可自查），不做自治回滚（git cherry-pick 天然不可安全半途杀，报错让用户决定 —— 与 AGENTS「不因重试产生双写/误杀」一致）。
- loadMore 整段重取：以 `result.length === 请求 limit` 判 hasMore，状态整体替换，无追加合并竞态。

## 五、验收

- [x] pnpm exec tsc --noEmit 全绿（EXIT=0，2026-10-22 实跑）
- [x] 受影响文件 eslint 0 error（HistoryTab/CommitDetailsPane/LaneGraph/gitStore/*Test；HistoryTab:1733 存量 non-null warning 为分支下拉旧代码，未动）
- [x] cargo check EXIT=0（git.rs series 含 `get_diff(path, base, target: Option<&str>)` 新签名）
- [x] cargo check --no-default-features --bin polaris-web --bin polaris-mcp EXIT=0
- [x] vitest：gitStore + GitPanel 35 文件 334 用例全过（含 HistoryTab 20 / LaneGraph 9 / commitSlice 新增用例）
- [x] 手工走查点（实现对应）：多选(键鼠两路/Ctrl+Shift/hover+/Space/Esc)→操作条→对比(2个)→cherry-pick(旧→新序)；搜索诚信条→一键切精确→chips 回显；loadMore 整段重取泳道连续 + 失败错误行重试；refs 当前分支名匹配高亮(emerald/orange/purple 硬编码色全部 token 化)；图例常显
- 实现注记：①键盘焦点行 scrollIntoView 加了存在性守卫（jsdom 无此 API，测试已验）；②行点击显式 focus 列表容器（div 不可聚焦，否则容器 onKeyDown 收不到事件）；③批量 cherry-pick 复用单条动作前端循环（旧→新序，首败即停），cap 契约未新增动作。
