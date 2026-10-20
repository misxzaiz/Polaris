# 插件管理 + Hook 驱动生效注入（plugin-manage-hook-inject v1）

> 目标（goal）：插件管理不只是简单的安装/开关，而是能让插件**真正生效注入**到宿主（AI 工具集 / 面板 / 卡片 / 引擎 / 生命周期），
> 支持**热加载、免重启**；顺手结合一个**基础的 hook 功能**（宿主关键时点 → 插件可订阅/注入）。
> 状态：**P0 已实现**（插件生命周期事件 + 后端统一感知）+ **P1 已实现**（cap.hook + hook_registry + AI 会话/工具插桩）+ **P2 已实现**（cap.ui.render 可交互渲染）+ **P3 已实现**（cap.mcp 工具注入管理面 + PluginTab「AI 工具」）
> 日期：2026-10-20

---

## 0. TL;DR

「插件管理」当前是**纸面生效**：所有开关改 state.json / localStorage，但**没有任何机制通知宿主『插件变了，请重新装载生效』**。
插件要真正生效到 AI 工具 / 面板 / 卡片 / 引擎，靠的是**下一次 AI 会话解析时碰巧读到新状态**，而非主动注入。

本方案把「插件管理」从「CRUD 开关」升级为「**声明 + 生命周期 + 注入**」三层：
1. **声明**：插件在 manifest 声明它注入哪些席位（AI 工具 / 面板 / 卡片 / 引擎 / 服务 / hook）。
2. **生命周期**：宿主有插件生命周期（注册→启用→生效→停止→卸载），每个阶段**广播事件 + 触发插件 hook**。
3. **注入**：状态变更后，宿主**主动 re-resolve + 广播新状态**，让插件在**当前会话/回合**内生效（免重启、免等待）。

同时引入一个**基础 hook 机制**（`cap.hook` + hook registry）：
- 宿主在关键时点（AI 工具调用前/后、会话开始/结束、插件生命周期、UI 渲染帧等）「派发 hook」；
- 插件可声明订阅某类 hook，收到时执行自己的逻辑（注入工具、改参数、追加上下文、渲染交互卡），并可返回数据给宿主。

---

## 1. 现状调研（源码核实）

### 1.1 插件管理 = 安装/开关，没有「生效注入」

| 层面 | 现状（源码证据） | 问题 |
|---|---|---|
| 后端安装/卸载 | `cap.pluginDiscovery`（`plugin_discovery_capability.rs:181-332`）纯文件/进程操作，**完成后只返回结果、不广播** | 装完/卸载对其它模块零通知 |
| 后端状态 | `PluginStateService.load/save`（`plugin_state_service.rs:20-46`）只落 `state.json`：`enabled/ui_enabled/mcp_enabled/mcp_servers` | **无「变更 → 触发 reload」通道** |
| 前端状态 | `pluginStore.setPluginEnabled/McpEnabled`（`stores/pluginStore.ts:189-217`）只更新 zustand + localStorage | **无后端 re-resolve 调用** |
| MCP 解析 | `resolve_workspace_mcp_runtime_service`（`mcp_config_service.rs:784-816`）每次全新构造 + 读 state.json，**无缓存** | 「立即生效」的技术前提已具备，缺的只是**触发时机** |
| 工具注入 | `prepare_mcp_config`（`ai/launcher.rs:56-120`）在**每次 start/continue** 才执行 | 状态变更后要等下一次会话 |

**结论**：`resolve_workspace_mcp_runtime_service` 无缓存 + 每次全重读，意味着「插件状态变更 → 触一次 re-resolve 即为立即生效」是**完全可行的**，现在缺的只是「谁在状态变更后调它」。

### 1.2 插件生命周期断点

- 安装/卸载/启用/禁用：**没有任何生命周期回调/hook/事件**。
- `discover_installed_plugins`（`plugin_service.rs:323-355`）只「发现 metadata，不执行插件代码」。
- 唯一「半生命周期」：`PluginServiceManager`（`plugin_service_manager.rs`）管理后台服务（HTTP/Worker）进程，含 `spawn_process_watcher` 自动重启；`uninstall_with_cleanup` 先停服务再删目录。

### 1.3 可交互渲染（cap 渲染协议）—— 方案 1 详述，这里引用

- `plugin_card`（interaction）+ `respond_plugin_card`（`ai_chat_core.rs:2105`）完整链路已存在，但**绑定 MCP 伴生进程**。
- `cap.ui.*`（chat/theme/input）确立「前端应答式 cap」范式。
- 本方案复用：`cap.ui.render`（见 `plans/plugin-cap-inject-render-v1.md`）作为「cap 返回可交互渲染」的通用入口。

### 1.4 动态 cap（cap.registry）—— 已实现

- `dynamic_capability.rs`：`handler:{type:"forward",target,defaults}`，注册即入总线，`cap_dispatch` 可调，持久化重启重建。
- 局限：**纯 forward，无渲染、无 hook**。

### 1.5 hook / 事件基座

| 通道 | 现状 | hook 可复用度 |
|---|---|---|
| `EventBroadcaster`（`web/event_broadcaster.rs:73`） | tokio broadcast 多订阅者，WS 已订阅推事件 | **事件源基座**：插件进程可订阅宿主事件流 |
| `broadcast_chat_event`（`ai_chat_core.rs:1912`） | AI 事件（session_start/end 等）单向广播给前端 | 事件源丰富，但**无插件侧钩子** |
| 前端事件总线 | `pluginRegistry` 注册/清理面板/卡片/引擎；`chatCardRegistry`；无全局事件订阅 | 前端插件注入已通，缺「hook 事件」 |

