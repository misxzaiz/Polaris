# 插件管理 + Hook 驱动生效注入（plugin-manage-hook-inject v1）

> 目标（goal）：插件管理不只是简单的安装/开关，而是能让插件**真正生效注入**到宿主（AI 工具集 / 面板 / 卡片 / 引擎 / 生命周期），
> 支持**热加载、免重启**；顺手结合一个**基础的 hook 功能**（宿主关键时点 → 插件可订阅/注入）。
> 状态：**方案（待评审）** ★ hook 侦查结论待并入
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