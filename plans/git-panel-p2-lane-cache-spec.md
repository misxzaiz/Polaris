# P2 泳道图增量 · 增量 log 缓存 spec

> 效力顺序：`git-panel-master-plan.md` > `git-panel-prd.md` > 本文。
> 四段式：目标 / 契约 / 验收 / 不做。

---

## 一、目标

泳道图二次打开（HEAD 未变、refs 未变）时，`get_log_with_lanes` 的语义色计算从 **O(可达 commit) × 3 条 revwalk** 降到 **O(页内 commit)**：
命中缓存则跳过三条 revwalk 的集合构造，只剩页遍历 + lane 计算，对齐 master-plan 性能预算「二次打开 p50 < 80ms」。

语义色 map 只依赖 `(仓库, 分支 tip, HEAD commit, refs 状态)`，与页码 / skip 无关 → **跨页共享**，天然适合缓存。

---

## 二、契约

### 2.1 缓存键

```
键 = (repo 绝对路径, branch 名, HEAD commit sha, refs 指纹)
```

- **HEAD commit sha**：独立解析的真分支 tip（`refs/heads/<b>` > `refs/remotes/<b>` > revparse，与 `push_history_tip` 同偏好），**不是**页首 commit。
  - 原因：`walk_shas[0]` 在 `skip>0` 时是中间 commit，直接用它当键会让不同页码抖动缓存。
- **refs 指纹**：遍历全部 refs，收集 `(full_name, peel→commit sha)`，排序拼接后 FNV-1a 哈希。
  - `repo.references()` 已含 packed-refs，无需额外读 mtime；任何 fetch / 分支增删 → 目标 sha 变 → 指纹变 → 缓存失效。

### 2.2 缓存文件

- 目录：`data_root().cache_dir() / "git-lane-semantic"`（共享层，跨实例共享，语义色与实例无关）。
- 文件名：`semantic-<hash(repo 绝对路径 + "\x00" + branch)>-<head_sha>-<refs_fp>.json`。
  - repo/branch 含 Windows 非法字符（`:` `/` `\` 等）→ 统一走 fnv1a 哈希；head_sha 与 refs_fp 为十六进制直接可作文件名。
- 内容（JSON）：
  ```json
  {
    "key": "<head_sha>:<refs_fp>",
    "map": { "<commit sha>": "unpushed" }
  }
  ```
  `key` 做双保险：读到的文件再验一次键。

### 2.3 生命周期

- **写入**：未命中时计算全量 map（`compute_semantics_for_tip`，遍历分支可达集生成 `HashMap<sha, kind>`）→ 原子写（先写 `<file>.tmp` 再 rename）→ 写前清理同目录：文件数 > 50 时按 mtime 删最旧直到 ≤ 30。
- **读取**：路径存在 && 内容 `key` 与当前 `(head_sha, refs_fp)` 匹配 → 命中；否则 `None`（当未命中处理，重新计算并覆盖）。
- **失败语义**：缓存加载 / 保存 / 清理任何失败都**静默降级**为未命中（warn 日志），不阻塞主流程——缓存是性能增强，非正确性依赖。

### 2.4 对外签名

- `get_log_with_lanes(path, limit, skip, branch)` 签名不变（前端 / git_capability KNOWN_ACTIONS 不动）。
- 新增 `services/git/lane_cache.rs`，`mod.rs` 挂载，逻辑不进 `log.rs` 公共 API。

---

## 三、验收

1. 首次打开（无缓存）语义色正确（复用既有 4 个语义测试：`semantic_all_unpushed_when_no_remote` / `semantic_colors_unpushed_local` 等）。
2. 二次打开（HEAD / refs 未变）~>80ms 预算内命中缓存：同 page 输出逐责相等（`GitLogPage.semantic` 与不解缓存一致）。
3. HEAD 变化（新 commit）→ 缓存失效重算；删除 refs / fetch 更新 refs → 指纹变 → 缓存失效重算。
4. 空仓库 / 非仓库路径 → 缓存降级为 None，不 panic、不写缓存文件。
5. 门控全绿：`cargo check --lib`、`cargo check --no-default-features --bin polaris-web --bin polaris-mcp`、clippy 新增 0、`tsc --noEmit`、eslint。

---

## 四、不做

- **不做整页缓存**（commits+rows 体积大且随 skip 变，LRU 复杂度换不来收益）。
- **不做跨分支缓存共享**（不同分支语义色本就不同，各自独立文件，无需合并）。
- **不做 LRU / TTL**（仅按 mtime 溢出清理，语义 map 小）。
- **不改前端协议 / 不改 git_capability**（这是后端纯性能优化）。
- **graph.c 四数组收缩**仍为独立后续增量（本 spec 只覆盖缓存）。