# P2 泳道图增量 — 语义着色 + WIP/stash 虚拟节点 spec

> 四段式：目标 / 契约 / 验收 / 不做。
> 上位：`plans/git-panel-master-plan.md`（P2 主役）、`plans/git-panel-prd.md`、`plans/git-panel-vnext-prototype.html`（泳道图 mock 486-527）。
> 初版（commit `9e9d42e8`）已交付：`get_log_with_lanes` lane 分配放 Rust + refs 三色装饰 + LaneGraph 纯渲染。
> 本文档是初版后第一组增量：**语义着色** + **WIP/stash 虚拟节点上图**。
> 后续增量（增量 log 缓存、graph.c 四数组收缩）单独 spec，不在本实施范围。

---

## 一、目标

把泳道图从「结构正确但一眼信息量有限」提升到「一屏内就能读出仓库语义状态」：

1. **语义着色**：每行 commit 节点 + 泳道线的颜色直接表达「该提交在仓储拓扑中的位置语义」，
   而不只是 refs 三色标签的重复：
   - `local`：属于当前分支本地历史（绿）
   - `unpushed`：未 push 到任何上游（红）—— 覆盖「当前分支领先 origin 的那段提交」+「尚未跟踪上游的本地分支提交」
   - `merged`：已并入当前分支（接受 merge-base 判定的已合入节点）（蓝灰）
   - `dim`：纯历史（超出语义切分窗口的旧提交 / 与当前分支无关联的孤立提交）（灰暗）

2. **WIP / stash 虚拟节点上图**：泳道图顶部两条「非 commit 行」，让「工作区有未提交改动 / 有 stash」在图形上一眼可见：
   - **WIP 行**：工作区有 staged/unstaged/untracked 时出现，绿色虚线空心圆，标注「N files 未提交」
   - **stash 行**：仓库有 stash 时出现，紫色圆角方块，标注最近的 stash@{0} 摘要

两者都遵循原型语义（268-272 图例、447-451 mock、489 色表、513-519 节点画法）。

---

## 二、契约

### 2.1 后端：`GitLogPage` 扩展语义字段（改协议，双边同步）

`src-tauri/src/models/git.rs` + `src/types/git.ts` 同步加：

```rust
// models/git.rs
/// 单行语义色（泳道图语义着色的服务端预计算）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitLaneSemantic {
    /// "local" | "unpushed" | "merged" | "dim"
    pub kind: String,
}
// GitLogPage 增字段（serde skip_serializing_if 保持旧调用方兼容）
#[serde(skip_serializing_if = "Vec::is_empty")]
pub semantic: Vec<GitLaneSemantic>,   // 与 commits 一一对应
```

```ts
// types/git.ts
export type GitLaneSemanticKind = 'local' | 'unpushed' | 'merged' | 'dim'
export interface GitLaneSemantic { kind: GitLaneSemanticKind }
export interface GitLogPage {
  commits: GitCommit[]
  rows: GitLaneRow[]
  /** P2 增量：每行语义色（与 commits 一一对应）；缺省空数组 = 旧后端/旧前端兼容 */
  semantic?: GitLaneSemantic[]
}
```

### 2.2 语义色计算规则（Rust `services/git/log.rs`）

`get_log_with_lanes` 内，从 `collect_commit_refs` + revwalk 当前 tip 计算：

- 输入：
  - `head_sha`：revwalk tip（`push_history_tip` 后首个 commit）
  - `current_branch_ref`：HEAD 符号目标（`repo.head()` 成功时的 `shorthand`）
  - `refs_map`：已收集的全部 refs（一次遍历复用）
  - `main_branch` 同 init 逻辑取 `main`（master-plan：`main` 优先级，缺省 `master`，都没有则无 `merged` 判定）
- 规则（按优先级，先命中即定）：
  1. `unpushed`：该 commit 是 `HEAD..origin/<current_branch>`（或 `HEAD../refs/remotes/<upstream>`）范围内、
     且不在任何远程分支可达（`revwalk push 全部 refs/remotes/*，hide head` 判定不可达）。合并即远程分支含该 commit → 归 next。
  2. `local`：commit 在 `main..HEAD`（当前分支领先主干的未 push 提交之外的本地历史）或当前分支自身可达范围；
     —— 精确定义：不在第 1 项、且 `HEAD` 可达该 commit（在 revwalk（当前分支）内）、且不属于 `merged`。
  3. `merged`：该 commit 在 `main` 的可达范围内（`revwalk push main`），且不在当前分支 tip 之外的未 push 段；
     —— 即：被 merge 进主干的提交。判定：`repo.revwalk()` push `main`，hide `HEAD`，若该 commit 可达 → merged。
  4. `dim`：其余（不在当前分支可达范围 —— 如已删除分支的孤立提交，或上一页 `--all` 场景下的陈旧节点）。

