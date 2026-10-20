# P3 冲突合并器 + 冲突域协议升级（C10/C11）spec

> 效力顺序：`git-panel-master-plan.md` > `git-panel-prd.md` > 本文。
> 四段式：目标 / 契约 / 验收 / 不做。
> 对应 C10（非内容冲突全穿帮）+ C11（序列操作交叉守卫 + continue 链断裂）+ FR-P3-1 冲突合并器。

---

## 一、目标

### 1.1 现状缺陷（源码证据）

1. **C10 非内容冲突全穿帮**：
   - 四类结果协议只有 `conflicts: string[]`（`models/git.rs:522/539/558/575`，前端 `types/git.ts:418/430/443/455`）；
   - merge 用 `index.conflicts()` 只取 path（`branch.rs:319-330`），binary/delete-modify/rename-delete 无 marker 可解析；
   - `status.rs:183-185` 把冲突归并一个 `CONFLICTED` bit → `conflicted: Vec<String>` 丢 kind。
2. **C11 序列操作交叉守卫缺失 + continue 链断裂**：
   - `branch.rs:250` 只查 `has_conflicts`，merge 与 rebase 状态不互斥；
   - rebase/cherry-pick/revert 冲突判定靠 stderr 包含 "CONFLICT"（`rebase.rs:115-117`、`cherry_pick.rs:79-81`、`revert.rs:79-81`）；
   - rebase continue 步数不存活（`rebase_continue` 失败返回 `current_step: 0, total_steps: 0`）；
   - `get_conflict_files`（`git diff --name-only --diff-filter=U`）不区分 kind。
3. **FR-P3-1 冲突合并器缺失**：无三窗编辑器、无 per-hunk 控件、无未解决计数、无 current/incoming 语义标签。

### 1.2 本期交付

- **协议升级一次到位**（C10）：`GitConflictEntry { path, kind, stages }`，四结果结构（merge/rebase/cherry-pick/revert）`conflicts` 字段升级为 `Vec<GitConflictEntry>`。
- **归一序列操作状态探测**（C11）：`git_sequence_state` 从 `.git/{MERGE_HEAD, REBASE_HEAD, rebase-merge, CHERRY_PICK_HEAD, REVERT_HEAD}` 读取，判定当前操作类型 + 步数回读；Continue 一律从状态回读，不信任 stderr。
- **前端三窗合并器**（FR-P3-1）：独立对话框 + 编辑器内嵌两形态；per-hunk Accept Ours/Theirs + Apply All Non-Conflicting；未解决计数常驻；current/incoming 语义标签随操作类型变化；解决后直落 staging。

---

## 二、契约

### 2.1 后端协议（`models/git.rs`，camelCase）

```rust
/// 冲突 kind（C10：二进制 / delete-modify / rename-delete 不再穿帮）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitConflictKind {
    Text,    // 文本冲突（有 marker 可解析）
    Binary,  // 二进制冲突（无 marker，只能整文件取舍）
    DeletedByUs,    // delete/modify：本地删、对方改
    DeletedByThem,  // delete/modify：对方删、本地改
    RenameDelete,   // rename/delete
}

/// 单文件冲突条目
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitConflictEntry {
    pub path: String,
    pub kind: GitConflictKind,
    /// 冲突三方 stage 内容（Text 有内容；Binary 无，可为空）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ours: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theirs: Option<String>,
}
```

- 四结果结构 `GitMergeResult` / `GitRebaseResult` / `GitCherryPickResult` / `GitRevertResult` 的 `conflicts: Vec<String>` → **`conflicts: Vec<GitConflictEntry>`**（一次改齐，C10）。
- 保留 `has_conflicts: bool`（后端向前端仍是布尔开关，前端无需改判断逻辑）。
- `GitRepositoryStatus.conflicted: Vec<String>` **保持不动**（status 高频轻量，不升级为 entry；合并器从 `get_conflict_state` 拿完整数据）。

### 2.2 后端序列操作机（C11，新文件 `services/git/sequence.rs`）

```rust
/// 当前进行中的序列操作类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitSequenceKind {
    None,
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

/// 序列操作状态（归一探测，Continue 一律从这里回读）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitSequenceState {
    pub kind: GitSequenceKind,
    pub has_conflicts: bool,
    pub conflicts: Vec<GitConflictEntry>,
    /// rebase 步数（rebase-merge/end + done 文件回读；merge 等无步数为 None）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_step: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_steps: Option<usize>,
}
```

