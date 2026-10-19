# Git 面板 P2 泳道图 — 规格

> 效力：`git-panel-master-plan.md` > `git-panel-prd.md` > 本文。
> 本文只做 P2 泳道图（FR-P2-1）的目标 / 契约 / 验收 / 不做，不重复规划原文。

---

## 一、目标

把 HistoryTab 的纯文本提交列表升级为 **泳道图（lane graph）**：每个 commit 一行的左侧渲染拓扑连线的 lane 列，右侧保留现有 subject/sha/时间，叠加 refs 装饰与语义着色。

对齐 master-plan 裁决：
- **lane 计算放 Rust 端**（不放前端解析字符图）——PRD §2.1 性能手段。
- **refs 装饰与 log 同一次查询返回**，避免 N 次往返。
- 折叠线性段选项（master-plan §1.2 砍掉），不做。
- AI-3 / AI-5 / AI-8 均在 P3，本 spec 不涉及。

---

## 二、契约

### 2.1 协议扩展（双边同步，唯一权威）

**后端 `src-tauri/src/models/git.rs`** — `GitCommit` 增加：

```rust
/// 提交上的 refs 装饰（用于泳道图三色 + 标记）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRef {
    pub name: String,      // 显示名（如 main、origin/main、HEAD）
    pub kind: String,      // "head" | "local" | "remote" | "tag"
    pub target: String,    // ref 全名（refs/heads/main / refs/remotes/origin/main / refs/tags/v1.0）
}

pub struct GitCommit {
    // ...既有字段不动...
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub refs: Vec<GitCommitRef>,
}
```

**前端 `src/types/git.ts`** — 同步：

```ts
export interface GitCommitRef {
  name: string
  kind: 'head' | 'local' | 'remote' | 'tag'
  target: string
}
// GitCommit 增加 refs: GitCommitRef[]（可选，缺省 []）
```

**向后兼容**：`skip_serializing_if` 保证旧消费方（diff 视图等）不感知；前端字段类型 `refs?: GitCommitRef[]`，缺省空数组。

### 2.2 lane 数据结构（新独立类型，前端消费）

**后端 `src-tauri/src/models/git.rs`** 增加 `GitLogPage` 与 lane 数组（泳道计算产物）：

```rust
/// 单条泳道（每 commit 一行）
pub struct GitLaneRow {
    pub sha: String,
    pub lanes: Vec<GitLaneCell>, // 每条泳道的节点/连线标记
    pub refs: Vec<GitCommitRef>, // 冗余带 refs，前端不必再查
}

/// 一个泳道格子：该 commit 在泳道列位置的绘制原语
pub struct GitLaneCell {
    pub lane: usize,            // 泳道下标
    pub node: String,           // "commit" | "merge" | "empty" | "none"
    pub edges: Vec<GitEdge>,    // 与本行上/下行连接
}
```

**定位**：初版 lane 计算在 Rust 端用简化算法（拓扑序已知 + parents 已知 → 每 commit 分配泳道 + 上下连线），不做 git `graph.c` 的 column 合并/收缩——合并收缩是后续增强，初版覆盖「单线主分支 + 合并分支」足够语义正确。

### 2.3 cap.git 动作

新增动作 `get_log_with_lanes`（**不改 `get_log` 现有行为**）：

```json
{ "action": "get_log_with_lanes", "params": { "workspacePath": "string", "limit": "number", "skip": "number", "branch": "string|optional" } }
```

返回 `GitLogPage { commits: Vec<GitCommit>, lanes: Vec<GitLaneRow> }`。

前端新增 service 函数 `getLogWithLanes(workspacePath, limit, skip, branch)`，走 `router_dispatch`。

### 2.4 前端组件

- **新建 `src/components/GitPanel/LaneGraph.tsx`**：纯展示组件，输入 `lanes: GitLaneRow[]` + `refs: GitCommitRef[]`，输出 lane 列 SVG（每 commit 一行格子）。**不膨胀 HistoryTab**（巨型文件纪律）。
- **HistoryTab 接入**：`renderCommitRow` 左侧圆点替换为 `<LaneGraph row={...}/>`；refs 三色标签渲染在 sha 右侧。
- **语义着色**：初版只做「HEAD/本地/远程/tag 四色标签」；「未 push 红 / 已 merge 暗灰」语义着色依赖跨页拓扑，留待 P2 增量（本 PR 不做，见 §四）。

---

## 三、验收

1. **协议双向同步**：`cargo check --lib` + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 全绿；`pnpm exec tsc --noEmit` 零错误。
2. **lane 正确性**：构造 1 主线 + 1 合并分支的临时仓库（`log.rs` 测试范式），`get_log_with_lanes` 返回的 `lanes` 满足：
   - 主线 commit 泳道连续（node=commit，边=直线）；
   - 合并 commit 两条父边（node=merge，边连接两泳道）；
   - 分叉点后两条泳道并存；
   - 与 `git log --graph --oneline` 文本对齐（抽查）。
3. **refs 装饰**：仓库有本地分支 + 远程 + tag + HEAD 时，`refs` 字段覆盖四类且 target 全名正确。
4. **前端渲染**：HistoryTab 正常出图，无 console error；refs 标签三色可见。
5. **向后兼容**：`get_log` 行为不变（无 lanes 字段，前端旧行渲染路径仍在）。

---

## 四、不做（明确排除）

- 泳道收缩/列合并（git `graph.c` mapping/new_columns/old_columns 四数组）——P2 增量。
- 语义着色（未 push 红 / 已 merge 暗灰）——依赖跨页拓扑，P2 增量。
- WIP/stash 紫点上图——P2 增量。
- 增量 log 缓存（`(repo, head_sha, refs_snapshot)` 持久化）——P2 增量，单独 PR。
- react-virtuoso 现有滚动/加载更多机制——沿用，不改。
- AI-3 Review 门 / AI-5 / AI-8 / P3 全部——不涉及。
- 折叠线性段选项——master-plan §1.2 已砍。

---

## 五、实施路径（单 PR）

1. 协议扩展：`models/git.rs`（GitCommitRef + GitLaneRow + GitLaneCell + GitLogPage）+ `types/git.ts`。
2. Rust lane 计算：`log.rs` 新增 `get_log_with_lanes` + lane 分配算法（拓扑序已知 → 泳道 + 连线）。
3. cap.git 动作注册 + 巡逻测试。
4. 前端 service `getLogWithLanes` + `LaneGraph.tsx` 组件 + HistoryTab 接入。
5. 后端 lane 单测 + 前端组件测试。
6. 验证四门（tsc / vitest / cargo check / web-gate）+ 验收场景。