> 实现要点：用 3 个 revwalk 集合（in_branch_headset / in_remote_anyset / in_main_headset）won't-O(N) 内存，
> 每 commit O(1) 查属于哪集合。仓库 ≤10k commits 内存可控。判定顺序：
> 1. `in_main_headset`（可达 main）→ `merged`（已是历史主干，非未 push）
> 2. `else if in_remote_anyset && !in_branch_headset` → `dim`（远程可达但当前分支不可达 = 陈旧/他分支提交）
> 3. `else if in_branch_headset && in_remote_anyset` → `local_disambiguation`：
>    - 若该 commit 在 `HEAD..origin/main` region → `unpushed`（领先远程）
>    - else → `local`（两者都可达 = 已同步的本地提交）
> 4. `else if in_branch_headset` → `unpushed`（当前分支内、任何远程不可达 → 未 push）
>
> `master-plan` 语义：绿=本地分支内、红=未 push、灰暗=已 merge 进 main。上表是判定的成熟化：
> "已 merge 进 main 且仍在分支内" 的提交，语义上属于**历史**（已进主干），着灰暗更直觉，
> 但绝不把「未 push 的当前分支提交」误判为 merged —— 判定 1 优先于一切，只有 truly reachable from main
> 才 merged。等价地：往前溯，所有 `git merge main` 之后还能在 main 上推进的提交 = merged。

### 2.3 前端集成

- `src/components/GitPanel/LaneGraph.tsx`：props 增 `semantic?: GitLaneSemantic`；
  节点 + 泳道线颜色按 semantic.kind 取语义色 token：
  - `local` → 绿（`rgb(var(--c-success))` 系，参考原型 `#4c8dff`→绿语义）
  - `unpushed` → 红（`rgb(var(--c-danger))` 系，原型 `#f2636a`）
  - `merged` → 蓝灰（`text-text-secondary`）
  - `dim` → 灰暗（`text-text-tertiary` 且整行 opacity .45）
  - 无 semantic（旧后端 / 未计算）→ 回退当前 `text-primary` 行为
- `src/components/GitPanel/HistoryTab.tsx`：
  - `loadCommits` / `loadMoreCommits` 存 `semantic`（sha → semantic 映射同 laneRows 模式）
  - 该 commit 行渲染传 `semantic={semanticBySha[commit.sha]}` + `semanticIndex`（供 opacity）
- 图例（泳道图上方的 legend 行）：加 4 色说明（当前分支/未 push/已进主干/历史）—— 挂在 HistoryTab 列表头

### 2.4 WIP / stash 虚拟节点（纯前端合成，不改后端）

HistoryTab 订阅：
- `const status = useGitRepoStatus(effectiveWorkspacePath)`（已有）
- `const stashListByWs = useGitStore((s) => s.stashListByWs)`
- `const getStashList = useGitStore((s) => s.getStashList)`

渲染（在 commit 列表顶部、lane 泳道第 0 行之前插两行虚拟行）：

```
WIP 行：  [⚡ N files] 未提交改动                      （status 有 staged/unstaged/untracked 时）
stash行： [▣ stash@{0}] <message 前 40 字>  — · —      （stashListByWs[path] 非空时）
```

- WIP 行：绿色虚线空心圆（LaneGraph 无 node 类型支持，直接用小 SVG + 主题 token）
- 数据：`status.staged.length + status.unstaged.length + status.untracked.length` > 0 → 显示；
  文案用现有 `t('...')`（新 key，见 2.5）
- stash 行：紫色圆角方块；数据来自 `stashListByWs[effectiveWorkspacePath]`（缺省空）；
  stash 刷新：`loadCommits` 时并行 `void getStashList(effectiveWorkspacePath)`（已有 action，不改）
- 点击行为：WIP 行 → 切到 Changes tab（onCommitSelected 已有语义不适用，改为调 `onOpenDiffInTab`/直接 focus changes？——本期只做展示不接跳转，原型「具独立 diff」为增量）

### 2.5 i18n

`src/locales/zh-CN/git.json` + `en-US/git.json` 各加一组：