- **探测优先序**（Git 原生优先级）：`rebase-merge/` > `MERGE_HEAD` > `REBASE_HEAD` > `CHERRY_PICK_HEAD` > `REVERT_HEAD` > 无。
- **步数回读**：rebase 从 `rebase-merge/end`（总步数）与 `rebase-merge/msgnum`（当前步，1 起）读取；无文件时 `None`。
- **冲突枚举**（所有操作统一）：`index.conflicts()` 逐条，从 stage 条目构造 `GitConflictEntry`：
  - `our`+`their`+`ancestor` 都有，且任一方内容含 `\0`（二进制）或 diff 无法解析 → `Binary`；
  - 只有 `our`（对方删）→ `DeletedByThem`；只有 `their`（本地删）→ `DeletedByUs`；
  - 其余 → `Text`，带 `base/ours/theirs` 全文（供前端解析 markers）。
- **新动作**（cap.git）：`get_conflict_state`（只读，非写 → 不进 DESTRUCTIVE_ACTIONS，不进操作流水）。
- **continue 加固**（C11）：`rebase_continue` / `cherry_pick_continue` / `revert_continue` 失败路径改为**先回读状态**：
  - 有未解决冲突 → 返回 `has_conflicts: true + conflicts + current_step/total_steps（步数存活）`；
  - 无冲突但命令失败 → 才报 CLIError（不再靠 stderr "CONFLICT" 判定）。
- **交叉守卫**（C11）：`merge_branch` / `rebase_branch` / `cherry_pick` / `revert` 入口统一走 `get_conflict_state` 检查——只要 `kind != None` 即报对应 InProgress 错误（不再只查 `has_conflicts`）。

### 2.3 前端协议（`types/git.ts`，snake_case，C3 裁决不对称保留）

```ts
export type GitConflictKind = 'text' | 'binary' | 'deleted_by_us' | 'deleted_by_them' | 'rename_delete';
export interface GitConflictEntry {
  path: string;
  kind: GitConflictKind;
  base?: string;
  ours?: string;
  theirs?: string;
}
export type GitSequenceKind = 'none' | 'merge' | 'rebase' | 'cherry_pick' | 'revert';
export interface GitSequenceState {
  kind: GitSequenceKind;
  hasConflicts: boolean;
  conflicts: GitConflictEntry[];
  currentStep?: number;
  totalSteps?: number;
}
```

- 四结果接口 `conflicts: string[]` → `conflicts: GitConflictEntry[]`（双边同步）。

### 2.4 前端合并器（FR-P3-1）

**组件结构**（不膨胀 HistoryTab，新组件）：

```
src/components/GitPanel/conflict/
  ConflictMergerDialog.tsx     // 独立对话框形态（文件级对话框：Accept Yours/Theirs/Resolve Manually + Resolve All Simple）
  ThreeWayMergeEditor.tsx      // 编辑器内嵌形态（三窗 base|result|theirs + per-hunk 控件）
  parseConflictMarkers.ts      // 纯函数：文本 marker → hunks 结构
```

**`parseConflictMarkers.ts`**：
- 输入：`conflict.base` / `conflict.ours` / `conflict.theirs`（`GitConflictEntry`）；
- 输出：`hunks: { id, oursLines, theirsLines, baseLines, conflictRange }[]`；
- 解析 `<7*'<' HEAD` ... `=======` ... `<7*'>' incoming` 标准 marker，合并相邻/非交叠；
- `binary` / `deleted_by_*` 无 marker → 不进入 per-hunk 编辑器，走文件级整取舍。

