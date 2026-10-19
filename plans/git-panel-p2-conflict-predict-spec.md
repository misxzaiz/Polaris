# FR-P2-AI4 冲突预测 — 实施 spec

> 效力：`git-panel-master-plan.md` §1.2（AI-4 裁决砍掉 AI、仅留一条规则建议）> 本文。
> 形态：纯后端确定性计算 + 前端直接显示；0 token 消耗。AI 解释层为后续可选升级。

---

## 一、目标

fetch（或 auto-fetch）成功后，对本仓库「对方 ahead commits 涉及的文件」与「本地 modified
文件」求交集，产出**冲突风险清单**，前端 fetch 入口附近点亮卡片。清单是确定计算，前端直接
显示，不点开不消耗任何 token。

对齐原型 `plans/git-panel-vnext-prototype.html` 的 `#conflict-predict` 卡片
（"↓N commits 涉及文件 ∩ 本地 modified"，风险文件红链表 + 建议条）。注 ⑦：清单不耗 token，
AI 只产解释 → 成本 ⚡⚡ 分段可控；master-plan 裁决本阶段将解释层整体砍掉，仅保留规则建议。

## 二、契约

### 2.1 后端

**新模块** `src-tauri/src/services/git/conflict.rs`：

```
pub fn predict_conflicts(
    path: &Path,
    branch: Option<&str>,          // 缺省当前分支
) -> Result<GitConflictPrediction, GitServiceError>
```

算法（全部 git2，纯读）：
1. 打开仓库，取当前 HEAD（分支可显式指定）。
2. 定位本地分支的 upstream（`refs/remotes/<remote>/<branch>`），无 upstream → 返回空预测
   （`upstream: None`，风险为空）。
3. **本地 modified 集合**：复用 `status.rs::parse_statuses`（改可见性 `pub(super)`），
   取 staged + unstaged 的路径（排除纯 untracked —— 未跟踪文件不与 pull 冲突判定，
   对齐 PRD「本地 modified 文件」措辞）。
4. **incoming commits**：revwalk `push(upstream_oid).hide(head_oid)`，得到「对方在前、
   本地没有」的提交集（等价 `HEAD..<upstream>`，`git log HEAD..origin/main` 语义）。
5. **incoming files**：对每个 incoming commit，`diff_tree_to_tree(第一父, 自身)` 遍
   `deltas()` 收集受影响的路径（新/旧路径取其一，rename/copy 取 new）。合并 commit 只
   与第一父比（保守口径）。
6. **riskFiles** = incomingFiles ∩ localModified。空交集 → 直接 pull 安全。

