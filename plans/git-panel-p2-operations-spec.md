# FR-P2-4 操作流水面板 spec

> 对应 master-plan P2「操作流水面板」/ PRD §FR-P2-4（GitKraken Activity Log 等价）。
> 状态：待实施（FR-P2-3 undo 网络已完成，本条目为 P2 最后一个子项 + P2-AI4 冲突预测 / 泳道图增量前置）。

## 一、目标

危险操作与日常写操作（commit/stage/discard/reset/checkout/delete branch/rebase/undo 等）在 cap.git
执行后留痕一条「操作流水」：`时间 + 操作名 + 耗时 + 来源`。前端面板只读展示（GitKraken Activity
Log 等价 + Undo 网络证据链）。

对齐 prototype `addAct(name, ms)`（第⑥条）：最新在上，至多保留 N 条，UI 显示 `HH:MM:SS 操作名 xxms`。

## 二、数据流（唯一权威，禁止多写路径）

```
cap.git invoke (写动作，WRITE_GATE 内)
  └─ ActionRecord { ts, ws_path, action, duration_ms, ok, source, git_task_id? }
       ├─ 就地 emit `git-operation` 事件（经 Context::emit → 桌面 app_handle.emit / Web WS）
       └─ 落内存 rolling buffer（每 ws 最多 50 条，倒序时间）→ 前端初始拉取
```

- **写入点只有一个**：`git_capability.rs::invoke` 的写动作分支的**统一收口**（WRITE_GATE 持有期测得
  elapsed）。读动作不记录（噪声；git status/diff 高频）。
- **存储**：内存 `Mutex<Vec<GitOperationEntry>>`（ring，上限 50/ws），不落盘（操作流水是会话态审计，
  重启即阅即弃；跨会话历史归 reflog / undo 快照）。无新持久化路径，规避「多写路径竞争」。
- **事件**：`git-operation`（payload = GitOperationEntry camelCase）。桌面中继 + Web WS
  （复用 FR-P2-3 搭好的 Context::emit → EventBroadcaster 通道，加一条中继臂）。

## 三、协议

后端 `models/git.rs` 新增（`#[serde(rename_all = "camelCase")]`）：

```rust
pub struct GitOperationEntry {
    pub ws_path: String,        // 仓库路径
    pub action: String,         // 动作名（discard_changes / commit_changes / ...）
    pub ok: bool,               // 成败
    pub duration_ms: u64,       // 耗时 ms
    pub source: String,         // bootstrap / remote / plugin:<id>
    pub ts: i64,                // unix 秒
    pub label: String,          // 展示名（前端可改文案，后端给机器名）
    pub git_task_id: Option<String>, // P2.5 任务队列 taskId（未启用时 None）
}
```

cap.git 新增动作：
- `get_operations`（读，不破坏性）→ `GitOperationEntry[]`（本 ws 倒序）
- `clear_operations`（写类，DESTRUCTIVE 名单）→ 清空本 ws 缓冲

## 四、前端

- `types/git.ts`：`GitOperationEntry`
- `gitStore/operationsSlice.ts`：`getOperations` / `clearOperations` + `operationsByWs` 分片
- `operationsSubscriber.ts`：订阅 `git-operation` → prepend 到分片（≤50 保留）
- UI：GitPanel「操作流水」折叠区（changes tab 底部，复用 prototype `#activity` 形态）：
  `时间(灰) + label + 耗时(右对齐) + ok 红绿点`；空态「暂无操作记录」

## 五、验收

1. 任意写动作（commit/discard/reset/checkout/undo…）执行后 ≤1s 内「操作流水」出现该条，含耗时
2. 触发撤销 snapshot 的危险操作 → 流水与 undo 事件同现（证据链）
3. 读动作（get_status/get_log）不产生流水
4. 恢复/刷新 Web 端可见（事件走 WS）
5. 上限 50 条保留，latest 在最上
6. `cargo check` + `--no-default-features`（gated）+ 前端 vitest + `tsc --noEmit` 全绿

## 六、边界（如实交代）

- 不落盘、不做分页（会话内滚动 50 条够用；跨会话审计归 reflog/undo）
- source 仅透传来源类型，不外泄调用方参数
- mid-operation 失败（panic）不产生流水（安全网优先，缺一条可接受——undo 仍在）