**`ThreeWayMergeEditor.tsx`**（VS Code 规范）：
- 三窗：左 `ours`（只读）｜ 中 `result`（可编辑，逐 hunk 拼合）｜ 右 `theirs`（只读）；
- per-hunk 控件：`Accept Ours` / `Accept Theirs` / `✦ AI 建议`（默认折叠，逐块确认——AI-5）；
- `Apply All Non-Conflicting` 一键：非冲突单侧改动（`ours` 空或 `theirs` 空）全部纳入 result；
- **未解决计数常驻**：顶栏 `未解决 N`，归零后「完成并暂存」按钮点亮；
- 完成 → 写 result 到工作区文件 + `git add`（直落 staging）；
- current/incoming 语义标签：按 `GitSequenceState.kind` 渲染
  - `merge` → 左=ours（current）/ 右=theirs（incoming）
  - `rebase` / `cherry_pick` → 左=ours（incoming）/ 右=theirs（current，被 cherry-pick/rebase 的提交内容）
  - `revert` → 左=ours（incoming）/ 右=theirs（current，被 revert 的提交内容）
- **完成后自动跳下一冲突文件**。

**`ConflictMergerDialog.tsx`**（文件级，先弹）：
- 列出所有 `GitConflictEntry`，每文件：`Accept Yours` / `Accept Theirs` / `Resolve Manually`；
- `Resolve All Simple Conflicts` 一键（binary 之外所有 `deleted_by_*` 自动取 ours）+ 剩余文本冲突进编辑器；
- 入口：冲突文件行点击（graph 冲突节点 ⚠️ / status conflicted 列表 / 合并后冲突提示）。

**store / 服务**：
- `conflictStore.ts`（新 slice）：`getConflictState` invoke + 合并器打开/关闭状态；
- `gitService.ts` 或 transport 透传 `git_get_conflict_state` → cap.git。

### 2.5 cap.git 注册（三处同步 + 巡逻）

- `KNOWN_ACTIONS` 加 `"get_conflict_state"`（`git_capability.rs:225`）；
- match 分支加 `get_conflict_state`；
- 前端 transport 若按 KNOWN_ACTIONS 做 describe（如有）同步；
- `tests::every_known_action_is_handled` 巡逻自动覆盖。

---

## 三、验收

1. **协议双边同步**：`models/git.rs` + `types/git.ts` 的 `GitConflictEntry` / `GitSequenceState` 字段一一对应（kind 枚举值 snake_case 一致）。
2. **C10 非内容冲突穿帮**：构造 merge 场景含 (a) 文本冲突 (b) 二进制冲突 (c) delete-modify (d) rename-delete → `get_conflict_state` 返回四种 `kind` 正确区分，`conflicts` 均带 `path`。
3. **C11 状态回读**：
   - rebase 停在冲突步 → `get_conflict_state` 返回 `kind=rebase` + `current_step`/`total_steps` 正确存活（不等于 0）；
   - merge 进行中 → `kind=merge`；`merge_branch` 此时调用报 `MergeInProgress`（不误报 RebaseInProgress）。
4. **continue 不信任 stderr**：rebase 冲突后 `rebase_continue` 返回 `has_conflicts=true + 步数存活`（不再 `current_step=0`）。
5. **前端合并器**：
   - `parseConflictMarkers` 单测覆盖标准 marker / 相邻 hunk / 无 marker 三类；
   - `ThreeWayMergeEditor` 渲染三窗 + per-hunk Accept Ours/Theirs 生效 + 计数递减 + 归零点亮完成按钮；
   - `Apply All Non-Conflicting` 只合入非冲突单侧改动；
   - 语义标签随 kind 变化（merge vs rebase 左右互换）。
6. **门控全绿**：`cargo check --lib`、web-only 门控、clippy 新增 0、GitPanel 46 + gitStore 232 测试全绿、前端 `tsc --noEmit` + `lint`。

---

## 四、不做

- **不做完整 VS Code merge editor 代码折叠/滚动同步**（本轮只做三窗 + per-hunk + 计数 + 直落 staging）。
- **不做 AI-5 整文件级「AI 一键解决草稿」**（FR-P3-AI5 的 agentic 升级留 P3+ 探索，本轮只做 per-hunk 建议卡，默认折叠）。
- **不做 Interactive Rebase**（FR-P3-2 单独条目）。
- **不做 status 协议升级**（`conflicted: Vec<String>` 保持，合并器数据源是 `get_conflict_state`）。
- **不做 merge 的 renaming 冲突自动探测**（RenameDelete 只做 kind 标记，不做 rename 应用逻辑）。
- **不做 `get_conflict_state` 进操作流水/审计**（只读查询，不是写动作）。
