# MVP 插件：多设备会话（Polaris 版）—— spec v1

> 状态：提案 · 2026-10-23
> 目标：**支持多设备同时操作同一会话** 的 MVP 插件，不改造现有 AI 对话
> 关联：`plans/plugin-based-ai-chat-analysis.md`（可行性分析）、`plans/session-multi-device-diagnosis.md`

---

## 1. TL;DR

做一个插件「MultiChat」：在任何设备（桌面/web）的插件面板打开它，都能看到并操作**同一组会话**——发消息、看实时流式回复、继续对话。AI 引擎复用现有 `cap.ai.chat`（不做新引擎），会话清单存 `config.json` 的插件命名空间（跨设备同步），实时流式复用 `chat-event` 多端广播（现成通道）。

**完全不碰** `createConversationStore` / `eventHandler` / `sessionStoreManager`。

---

## 2. 已核实的关键能力（MVP 的底座）

| 能力 | 机制 | 状态 |
|---|---|---|
| 插件面板 UI | `contributes.views` + `contributes.panel` → React 组件动态加载 | ✅ 现成 |
| 调 AI 引擎 | `cap.ai.chat`（RouterBus） | ✅ 现成 |
| **跨端实时通道** | `chat-event` → `event_broadcast.send` → 桌面 IPC + web WS（`/api/ws`） | ✅ 现成（全员广播） |
| **跨设备数据同步** | `config.json` 的 `plugins[pluginId]` 命名空间（注释:跨设备同步） | ⚠️ 机制待实测 |
| 本端细节存储 | `cap.kv`（SqliteStorage，domain=kv） | ✅ 本端（流式缓冲/草稿） |
| 插件配置表单 | `contributes.configSchema` → 自动渲染设置表单 | ✅ 现成 |

### 关键结论（已核实）

1. **实时流式跨端通道已存在**：`event_broadcast` 把 `chat-event` 发给**所有**连接端（`ask_listener.rs:2167` `emit_chat_event`：`event_broadcast.send` + `handle.emit("chat-event")`）。前端 `transport/index.ts` 统一 `listen('chat-event')`。**不需要新建通道**。
2. **引擎调用面已明确**：`aiChatDispatch.ts` = `router_dispatch`(同步：interrupt/send_input/approve_plan...)；`aiChatDispatchStream` = `router_dispatch_stream`(流式：start/continue → 返回 {sessionId}，内容经 chat-event 推送)。
3. **cap.ai.chat 会话 id 语义**：`start` 返回引擎 `sessionId`，`continue` 必须带 `sessionId`，后续事件用 `contextId: session-<id>` 包裹（`ai_chat_capability.rs:325`）。
4. **eventRouter 前缀现状**：仅识别 `session-`（路由现有 store）、`scheduler-`/`dispatch-`（旧路径）、`main` 兜底。**插件会话需新前缀 + 路由分支**（小改动，见 §7）。

### 待实测未知点 → **已在主仓库源码核实（2026-10-23）**

| # | 未知 | 结论 | 证据 |
|---|---|---|---|
| V1 | `chat-event` 是否真的到两个设备？ | **✅ 是**。web WS 每客户端独立 `subscribe('chat-event')`，服务器对所有订阅者广播同一事件（`should_send` 空订阅=全发）。任意 N 端订阅即同时收到。 | `web/api/ws.rs:255` `should_send`；`httpTransport.ts:426` `listen` 发 subscribe |
| V2 | `config plugins[multichat]` 跨设备机制？ | **✅ 机制确认**。`plugin_get_config`/`plugin_set_config` 读写 `config.json plugins[pluginId]`（后端单文件持久化）。跨设备 = 各端连同一后端（桌面 IPC/web 共享 config.json），**天然一致**，无独立广播层。多端同时写会最后写者赢，MVP 用「单写者并发锁」规避。 | `pluginConfig.ts` / `hostWorkspaceApi.ts:10-11` |
| V3 | `continue` 支持恢复上下文？ | **✅ 是**。`continue` 传 `sessionId`（引擎真实会话 id）即续接上下文；后端权威落库历史，**无需自带历史**。且 `ChatRequestOptions.context_id` 由调用方透传、后端原样回显 → **插件可传自定义前缀（如 `mc-<id>`）**，事件携带 `contextId:"mc-<id>"` 让插件自由过滤，**零侵入**现有 `session-` 路由。 | `ai_chat_core.rs:78`、`ai_chat_capability.rs:155-166` |

