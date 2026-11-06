# pet-overlay 流式 dispatch 改造（方案 A）

> 关联：`plans/perf-max-benefit-plan.md`（dispatch 楔死取证）、`plans/pet-overlay-r2-spec.md`（R2 规格）
> 日期：2026-11-04

## 背景

`cap.ai.chat` 有两条 dispatch 路径：

| 路径 | 入口 | 执行模型 | 是否触发 10s 楔死告警 |
|---|---|---|---|
| 同步 `router_dispatch` | `commands/router.rs:100` / `web/api/ipc.rs:2895` | `spawn_blocking` + `block_in_place` 驱动 `start_chat_inner`，**占用 tokio blocking 池槽整个会话启动期** | 是（`select! { dispatch, sleep(10s) }` watchdog） |
| 流式 `router_dispatch_stream` | `commands/router.rs:174` / `web/api/ipc.rs:3023` | `invoke_stream` 用 `std::thread::spawn` 独立 OS 线程驱动，ack 立即返回 | 否 |

pet-overlay 的 `aiWhisper`（碎碎念）与 `sendChat`（宠物对话）此前用同步 `router_dispatch` 调 `cap.ai.chat` start/continue。慢启动引擎（codebuddy 冷启动 ~15s）会独占 blocking 池槽，触发 10s 楔死告警（`commands/router.rs:110`）。

## 目标

将 pet-overlay 的 start/continue 从同步 `router_dispatch` 迁至流式 `router_dispatch_stream`，消除 blocking 池占用与 10s 楔死告警。同步动作（`interrupt`/`send_input`/`form_*` 等）不受影响，继续走 `router_dispatch`。

## 接口

### 流式 ack 形状（`aiChatDispatchStream`）

```ts
// services/aiChatDispatch.ts
export interface AiStreamAck { msgId: string; trace: string }
```

ack **不含 sessionId**。start 时 sessionId 须从 `chat-event` 事件的 `session_start` 载荷提取：

```json
{ "type": "session_start", "sessionId": "<sid>", "engineId": "<eid>" }
```

（来源：`ai_chat_core.rs:1357` 的 `session_id_update_callback`）

### chat-event 中继载荷（Tauri lib.rs relay）

lib.rs 的 chat-event relay 推的是**内层 payload 本身**（`{ type, sessionId, content, isDelta, reason }`），不是 `{ payload: {...} }` 信封。`aiChannel.ts::parseChatEvent` 统一解析 string/object 两种 raw。

## 实现

### `aiChannel.ts` 新增 `streamChat`

```ts
export function streamChat(params: {
  action: 'start' | 'continue'
  message: string
  sessionId?: string      // continue 必填；start 留空
  options?: Record<string, unknown>
  timeoutMs: number
}): Promise<{ sid: string; text: string }>
```

流程：
1. 先 `listen('chat-event', ...)` 订阅（避免 session_start 早于注册丢失）
2. start：从 `session_start` 事件捕获 sid
3. 累积 `assistant_message` 文本（isDelta 拼接 / 非_delta 替换）
4. `session_end` 后延迟 300ms finish（与 `waitAssistant` 同语义，兜底最后的 flush）
5. 发起 `aiChatDispatchStream`（ack 仅表示后端已接收）
6. 超时兜底 finish

返回 `{ sid, text }`：start 时 sid 为新会话 id；continue 时 sid 为入参原值。text 去 think 块并 trim。

### `OverlayApp.tsx` 两处调用点改用 `streamChat`

- `aiWhisper`（碎碎念）：start/continue 合并为一次 `streamChat` 调用，sid 落 `whisperSessionRef`
- `sendChat`（宠物对话）：同上，sid 落 `chatSessionRef`

## 验收

- [x] `pnpm exec tsc --noEmit` 通过
- [x] `pnpm lint`（改动文件）通过
- [ ] 实测：pet-overlay 碎碎念/对话正常，后端日志无 `dispatch 10s 未返回` 告警（target=cap.ai.chat）

## 风险与边界

1. **session_start 早于 listen 注册**：`streamChat` 先订阅再 dispatch，ack 返回前事件极少早到；但理论上 listen 注册是异步的（`.then`），极端情况下 start 的 session_start 仍可能丢失。当前兜底：超时返回空 text，调用方按"失败"处理（与原同步路径失败等价）。
2. **多窗口事件串扰**：`chat-event` 是全局广播，`streamChat` 按 `p.sessionId !== sid` 过滤；start 阶段 sid 未知时只捕获 `session_start`，不会误吞其他会话事件。
3. **waitAssistant 保留**：作为公共导出保留在 `aiChannel.ts`（spec §2.4 一部分），OverlayApp 不再直接使用。
4. **同步路径未删**：`aiChatDispatch`（同步）保留给 `interrupt`/`send_input`/`form_*` 等短时动作，这些动作快（<1s）不触发 10s 告警。