### 1.5.1 已有 hook 基底：`session-v2` 的前端插件 host（重要发现）

`src/session-v2/core/plugin-host.ts` 已有**完善的插件 hook host 原型**（借鉴 Minecraft 模组三阶段）：
- `LoadPhase = 'register' | 'wire' | 'run'`（`session-v2/core/types.ts:258`）；
- `SessionPlugin`（`:301`）：`beforeCreateSession` / `beforeAppendMessage` / `onSessionStatusChange` / `beforeRequestStart` 4 个 hook，可选实现，`dependencies` 声明依赖做拓扑排序；
- `PluginHost`（`:328`）：`register / advancePhase / phase / listPlugins`；
- `InMemoryPluginHost`（`plugin-host.ts:27`）：实现（**层 1 验证原型**，被测试/类型引用，`new InMemoryPluginHost` 未接入生产）。

**结论**：Polaris 已有 hook 机制的**设计蓝图**（hook 接口 + 三阶段加载 + 拓扑排序 + 链式可中断分发），只是**未接入生产**。这是「基础 hook 功能」的最佳升级起点，无需从零发明。

### 1.5.2 前端 hook / 事件总线全貌（插件可挂接的基础）

| 总线 | 位置 | 能力 | 插件可挂接度 |
|---|---|---|---|
| `ai-runtime/event-bus.ts` | `getEventBus()` `:463` | `on(type)/onAny('*')/once/priority/namespace/EventChannel`（`event-bus.ts:75-458`）+ 监听器级错误隔离 | **★★★ 最佳骨架**：现成的 priority 链，可扩成「可改写事件」的 hook 链 |
| `eventBus.ts` | `PolarisEventMap:29` | 跨组件 TS 类型化总线，singleton `eventBus:100` | ★ TS map 锁死约 12 事件，**需动态扩展**才可挂插件 |
| `eventRouter.ts` | `register(contextId,'*'\|'main')` `:120/:159` | 路由 Tauri 'chat-event' 到会话 store | ★ 可注册（观察型） |
| AIEvent | `event.ts:892` union | 全链路唯一事件模型；`tool_call_start/end`（`:35/:52`）、`session_start/end`（`:125/:136`）、`user_message` `:147` | ★ 事后事件流，**无拦截语义**（缺 pre/post） |

特例：Claude CLI 的 hooks 已被透传解析为 `HookEvent`（`models/ai_event.rs:1507`、事件类型 `:1636`；`ai/engine/claude.rs:562,683` 加 `--include-hook-events` → `event_parser.rs:226,370` 解析）——**仅观察列表，Polaris 未实现拦截语义**。但 `isHookEvent`（`event.ts:744/1422`）类型位已预留，可复用为宿主 hook 通道的承载类型。

### 1.5.3 生效时点矩阵（插件注入面 × 生效时机）

| 能力 | 挂点 | 何时生效（现状） |
|---|---|---|
| views/panel（activityBar + shadow/chain） | panelRegistry（`registry.ts:99`） | 立即（hydration / replaceInstalled） |
| chatCards | chatCardRegistry（`chatCardRegistry.ts:38`） | 注册后对**新 tool_call** 立即渲染 |
| mcpServers | `launcher.rs:129 inject_mcp_into_session_opts` | **下一会话启动**，当前会话不变 |
| engines | `commands/plugin_engine.rs:20` → `ai/registry.rs:125` | 立即可列表；**运行要下一会话** |
| services | `plugin_service_manager.rs:114/158` | enable 切换 / App 启动立即 spawn |
| toolProviders | 后端 MCP 解析替换同 capability | 会话启动时（下一会话） |
| styles | `styles.ts` + `usePluginServiceSync:102` | 立即（DOM） |
| configSchema | `types.ts:288` 设置页渲染 | 重载后立即 |

### 1.5.4 要新建的 hook 基础设施（基于侦查结论）

| 新建项 | 依据 | 方案落点 |
|---|---|---|
| 引擎链路 **pre/post 拦截 hook** | 现在 tool 执行完全在引擎内部（SimpleAI `chat_loop.rs:180` loop，`tools` `:141` 冻结），事后才 emit | 在 loop 内请求前/结果后插桩 `ai.tool.before/after`；Claude/OpenCode 维持「下一条生效」 |
| 插件**生命周期回调**（onInstalled/onEnabled/onDisabled） | `cap.pluginDiscovery` 纯文件/进程操作，无代码回调；`discover_installed_plugins:323` 仅读 manifest | P0 在 install/uninstall/update/enable/disable 后派发 `plugin.lifecycle` |
| **宿主→插件反向事件通道** | 现仅 `window.__POLARIS_HOST_INVOKE__`（`main.tsx:17`）单向 invoke，卡片靠 React props 拿 payload | hook 链：插件 hook 返回数据 → 宿主/前端消费（经 `dispatch_hook` 返回） |
| **eventBus 动态扩展** | `PolarisEventMap:29` TS 锁死 | 插件声明新事件 key → 前端 hook 注册表动态注册 |
| **可改写事件的 hook 链** | 基于 `ai-runtime/event-bus.ts` 的 priority/namespace | `dispatch_hook(id, payload)` 按 priority 调插件 hook，逐级改写 payload（同一 `beforeXxx` 链语义） |

### 1.5.5 既有「hook 类似物」（借鉴先例）

