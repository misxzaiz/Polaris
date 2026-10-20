# FR-P2-3 · Undo 网络（危险操作快照 + 一键恢复）— Spec

> 四段式 spec：目标 / 契约 / 验收 / 不做。
> 依据：`git-panel-master-plan.md` P2「undo 网络（恢复语义含反向快照 + .rej 诊断 + 保留策略 per-ws 上限）」+ `git-panel-prd.md` §3 Undo 网络、§安全「危险操作快照覆盖率 100%」。
> 效力顺序：master-plan > PRD > 本文。

---

## 一、目标

危险操作（discard / reset hard / checkout 覆盖 / interactive rebase / 删除分支）执行前自动保存当前工作区状态，操作后就地通知条可一键恢复；并约束保留策略避免无限膨胀。

**核心设计决策：快照 = git-native ref（`refs/polaris-undo/...`），不复制文件。**

理由：
- 快照成本低——git 对象增量存储，只存「与 HEAD 的差」，不复制整个工作区；
- 恢复走 git2 既有路径（apply / checkout 到快照），语义与 git 一致，不重写文件；
- `.rej` 诊断是恢复遇冲突时的天然副产品（`git checkout` / `git stash apply` 的 reject 文件），符合 master-plan「恢复语义含反向快照 + .rej 诊断」；
- 删除分支保留 hash 亦可（快照记录目标 ref 的原始 commit，删除后可恢复）；
- 保留策略 per-ws 上限 = ref 计数 + 时间，清理廉价。

**快照原语 = `git stash create` 单步**（不经 stash 栈、不改工作区）：

```sh
# 快照：把当前未提交改动做成一个 stash commit 对象，返回其 sha（不动工作区、不入 stash 栈）
sha=$(git stash create "polaris-undo <context>")
# 记为 refr（供恢复、列表、清理）
git update-ref refs/polaris-undo/<ws>/<ts> "$sha"
```

- `git stash create` 只创建 commit 对象并返回 sha，**不修改工作区、不 pop、无冲突竞态**（对比 naive 的 stash→commit→pop 三步，pop 有冲突风险）；
- 无未提交改动时返回空 → 快照 ref 指向当前 HEAD（记录 refs 原值的场景）；
- 恢复：有改动快照 → `git stash apply <sha>`（遇冲突出 `.rej`）；指 HEAD 但记录删分支 refs → 重建 ref。

---

## 二、契约

### 2.1 快照原语（Rust）

新增 `src-tauri/src/services/git/undo.rs`（挂在 `services/git/mod.rs`）：

```rust
/// 为 workspace 创建撤销快照。返回快照 ref 名（失败返回 Err）。
/// 快照 = refs/polaris-undo/<ws-encoded>/<yyyyMMdd-HHmmss>：
/// - 有未提交改动 → git stash create 产生 stash commit（不改工作区），ref 指向它
/// - 无改动 → ref 指向当前 HEAD，且（如 extra_refs 传了删除分支）记录该 ref 原 commit
pub fn create_undo_snapshot(
    repo: &Repository,
    ws_path: &Path,
    context: &str,          // 触发操作（discard / reset_hard / checkout / rebase / branch_delete）
    extra_refs: &[String],  // 需要记录原始 commit 的 refs（如删除的分支名）
) -> Result<String, GitError>
```

```rust
/// 恢复指定快照。等价 git checkout 快照 commit + （如快照记录了原 ref）重建 ref。
/// 遇冲突：返回冲突文件列表 + 写 .rej 文件（诊断）。
pub fn restore_undo_snapshot(repo: &Repository, ws_path: &Path, snapshot_ref: &str) -> Result<RestoreOutcome, GitError>
```

```rust
/// 列出某 workspace 的全部快照（倒序），前端通知条/面板用。
pub fn list_undo_snapshots(repo: &Repository, ws_path: &Path) -> Result<Vec<UndoSnapshotMeta>, GitError>
```

