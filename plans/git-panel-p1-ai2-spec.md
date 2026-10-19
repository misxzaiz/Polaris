# Git 面板 · P1 AI-2 原子提交建议（本地分组预检先行）

> 效力顺序：`git-panel-master-plan.md`（最高权威）> `git-panel-prd.md` > 本文。
> 本文是实施 spec（四段式：目标 / 契约 / 验收 / 不做），对齐 master-plan 裁决 C12 / §1.2 / §1.3。

---

## 一、目标

**把一揽子改动拆成语义独立的多个 commit（原子提交）。**

按 master-plan 裁决 C12 与 §1.2 的**降格形态**：本地启发式分组预检先行（目录聚类 + change_type，**纯代码、确定性计算**），AI 只解释**置信低项**。不是「AI 全权分组」——确定性骨架优先于 LLM 项（裁决 8：LLM 三禁）。

核心链路：
1. **本地预检**：变更清单 → 确定性分组（同目录聚类 + change_type 判别），产出分组方案。
2. **AI 解释层（可选）**：对跨目录 / 多 change_type / 判定为「不适合拆分」的低置信项，投喂 `git-atomic` 会话，AI 给出合并/拆分建议，**AI 产出只是建议**。
3. **逐组确认执行**：分组卡片每组成员 + 拟 message + 理由；用户**逐组勾选确认**才执行（红线：所有 AI 产出必须是「建议 + 人工确认」二段式）。
4. **按组原子提交**：后端按组 stage → commit，**组间文件隔离**（不污染彼此 index 内容）。

验收场景（PRD FR-P1-AI2）：一次含 2+ 独立改动的场景下，分组卡片逐组勾选 → `git log --stat` 抽查组内文件与 message 语义一致。

---

## 二、契约

### 2.1 本地分组预检（纯代码 · 前端 service）

新文件 `src/services/gitAtomicGrouping.ts`：

```ts
/** 单组原子提交方案 */
export interface AtomicCommitGroup {
  id: string                        // 稳定组 id（排序后的文件集 hash）
  message: string                   // 拟提交信息（Conventional Commits，本地生成）
  files: GitDiffEntry[]             // 组内文件（含 worktree + index 统一视角）
  reason: string                    // 分组理由（目录聚类 / change_type / 不适合拆分）
  confidence: 'high' | 'low'        // 高置信（确定性判定）| 低置信（需 AI 解释）
  changeType: DiffChangeType        // 主导 change_type
  dir: string                       // 主导目录（相对仓库根，'' 表示根）
}

/** 本地预检分组（纯函数，无 IO） */
export function groupChangesForAtomicCommit(
  diffs: GitDiffEntry[],
  opts?: { splitByChangeType?: boolean }
): AtomicCommitGroup[]
```

分组规则（确定性，文档化）：
1. **目录聚类优先**：按 `dirname(file_path)` 聚类，同目录文件归一组。
2. **change_type 判别**：组内 change_type 不纯（如同目录既有 add 又有 delete）时，按 change_type 拆分子组（`splitByChangeType` 默认 true）。
3. **「不适合拆分」预检**：跨目录多 hunk 改动（文件分散在 >1 目录）→ 归为 `confidence:'low'` 的「合并组」候选，AI 解释层处理。
4. **单文件组**：孤立目录的单个文件 → `confidence:'high'`，message 按 change_type 生成（`feat`/`fix`/`docs`/`chore`/`refactor`/`test`）。

message 本地生成规则：`<type>(<scope>): <摘要>`；scope=主导目录段（如 `parser`、`merge`），摘要=文件数 + 主导 change_type 短语（如 `更新 3 个文件`、`新增 parser 解析`）。AI 可后续改写。

### 2.2 AI 解释层（kind='git-atomic' 会话）

克隆 `commitMessageChat.ts` 范式（handoff §7 step 2）：

- `src/services/atomicCommitChat.ts`：`openAtomicCommitChat({ workspaceId, workspacePath, engineId, groups, lowConfidenceOnly })`
  - `kind='git-atomic'` + `workspaceLocked` + `commitWorkspaceId=workspaceId`（复用 commit-message 的按 workspace 隔离模式）
  - **只投喂低置信组**（lowConfidenceOnly=true）：高置信组不消耗 token（AI 三禁之一：不让 AI 碰确定性的活）
  - 输入裁剪：低置信组 diff 用 `formatGitDiffWithContent`（单文件 600 chars / 总量 12k，AI-1 已有），组清单用 `formatGitDiffSummary`
  - `useAtomicCommitSuggestion(workspaceId)` 回流 hook：返回低置信组的 AI 建议文本，供「调整分组」回流
- 会话类型扩展：`types.ts` 的 `SessionMetadata.kind` / `CreateSessionOptions.kind` 增加 `'git-atomic'`（三处：`types.ts`、`createConversationStore` 若引用、`PROTECTED_SESSION_KINDS`）

