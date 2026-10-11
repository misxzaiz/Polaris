# Session API — 移动端协议文档（S5）

> 供 `polaris-mobile` / `polaris-pocket` 及任何第三方端接人同一后端会话权威。
> 对齐 `plans/session-rearchitecture/S1-S5` spec。

---

## 1. 总览

移动端通过 HTTP+WS 连同一 Polaris 后端，复用桌面端的会话投影协议：

- **会话列表** = `session_index_list`（S1，workspace 级权威投影）
- **增量订阅** = `session_index_list_after`（S1，gap repair 用）
- **发送/中断** = `cap.ai.chat` action=start/continue/interrupt（S4，带 deviceId）
- **映射反查** = `session_mapping` 按 external_id 反查（S5，恢复旧 JSONL 会话）

移动端**不再有自己的会话持久层**；断线时本地只缓存投影快照。

---

## 2. workspaceKey 解析

```ts
function resolveWorkspaceKey(path: string | null, identity?: string): string {
  return identity?.trim() || path?.trim() || '__free__'
}
```

- `identity`：远程/容器/WSL 等场景的稳定身份标识（预留）
- `path`：本地工作区路径（本地场景的稳定标识）
- 两者皆空 → `__free__`（自由会话桶）

---

## 3. API 清单

### 3.1 会话列表（首拉快照）

```
POST /api/session-index-list
Body: { "workspaceKey": "<key>" }
→ { "sessions": SessionProjection[], "lastSeq": number }
```

### 3.2 会话增量（gap repair）

```
POST /api/session-index-list-after
Body: { "workspaceKey": "<key>", "afterSeq": <number> }
→ { "sessions": SessionProjection[] }
```

### 3.3 注册会话到投影

```
POST /api/session-index-register
Body: { "workspaceKey": "<key>", "record": SessionRecord }
→ SessionProjection
```

### 3.4 删除投影条目

```
POST /api/session-index-delete
Body: { "workspaceKey": "<key>", "sessionId": "<id>" }
→ { "ok": true }
```

### 3.5 发送消息（cap.ai.chat）

```
router_dispatch_stream:
  target: "cap.ai.chat"
  payload: {
    "action": "start" | "continue",
    "message": "...",
    "sessionId": "...",
    "conversationId": "...",
    "requestId": "<UUID>",
    "deviceId": "<端级 UUID>"
  }
→ { "msgId": "<ticketId>", "trace": "..." }
```

### 3.6 中断（cap.ai.chat）

```
router_dispatch:
  target: "cap.ai.chat"
  payload: {
    "action": "interrupt",
    "sessionId": "...",
    "requestId": "<UUID>",
    "deviceId": "<端级 UUID>"
  }
→ { "interrupted": true } | { "interrupted": false, "reason": "not_owner|not_running" }
```

---

## 4. SessionProjection 类型

```ts
interface SessionProjection {
  workspaceKey: string
  sessionId: string
  conversationId?: string
  title: string
  status: 'idle' | 'running' | 'error' | 'none'
  seq: number          // workspace 内变更序号（跨端因果序）
  updatedAt: number
  engineId: string
  workspaceId?: string
  lastError?: string
  startedByDevice?: string
  createdAt: number
}
```

---

## 5. 订阅生命周期

```
桶激活 → session_index_list 首拉快照 → 定期 session_index_list_after 增量
  └ gap 过大（>50 帧）→ 回退全量快照
桶失活 → 停止轮询
```

- 增量轮询间隔：5s（拉取版；广播帧留后续）
- gap 阈值：50 帧
- 断线重连：resync（重拉全量快照）

---

## 6. deviceId 与 requestId

- **deviceId**：端级全局唯一 UUID，localStorage 持久化（端级稳定）
- **requestId**：请求级幂等键，每次新 UUID，不跨请求复用
- 后端仲裁（S4 后端阶段）：
  - send → `startedByDevice == deviceId` 或非 running → accepted
  - interrupt → `startedByDevice == deviceId` → 停；否则 not_owner

---

## 7. 旧 JSONL 会话恢复（映射反查）

```
session_mapping 表：
  session_id ↔ conversation_id ↔ external_id（旧 JSONL 文件名）

恢复流程：
  1) 按 external_id 反查 session_mapping → session_id + conversation_id
  2) 用 session_id 注册到 workspace 桶
  3) 用 conversation_id 继续对话
```

---

## 8. 验收

| # | 场景 | 验收 |
|---|---|---|
| 1 | 移动端打开 workspace | 列表与桌面一致（<2s） |
| 2 | 桌面新建会话 | 移动端列表自动出现 |
| 3 | 移动端发送消息 | 桌面实时收到流式块 |
| 4 | 两端同时发送 | 仅一端 accepted，另一端明确 reason |
| 5 | 旧 JSONL 会话 | 移动端可恢复、可继续 |