- **cap 总线审计**（`contracts/mod.rs:281/300` + `router/audit_sink.rs:161`）：观察型审计，非插件可挂 — 可作为 hook 调用的审计落点。
- **Tauri `on_download`**（`commands/browser.rs:1598,1660`）：仓库内唯一字面 named hook，platform 级回调注册先例（稳定 API 接住下载落盘）— 佐证「宿主在稳定时点挂回调」模式可行。
- **`ai-runtime` NamespacedEventBus**：priority/once/namespace/onAny('*') + 监听器级错误隔离（`event-bus.ts:93-196`）— **现成可扩成 hook 链的骨架**。

---

## 2. 目标能力

### 2.1 插件真正生效注入（核心）

插件状态变更 → 宿主 **主动 re-resolve + 广播**，让插件在**当前会话/回合内**生效（免重启、免等待、免重开会话）。注入面：

| 席位 | 生效内容 | 生效时点（改造后） |
|---|---|---|
| AI 工具（MCP server / 工具） | 插件的 `mcp__{server}__{tool}` 进工具集 | **当前 turn 内**可刷新（SimpleAI 优先；Claude/OpenCode 进程级固定 → 明确提示下一条生效） |
| 面板 / 卡片 | 前端 `pluginRegistry` 注册/清理 | **立即**（已支持，补状态触发） |
| 引擎 | `register_plugin_engine`（`ai/registry.rs:125`） | **立即**（已支持） |
| 后台服务 | `PluginServiceManager` start/stop | **立即**（已支持） |
| 样式 / 配置 | `styles` / `configSchema` | **立即**（前端注入） |

### 2.2 基础 hook 机制（新增）

**`cap.hook` + hook registry**：宿主在关键时点派发「hook 事件」，插件声明订阅并执行，可注入数据返回宿主。

```
宿主关键时点 ──派发──>  hook registry ──通知──> 订阅该 hook 的插件
   |                   （注册表）               （执行自己的逻辑：注入工具 / 改参数 / 追加上下文 / 渲染交互卡）
   |                    ▲                            |
   └────────────────────┴── 插件返回数据（可选）──── 宿主/前端消费
```

**hook 点（v1 支持）**：
| hook id | 时点 | 数据 | 可用处 |
|---|---|---|---|
| `plugin.lifecycle` | 插件注册/启用/禁用/卸载 | `{pluginId, event, installPath}` | 插件联动、宿主联动 |
| `ai.session.start` / `ai.session.end` | AI 会话开始/结束 | `{sessionId, engineId}` | 会话级注入、清理 |
| `ai.tool.before` | AI 工具调用前 | `{sessionId, toolName, args}` | 工具参数改写、拦截、追加上下文 |
| `ai.tool.after` | AI 工具调用后 | `{sessionId, toolName, result}` | 结果变换、观测、联动 |
| `ui.render` | cap.ui.render 请求帧 | `{interactionId, frame}` | 插件自定义交互渲染（可交互卡） |

> **hook 落点（源码核实）**：
> - `ai.tool.before/after`：落点 `simple_ai/chat_loop.rs:180` 的 `loop`（每轮 tool_call 循环，`tools` 在 `:141` 冻结，请求发出前/结果回填后可插桩）。前端 `session-v2` 已有 `beforeAppendMessage` / `onSessionStatusChange` 等会话 hook 原型可复用。
> - 前端会话 hook：`InMemoryPluginHost`（`session-v2/core/plugin-host.ts:27`）的 `dispatchBeforeAppendMessage` / `dispatchOnSessionStatusChange` 等分发器，升级后可接 `ai.tool.before/after` 前端镜像。

**hook 载体**（两种，v1 至少一种）：
- **后端进程外 hook**：插件声明 `contributes.hooks[]`，宿主经 cap 总线/进程调用插件（复用 MCP/进程引擎通道）执行 hook。适合需要宿主进程内数据（MCP/引擎）的 hook。
- **前端 hook**：插件 `contributes.hooks[]` 声明前端 hook 文件，`pluginRegistry` 动态加载（仿 chatCard 的 Blob URL 加载），前端在对应时点派发。适合 UI 渲染类 hook（如 ui.render）与轻量联动。

**实现要点**：
- 后端 `hook_registry.rs`：`register_hook`（插件声明）→ 派发点调 `dispatch_hook(id, payload)` → 返回各插件 handle 结果。
- 与 cap 总线一致走权限 gate + 审计。
- 派发点插桩在：插件生命周期方法、`ai_chat_core` 的工具调用前后、`cap.ui.render` 的 request。

### 2.3 cap 渲染协议（复用方案 1 的 cap.ui.render）

- 任意 cap（含动态注册的 `ui-render` handler）→ 弹交互卡 → 用户操作 → oneshot 回填 AI 同回合。
- 插件自定义渲染：hook `ui.render` 或 cap.ui.render 的 `frame.type=custom` → 前端按 `chatCardRegistry` 匹配插件组件渲染。

### 2.4 工具注入管理面（复用方案 1 的 cap.mcp list/set）

- `cap.mcp list_plugin_tools` / `set_plugin_tools` + `state.json` 增加 `mcpToolGates`，内置 ask/prd + 外置统一。
- 状态变更后**立即触发 re-resolve**（本方案 2.1），不再等下一轮。

### 2.5 热加载 UX

- `PluginTab` 增加「AI 工具」子面板：按插件列出注入工具 + 一键开关（立即生效，带 toast「已生效」）。
- in-flight 会话提示：Claude/OpenCode 类进程级工具集，「下一条消息生效」；SimpleAI 当前回合可刷新。

