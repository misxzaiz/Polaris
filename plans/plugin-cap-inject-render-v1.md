# 插件管理 + Cap 通用调用 + 可交互渲染（plugin-cap-inject-render v1）

> 目标（goal）：用户手动管理插件；插件支持热加载（无需重启应用）；任意插件即使未安装也可经 cap 调用；
> ask/prd 等可更新 cap 返回的渲染参数固定渲染；cap 提供渲染方式、可交互（类似 ask / form）。
> 状态：**方案（待评审）**
> 日期：2026-10-20

---

## 0. TL;DR

Polaris 已有 4 块关键地基，无需从零建设：

| 需求 | 已有地基 | 缺什么 |
|---|---|---|
| 用户手动管理插件 | `cap.pluginDiscovery`（list/install/uninstall/update）、`cap.pluginServiceManager`（start/stop/restart/autostart）、`PluginTab.tsx`（UI） | **AI 工具级**注入管理（哪些插件工具进 AI 会话、一键注入/移除，含内置 ask/prd + 外置） |
| 插件热加载 | 前端 `pluginRegistry` 运行时注册/清理面板+卡片+引擎（`registry.ts`）、`register_plugin_engine` 热注册、`cap.registry` 动态 cap 注册 | 后端会话侧 MCP 工具集**当前 turn 内**动态刷新（目前仅下一轮生效） |
| 任意插件未安装也可经 cap 调用 | `cap.registry`（已实现，动态注册 + 持久化重启重建 + `cap_dispatch` 通道） | cap 能力可返回 **可交互渲染** |
| cap 提供渲染方式、可交互 | `plugin_card`（interaction 模式）+ `respond_plugin_card`（`ai_chat_core.rs:2105`）完整链路 + `cap.ui.*` 「前端应答」范式 | 把它**提升为通用 cap 契约**，不再绑定 MCP 伴生进程 |

**本方案核心**：把「可交互渲染」从「MCP 伴生进程专属」提升为 **cap 契约的一等公民**（`cap.ui.render`），
并补上「插件 → AI 工具」的注入管理（`cap.mcp` 管理面）。三者拼起来即达成目标。

---

## 1. 现状调研（源码核实结论）

### 1.1 工具注入的真实链路（为什么会说「没有这个工具」）

- 每次 `start` / `continue` 重新执行 `prepare_mcp_config`（`src-tauri/src/services/ai_chat_core.rs:1046/1569`）→
  重新 `discover_installed_plugins` + 读 `state.json` → 重新解析模板 → 重新 spawn。
- **工具定义是「每 turn 快照、turn 内冻结」**：SimpleAI 每轮 `run_chat_loop` 重建 `McpClientPool::from_servers`
  （30s 超时）→ `tools/list` → `cached_specs` 冻结（`simple_ai/chat_loop.rs:117-141`）；ClaudeCode/OpenCode 各自进程启动时一次 tools/list。
- 因此「AI 说没有这个工具」的高频成因（按可能性）：
  1. **当前 turn 内中途新装/启用插件** → 本轮快照已生成，下一轮 continue 才生效；
  2. `enableMcpTools=false`（总开关，`ai_chat_core.rs:1038` 默认 false，聊天路径固定传 true，但 scheduler/dispatch 等要逐一核）；
  3. `aiToolAccess` 权限门控未开（`ai/launcher.rs:86-100`）；
  4. `disabledMcpServers` 过滤（`state.json` 的 `mcpEnabled`/per-server 开关）；
  5. ask 依赖 `ask_listener`（`mcp_config_service.rs:573-578`，AskListener 模式 server 在 listener 未就绪时 skip）；
  6. `polaris-mcp` 二进制缺失（`mcp_config_service.rs:468-472`）。

关键结论：**不是「插件进程没重连」，而是「工具集在 turn 内冻结 + 各门控」**。重启应用后配置可 rediscover，
但**本回合已冻结** → 表现为「偶发没有、下轮又有」。

### 1.2 可交互渲染的现状（已有一条完整但不通用的链路）

- `plugin_card` 块 + `PluginCardHost` + `chatCardRegistry`（按 `mcp__{server}__{tool}` 匹配 React 组件）：
  - result 模式：展示 MCP 工具结果（prd 的 preview_html/read_preview、agnes 的媒体卡）
  - interaction 模式（注释规划，已落地到 respond）：卡片 `respond(result)` → `respondPluginCard(sessionId, interactionId, result)`
    → `chatDispatch('respond_plugin_card')` → `ai_chat_core.rs:2105` `pending_plugin_cards` 表 + oneshot sender
    → 唤起挂起的 AI 回合 → `plugin_card_answered` 事件 → 前端卡片切已处理态。