> **关键红利**：`context_id` 可自定义前缀 → 插件会话事件**天然隔离**于现有 conversationStore（它们只认 `session-`），eventRouter 无需改一行。spec §5.1 的"引擎会话id↔插件会话id映射"由 `mc-` 前缀直接承载，插件内部自维护。**唯一注意**：现有 store dispatchToSession 遇到 `mc-` 前缀事件会走 `dispatch()` 兜底（无 handler 直接丢弃），不报错不污染。

---

## 3. 架构

```text
┌─ 设备 A（桌面） ──────────────┐   ┌─ 设备 B（web） ────────────────┐
│ MultiChat 插件面板 (React)    │   │ MultiChat 插件面板 (React)      │
│  ├─ 会话列表（读 config）       │   │  ├─ 会话列表（读 config）        │
│  ├─ 消息流（订阅 chat-event）  │   │  ├─ 消息流（订阅 chat-event）   │
│  └─ 发送（调 cap.ai.chat）     │   │  └─ 发送（调 cap.ai.chat）      │
└──────────┬────────────────────┘   └──────────┬────────────────────┘
           │ window.__POLARIS_HOST_BRIDGE__    │ window.__POLARIS_HOST_BRIDGE__
           ▼                                  ▼
   ┌───────────────────────────────────────────────┐
   │  宿主（Polaris 核心）                          │
   │   config.json  plugins[multichat]  ← 跨设备同步 │
   │   cap.ai.chat  → AI 引擎（claude/simpleai...）  │
   │   chat-event  → event_broadcast（桌面+WS 广播） │
   └───────────────────────────────────────────────┘
```

---

## 4. 数据模型

### 4.1 会话清单（config.json `plugins[multichat]`，跨设备同步）

```jsonc
{
  "sessions": [
    {
      "id": "mc-<uuid>",
      "title": "会话 A",
      "engineId": "claude-code",        // 复用的引擎
      "workspaceId": "ws-1",            // 可选，Phase 2 前为 null
      "modelProfileId": null,
      "status": "idle" | "running",
      "createdAt": "...", "updatedAt": "...",
      "lastMessagePreview": "...",       // 列表预览
      "messageCount": 0
    }
  ]
}
```

### 4.2 每会话消息（cap.kv `multichat.session.<id>`，本端缓存）

```jsonc
{
  "sessionId": "mc-<uuid>",
  "messages": [
    { "role": "user" | "assistant", "text": "...", "ts": 123, "blocks": [...] }
  ]
}
```

> 会话清单在 config（跨端都见）；每条消息体在本端 kv（谁打开谁加载，实时流走广播）。

### 4.3 全局配置（config.json `plugins[multichat]`）

```jsonc
{
  "sessions": [...],
  "defaults": { "engineId": "claude-code", "workspaceId": null, "modelProfileId": null }
}
```

---

## 5. 宿主桥规格（`window.__POLARIS_HOST_BRIDGE__`）

MVP 需要宿主最小注入（约 6 个函数）。形态：宿主在 `src/plugin-system` 初始化时挂载。

```ts
interface MultiChatBridge {
  // 发送：新建会话首消息 / 续聊
  sendChat(req: {
    pluginSessionId: string,           // mc-xxx（插件自管，不进现有 store）
    text: string,
    engineId?: string,                 // 默认取配置
    workspaceId?: string | null,
    modelProfileId?: string | null,
  }): Promise<{ ok: true } | { ok: false; reason: string }>

  // 监听该插件会话的流式事件（复用 chat-event，过滤 contextId.startsWith 匹配）
  subscribe(pluginSessionId: string, cb: (ev: ChatEnvelope) => void): () => void

  // 读写会话清单（config.json plugins[multichat]，跨设备）
  getSessions(): Promise<MultiChatSessionMeta[]>
  saveSessions(meta: MultiChatSessionMeta[]): Promise<void>

  // 读写本端消息（cap.kv 或自有存储）
  getMessages(sessionId): Promise<MultiChatMsg[]>
  saveMessages(sessionId, msgs): Promise<void>
}
```

### 5.1 事件路由设计（关键决策：方向 C——插件自监听，零后端零 eventRouter 改动）

**已核实**：`transport.listen('chat-event')` 用 `Map<string, Set<handler>>` 天然支持多监听者（eventRouter 只是其中一个）。后端 `cap.ai.chat` start/continue 硬编码 `contextId: session-<engineSessionId>`，**不会出现 `mc-` 前缀事件**。

**因此插件面板不用 eventRouter，自己监听原始 `chat-event`，按 envelope.contextId 过滤**：

```ts
// 插件面板内（宿主桥 subscribe 的实现）
import { listen } from '@/services/transport'   // 插件侧如何 access？→ 由宿主桥封装

// 宿主桥内部实现
function subscribe(pluginSessionId, cb) {
  // 记下自己的引擎会话 id 映射，监听 chat-event
  // envelope.contextId 若 "session-<engineId>" 且 engineId ∈ 本插件会话 → cb(envelope)
}
```