---

## 3. 接口清单

### 后端新增能力 / 服务
| 项 | 类型 | 说明 |
|---|---|---|
| `cap.hook` | 同步能力 | 注册/卸载 hook、派发 hook、列出已注册 hook |
| `hook_registry` | 服务 | hook 注册表 + 派发器（`dispatch_hook(id,payload)`） |
| `cap.ui.render` | 同步能力 | 可交互渲染入口（复用方案 1） |
| `cap.mcp` 管理面 | 扩展 | `list_plugin_tools` / `set_plugin_tools` |

### 后端插桩点
| 位置 | 插桩 |
|---|---|
| `plugin_service.rs` / `cap.pluginDiscovery` 的 install/uninstall/apply_update | 完成后派发 `plugin.lifecycle` hook + 返回事件 |
| `PluginStateService.save` | 保存后广播「状态变更」事件（或由调用方触发 re-resolve） |
| `ai_chat_core.rs` 工具调用循环 | `ai.tool.before` / `ai.tool.after` 派发 |
| `ai/launcher.rs` | `ai.session.start/end` 派发 |
| `cap.ui.render` | `ui.render` 派发 |

### 状态/类型扩展
| 位置 | 变更 |
|---|---|
| `models/plugin_state.rs` | `PluginState` +`mcpToolGates`；生命周期状态字段（如 `injected`） |
| `plugin-system/types.ts` | `PolarisPluginManifest` +`contributes.hooks[]`（声明 hook 订阅） |
| 前端 `stores/pluginStore.ts` | `setPluginEnabled/McpEnabled` 后触发后端 re-resolve（`invoke` 通知）+ 本地乐观生效 |

### 前端
| 位置 | 变更 |
|---|---|
| `PluginCardHost` / `chatCardRegistry` | `custom` frame key 匹配 |
| `PluginTab.tsx` | 「AI 工具」子面板 + 生命周期状态展示 |
| `eventHandler.ts` | 消费 `plugin.lifecycle` 事件 + `ui.render` 帧 |

---

## 4. 验收标准

1. **真正生效注入（免重启/免等待）**：`PluginTab` 打开某插件 AI 工具开关 → 当前会话后续轮次 AI 工具集出现该工具（SimpleAI 验证 + Claude/OpenCode 误报为「下一条生效」）；关闭后后续轮次消失。
2. **生命周期事件**：安装/卸载/启用/禁用插件时，订阅 `plugin.lifecycle` 的 hook 收到事件并执行推荐逻辑（如安装后自动注册该插件 MCP server）。
3. **hook 机制**：
   - 插件声明 `contributes.hooks: [{id:"ai.tool.before"}]` → AI 工具调用前执行插件逻辑（改参数/追加上下文）→ 调用结果包含插件副作用。
   - `ui.render` 本 hook 或 cap.ui.render 让插件渲染交互卡，用户操作回填 AI。
4. **热加载**：装新插件（含 chatCards/mcpServers/hooks）免重启，前端注册表更新 + 后端 re-resolve 生效。
5. **内置+外置统一**：ask/prd（内置）与 mimo-tts（外置）都能被 `list_plugin_tools` 列出、被统一开关控制。
6. **安全**：`cap.hook`/`cap.ui.render` 对未授权 Remote 拒绝；hook 返回值白名单校验；生命周期 hook 防重入（幂等）。
7. 验证命令全绿：`cargo check`、`cargo check --no-default-features --bin polaris-web --bin polaris-mcp`、`pnpm exec tsc --noEmit`、`pnpm lint`、相关 vitest。

---

## 5. 实施步骤（建议顺序）

### P0：插件生命周期 + 立即生效（解决「管理≠生效」大头）
1. `PluginStateService.save` 后广播「插件状态变更」事件（或返回变更集）。
2. 前端 `pluginStore` 开关动作 → `invoke` 通知后端 `re-resolve`（触发 `resolve_workspace_mcp_runtime_service`）。
3. `cap.pluginDiscovery` 的 install/uninstall/update 完成后：派发 `plugin.lifecycle` hook + 广播事件。
4. 后端能力 `cap.plugin.lifecycle` / `cap.hook.register/list` 最小可用。

### P1：基础 hook 机制
5. 定义 hook 点枚举 + `cap.hook` + `hook_registry`（注册/派发/审计/幂等）。
6. 插桩 `ai.session.start/end`、`ai.tool.before/after`。
7. 前端 hook 载体（插件声明 hooks + Blob URL 动态加载）+ 前端派发点。

### P2：可交互渲染（复用方案 1 的 cap.ui.render）
8. `cap.ui.render` + contracts + 前端渲染块复用 + `custom` frame 匹配。
9. 动态 cap 支持 `ui-render` handler。

### P3：工具注入管理 + 热加载 UX
10. `cap.mcp list_plugin_tools/set_plugin_tools` + `mcpToolGates` 注入过滤 + `PluginTab`「AI 工具」面板 + in-flight 提示。

---

## 6. 边界与不做（v1）