- **限制**：`plugin_card` 请求目前只由 MCP 伴生进程（`ask_listener.rs` 的 `plugin_card` 请求分支：`ask_mcp_server.rs` / `browser_mcp_server.rs` / `dispatch_mcp_server.rs`）发起。
  **任意 cap 能力无法发起可交互 UI** —— 这是缺口。

### 1.3 动态 cap 能力（cap.registry 已实现）

- `dynamic_capability.rs`：`handler:{ type:"forward", target, defaults }`，注册即入 RouterBus，`cap_list` 可见、`cap_dispatch` 可调、持久化重启重建。
- 机制局限：**纯 forward，无渲染维度**。cap 被调用返回的只是 Value 数据。

### 1.4 cap.ui 家族已确立「前端应答」范式

- `cap.ui.chat` / `cap.ui.theme` / `cap.ui.input`：状态真相在前端 store，cap 只校验 + 审计 + describe，效果经 tool_call_end 事件落前端。
- `ai_chat_capability.rs` 已含 `respond_plugin_card` / `answer_question` / `form_submit` 等交互回传动作。

---

## 2. 目标架构

```
  AI 会话（claude/opencode/simple/插件引擎）
    │ tools: cap_list / cap_dispatch / cap_dispatch_stream / mcp__{server}__{tool}
    ▼
  RouterBus（cap 总线，统一权限+审计）
    ├─ [cap.registry]  动态注册/卸载 AI 自拓展能力（已存在）
    ├─ [cap.ui.render]*  ★新增：发起可交互 UI 请求（渲染协议一等公民）
    ├─ [cap.mcp]        插件 MCP 调用（已存在，补管理面）★
    └─ [cap.<dynamic>]  AI/插件注册的动态能力（可 forward 到 cap.ui.render）★
    ▼  dispatch → EventAdapter
  前端 EventHandler
    ├─ PluginCardHost  → cap.ui.render 产物 → 渲染（复用 chatCardRegistry / 新 render type）★
    └─ respondPluginCard / form_submit / answer_question → 回填 AI 同回合 ★
```

### 2.1 新增：`cap.ui.render` —— 可交互渲染能力（核心）

cap 调用 `cap.ui.render` 请求一个「可交互 UI 帧」。宿主按 `frame.type` 选择渲染器，用户操作（提交/跳过/点击）后，
answer 通过 oneshot 回传调用方（AI 同回合继续）。**与 `plugin_card` 问询同构，但提升为通用 cap 契约。**

**请求协议**（`cap.ui.render` 的 `invoke` 入参，由任意 cap 内部发起或直接 cap_dispatch 调用）：

```jsonc
{
  // render 参数（渲染契约）
  "interactionId": "uuid",            // 全局唯一
  "sessionId": "session-uuid",        // 目标 AI 会话
  "title": "确认操作",
  "frame": {
    "type": "question",               // 复用 ask 的题卡（questions[]/options[]/allowCustomInput）
    // 或
    "type": "form",                   // 复用 form 的 schema 驱动（fields[]/read/private）
    // 或（v1 之后扩展）
    "type": "custom",                 // 插件自定义 React 组件 key → chatCardRegistry 匹配
    // 或
    "type": "confirm", "content": "确定删除？", "danger": true
  },
  "renderHint": { "width": "sm" }     // 可选，渲染外壳提示
}
```

**返回协议**（发起方期待的应答 / oneshot 回传）：

```jsonc
{
  "status": "answered" | "declined" | "timeout",
  "answer": { /* question: {answers:[{selected,customInput,declined}]} / form:{values} / custom: raw */ },
  "interactionId": "uuid"
}
```

**实现位置**：
- 后端新 capability `services/router/ui_render_capability.rs`：校验 render 参数白名单 + 在 `state.pending_plugin_cards`
  登记 `PendingPluginCard` + `register_plugin_card_answer_sender`（**复用 ask 同款 oneshot 通道**，location 在 `ask_listener.rs` 已抽出的 pub(crate) API）→ 等待应答 → 返回给调用方。
- 复用 `respond_plugin_card`（`ai_chat_core.rs:2105`）作为唯一回填入口（合并 pending_plugin_cards 表语义）。
- 前端：`eventHandler` 增加 `ui.render` 帧 → 复用 `question`/`form` 块渲染（`AskQuestionCard`/`FormCard`），
  或 `plugin_card`/`custom`（chatCardRegistry）。`respond` 统一走 `respondPluginCard`。

**安全**：`cap.ui.render` 仅允许 `Source::Bootstrap` / `Source::Plugin` / 带 token 的 `Remote`（同 `cap.mcp` 放行规则）；
`render.frame` 字段白名单校验；interactionId 防重放。

### 2.2 扩展 `cap.registry`：动态能力可声明「渲染型」

