# S2 — 前端 SessionStore 重构：workspace 分桶（spec）

> 状态：提案 · 归属：前端（src/renderer）· 依赖：S1（后端投影就绪）

---

## 1. 目标

把前端会话真相从 **「全局单一 activeSessionId + Map<sessionId, store>」** 重构为 **「workspace 会话桶 + 每会话投影」**，使多窗口 / 多端可同时查看与操作同/异会话而不互相覆盖。

对齐 ZCode：`zcodeSessionStoreWorkspaceSlice.ts`（1055 行，workspace 分桶）、`zcodeSessionStoreTypes.ts`（558 行）、`zcodeSessionStoreSelectors.ts`（289 行，`identity ?? path` workspaceKey + 远程桶隔离）。

## 2. 现状（已核实）

- `src/stores/conversationStore/sessionStoreManager.ts`（901 行）：全局单一 `activeSessionId` + `Map<sessionId, store>`；`switchSession` 改单一活跃态；`dispatchEvent` 对无 store 的会话 **丢弃事件**（跨端不可见根因之一）。
- `src/stores/conversationStore/createConversationStore.ts`（2535 行）：大而全——messages/progress/attachment/notification/running/error 全塞一个 hook 内。
- `src/stores/conversationStore/useActiveSession.ts`：暴露单一 `activeSessionId`。
- 触达面：hooks 隔离良好，components 不直连 stores（已核实 = 0 处），**重构自由度高**。

## 3. 目标结构

### 3.1 workspace 会话桶（对齐 ZCode WorkspaceSessionComposite）

```ts
interface WorkspaceSessionBucket {
  workspaceKey: string
  sessions: Map<sessionId, SessionStoreRef>   // 该桶内全部会话
  activeSessionId: string | null
  activeSessionParams: SessionStartParams | null
}

// 存储根（替代全局单一 activeSessionId）
interface SessionStoreManager {
  buckets: Map<workspaceKey, WorkspaceSessionBucket>
  getWorkspace(workspaceKey): WorkspaceSessionBucket
  getAllActive(): { workspaceKey, activeSessionId }[]   // 多窗口多端不互踩
}
```

### 3.2 拆分策略（按 AGENTS.md：只拆常触碰的）

将 `createConversationStore.ts` 按生命周期拆分，**不动无关状态**：

| 拆出模块 | 内容 | 对齐 |
|---|---|---|
| `useWorkspaceSessionTree` | 桶 + active 指针 + switch（替代 sessionStoreManager 的单一态） | `zcodeSessionStoreWorkspaceSlice` 的 workspaceKey 侧 |
| `useSessionMessages` | 消息数组 + 追加去重 + 流式缓冲 | `zcodeSessionStoreSelectors` 的乐观合并 |
| `useSessionRuntime` | running/error/progress + key 变更重连 | `zcodeSessionStoreTypes` 的 status 字段 |
| `useSessionActions` | send/interrupt/continue（**内部只派发，不做本地自决** → 依赖 S4） | `useAgentSessionActions` |

### 3.3 状态机

```ts
type SessionStatus = 'idle' | 'running' | 'error' | 'none'
interface SessionRuntime {
  status: SessionStatus
  isStreaming: boolean
  errorMessage: string | null
  key: string          // 会话实例指纹（变更触发重连/重建）
}
```

- 状态变化**只来自后端事件**（`session/started`、`session/finished`、`session/error`、流式 chunk → agent 状态映射），前端不再自造 status。
- `status: 'running'` 且无事件 5s → 触发 resync（靠 S3 的 gap repair 兜底，不靠轮询）。

## 4. 迁移要点

- 多窗口互不覆盖：`switchSession(workspaceKey, sessionId)` 写入对应桶的 `activeSessionId`，不再有「全局活跃」。
- 跨端事件：事件带 `_routeWorkspaceKey + _routeSessionId`；找不到桶 → **不再丢弃**，触发懒加载（`ensureWorkspaceBucket(workspaceKey)` + 检查 S1 后端投影）。
- 保持 hooks 出口兼容：`useActiveSession` 改为 `useActiveSession(workspaceKey?)`（默认当前工作区 key），既有组件接入点不变。

## 5. 验收

| # | 场景 | 验收 |
|---|---|---|
| 1 | 桌面 A 桶开会话 A1，web 开 A2 | 两端各自 getWorkspace(A).activeSessionId 独立 |
| 2 | 切换 workspace B | A 桶草稿/运行态保留；B 桶独立 |
| 3 | 事件路由未知桶 | 懒加载桶 + 从后端投影拉取，不再丢事件 |
| 4 | 既有组件 | 无 components 直连 store 改动（hook 出口兼容） |
| 5 | `pnpm typecheck` + vitest | 全绿 |

## 6. 风险

- `createConversationStore.ts`（2535 行）拆分易引入回归 → 每个拆出模块配 vitest（沿用现有 `conversationStore.test` 命名）；一次 PR 只拆 1-2 个模块。
- 行为兼容：先「桶化 + 复用旧 store 逻辑」，后「逐步迁移状态来源到后端投影」；两步不同步做。

## 7. 涉及文件

- `src/stores/conversationStore/sessionStoreManager.ts` → `workspaceSessionStoreManager.ts`（改造）
- `src/stores/conversationStore/createConversationStore.ts` → 拆出上述 4 模块（原文件保留为组合壳）
- `src/stores/conversationStore/useActiveSession.ts` → 签名扩展（+workspaceKey?）
- 新增 `src/stores/workspaceSession/`（types/selectors/slice，对齐 ZCode 三件套）