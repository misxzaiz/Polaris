# 002 · 会话存储命令上总线（cap.session）spec

> 来源：需求库 needs/002（analyzed，夜班已勘察）。状态：specd，待拍板。
> 所有者：宿主端（src-tauri router/session_capability.rs）+ 前端会话相关 service。

## 目标

把三个旧命令簇收敛为单一 `cap.session` 总线能力，前端统一走 `router_dispatch`，消除会话存储多写路径，对齐 todo_capability / git_capability 整域摘除范式。**业务签名不变、内部改走总线**（dataRootService.ts 迁移样板）。

## 现状（2026-10-30 勘察数据）

| 文件 | 行数 | 命令数 | 前端直连 invoke |
|---|---|---|---|
| commands/dialog_storage.rs | 835 | 8 | 7 处 |
| commands/session_messages.rs | 247 | 8 | 33 处 |
| commands/session_state_commands.rs | 605 | 19 | 35 处 |
| **合计** | 1687 | **35** | **~75 处** |

**第三条通道**：`web/api/ipc.rs` 有 176 行会话命令 dispatch 包装（`"dialog_read" => dispatch_dialog_read(...)` 等）——Web 端独立通道，必须同批接入，否则 Web-only 构建回归。

**写后副作用**：`dialog_index::on_self_write(202) / on_self_append(271,297) / on_self_delete(399)` 四处钩子在 dialog_storage.rs 内联调用——随写入路径原位搬迁进 capability，不是独立命令。

## 接口：单 cap.session，action 前缀分组

`dialog.*`（8）：list / list_meta / read / write / consolidate / append / read_page / delete
`message.*`（8）：append / revise / read / read_history / get_latest / delete_by_conversation / tombstone_after / revise_undelete
`state.*`（19）：get_status / request_start / request_interrupt / event_append / event_read / event_read_after_seq / event_current_seq / event_delete_by_conversation / reconcile / register / get / list / append_message / update_metadata / delete / index_register / index_list / index_list_after / index_delete

payload 逐字段透传旧命令参数（不改签名）；返回结构不变。**不拆三个 capability**：三域高度耦合（发消息同写 dialog+message+event），拆分引入跨能力事务问题（needs/002 分析结论）。

## 迁移批次（每批独立可回退，批后跑门槛）

1. **dialog 组**（8 命令 / 7 处直连，最小风险起步）：capability 骨架 + dialog.* + dialog_index 钩子原位搬迁。
2. **message 组**（8 命令 / 33 处直连）：消息簇迁入 + 前端 sessionMessages/dialogStorage service 改 dispatch。
3. **state 组**（19 命令 / 35 处直连）：含 `session_request_start/interrupt`（中断链路，只换入口不改 `SessionStateDb` 调用）与 `session_event_*`（seq 自增与 `read_after_seq` 轮询语义不得漂移——remoteSessionFollower 依赖）。
4. **Web 通道收口**：web/api/ipc.rs 的 176 行 dispatch_* 改为透传 cap.session（Web 无 Tauri invoke，走宿主 HTTP 的 router_dispatch 既有通道），旧包装删除。
5. **旧命令摘除**：三文件 invoke handler 删除（对齐 commands/todo.rs 已删先例），lib.rs generate_handler 清理。

每批门槛：`cargo check` + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` + `pnpm exec tsc --noEmit` + 相关 vitest。

## 边界（明确不做）

- 不改会话数据格式与存储路径（JSONL / SqliteStorage domain 不变）。
- 不改 session-v2 Reconcile 对账算法（只迁读写入口）。
- 不做协议 schema 运行时校验（needs/007 单独治理）。
- 不收 history_index.rs（33 行独立小模块）。

## 验收（可执行冒烟）

1. 门槛全绿（上列三命令 + typecheck）。
2. `grep -rn "invoke('dialog_\|invoke('message_\|invoke('session_" src/` 仅剩兼容层零直连；web/api/ipc.rs 无独立会话 dispatch。
3. 行为冒烟：桌面端打开任一会话 / 发消息 / 历史加载 / 中断按钮；Web 端（9827）同链路；session-v2 对账不产生孤儿事件。
4. 中断冒烟：会话发送中点中断 → 晚到 stop 幂等消费（对齐 simpleai-interrupt-race-fixed 修复语义，不回归）。

## 风险

- **seq 链路漂移**是本迁移唯一高危（event_append 自增 + read_after_seq 轮询）；批次 3 单独验证，冒烟含跨端会话跟随。
- 中断入口换壳时保留幂等归属（调用方→处理方），防双写/误杀（AGENTS.md §4.2）。
