# spec: Polaris 双总线架构说明

> 日期：2026-10-25 · 状态：参考文档
> 背景：AI 通过 MCP 调用 cap.* 能力时，存在两条总线入口，需明确区分使用场景。

---

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        Polaris 应用                             │
│                                                                 │
│  ┌─────────────┐     ┌──────────────┐     ┌─────────────────┐  │
│  │ polaris-bus │     │ polaris-     │     │ 主进程 RouterBus│  │
│  │ MCP Server  │     │ dispatch     │     │ (能力注册中心)   │  │
│  │ (独立进程)   │     │ MCP Server   │     │                 │  │
│  └──────┬──────┘     └──────┬───────┘     └────────┬────────┘  │
│         │                   │                      │            │
│         ▼                   ▼                      ▼            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    RouterBus (全局单例)                   │   │
│  │  - 权限 gate (Source::Bootstrap/Plugin/Remote)           │   │
│  │  - 审计链 (dispatch.jsonl)                               │   │
│  │  - 动态能力注册表                                        │   │
│  └─────────────────────────────────────────────────────────┘   │
│                            ▲                                    │
│                            │                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    前端应用 (React)                       │   │
│  │  - store 消费事件 → UI 更新                              │   │
│  │  - eventHandler 处理 plugin_card / chat-event            │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 两条总线对比

### 2.1 bus_dispatch（本地进程总线）

| 属性 | 值 |
|---|---|
| **MCP Server** | `polaris-bus`（独立进程） |
| **工具名** | `mcp__polaris-bus__bus_dispatch` |
| **入口限制** | 白名单制，仅 8 个能力 |
| **设计目的** | 轻量、安全、高频操作 |

**白名单能力：**
```typescript
const BUS_DISPATCH_WHITELIST = [
  'cap.todo',      // 待办事项 CRUD
  'cap.http',      // HTTP 请求转发
  'cap.bash',      // 后台任务管理
  'cap.fs',        // 文件系统只读
  'cap.git',       // Git 域动作（P4）
  'cap.ui.theme',  // 主题配色控制
  'cap.ui.chat',   // 对话渲染配置
  'cap.ui.input',  // 输入区 UI 调节
] as const
```

**典型调用示例：**
```json
{
  "target": "cap.todo",
  "payload": {
    "action": "create",
    "content": "完成代码评审",
    "priority": "high"
  }
}
```

---

### 2.2 cap_dispatch（主进程总线）

| 属性 | 值 |
|---|---|
| **MCP Server** | `polaris-dispatch` |
| **工具名** | `mcp__polaris-dispatch__cap_dispatch` |
| **入口限制** | 无限制，可触达全部 cap.* |
| **设计目的** | 完整能力访问、跨进程通信 |

**全量能力清单（24 个）：**
```typescript
const ALL_CAPABILITIES = [
  // AI 会话
  'cap.ai.chat',       // 流式会话（start/continue/interrupt）
  'cap.history',       // 会话历史查询
  
  // 系统管理
  'cap.config',        // 系统配置读写
  'cap.data_root',     // 数据根管理
  'cap.pluginDiscovery',    // 插件发现
  'cap.pluginServiceManager', // 插件服务管理
  
  // 工具能力
  'cap.bash',          // 后台任务（与 bus 共享实现）
  'cap.fs',            // 文件系统（与 bus 共享实现）
  'cap.git',           // Git 域（与 bus 共享实现）
  'cap.http',          // HTTP 请求（与 bus 共享实现）
  'cap.kv',            // 键值存储
  'cap.mcp',           // MCP 工具调用
  'cap.prompt_snippet', // 提示词片段
  
  // UI 能力
  'cap.ui.render',     // 可交互渲染 ⭐
  'cap.ui.theme',      // 主题配色（与 bus 共享实现）
  'cap.ui.chat',       // 对话渲染（与 bus 共享实现）
  'cap.ui.input',      // 输入区 UI（与 bus 共享实现）
  'cap.self.mutate',   // UI 插槽改造
  
  // 其他
  'cap.context',       // 上下文记忆（内存型）
  'cap.hook',          // Hook 机制
  'cap.registry',      // 动态能力注册
  'cap.self.inspect',  // 自身透视
  'cap.stream.echo',   // 流式骨架 demo
  'cap.todo',          // 待办事项（与 bus 共享实现）
  'cap.voice',         // 语音合成
] as const
```