```rust
/// 按保留策略清理：每 ws 最多保留 N（默认 5）个最近快照，超限删旧。
pub fn prune_undo_snapshots(repo: &Repository, ws_path: &Path, max_keep: usize) -> Result<usize, GitError>
```

类型（`models/git.rs` + `types/git.ts` 双边同步）：

```rust
pub struct UndoSnapshotMeta {
    pub name: String,       // 快照 ref 名
    pub created_at: i64,    // 时间戳
    pub context: String,    // 触发操作
    pub has_changes: bool,  // 是否有未提交改动被快照
    pub branch: Option<String>,  // 快照时所在分支
}
```

### 2.2 危险操作挂钩（快照覆盖率 100%）

**统一单点挂钩**：所有 git 动作都经 `git_capability.rs::invoke()`（`is_destructive` + WRITE_GATE 已在 L242-248，拿到 action 名 + workspace path），在 match 前插快照钩子，一次性覆盖全部危险 action——比在各函数内插更省、且天然在写栅栏串行域内。

```rust
// git_capability.rs::invoke() 内，写栅栏通过后、match 前：
// 只对「真危险」动作快照；日常写（commit/stage/stash 等）不做——
// 它们的后果经 reflog + commit 历史天然可恢复，快照是成本+噪音。
if SNAPSHOT_ACTIONS.contains(a) {
    if let Ok(snapshot_ref) = create_undo_snapshot_for_action(a, p)? { /* 成功后 emit UndoSnapshotEvent */ }
}
```

**SNAPSHOT_ACTIONS**（真危险集，不含日常写）：
`discard_changes, reset(hard), checkout_branch, checkout_commit, delete_branch, rebase_branch`。

| action | 快照内容 | 恢复方式 | context |
|---|---|---|---|
| `discard_changes` | 目标文件当前工作区内容 | 重写该文件 | `discard` |
| `reset` (mode=hard) | 完整工作区改动（`git stash create` 全量）+ HEAD sha | `git stash apply` / reset 回原 HEAD | `reset_hard` |
| `checkout_branch` | 当前 HEAD sha + 脏工作区 diff | checkout 回原分支 + stash apply | `checkout` |
| `checkout_commit` | 当前 HEAD sha + 脏工作区 diff | checkout 回原 HEAD + stash apply | `checkout` |
| `delete_branch` | 被删分支 tip commit sha + 引用名 | 重建 ref 指向原 tip | `branch_delete` |
| `rebase_branch` | 当前 HEAD + rebase 起点 | reset 回原 HEAD | `rebase` |
| interactive rebase | 无（P3 补） | — | — |

- **快照失败不阻塞操作**：`create_undo_snapshot` 返回 Err 时记录 warn 日志并继续原操作（undo 是增强安全网，不是硬门槛）。「覆盖率 100%」的实现边界是「代码路径上都有快照调用」，而非「快照失败也强制拦停」— 见 §四。
- 操作成功后立即 `prune_undo_snapshots(ws, 5)`，并向前端返回本次会话刚建的快照 ref（供 toast）。

### 2.3 恢复链路与事件

- **快照通知走事件，不改操作响应类型**：cap.git 危险操作成功后，emit 一个 `git-undo-snapshot` 事件（载荷 `{ wsPath, snapshotRef, context }`）。前端订阅该事件弹 toast——与 `file-system-change` 事件模式一致，不侵入所有危险操作的 invoke 返回类型。
- toast 通知条显示「已创建撤销快照」+「撤销」按钮（复用 toastStore `addToast` + `action`，参考 `sessionComplete` 用法）。
- 点「撤销」→ 调 `restore_undo_snapshot(ws, snapshot_ref)` → 恢复后 `refreshStatus` + 刷新 log/branches。
- 恢复遇冲突 → toast 展示冲突文件列表，`.rej` 留在工作区供诊断。

```rust
/// 快照事件载荷（emit 到前端）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoSnapshotEvent {
    pub ws_path: String,
    pub snapshot_ref: String,
    pub context: String,
}
```