```jsonc
{
  "lane": {
    "wip":       "未提交改动",
    "wipCount":  "N files",          // {{count}}
    "stash":     "stash",            // 前缀
    "legendLocal":     "当前分支",
    "legendUnpushed":  "未 push",
    "legendMerged":    "已进主干",
    "legendDim":       "历史",
    "legendWip":       "WIP / stash",
    "semanticColorTitle": "泳道语义色"
  }
}
```

---

## 三、验收

### 后端（cargo check --lib + 单元测试）

- [ ] `GitLogPage.semantic` 与 `commits` 同长；每项 kind ∈ {local, unpushed, merged, dim}
- [ ] 单线仓库（无远程）→ 全部 `unpushed`（当前分支所有提交，任何远程不可达）
- [ ] 带 `origin/main` 超前/落后场景：落后段 = `merged`（可在 main 上 reachable），
      超前段 = `unpushed`，两段之间 = 已合并提交 `merged`
- [ ] `dim`：删除分支的孤立提交（revwalk 只看当前分支，若用 `--all` 场景才出现，单分支单测试跳过）
- 新增 `log.rs` 测试：`semantic_colors_local_unpushed_merged`（构造 origin 超前/落后 fixture）
- 门控：`cargo check --lib` ✅、web-only gate ✅、clippy 新增 0 ✅

### 前端（vitest + tsc + lint）

- [ ] `LaneGraph` 语义色：`semantic.kind=unpushed` 节点红、`merged` 灰蓝、`dim` 行 opacity 低
- [ ] `HistoryTab` 渲染 WIP 行当 status 有变更；stash 行当 stashListByWs 非空；都空 → 都不渲染
- [ ] i18n 484/484？新增后 487/487 对齐（za/en）
- [ ] `pnpm exec tsc --noEmit` ✅、`pnpm lint` ✅（改动文件 0 error）
- [ ] 新增测试：`LaneGraph.test.tsx`（语义色 3 态 + 回退）、`HistoryTab` WIP/stash 虚拟行
- [ ] 全量 vitest 相关域：gitStore + GitPanel 现有测试不回归

### 端到端手测（本机 dev）

- [ ] 开一个 repo：有未提交改动 → 顶部出现 WIP 行（绿虚线圆）；`git stash save` 后切换 → WIP 消失、stash 紫行出现
- [ ] 分支领先 origin → 该段节点红（unpushed）；Merge 后 → 蓝灰（merged）
- [ ] 图例 4 色说明显示

---

## 四、不做（明确排除）

- **增量 log 缓存**（`(repo, head_sha, refs_snapshot)` 持久化到 DataRoot，二次打开 p50<80ms）—— 独立 spec 后续实施
- **graph.c 四数组 lane 收缩合并**（多分支交错收缩）—— 独立 spec 后续实施（本增量的 compute_lanes 不变）
- **WIP/stash 行跳转 / 展开 diff**（原型「具独立 diff」）—— 后续增量
- **`--all` 全引用 log**（dim 场景主要来源）—— 保持当前 HEAD 单分支 revwalk
- 不做精确 mock 像素级还原（原型是 JS mock，我们照语义取色，不逐像素对齐）

---

## 五、改动文件清单

| 端 | 文件 | 改动 |
|---|---|---|
| 后端 | `src-tauri/src/models/git.rs` | `GitLaneSemantic` + `GitLogPage.semantic` |
| 后端 | `src-tauri/src/services/git/log.rs` | 语义色计算（3 revwalk headset + 判定）+ `semantic` 填充 |
| 前端 | `src/types/git.ts` | `GitLaneSemantic` + `GitLogPage.semantic?` |
| 前端 | `src/components/GitPanel/LaneGraph.tsx` | `semantic` prop + 节点/泳道/行 opacity 语义色 |
| 前端 | `src/components/GitPanel/HistoryTab.tsx` | semantic 存储 + WIP/stash 虚拟行 + 图例 + stashList 订阅 |
| 前端 | `src/locales/zh-CN/git.json` + `en-US/git.json` | `lane.*` 双语 key |
| 测试 | `src-tauri/src/services/git/log.rs` tests | 语义色 fixture 测试 |
| 测试 | `src/components/GitPanel/LaneGraph.test.tsx` | 语义色 3 态 + 回退 |
| 测试 | `src/components/GitPanel/HistoryTab.test.tsx` | WIP/stash 虚拟行渲染 |