现有 `DynamicHandler` 只有 `Forward`。增加：

```jsonc
{
  "id": "cap.user.confirm",
  "summary": "向用户发起确认框",
  "handler": {
    "type": "ui-render",              // ★ 新增 handler 类型
    "target": "cap.ui.render",        // 转发到渲染能力
    "frame": { "type": "confirm" },   // 默认渲染帧（可被调用方覆盖）
    "defaults": {}
  }
}
```

即：**任意 AI/插件动态注册的 cap，forward 类型支持 `ui-render` → 调用即弹交互 UI**。
这就实现「ask、prd 可更新 cap 返回的某个参数去固定渲染」——渲染参数（frame）在 cap 注册配置里固定或由调用方传参覆盖。

### 2.3 新增：`cap.mcp` 工具注入管理面（解决「用户手动管理插件工具注入」）

`cap.mcp` 当前只有当作调用通道（`mcp_capability.rs`）。增加**管理面动作**（挂到 `cap.pluginDiscovery` 或 `cap.mcp` 均可，建议 `cap.mcp` 内聚）：

```jsonc
// 列出某插件注入 AI 的全部工具（只读诊断）
{ "action": "list_plugin_tools", "pluginId": "polaris.ask" }
→ { "pluginId": "polaris.ask", "servers": [{
     "server": "polaris-ask", "tools": ["ask_user_question", "form"],
     "injected": true, "gate": "mcpEnabled",   // 当前是否注入 + 被哪扇门挡
     "via": "builtin" | "external" | "dynamic" }] }

// 一键注入 / 移除某插件的 AI 工具（改 state.json mcpEnabled + 触发下一轮生效）
{ "action": "set_plugin_tools", "pluginId": "polaris.ask", "enabled": true }
→ { "ok": true, "effectiveFrom": "nextTurn" }
```

同时补「**per-tool 注入开关**」：`state.json` 增加 `mcpToolGates: { [mcpToolName]: boolean }`，`mcp_config_service.rs`
在注入工具前按此过滤（内置 ask/prd + 外置统一生效）。**这是「用户手动管理插件 → AI 工具」的落地。**

### 2.4 热加载补强：工具集「每 turn 内可刷新」

- 现有已满足「下一轮生效」；要满足「当前 turn 热插拔」，在 `run_chat_loop` 的 tool_call 循环前允许
  **一次额外的工具集刷新**：当检测到 `state.json` / 动态 cap 变化时，对 SimpleAI 重新 `McpClientPool` spawn +
  `tools/list` 合并新 server；对 Claude/OpenCode 属进程级固定，**维持「下一轮生效」，本轮给明确提示**（不误导）。
- 前端 `PluginTab` 的 MCP/工具开关动作后，若当前有 in-flight 会话，提示「下一条消息生效」。

### 2.5 插件热加载（补充认识）

- 前端已支持运行时注册/清理面板+卡片+引擎（`registry.ts:64-97` `replaceInstalled`）；引擎已支持 `reRegisterPluginEngines`。
- **后端插件 MCP 工具集的装载**：已在每轮 `prepare_mcp_config` 动态发现 → 装新插件的 MCP server 天然「下一轮生效」。
- 需要的补强集中在 2.3/2.4（工具注入管理 + turn 内刷新感知）。

---

## 3. 接口清单（新建/扩展）

### 后端 RouterBus 能力
| 能力 | 类型 | 动作 | 说明 |
|---|---|---|---|
| `cap.ui.render`（新） | 同步 | `request`（发起交互帧）、内部登记 `PendingPluginCard` + oneshot | 通用可交互渲染入口 |
| `cap.mcp`（扩展） | 同步 | +`list_plugin_tools` / `set_plugin_tools`（工具注入管理面） | 插件→AI 工具清单与开关 |
| `cap.registry`（扩展） | 同步 | +handler `ui-render` 类型 | 动态 cap 可声明渲染型 |
| `cap.ai.chat`（复用） | — | `respond_plugin_card`（已存在） | 唯一回填入口，不新建 |

### 类型/状态
| 位置 | 变更 |
|---|---|
| `src-tauri/src/contracts/` | 增加 `UiRenderFrame` 枚举（question/form/confirm/custom）与 answer 结构 |
| `src-tauri/src/state.rs` | `pending_plugin_cards` 复用；扩展 `PendingPluginCard` 支持 frame 类型 |
| `src-tauri/src/models/plugin_state.rs` | `state.json` +`mcpToolGates`；`plugin_state_service.rs` 读写 |
| 前端 `src/types/` | `UiRenderFrame` / answer 类型 camelCase 对齐 |

