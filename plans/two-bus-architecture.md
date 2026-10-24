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
| **入口限制** | 无静态白名单——可转发目标 = 本进程 RouterBus 已注册能力（注册表派生） |
| **设计目的** | 轻量、高频操作；独立进程崩溃不影响主进程 |

**历史形态**是静态 `DISPATCH_WHITELIST`（8 项白名单），与注册块两处并行维护，曾导致「白名单放行、RouterBus 报能力未注册」的静默失效；**已废除**，改为注册表派生（`bus_mcp_server.rs` 的 `dispatchable_capabilities`）：注册即放开，新增能力只需在注册块加一行，`tools_list` 的 target enum 与 `bus_help` 每次调用时实时重算。

**bus 进程静态注册的能力（17 个；`git` feature 关闭时 16）：**

```text
cap.todo  cap.http  cap.fs  cap.bash  cap.kv  cap.prompt_snippet  cap.data_root
cap.hook  cap.self.mutate  cap.ui.theme  cap.ui.chat  cap.ui.input  cap.git
cap.context  cap.self.inspect  cap.help  cap.registry
```

另含经 cap.registry 重建的动态能力。注意 `cap.registry` / `cap.help` / `cap.self.inspect` 在 bus 进程与主进程是**同名不同实例**（各自管理本进程注册表）。

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

**全量能力清单（26 个，主进程 RouterBus 注册表实测）：**
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
  'cap.help',          // 能力索引/详情（与 bus 同名不同实例）
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

bus 进程注册表 ⊂ 主进程注册表（26 项中 17 项两边都有）。重叠能力的实现代码在
`services/router/` 下**只写一份**，但两条总线各自进程实例化（同代码、不同实例；
cap.registry / cap.help / cap.self.inspect 各管本进程注册表）。

**仅主进程有的 9 个**：`cap.ai.chat`（流式）、`cap.history`、`cap.ui.render`、
`cap.mcp`、`cap.voice`、`cap.config`、`cap.stream.echo`、`cap.pluginDiscovery`、
`cap.pluginServiceManager`——这些依赖主进程状态（会话/事件广播/插件进程池），只能走 `cap_dispatch`。

**结论**：重叠能力优先 `bus_dispatch`（独立进程、不依赖主进程状态）；主进程特有能力只能 `cap_dispatch`。

---

## 4. 使用决策树

```
需要调用 cap.* 能力？
├─ 目标是否在 bus 进程注册表？（17 个静态：todo/http/fs/bash/kv/prompt_snippet/
│  data_root/hook/git/ui.theme/ui.chat/ui.input/self.mutate/self.inspect/help/registry
│  + 动态注册能力；tools_list 的 target enum 实时可查）
│  ├─ 是 → 优先 bus_dispatch（独立进程、轻量稳定）
│  └─ 否（ai.chat/history/ui.render/mcp/voice/config/stream.echo/
│     pluginDiscovery/pluginServiceManager）→ cap_dispatch（唯一选择）
│
└─ 是否是流式操作？（ai.chat start/continue）
   └─ 是 → 必须用 cap_dispatch（WebSocket 事件订阅）
```

---

## 5. 技术细节

### 5.1 bus_mcp_server 架构

```rust
// src-tauri/src/services/bus_mcp_server.rs
// 独立进程，自持轻量总线：静态注册 17 个能力（git 门控时 16）
// + 经 cap.registry 重建的动态能力。
// 可转发目标从注册表派生，无静态白名单：

pub fn dispatchable_capabilities(router: &RouterBus) -> Vec<String> {
    let mut out = router.list_capabilities().iter().map(|c| c.0.clone()).collect();
    out.sort(); out.dedup(); out  // 每次调用实时重算
}
```

bus_dispatch 分支不做名单检查——直接构造 `Envelope` 交给本进程 RouterBus，
由注册表命中 + PolicyPermission + 审计统一裁决。

### 5.2 polaris-dispatch 架构

```rust
// src-tauri/src/services/dispatch_mcp_server.rs
// 连接主进程，透传所有 cap.* 调用

// 工具注册
"cap_dispatch" → RouterBus.dispatch(target, payload)
"cap_list"     → 列出全部已注册能力
```

### 5.3 共享实现

重叠能力（bash/fs/git/http/todo/kv/ui.* 等）在 `services/router/` 下**代码只实现一次**，两条总线在各自进程内实例化复用（同代码、不同实例）。

---

## 6. 常见错误

### 错误 1：用 bus_dispatch 调 bus 进程未注册的能力

```json
// ❌ 错误：cap.ui.render 只在主进程注册
{"target": "cap.ui.render", ...}
// 返回：能力未注册类错误（bus 进程 RouterBus 统一裁决，非白名单报错）

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

**文档版本**：v1.1（2026-10-25 勘误：bus_dispatch 静态白名单已废除、改注册表派生；主进程能力清单修正为 26 并补 cap.help）  
**最后更新**：2026-10-25