**典型调用示例：**
```json
{
  "target": "cap.ui.render",
  "payload": {
    "action": "request",
    "cardId": "frame-renderer",
    "frame": { "type": "template", "templateId": "fund-nav-chart" },
    "mode": "display"
  }
}
```

---

## 3. 能力重叠说明

以下能力在两条总线上**都可访问**（bus 白名单 + 主进程全量）：

| 能力 | bus_dispatch | cap_dispatch | 说明 |
|---|---|---|---|
| `cap.bash` | ✅ | ✅ | 后台任务管理 |
| `cap.fs` | ✅ | ✅ | 文件系统只读 |
| `cap.git` | ✅ | ✅ | Git 域动作 |
| `cap.http` | ✅ | ✅ | HTTP 请求转发 |
| `cap.todo` | ✅ | ✅ | 待办事项 CRUD |
| `cap.ui.theme` | ✅ | ✅ | 主题配色 |
| `cap.ui.chat` | ✅ | ✅ | 对话渲染 |
| `cap.ui.input` | ✅ | ✅ | 输入区 UI |

**结论**：对于重叠能力，优先使用 `bus_dispatch`（更轻量、独立进程不依赖主进程状态）。

---

## 4. 使用决策树

```
需要调用 cap.* 能力？
├─ 是否在白名单内？（todo/http/bash/fs/git/ui.theme/ui.chat/ui.input）
│  ├─ 是 → 使用 bus_dispatch（轻量、稳定）
│  └─ 否 → 使用 cap_dispatch（唯一选择）
│
├─ 是否涉及主进程特有状态？（context/kv/plugin/ai.chat/history/render）
│  ├─ 是 → 必须用 cap_dispatch
│  └─ 否 → 走上面决策
│
└─ 是否是流式操作？（ai.chat start/continue）
   └─ 是 → 必须用 cap_dispatch（WebSocket 事件订阅）
```

---

## 5. 技术细节

### 5.1 bus_mcp_server 架构

```rust
// src-tauri/src/services/bus_mcp_server.rs
// 独立进程，自持轻量总线
// 只注册白名单能力，其余请求拒绝

const DISPATCH_WHITELIST: &[&str] = &[
    "cap.todo", "cap.http", "cap.bash", "cap.fs",
    "cap.git", "cap.ui.theme", "cap.ui.chat", "cap.ui.input",
];
```

### 5.2 polaris-dispatch 架构

```rust
// src-tauri/src/services/dispatch_mcp_server.rs
// 连接主进程，透传所有 cap.* 调用

// 工具注册
"cap_dispatch" → RouterBus.dispatch(target, payload)
"cap_list"     → 列出全部已注册能力
```

### 5.3 共享实现

重叠能力（bash/fs/git/http/todo/ui.*）在 `services/router/` 下**只实现一次**，两条总线通过不同入口复用同一 Capability 实例。

---

## 6. 常见错误

### 错误 1：用 bus_dispatch 调用非白名单能力

```json
// ❌ 错误
{"target": "cap.ui.render", ...}
// 返回：target cap.ui.render 不在 bus_dispatch 白名单内

// ✅ 正确
{"target": "cap.ui.render", ...}  // 用 cap_dispatch
```

### 错误 2：混淆 sessionId

- `bus_dispatch` 和 `cap_dispatch` 的 `sessionId` 含义相同（后端 conversationId）
- 但前端会话 ID 是另一套（前端 createSession 生成），二者在 AI 会话内同值，外部入口不匹配

### 错误 3：流式操作同步调用

`cap.ai.chat start/continue` 是流式能力，需经 WebSocket 订阅事件，不能期望同步返回完整结果。

---

## 7. 参考文档

- `plans/dynamic-capability-registry.md` — 动态能力注册
- `plans/plugin-cap-inject-render-v1.md` — cap.ui.render 出处
- `plans/plugin-cap-plugin-system-audit-2026-10-24.md` — 三入口命名问题
- `plans/mcp-bridge-selfheal.md` — bus 与 dispatch 通道诊断

---

**文档版本**：v1.0  
**最后更新**：2026-10-25
