# Git 面板：多选提速 + 行内快捷按钮 + 键盘交互 spec

日期：2026-10-22
动机（用户原话）："git 面板…支持多选…优化查询修改内容的交互，如快捷键、快文件调整、加入手动点击按钮…目前有的可以用，但是不好用——需要便于多情况看变更及调整。"

## 一、目标 / 非目标

目标：
1. **快捷文件调整**：变更行悬停即出快捷按钮（stage / unstage / discard），不必进右键菜单。
2. **多选增强**：Shift+点击区间多选、Ctrl+A 全选/反选、Esc 清除选择。
3. **批量操作提速**：前嫌批量 stage/unstage/discard 走前端逐文件循环（每个文件一次调用 + 一次 refreshStatus），改为**单次总线调用 + 单次刷新**。
   - stage 复用既有 `batch_stage`；
   - 新增后端动作 `batch_unstage` / `batch_discard`（cap.git）。`batch_discard` 属真危险动作 → 自动建撤销快照（对齐 `discard_changes`）。
4. **键盘交互**（面板级，不上全局 keybinding 系统）：
   - ↑ / ↓：移动焦点行（列表可视滚动跟随）
   - Enter：打开焦点行 diff（= 点行）
   - Space / Shift+Space：勾选焦点行 / 区间勾选（锚点 = 上次选择操作所在行）
   - Ctrl/Cmd+A：列表内全选/取消全选
   - Ctrl/Cmd+Enter（CommitInput 聚焦时）：提交
   - F5：刷新状态；Esc：清除多选（面板级，输入框内不劫持）
5. **History tab**：已完整（泳道/搜索/commit 详情/文件历史/blame 转跳），本轮不动其交互；徽标数（恒 0）不在本轮修（历史数量 = 加载页计数，语义有歧义）。

非目标：拖拽 stage/unstage、行内 hunk 级操作、全局快捷键注册系统、AtomicCommitCard 复挂。

## 二、所有权与数据流

```
FileChangesList （UI：行渲染 / 区间锚点 anchRef / 焦点行 focusedKey / 行内按钮）
   │  onSelectRange(paths, select)  ← Shift 点击 / Shift+Space
   ▼
index.tsx （selectedFiles 单权威；批量 handlers 一次调用 store 批量 action）
   ▼
gitStore commitSlice （batchStage / batchUnstage / batchDiscard：invoke 一次 + refreshStatus 一次）
   ▼ transport shim（git_ 前缀 → cap.git router_dispatch）
   ▼
cap.git（写动作过 WRITE_GATE max=1；batch_discard 自动快照 + git-operation 流水）
   ▼
GitService::batch_stage / batch_unstage / batch_discard （libgit2，单 repo open，单 index write）
```

事件顺序与幂等边界：
- 批量结果按文件收集 `ok[] / failed[]`，**部分成功不整体失败**；前端 toast 呈现成功/失败计数，失败明细靠 git-operation 流水 + status 刷新后的真实状态兜底。
- batch_discard 快照在 WRITE_GATE 后、执行前创建（与 discard_changes 同钩子）；失败只 warn 不阻塞。

## 三、接口约定（双边同步）

Rust `models/git.rs` 新增：
```rust
pub struct BatchOpResult { pub ok: Vec<String>, pub failed: Vec<StageFailure>, pub total: usize }
```
前端 `types/git.ts` 对应 `BatchOpResult`。

cap.git 新 action（camelCase 参数，同 batch_stage）：
- `batch_unstage`: `{ workspacePath, filePaths: string[] }`
- `batch_discard`: `{ workspacePath, filePaths: string[] }`（untracked 拒绝逐条记入 failed）
- 两处登记：`KNOWN_ACTIONS` + invoke match（tests::every_known_action_is_handled 巡逻）；同时登记 `DESTRUCTIVE_ACTIONS`、`SNAPSHOT_ACTIONS`(仅 batch_discard)、`action_label`。

gitStore `CommitActions` 新增：
```ts
batchUnstage(ws: string, filePaths: string[]): Promise<BatchOpResult>
batchDiscard(ws: string, filePaths: string[]): Promise<BatchOpResult>
```

## 四、验收

实际验证（2026-10-22）：`cargo check` ✅ / `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` ✅ / `pnpm exec tsc --noEmit` ✅ / 受影响文件 eslint 0 警告 ✅ / `vitest run`（gitStore + GitPanel 18 文件 141 用例）✅

- [x] 悬停行直接出现 stage/unstage/discard 按钮，单击即生效（discard 仍经确认框）
- [x] Shift+点击 与 Shift+Space 区间多选；Ctrl+A 全选/反选；Esc 清除
- [x] ↑/↓/Enter/Space 键盘走查变更列表；Ctrl+Enter 在提交框提交；F5 刷新
- [x] 批量 3 类操作 = 每类 1 次总线调用 + 1 次 refreshStatus（含 N=1）
- [x] `pnpm typecheck` 通过；`pnpm lint` 无新增；`cargo check` 通过
- [x] GitPanel 既有 vitest 全过

## 五、i18n 新键

`git namespace`：`selectionHints`（全选栏 title 提示）、`batchPartial`（部分成功计数）、`commit.ctrlEnterHint`（提交按钮 title）。zh-CN / en-US 双语同步。