**结果模型**（`src-tauri/src/models/git.rs`，camelCase）：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictPrediction {
    pub branch: String,                     // 计算对象分支名
    pub upstream: Option<String>,           // upstream 的 shorthand 名（无上游为 None）
    pub behind: usize,                      // 对方领先的提交数（HEAD..upstream 计数）
    pub incoming: Vec<GitIncomingCommitPreview>, // 对方提交预览（sha/summary）
    pub local_modified: Vec<String>,        // 本地已修改路径（staged+unstaged）
    pub incoming_files: Vec<String>,        // 对方提交涉及的全部路径
    pub risk_files: Vec<String>,            // 交集 = 冲突风险清单
    pub advice: String,                     // "none" | "commitOrStash"（见 §2.2）
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIncomingCommitPreview {
    pub sha: String,
    pub short_sha: String,
    pub summary: String,
}
```

### 2.2 建议规则（master-plan §1.2：AI 砍掉，一条规则建议）

- `advice = "commitOrStash"`：`risk_files` 非空且本地有未提交改动 → 建议「先 commit/stash
  本地 WIP 再 pull」。
- `advice = "none"`：无风险（直接 pull 安全，或 behind == 0）。

前端按 advice 映射 i18n 文案；后端只回稳定的枚举串，不做双语。

### 2.3 cap.git 动作

`git_capability.rs` 新增只读动作 `predict_conflicts`：

- params: `{ workspacePath: string, branch?: string }`
- 只读：**不进** DESTRUCTIVE_ACTIONS / SNAPSHOT_ACTIONS / 操作流水（不写环形缓冲、不
  emit 事件）；KNOWLEDGE. 不加写栅栏。
- 同步：`KNOWN_ACTIONS` + `describe()` + 巡逻测试 `every_known_action_is_handled` 三处。

### 2.4 前端

- `src/types/git.ts`：`GitConflictPrediction` / `GitIncomingCommitPreview` 接口
  （camelCase，与 Rust serde 对齐）。
- `src/stores/gitStore/conflictPredictSlice.ts`：方法 `predictConflicts(workspacePath,
  branch?) → Promise<GitConflictPrediction | null>`；分片状态 `conflictPredictionByWs`
  （keyed，对齐 P1.5 约定），返回空预测时置 `null`。镜像域 `conflictPrediction`（当前
  生效仓库直读，无路径参数版）。
- `src/components/GitPanel/ConflictPredictionCard.tsx`（新建，独立组件不膨胀 RemoteTab）：
  - 入参 `prediction`（null 时不渲染）；
  - 渲染：标题「冲突预测」、behind 提示（"对方领先 N 个提交"）、风险文件红链表（riskFiles）、
    本地已修改/对方涉及文件折叠明细、建议条（advice → i18n）；
  - 「重新计算」按钮（可手动刷新，界面不阻塞）。
- `RemoteTab.tsx`：`handleFetch` 成功后追加 `predictConflicts(workspacePath, remote)`，
  结果渲染卡片（置于远程列表下方）。auto-fetch 走同一 handleFetch → 自动刷新。

### 2.5 i18n

`zh-CN/git.json` + `en-US/git.json` 各新增 `conflictPrediction.*`（键集保持严格对齐）：

| key | zh | en |
|---|---|---|
| title | 冲突预测 | Conflict Prediction |
| behind | 对方领先 {{count}} 个提交 | {{count}} commits ahead |
| riskTitle | 可能冲突的文件 | Files at risk |
| riskCount | {{count}} 个文件可能冲突 | {{count}} files may conflict |
| localModified | 本地已修改 | Local changes |
| incomingFiles | 对方涉及文件 | Incoming files |
| advice.none | 无冲突风险，可直接拉取 | No conflict risk, safe to pull |
| advice.commitOrStash | 建议先提交/储藏本地改动，再拉取 | Commit or stash local changes first, then pull |
| safe | 拉取安全 | Pull safe |
| recompute | 重新计算 | Recompute |
| noUpstream | 分支无上游，无比较对象 | No upstream to compare |

## 三、验收

1. **Rust 单元**（`conflict.rs`，hermetic 仓库构造）：
   - 分叉场景：main 在 c1；另建 c2（含 a.txt 修改）作为 upstream（`refs/remotes/origin/main`
     指向 c2）；本地工作区改 a.txt 与 b.txt → `predict_conflicts` 的 `riskFiles == ["a.txt"]`，
     `incoming_files` 含 a.txt，`advice == "commitOrStash"`。
   - 无风险场景：本地只改 b.txt → `riskFiles` 空，`advice == "none"`。
   - 无 upstream → `upstream: None`，空清单，不报错。
   - `every_known_action_is_handled` 巡逻（predict_conflicts 进 KNOWN_ACTIONS + match）绿。
2. **前端**：
   - `conflictPredictSlice.test.ts`：invoke 命中 `git_predict_conflicts` + 空预测置 null +
     失败吞错（不 throw，返回 null）。
   - `RemoteTab.test.tsx` 扩展：mock `predictConflicts`；fetch 后断言被调用；卡片渲染风险清单。
   - `ConflictPredictionCard.test.tsx`：null 不渲染 / 有风险渲染红链表 / advice 文案。
3. **双语键集**：zh/en `conflictPrediction.*` 严格对齐（脚本比对 0 diff）。
4. **真实仓库 e2e**（手工）：构造 2 仓库分叉，`fetch` 后卡片清单文件集与 `git log
   HEAD..origin/main --name-only` ∩ `git status` 交集人工比对一致。

## 四、不做

- **不做** AI 解释层（master-plan §1.2 已砍；后续可按 ⚡⚡ 预算升级为 `kind='git-conflict'` 会话）。
- **不做** untracked 文件冲突判定（PRD 措辞「本地 modified 文件」限定）。
- **不做** 3-way 冲突渲染 / 冲突合并器（P3 FR-P3-1 范围）。
- **不做** 提交级拖拽 / rebase 计划提议（P3 AI-8 范围）。
- **不做** 把预测持久化到磁盘（fetch 后重算即可，会话内只在 store）。
- **不动** 现有 casing 约定（`types/git.ts` 旧字段 snake_case 保留；本功能新协议定标 camelCase，
  对齐 `models/git.rs`）。