- **不改 Claude/OpenCode 进程级 toolset 动态性**：保持「下一条生效」语义 + 明确提示（进程级固定是引擎约束）。
- **hook v1 支持有限值返回**：`ai.tool.before` 可改写 args；`ai.tool.after` 可观测，不做完整 result 中间变换（复杂变换列 v2）。
- **cap.ui.render 不支持任意 HTML**：v1 只支持 question/form/confirm + 插件 chatCard 的 `custom` key。
- **不把插件生命周期做成 CSP 沙箱**：hook 执行走既有插件进程/前端模块加载，安全靠权限 gate + 白名单 + 审计。
- **不新建「未安装插件反向工具」**：v1 的「任意插件经 cap 调用」指动态 cap 注册（已实现），新增的只是【动态 cap 也能 hook/渲染交互】。

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 插件状态变更触发 re-resolve 有性能开销 | re-resolve 轻量（读 state.json + 解析模板，无进程 spawn）；节流（变更合并 100ms 内一次） |
| hook 派发阻塞 AI 回合 | hook 时序：`ai.tool.before` 同步可选（插件快速返回）；超时兜底（默认放行原行为）；异步 hook 不阻塞 |
| 生命周期 hook 重入/死循环 | 幂等（同 hook+payload 只生效一次）；派发深度限制；`plugin.lifecycle` 只广播不递归触发 |
| `mcpToolGates` 破坏现有插件状态 | 向后兼容（缺省全放行），显式关闭才有影响 |
| 前端 hook 动态加载（Blob URL）跨会话状态 | 复用 chatCard 的 `loadModuleFromFile` + 缓存 + 卸载清理 |
| 交互 UI 被 Remote/AI 滥用 | `Source::Remote` 默认 deny + frame 白名单 + interactionId 防重放 + 审计 |

---

## 8. 与既有 spec 的关系

- 复用 `plans/dynamic-capability-registry.md`（cap.registry）能力模型。
- 复用 `plans/plugin-cap-inject-render-v1.md`（cap.ui.render / cap.mcp 管理面）。
- 复用 `components/Chat/chatBlocks/` 的 `AskQuestionCard` / `FormCard` / `PluginCardHost`。
- 交互提交通道走 `ai_chat_core.rs:2105` `respond_plugin_card`（既有）。
- hook 事件源复用 `EventBroadcaster`（`web/event_broadcaster.rs`）。

---

## 9. P0 具体落地（2026-10-20 实施核对）

**目标**：插件生命周期事件（install/uninstall/update + 状态开关变更）广播到前端 + 总线，让「管理」与「生效」关联。实施前确认的命令层事实：

| 事实 | 源码依据 |
|---|---|
| 前端开关已写后端 | `pluginStateService.ts` → `plugin_state_save`（Tauri 命令 `commands/plugin_state.rs` + Web API `ipc.rs:2056`）→ `PluginStateService.save` → state.json |
| 配置层无缓存、每回合重读 | `resolve_workspace_mcp_runtime_service`（`mcp_config_service.rs:784`）每次全新构建 + 读 state.json，「下一回合生效」天然成立 |
| 安装/卸载/update 无生命周期广播 | `plugin_discovery_capability.rs` invoke：install_local/install_package/install_remote/uninstall_local/uninstall_with_cleanup/force_uninstall/apply_update 纯文件/进程操作，返回 PluginOperationResult，**零事件** |
| 可广播契约 | `contracts/mod.rs:126` `Event{seq,kind,payload,trace}` 是 String kind，无枚举约束 → 新增 `plugin.lifecycle` kind **零契约改动**；`Context::emit`（`:174` 默认空实现）是插件能力内广播入口 |
| 前端订阅通道 | `EventAdapter`（`event_adapter.rs`，经 `AppState.event_broadcast`，WebSocket 复用）+ `useAppEvents.ts` 可加 kind 监听；`router/EventAdapter`（state.rs:377）已进生产 |

**P0 变更清单**（最小侵入）：
- 后端新增 `src-tauri/src/services/plugin_events.rs`：`broadcast_plugin_lifecycle(bc, event, plugin_id, install_path, detail)`，事件 kind=`plugin.lifecycle`，payload=`{ pluginId, event, installPath?, detail? }`。
- **插件能力侧**：`plugin_discovery_capability.rs` 各写动作完成后（install_local/install_package/install_remote/uninstall_local/uninstall_with_cleanup/force_uninstall/apply_update）用 `ctx` 广播。Context 默认空实现 → 需要 RealContext 连通 EventAdapter（低成本，见下）。
- **状态保存侧**：`ipc.rs:2056 dispatch_plugin_state_save` 与 `commands/plugin_state.rs` 保存后广播 `plugin.lifecycle`（event=`state_changed`，detail 携带变更概览）。Tauri 命令侧走 `state.event_broadcast`。
- **前端**：`useAppEvents.ts` 增加 `plugin.lifecycle` kind → 触发插件列表/状态刷新；`pluginStore` 增加 `mcpEnabled` 开关后的乐观生效（同一会话已有，补触发生效反馈）。
- 装配：确认 RealContext 的 `emit` 已走 EventAdapter（否则补接）。

**验收（P0）**：安装/卸载/更新/开关插件时，前端订阅到 `plugin.lifecycle`（含 pluginId/event）；`cargo check`、`cargo check --no-default-features --bin polaris-web --bin polaris-mcp`、`pnpm exec tsc --noEmit`、`pnpm lint` 全绿。

### P0 落地记录（2026-10-20 已实施）