### 前端渲染
| 位置 | 变更 |
|---|---|
| `eventHandler.ts` | 消费 cap.ui.render 帧 → 映射 question/form/plugin_card 块 |
| `PluginCardHost` / `chatCardRegistry` | 增加 `custom` frame key 匹配规则 |
| `PluginTab.tsx` | 增加「AI 工具」子面板：按插件列出注入工具 + 一键开关 |

---

## 4. 验收标准

1. **cap 通用调用**：AI 或前端 `cap_dispatch("cap.ui.render", { frame:{type:"confirm"} })` → 前端弹确认卡 → 用户点确定 →
   answer 回传调用方（oneshot 返回），AI 同回合拿到结果继续。
2. **渲染参数固定**：动态注册 `cap.user.confirm`（handler.type="ui-render", frame 固定 confirm）→ 调用即渲染固定确认框；
   调用方传 `frame` 覆盖默认生效。
3. **插件工具注入管理**：`cap.mcp list_plugin_tools polaris.ask` 返回 ask_user_question/form + 注入状态；`set_plugin_tools` 关闭后
   下一轮 AI 不再见 ask 工具（SimpleAI + ClaudeCode 双语都验证）。
4. **热加载**：安装新外部插件（含 chatCards 或 mcpServers）无需重启，前端注册表/后端下一轮 MCP 集均更新；已 inline 会话给「下一条生效」提示。
5. **内置+外置统一**：ask/prd（内置）与 mimo-tts（外置）都能被 `list_plugin_tools` 列出、被统一开关控制。
6. **安全**：`cap.ui.render` 对未经授权 Remote 拒绝；frame 白名单防注入；interactionId 防重放。
7. 验证命令全绿：`cargo check`、`cargo check --no-default-features --bin polaris-web --bin polaris-mcp`、
   `pnpm exec tsc --noEmit`、`pnpm lint`、相关 vitest。

---

## 5. 实施步骤（建议顺序）

1. **P0（可交互渲染协议）**：后端 `ui_render_capability.rs` + contracts 类型 + state 复用 pending_plugin_cards/oneshot
   → 前端 eventHandler 消费 + question/form 复用渲染 → 验证 cap.ui.render 全链路。
2. **P1（动态 cap 声明渲染）**：`DynamicHandler` 增 `ui-render` 变体 + cap.registry 支持 + describe 更新。
3. **P2（工具注入管理）**：`state.json` mcpToolGates + `cap.mcp` list/set 管理面 + `mcp_config_service` 注入过滤（内置+外置统一）。
4. **P3（热加载 UX + UI）**：PluginTab「AI 工具」子面板 + in-flight 会话提示 + 工具集 turn 内刷新（SimpleAI 优先）。

---

## 6. 边界与不做（v1）

- **不改 Claude/OpenCode 的进程级 toolset 动态性**：保持「下一轮生效」语义 + 明确提示（进程级固定是引擎约束，非缺陷）。
- **不做 `cap.ui.render` 的任意 HTML 渲染**：v1 只支持 question/form/confirm 三帧 + 插件 chatCard 的 `custom` key
  （渐进内容安全）。任意 HTML/IFrame 渲染列为 v2（需沙箱）。
- **不重构 `respond_plugin_card`**：作为唯一回填入口复用，保持向后兼容。
- **不动 `cap.mcp` 现有调用语义**：只加管理面动作，不影响既有 `call`。
- **不新建「插件未安装也可调用其工具」的反向能力**：v1 的「任意插件未安装经 cap 调用」指**动态 cap 注册**（cap.registry 已支持），
  新增的只是【这些动态 cap 也能弹可交互 UI】。若还要「挂载未安装插件声明的 mcpServers 配置但不复制进程」，列 v2。

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| `cap.ui.render` 与 `respond_plugin_card` 的 pending 表合并有竞态 | 复用 ask 同款 `register_plugin_card_answer_sender` + 统一 interactionId 命名，单测覆盖并发 |
| 工具注入管理改 `mcpToolGates` 破坏现有插件状态迁移 | 向后兼容：缺省全放行（默认 true），仅显式关闭才有影响 |
| 前端 eventHandler 新增 frame 类型影响旧会话恢复 | 恢复时无 frame 的历史块回落 plugin_card 兜底渲染 |
| 交互 UI 被 Remote/AI 滥用 | `Source::Remote` 默认 deny + frame 白名单 + interactionId 防重放 + 审计 |

---

## 8. 与既有 spec 的关系

- 复用 `plans/dynamic-capability-registry.md`（cap.registry）的能力模型，仅扩展 `ui-render` handler 类型。
- 复用 `components/Chat/chatBlocks/` 的 `AskQuestionCard` / `FormCard` / `PluginCardHost` 渲染块，不重写交互组件。
- 小组件交互提交通道走 `ai_chat_core.rs:2105` `respond_plugin_card`（既有），不新开写路径。