### 2.4 前端快照列表（可选增量，非首期）

通知条之外，提供一个「撤销快照」小列表（`UndoSnapshotsPanel`，GitPanel 里独立组件，不膨胀主文件），列全部快照可手动恢复/删除。首期可只做通知条，列表归 P2 增量。

---

## 三、验收

1. **Rust 单测**（undo.rs `#[cfg(test)]`）：
   - `create_undo_snapshot` 对「有未提交改动」仓库产 ref，工作区改动在快照中；
   - `restore_undo_snapshot` 恢复改动到工作区；冲突场景返回冲突列表 + `.rej` 存在；
   - `prune_undo_snapshots` 超限清理旧快照。
2. **协议双同步**：`UndoSnapshotMeta` 两边一致。
3. **挂点覆盖**：discard / reset hard / checkout 覆盖三处调用 `create_undo_snapshot`（单测断言调用顺序）。
4. **前端测试**：toast 通知条 + 撤销按钮触发 `restore_undo_snapshot`；恢复后 `refreshStatus` 被调。
5. **手动验证**：
   - discard 一个文件 → 通知条 → 撤销 → 文件内容回来；
   - reset hard → 撤销 → 恢复 reset 前状态；
   - 删除分支 → 撤销 → 分支重建在正确 commit。
6. **回归**：`pnpm exec tsc --noEmit` + GitPanel/gitStore vitest + `cargo check` + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp`（动命令层）。

---

## 四、不做（边界）

- **不做文件级快照复制**：快照是 git-native ref，不是把工作区复制到 DataRoot 目录（避免与 git 语义双轨）。
- **不做 .rej 自动应用**：恢复冲突时只出 `.rej` + 冲突列表，人工解决；自动 3-way 合并归 P3 冲突合并器。
- **interactive rebase 快照本 FR 不做**：P3 时在 rebase 入口插（当前无 rebase 实现）。
- **不做跨操作恢复**：快照只覆盖触发它的那一个操作，不承诺「恢复到任意历史点」（那是 reflog 的能力，已有 P1 reflog UI）。
- **日常写不快照**：commit / stage / stash / branch create 等后果经 reflog + commit 历史天然可恢复，不入 undo 快照集（快照是成本+噪音）。只对「真危险」6 动作快照。
- **快照失败不阻塞操作**：undo 是增强安全网；「覆盖率 100%」的实现边界是「代码路径上都有快照调用」，而非「快照失败也强制拦停」。
- **不做 DataRoot 持久化快照目录**：git ref 本身在 `.git` 里，随仓库走；DataRoot 只用于（可选）前端展示的元数据索引。

---

## 五、关键文件

- `src-tauri/src/services/git/undo.rs`（新建：create_undo_snapshot / restore_undo_snapshot / list_undo_snapshots / prune_undo_snapshots）
- `src-tauri/src/services/git/mod.rs`（挂载 undo 模块）
- `src-tauri/src/models/git.rs` + `src/types/git.ts`（`UndoSnapshotMeta` / `UndoSnapshotEvent`）
- `src-tauri/src/services/router/git_capability.rs`（`SNAPSHOT_ACTIONS` + invoke 钩子 + undo action 注册 + `git-undo-snapshot` 事件）
- git 实现插点（作为验证参考）：`commit.rs:340`（discard）、`reset.rs:35`（reset hard）、`branch.rs:135/375`（checkout）、`branch.rs:146`（delete_branch）、`rebase.rs:21`（rebase）
- `src/stores/gitStore/`（undoSlice：list/restore actions + 事件订阅）
- `src/components/GitPanel/`（toast 挂载点；UndoSnapshotsPanel 增量）
- 复用：`src/stores/toastStore.ts`（`addToast` + `action`）；`src/components/Common/Toast.tsx`（已渲染 action 按钮）；`src/components/Common/ConfirmDialog.tsx`（可扩展为「危险操作确认卡」）