| 步骤 | 文件 | 内容 |
|---|---|---|
| 1. 事件模块 | `src-tauri/src/services/plugin_events.rs`（新） | `broadcast_plugin_lifecycle`（EventBroadcaster 通道）、`emit_plugin_lifecycle`（Context::emit 通道）、`handle_plugin_state_change`（后端 diff 旧状态 → 逐插件广播 `state_changed` + 返回变更概览）+ 4 个 diff/广播单测 |
| 2. 模块注册 | `src-tauri/src/services/mod.rs` | 注册 `plugin_events` |
| 3. 能力侧广播 | `src-tauri/src/services/router/plugin_discovery_capability.rs` | 7 个写动作（install_local/install_package/install_remote/uninstall_local/uninstall_with_cleanup/force_uninstall/apply_update）成功后 `emit_plugin_lifecycle(ctx, pluginId, event, detail)`。**前置确认**：`RealContext::emit`（`router/mod.rs:647`）走 broadcaster → EventAdapter，cap 内广播可达前端 |
| 4. 状态保存侧广播 | `src-tauri/src/web/api/ipc.rs:2067` + `src-tauri/src/commands/plugin_state.rs:30` | 保存后 `handle_plugin_state_change`（diff 旧状态 → 广播 `state_changed`）+ 返回变更概览给前端友善回显 |
| 5. 前端订阅 | `src/stores/pluginLifecycleSubscriber.ts`（新）+ `src/hooks/useAppEvents.ts` | `initPluginLifecycleSubscriber`：收到 `plugin.lifecycle` → `loadPluginStates` 刷新开关真相；install/uninstall/update → `discoverInstalledPlugins` + `replaceInstalled` 重同步注册表。挂到 App 顶层常驻（非 PluginTab 也感知） |

**后端统一感知确认**（用户补充「后端感知而不是前端」）：diff 逻辑 + 事件广播统一在后端（`handle_plugin_state_change`），前端 subscriber 只做「展示/回填」两层——刷新开关真相 + 重同步注册表，不承担变更判定。

**验证**（worktree 隔离环境实测）：
- `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` **exit 0**（Web-only 门控，完整编译 lib 除 tauri-app；含修复 `ipc.rs:2073` `serde_json::json!` 全限定缺失）
- `pnpm exec tsc --noEmit` exit 0（仅 tsconfig `baseUrl` deprecation 存量噪音）
- vitest `pluginLifecycleSubscriber.test.ts` **8/8 通过**（多事件分类刷新 / installed→discover+replace / state_changed 不重发现 / 失败不抛 / cleanup 幂等）
- `pnpm eslint` 新增/改动文件 exit 0（仅 MODULE_TYPELESS 噪音）
- **cargo check（默认 features）本 worktree 受限**：tauri build.rs 需 `../dist`（前端产物），worktree 无 dist → `warning: build failed, waiting for other jobs to finish...`，**非代码错误**（无 Rust error）。tauri-app 专属代码（`plugin_state.rs` 广播）经静态类型核对：`AppState.event_broadcast: EventBroadcaster`（`state.rs:287`）→ `handle_plugin_state_change(..., &EventBroadcaster)` 签名匹配；`plugin_state_save` 整函数 `#[cfg(feature="tauri-app")]` 包裹,内部 `use tauri::State` 随之裁剪,Web-only 构建安全。
- tauri.config.json `frontendDist: "../dist"`（相对 src-tauri），主仓库 dist 存在于 `D:\space\base\Polaris\dist`；worktree `cargo check` 若要全绿需先 `pnpm build` 或 junction dist——两种都未做（环境限制，如实记录）。
- **`--no-default-features --features git,lsp-index` 组合不可用**：`bin/polaris` main 调 `polaris_lib::run()`（`lib.rs:499`），而 `run()` 被 `#[cfg(feature="tauri-app")]` 门控 → 无 tauri-app 时 main 挂（E0425）。**预存在工程约束，非 P0 引入**（`lib.rs`/`main.rs` 本次零改动）。有效的中间验证组合是**自带 bin 的**：`--no-default-features --bin polaris-web --bin polaris-mcp`（已 exit 0）。
- `plugin_events.rs` 的 4 个 Rust 单测**本机无法运行**（AGENTS.md 已知边界 `cargo test --lib` Tauri DLL 限制），其生产代码已被 Web-only 门控编译验证，diff/广播逻辑另有前端 vitest 覆盖。

---

## 10. P1 具体落地（基础 hook 机制，2026-10-20 实施核对）

**目标**：`cap.hook` + `hook_registry`，宿主在关键时点（AI 会话/工具循环）派发 hook，插件声明订阅并可注入数据返回宿主。

### P1 变更清单（已实施）

| 步骤 | 文件 | 内容 |
|---|---|---|
| 1. 注册表 | `src-tauri/src/services/hook_registry.rs`（新） | `HookRegistry`（register/unregister/list/all_hook_ids，幂等去重）+ `HookSystem` 全局单例（registry + router + broadcaster）+ `put_hook_system`/`get_hook_system`/`dispatch_hooks` 便捷函数 + 4 个单测 |
| 2. 能力 | `src-tauri/src/services/router/hook_capability.rs`（新） | `cap.hook`：register/unregister/list/dispatch 四个动作；无独立状态，经全局 HookSystem 操作；`pub use` re-export |
| 3. 模块注册 | `src-tauri/src/services/mod.rs` + `src-tauri/src/services/router/mod.rs` | 注册 `hook_registry` / `hook_capability` + `pub use HookCapability` |
| 4. 装配 | `src-tauri/src/state.rs` | `put_hook_system(HookSystem::new(Some(bus.clone()), Some(hook_adapter)))`（bus = RouterBus、hook_adapter = EventAdapter clone）+ 注册 `cap.hook` |
| 5. 插桩 `ai.session.start` | `ai_chat_core.rs` start_chat_inner | 临时 session_id 生成后派发 `{sessionId, engineId}` |
| 6. 插桩 `ai.session.end` | `ai_chat_core.rs` start/continue 双路径 SessionEnd | 引擎真实 session_id + `{sessionId, engineId, reason}` |
| 7. 插桩 `ai.tool.before` | `simple_ai/chat_loop.rs` 工具循环 | args 解析后派发 `{sessionId, toolName, args}`；回调返回 `{args}` 可改写（v1 取第一个） |
| 8. 插桩 `ai.tool.after` | `simple_ai/chat_loop.rs` 工具循环 | 结果后派发 `{sessionId, toolName, result, success}`（观测/联动） |

