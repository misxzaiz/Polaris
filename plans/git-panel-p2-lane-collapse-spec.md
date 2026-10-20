# P2 泳道图增量 · lane 收缩合并（graph.c 四数组） spec

> 效力顺序：`git-panel-master-plan.md` > `git-panel-prd.md` > 本文。
> 四段式：目标 / 契约 / 验收 / 不做。

---

## 一、目标

初版 `compute_lanes`（简化算法）已覆盖「单线 + 合并」，但存在两个缺陷：

1. **幽灵竖线**：merge 的历史列在父 commit 已消费后仍标记 `empty`（贯穿线残留），
   前端画出无意义的竖线；graph.c 语义下应释放为空闲 `none`。
2. **列泄漏**：feature 分支完全合入主线后，其历史 lane 仍等待「已在主线消费过的
   commit sha」，永不被匹配 → `lanes` 数组随 merge 次数无限增长（极端多分支场景）。

本次对齐 git `graph.c` 的 **列释放 + 收缩（collapse）** 语义：
- 已处理的 commit 不再占用 lane 等待位 → 历史列即刻释放为 `none`；
- 多个父引同一 commit 时，后续 merge 不重复占列。

---

## 二、契约

### 2.1 算法（替换 log.rs `compute_lanes` 内部实现，签名不变）

```
compute_lanes(commits) -> Vec<GitLaneRow>          // 签名不变
```

新增 `processed: HashSet<String>`（已输出的 commit sha 集合），每行流程：

1. **收缩前置**：遍历 lanes，任何 `wait == Some(sha)` 且 `sha ∈ processed` → `wait = None`（释放）。
2. **定位 C**：`lanes[?].wait == C.sha` → 落该 lane；否则复用空闲 lane / push 新 lane（同初版）。
3. **父占位**：第一父占原 lane；其余父：
   - 若该父 `∈ processed` → 占位后立即置 None（不占长期等待列）；
   - 否则占空闲/新 lane 并 `wait = Some(parent_sha)`。
4. **渲染本行**：cell 类型 `commit/merge/empty/none` 判定不变；`edgeDown/edgeUp` 语义不变。
5. 输出后 `processed.insert(C.sha)`。

**行结构 / GitLaneRow 协议不变**，前端零改动。

### 2.2 契约

- `GitLaneRow` / `GitLaneCell` 结构、serde、`types/git.ts` **完全不变**。
- 行为差异仅在 cell.node：历史列释放场景 `empty → none`（前端少画幽灵竖线）；
  无新增字段、无协议漂移。
- 既有「单线 + 合并」渲染（merge 斜线、主线贯穿）不变——`processed` 释放
  只影响「父已消费」的列，不影响仍在等待的活跃列。

---

## 三、验收

1. **单线 + 单 merge**（既有 `get_log_with_lanes_mainline_and_merge`）：行为不变，
   既有测试全绿。
2. **幽灵竖线消除**：主线 A←B←C，feature1(C→D1→E1) 合入为 M，M 之后主线继续 F；
   F 之后的 history 行 feature 侧 lane 为 `none`（非 `empty`），不再有贯穿线残留。
3. **列数不增长**：同 fixture 下 `lanes` 长度上限 = 活跃分支数 + 1（简化算法会因泄漏
   线性增长）。
4. **merge 斜线语义不变**：merge 行的 `edgeUp` 指向 merge 节点 lane 的斜线仍正确绘制。
5. **语义着色/缓存不回归**：`get_log_with_lanes` 输出 semantic 与缓存逻辑不变
   （本次只动 `compute_lanes`，`compute_semantics_full` / lane_cache 不动）。
6. **门控全绿**：`cargo check --lib`、web-only 门控、clippy 新增 0、GitPanel 46 +
   gitStore 232 测试全绿。

---

## 四、不做

- **不做完整 `graph.c` mapping 移植**（`new_columns` / `old_columns` 双数组折叠、
  `graph_width` 动态收缩等 git 全量逻辑）——只实现列释放 + 收缩两个最小语义，
  对齐 master-plan「多分支交错收缩场景归 graph.c 算法」的务实落点。
- **不改前端 / 不改协议**（`GitLaneRow` 不变）。
- **不做跨页状态**（`processed` 只在一页内累计，load more 新页从空集开始——
  页内拓扑序完整，页间无共享 lane 状态）。
- **不引入缓存依赖**：收缩算法是纯内存计算，与 lane_cache 正交。