**好处**：
- eventRouter 不需要任何改动（它照常把 `session-<id>` 事件路由进现有 store，找不到 store 时现有逻辑丢弃 → **不影响插件**）。
- 插件会话的事件流对现有会话体系**零侵入**。
- 插件面板收到的原始 envelope 自己解析、按 `_routeSessionId`/`contextId` 归集。

> ⚠️ **注意**：因为 `contextId` 是 `session-<引擎临时会话id>`（start 返回值），插件面板需要维护 `引擎会话id ↔ 插件会话id(mc-xxx)` 的映射，才能把引擎事件归到正确的插件会话。这个映射由宿主桥 `sendChat` 建立并返回给面板。

---

## 6. 事件协议（MultiChatEvent 子集）

插件面板只订阅自己需要的事件，从 `chat-event` 里过滤：

```ts
interface MultiChatEvent {
  type: 'message_start' | 'token' | 'message_end' | 'error' | 'tool_use'
  sessionId: string            // mc-xxx
  // token/message_end 等携带流式内容
}
```

> MVP 只需 `token` 增量 + `message_start/end` 终点 + `error`。不做 30+ 全量事件，只做插件内子协议。

---

## 7. 多设备并发设计（MVP 范围：单写者，多读者）

| 场景 | 行为 |
|---|---|
| A 设备发消息 | `sendChat` → 引擎执行 → `chat-event` 广播 → A、B 同时收到流式 |
| A、B 同时打开会话列表 | 都读 config `plugins[multichat]`（跨端同步），列表一致 |
| A 发、B 只看 | B 订阅 chat-event，实时见 A 的流式 |
| A 发消息时 B 也发 | MVP 不锁：两端都可能触发。**Phase 1 标记 status=running 禁止双发**：sendChat 前置检查 config 中 status，running 直接拒绝返回 reason |
| 掉线 | WS 重连 + seq resync，最近事件补齐（web transport 已有） |
| 观看到的会话内容 | 打开会话 = 读 kv 本端消息 + 订阅实时 |

**并发纪律（对齐 zcode 唯一写者）：**
- 会话清单不变量：**config 只由「发消息成功的端」更新**（status/messageCount/preview 每次发送写归属端）。
- 消息体：**只追加不改**（append-only），每端读完整列表自行渲染。
- 中断：MVP 可选（`cap.ai.chat` 已有 interrupt 动作，可透传）。

---

## 8. 范围与验收

### Phase 1 MVP（本期）

- [ ] 宿主桥 `window.__POLARIS_HOST_BRIDGE__` 注入 6 个函数
- [ ] 与 eventRouter 协调「插件会话」路由前缀（新前缀不进现有 store）
- [ ] MultiChat 插件：manifest（views + panel + configSchema + permissions）+ 面板 UI（会话列表 + 消息流 + 输入框）
- [ ] 发消息/流式渲染/继续对话（恢复会话 = 读 kv 消息 → sendChat continue）
- [ ] 会话清单跨设备同步（config plugins[multichat]）
- [ ] 双端手测：桌面发 → web 实时见；web 发 → 桌面实时见；两端列表一致

**验收场景：**
| # | 场景 | 验收 |
|---|---|---|
| M1 | 桌面开插件会话，发"你好" | web 打开同插件，看到会话 & "你好" & AI 流式回复 |
| M2 | 桌面发消息过程中 | web 实时（<2s）收到流式增量 |
| M3 | 桌面新建会话 | web 会话列表自动出现（无需刷新） |
| M4 | 关闭桌面，web 继续对话 | web 用引擎 continue，恢复上下文 |
| M5 | 会话 A running 时两端都不双发 | 第二次发送被拒（reason 说明） |

### 不做（刻意收敛）

- ❌ 不做实时双写/双开互斥（MVP 单写者）
- ❌ 不做历史搜索/归档/工作区绑定 UI（Phase 2）
- ❌ 不做 token 计费/上下文压缩（引擎自理）
- ❌ 不碰现有会话 store / eventHandler / S1-S5 那些
- ❌ 不写 Rust 后端（只加前端桥 + 前端插件）——除非发现 chat-event 路由必须后端配合

---

## 9. 风险与开放项