### 2.3 后端按组原子提交（cap.git 新动作）

**语义陷阱**：现有 `commit(path, message, stageAll, selectedFiles)` 传 `selectedFiles` 会先 stage 这些文件然后**提交整个 index**——组 2 的已暂存文件会被组 1 的提交带走。必须新增**隔离语义**。

`src-tauri/src/services/git/commit.rs` 新增：

```rust
/// 按组原子提交：只提交组内文件，index 中其它已暂存内容不动。
/// 实现：临时记下当前 index 中"组外已暂存文件" → 提交 → 恢复这些文件的暂存态。
/// 等价语义：`git commit <paths>` 直通（不经 index 全局快照）。
pub fn commit_group(
    path: &Path,
    message: &str,
    files: &[String],
) -> Result<String, GitServiceError>
```

实现要点：
- `stage_selection` 先 stage 组内文件（含 untracked）。
- 提交前记下「组外已暂存」清单；提交后对组外文件重新 stage（恢复暂存态）。**提交后的 unstage 语义**：组内文件提交后已入 HEAD，恢复组外文件暂存即可，组内文件保持 committed。
- 或者更稳的等价方案：`git commit --only <paths> -m msg` 直通（git2 无等价 API，需 CLI）。**优先 git2 路径**（避开 CLI 解析，master-plan §六.6），用「快照-提交-恢复」实现。
- 空组 / 文件全未变更 → `GitServiceError::CLIError("No changes to commit")`。

cap.git 动作登记（`git_capability.rs` 三处同步）：
- `KNOWN_ACTIONS` + match 分支：`commit_group`
- `DESTRUCTIVE_ACTIONS`：`commit_group`（写类）
- `every_known_action_is_handled` 巡逻测试

### 2.4 前端 store / slice

`commitSlice.ts` 新增：

```ts
commitGroup: (workspacePath: string, files: string[], message: string) => Promise<string>
```

实现：`invoke('git_commit_group', { workspacePath, message, files })` → 成功后 `refreshStatus`。

### 2.5 UI：分组卡片组件

新文件 `src/components/GitPanel/AtomicCommitCard.tsx`（**新组件，不膨胀 HistoryTab/FileChangesList**）：

- 挂载点：`GitPanel/index.tsx` changes tab，CommitInput 上方（`FileChangesList` 之上）。
- 触发：`hasChanges(effectivePath)` 且有 ≥2 个独立改动时显示预检卡片。
- 结构（对齐 prototype #atomiccard）：
  - 组行：checkbox + 拟 message + 文件集 + 理由 + `confidence` 徽标（高置信绿色 / 低置信琥珀）
  - 底部：`确认执行 N/N 组`（仅勾选组）+ `✦ 调整分组`（打开 git-atomic 会话投喂低置信组）
- 逐组确认：每组 checkbox 独立；执行时仅勾选组按序提交。
- 执行后：`refreshStatus`，卡片随无变更消失。

---

## 三、验收

1. **本地预检单测**（`gitAtomicGrouping.test.ts`）：
   - 同目录 3 文件 → 1 组 high
   - 跨 2 目录 + 混合 change_type → 目录聚类 + change_type 拆分
   - 单文件孤目录 → 1 组 high，message 含正确 type/scope
2. **AI 会话**：`git-atomic` 会话创建 / 复用按 workspace 隔离（`useAtomicCommitSuggestion` 对非本 workspace 返回空）；低置信组投喂内容不含高置信组 diff。
3. **后端**：`commit_group` 组间隔离——预置组 2 文件已暂存，提交组 1，组 2 文件仍保持暂存态（`git log --stat` 抽查）。cap.git 巡逻测试同步。
4. **UI 验收场景（手测）**：2+ 独立改动 → 预检卡片出现 2 组 → 逐组勾选执行 → `git log --stat` 组内文件与 message 语义一致；不勾选任何组时「确认执行」禁用。
5. 门控：`pnpm exec tsc --noEmit` + `pnpm lint`；`cargo check`；web-only gate 若动命令层。

---

## 四、不做（边界）

- **不做 AI 全权分组**：AI 只解释低置信项，不做整体分组（C12 降格形态）。
- **不做 P2 lane / file-watcher 事件刷新**（FR-P2-2）：`repo_touched` producer 尚不存在，属 P2，本 spec 不碰。
- **不做 PR-2a 队列/progress/结构化错误**：`commit_group` 沿用 WRITE_GATE 互斥；结构化错误载荷 P2a 扩。
- **不做 undo 快照**（FR-P2-3）：组提交后误提交靠 `git reset`（P3 序列操作机做 undo 网络），本 spec 不建备份目录。
- **不做「不适合拆分」的强制拦截**：预检只标记 `confidence:'low'` 提示，不阻止用户直接整包提交（红线：建议不阻断）。
- **不改 commit() 现有语义**：`commitGroup` 是新增动作，旧 `commitChanges` 行为零改动。