### 架构决策（全局 HookSystem 而非逐层传参）

- **问题**：自动派发点分布在深层链路（`chat_loop.rs` 工具循环、`ai_chat_core.rs` 会话生命周期），逐层传 `HookRegistry` 参数需穿透 Engine trait / SessionOptions，侵入面过大。
- **方案**：进程级 `OnceLock<HookSystem>` 全局单例（`put_hook_system` 装配时注入一次），插桩点统一 `dispatch_hooks(hook_id, data)` 便捷函数，未装配时静默 no-op。三端（desktop / polaris-web / MCP server）各自装配一次，进程内单例。
- **佐证**：既有 `turn_persist.rs`（`OnceLock<Mutex<HashMap>>` + `get_or_init`）同款全局媒介先例。
- **派发通道**：① 广播 `hook:<id>` 事件（EventAdapter，插件/前端订阅联动，不阻塞）；② 逐回调 dispatch（RouterBus，复用权限 gate + 审计，返回改写数据）。两通道可选（router/broadcaster 为 Option），纯广播模式（无 router）不崩。

### 安全边界落实（spec §7）

- 回调失败不回传给调用方（逐项收集 `{capId, error}`，warn 日志），不阻塞宿主主流程。
- 回调经 RouterBus dispatch 复用权限 gate + 审计；`Source::Bootstrap` 内部派发（无 token）。
- 幂等：同 hook + 同 cap_id 去重。
- `ai.tool.before` 多回调取第一个改写（防相互覆盖），无回调静默放行原 args。
- `plugin.lifecycle` 仅广播不递归触发（P0 已隔离）。

### 验证（worktree 隔离环境实测）

- `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` **exit 0**（含 P1 全部新代码 + 插桩）
- `cargo clippy --no-default-features --bin polaris-web --bin polaris-mcp` **exit 0**（新增代码零 clippy warning）
- `hook_registry.rs` 4 个单测**本机无法运行**（`cargo test --lib` Tauri DLL 限制），生产逻辑已被 Web-only 门控编译验证 + clippy 覆盖
- **cargo check（默认 features）仍受限**：worktree 无 `../dist`，环境限制（见 P0 记录）

### P1 未做 / 后续

- **前端 hook 载体**（spec §2.2 第 2 种）：插件 `contributes.hooks[]` 声明 → 前端注册表可见 + 前端派发点镜像。v1 后端 hook 已完整（插件经 cap.hook.register + cap 回调注入），前端载体列为 P3 热加载 UX 阶段一并做。
- **hook 链改写语义**（`beforeXxx` 链逐级改写 payload）：v1 只支持「第一个改写」，链式改写列 v2。

---

## 11. P2 具体落地（可交互渲染，2026-10-20 实施核对）

**目标**：`cap.ui.render` —— 把可交互渲染从 MCP 伴生进程专属提升为 cap 契约一等公民，任意 cap 调用即弹可交互 UI 帧，answer oneshot 回传同回合。

### P2 变更清单（已实施）

| 步骤 | 文件 | 内容 |
|---|---|---|
| 1. 能力 | `src-tauri/src/services/router/ui_render_capability.rs`（新） | `cap.ui.render` `request` 动作：校验 frame 白名单 → 登记 PendingPluginCard + oneshot → 广播 plugin_card 事件 → block_on await 应答 → 返回 `{status, answer, interactionId}` |
| 2. 事件可见性 | `src-tauri/src/services/ask_listener.rs` | `emit_plugin_card_event` 私有 → `pub(crate)`（cap.ui.render 复用广播） |
| 3. 模块注册 | `src-tauri/src/services/router/mod.rs` | `mod ui_render_capability` + `pub use UiRenderCapability` |
| 4. 装配 | `src-tauri/src/lib.rs` 双装配点 | Tauri（约 591）+ Web（约 1385）：`UiRenderCapability::with_state(state.clone())`，与 cap.ai.chat 同装配点（需 Arc<AppState>） |

### 架构决策（复用 plugin_card 全链路，前端零改动）

- **核心洞察**：前端 `eventHandler` 已有 `plugin_card`（渲染）+ `plugin_card_answered`（回填）处理；`PluginCardHost` 按 cardId/toolName 从 chatCardRegistry 匹配组件并透传 respond。**cap.ui.render 只要发出标准 plugin_card 事件，前端即完整渲染 + 回填**——不需要任何前端改动。
- **async 等待**：`Capability::invoke` 是同步 fn，但 `ai_chat_capability.rs:119-123` 已有范式——`tokio::task::block_in_place + Handle::block_on` 在同步 invoke 内驱动 async 业务核。cap.ui.render 同款实现。
- **安全**（spec §7）：frame.type 白名单 {question, form, confirm, custom} + 必填字段校验；interactionId 由后端 uuid 生成 + pending 表防重放；Source::Remote 默认 deny 由 policy_permission 控制。