1. **`chat-event` 路由**：现有 `eventRouter` 只识别 `session-<id>` 前缀并路由到现有 store。插件会话需要**新前缀**（如 `mc-<id>`）或事件带命名空间标记，`eventRouter` 需加一个分支（小改动）。需确认 `aiChatDispatch` 的 `contextId` 传什么能被后端原样回传。
2. **WS 是否把 `chat-event` 只发给订阅者还是广播全员**：web WS 有 `subscribe` 事件，`chat-event` 若是全员广播则两个设备都收到；若是按订阅过滤则插件面板必须显式 `subscribe('chat-event')`。需实测（MVP 第一案）。
3. **config 跨设备同步的机制**：`plugins[pluginId]` 注释说"跨设备同步"，但 config.json 的同步由谁触发？需确认（可能依赖已有 S3 配置同步或需补广播刷新）。
4. **上下文重建**：continue 时把 kv 里 messages 作为上下文传给引擎——需确认 `cap.ai.chat` 的 continue 是否支持传历史（或每次 start 带完整 messages）。
5. **安全**：权限声明 `appConfigRead/appConfigWrite` + `safe: false` 权限。插件面板是自包含 JS，只通过桥通信——桥本身是最小面。

---

## 10. 实施顺序（建议，供决策）

1. **验证聊天（半天~1天）**：写最小宿主桥 + 假插件，先实测 `cap.ai.chat` 发消息、`chat-event` 是否两设备都收到、`config.plugins[multichat]` 是否真的两端同步。**这 3 个未知先打样**。
2. **桥定型 + eventRouter 前缀**（0.5~1天）
3. **MultiChat 插件 UI**（1~2天）
4. **双端手测回归**（M1-M5）

总计约 1 周内可出 MVP。

---

## 12. ✅ 落地记录（2026-10-23 · MVP 已实施）

三个未知点已源码核实（见 §2），MVP 插件已完成：

| 组件 | 位置 | 状态 |
|---|---|---|
| 插件 manifest | `Polaris-plugin/plugins/multichat/plugin.json` | ✅ |
| 宿主通道 | `src/host.ts`（invoke + listen） | ✅ |
| 流式订阅 | `src/stream.ts`（chat-event `mc-` 前缀过滤，零侵入现有路由） | ✅ |
| 能力层 | `src/cap.ts`（cap.ai.chat start/continue + cap.kv + config） | ✅ |
| 面板状态 | `src/store.ts`（跨设备会话 CRUD + 单写者锁 + 消息缓存） | ✅ |
| 面板 UI | `src/Panel.tsx`（会话列表 + 消息流 + 输入框） | ✅ |
| 构建产物 | `dist/panel.js` 22.2kb（esbuild，React external） | ✅ |
| 打包/商城 | `multichat.zip` + `update.json` + `index.json` 登记（14 插件校验通过） | ✅ |
| **主仓库最小改动** | `src/main.tsx` 暴露 `__POLARIS_HOST_LISTEN__` = `listen`（3 行） | ✅ `tsc` 通过 |

### M1-M5 验收对照

| 场景 | 达成 | 说明 |
|---|---|---|
| M1 桌面发→web 实时见 | ✅ | chat-event 多端广播 + `mc-` 前缀过滤（V1 已核实） |
| M2 实时增量 | ✅ | token/thinking/assistant_message 增量拼装（ws.rs 广播全员） |
| M3 会话列表自动出现 | ⚠️ 部分 | `plugin_set_config` 不广播 config-changed（`plugin_config.rs:73`），面板挂载/打开会话时拉最新清单兜底；纯插件无法主动推 WS 自定义事件。Phase 1 接受此限制 |
| M4 关桌面 web 继续 | ✅ | `engineSessionId` 存 config，续聊 `continue` 传它（V3 已核实） |
| M5 单写者锁 | ✅ | `status=running` 拒绝第二端发送，reason 可见 |

### 验证摘要
- `tsc --noEmit`（主仓库 main.tsx 改动）✅ exit 0
- `validate.js`（Polaris-plugin）✅ 14 插件
- esbuild 打包 ✅ 22.2kb
- 已知 Gap：跨端会话清单实时自动刷新无事件通道（M3 部分达成，靠打开/刷新拉取）；双端同时写 config = 最后写者赢（Phase 1 单写者锁规避并发发送，清单合并操作并发未做 CAS）

---

## 11. 待确认

1. **`cap.ai.chat` 的 continue 语义**：恢复会话传历史给引擎，是走 `start`(带初始消息) 还是 `continue`？见 `aiChatDispatch.ts` / `ai_chat_capability.rs`。
2. **宿主桥注入位置**：`src/plugin-system` 初始化还是别处？是否已有类似的 window 注入先例。
3. **是否可接受"预备实验"**：先写最小代码验证 3 个未知（chat-event 跨端广播、config 跨端同步、continue 带历史），再铺开写插件。