### 验证

- `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` **exit 0**
- 前端渲染链路零改动，经静态核对（eventHandler plugin_card/plugin_card_answered + PluginCardHost）

### P2 待做

- **动态 cap 声明渲染**（方案 1 §2.2 `handler.type="ui-render"`）：动态注册 cap 的 handler 增加 ui-render 变体。列入 P3 一并（工具注入管理完成后）。

---

## 12. P3 已实施（工具注入管理面 + PluginTab「AI 工具」）

### P3 变更清单（已实施）

| 步骤 | 文件 | 内容 |
|---|---|---|
| 1. 类型 | `src-tauri/src/models/plugin_state.rs` | `PluginState` +`mcp_tool_gates: BTreeMap<String,bool>`（serde default + skip 空 → 向后兼容，缺省全放行） |
| 2. 全局门 | `src-tauri/src/services/mcp_tool_gates.rs`（新） | 全局 `OnceLock<Mutex<HashMap<plugin_id, HashMap<tool,bool>>>>`（P1 HookSystem 同构）；`is_tool_blocked` 缺省全放行；`put_mcp_tool_gates` 幂等装配/更新 |
| 3. 装配 | `src-tauri/src/state.rs` | 装配时从 state.json 载入全局镜像（`put_mcp_tool_gates`）+ `McpCapability::with_servers(servers, config_dir)` 注入 config_dir |
| 4. 能力扩展 | `src-tauri/src/services/router/mcp_capability.rs` | +`list_plugin_tools`（聚合 defs → 已拉起 server 列工具 + per-tool gate）/ `set_plugin_tools`（per-tool 或整插件 mcpEnabled → 写 state.json + 全局镜像同步 + 广播 state_changed）+ `with_broadcaster` 注入广播 |
| 5. 引擎过滤 | `src-tauri/src/ai/engine/simple_ai/mcp/mod.rs` | `McpClientPool::from_servers` tools/list 后 `is_tool_blocked(&server.plugin_id, &tool.name)` → 显式关闭的工具跳过注入（缺省全放行） |
| 6. 前端桥 | `src/services/pluginToolService.ts`（新） | `listPluginTools` / `setPluginTools` → `router_dispatch('cap.mcp', ...)`（对齐 mcpBridge 模式） |
| 7. 前端 UI | `src/components/Settings/tabs/PluginTab.tsx` | PluginCard 详情区 MCP 区块下方 +「AI 工具」子区块：刷新按钮 + 各 server 工具开关（per-tool，下一轮生效） |
| 8. 测试 | `src/services/pluginToolService.test.ts`（新） | 6 用例（list 解析 / 空 pluginId / 失败透传 / set 带 tools / set 无 tools / invoke 异常兜底）|

### 架构决策

- **过滤点唯一权威**：`McpClientPool::from_servers`（chat_loop.rs:117 唯一统一点）——tools/list 后逐工具查全局门。SimpleAI 引擎层拿不到 config_dir，走 P1 同款进程级全局镜像。
- **双语义 `set_plugin_tools`**：传 `tools[]` → per-tool 开关（写 `mcpToolGates`）；不传 → 整插件开关（`mcpEnabled`，装配层过滤 server）。缺省全放行（spec §6 向后兼容）。
- **实时镜像**：`set_plugin_tools` 写 state.json 后重读再 `put_mcp_tool_gates`（全局 = 文件实时镜像）→ 下一轮 `from_servers` 生效。
- **前端刷新**：广播 `plugin.lifecycle state_changed`（P0 通道）→ `pluginLifecycleSubscriber` 已订阅 → 插件状态刷新（无需新事件监听）。
- **诊断语义**：`list_plugin_tools` 对已拉起 server 列工具名 + per-tool gate；未拉起标 `injected: "lazy"`（工具未知，下一轮注入后可见）。

### 验证

- `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` **exit 0**
- `cargo test --no-default-features --lib mcp_tool_gates` **通过（3 用例）**
- `cargo clippy --lib --no-default-features` **零新增 warning**
- `pnpm exec tsc --noEmit --ignoreDeprecations 6.0` **仅 1 个 pre-existing 错误**（cryptoPolyfill，与本次无关）
- vitest：`pluginToolService.test.ts` 6 用例 + `pluginLifecycleSubscriber` + `mcp.test` + `mcpBridge.test` **28 用例全绿**
- eslint：新增文件 **零 error**（3 个 pre-existing `_err` warning）

### P3 待做

- **动态 cap 声明渲染**（方案 1 §2.2 `handler.type="ui-render"`）：动态注册 cap 的 handler 增加 ui-render 变体（让任意 cap 声明式弹交互 UI）。
- **in-flight 会话提示**：PluginTab 工具开关动作时，若当前有 in-flight 会话提示「下一条消息生效」。
- **Claude/OpenCode 工具集动态性**：进程级固定是引擎约束，v1 保持「下一轮生效」+ 提示。
- **内置插件（polaris.ask 等）不在 cap.mcp 管理面**：装配时 `state.rs` 过滤 `plugin_id != "polaris.builtin"`，`list_plugin_tools`/per-tool 门只覆盖外部插件；内置插件由既有 PluginTab MCP 区块（server 级 mcpEnabled）控制。如需内置也进 per-tool 门，需把内置 server 注入 McpCapability defs 并统一 `server.plugin_id` 为真实插件 id（v2）。