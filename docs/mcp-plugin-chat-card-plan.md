# MCP 插件自定义聊天卡片 — 实施计划

> 允许 MCP 插件按 `mcp__{server}__{tool}` 匹配后，由插件自定义渲染工具调用结果，
> 支持内置与外部安装插件。复用插件面板的 React 动态加载机制与 ask 的同回合交互通道。

## 总体目标

让插件不仅能贡献 MCP 工具与左侧面板，还能**自定义 MCP 工具结果在聊天流中的渲染**。

- **适用范围**：内置插件 + 外部安装插件（user/project scope）
- **渲染位置**：独立卡片（工具调用卡之后追加，双卡并存）
- **交互深度**：两种模式
  - `result`（展示型）：消费 tool result，纯展示 + 可选 `onSendToChat`
  - `interaction`（交互型）：插件 MCP server 经伴生通道请求同回合用户输入，卡片提交后回填 tool_result 给 AI（复用 ask 通道）
- **安全约束**：manifest `chatCards[].mcpServerId` 必须属于本插件声明的 `mcpServers`，防止插件劫持内置工具或其他插件的渲染（discovery 与 registry 双侧校验）
- **降级**：插件禁用/卸载/加载失败 → 兜底渲染（工具名 + JSON 折叠），不报错
- **超时**：interaction 模式默认 3 分钟无应答自动 declined

## 架构基础

1. **三引擎共享 MCP 解析**：`ResolvedExternalMcpServer`（`mcp_config_service.rs`）同时供 Claude CLI（`.mcp.json`）、Codex（`-c` 参数）、SimpleAI（`McpClientPool`）消费，模板展开集中在 `expand_external_mcp_template`。一处新增模板变量，三引擎同时生效。
2. **ask 交互通道可泛化**：宿主 `spawn_ask_listener` 绑定 `127.0.0.1:0` + UUID token，伴生进程经 `--polaris-port/--polaris-token` 连回，长度前缀 JSON 帧 + `pending_questions` + oneshot 回填。
3. **插件 React 组件动态加载已打通**：`loadModuleFromFile`（readFile → React shim → Blob import）+ `panelRegistry` 懒加载/缓存/按插件清理。已提炼为 `pluginModuleLoader.ts` 共享。
4. **前端 block 体系有完整先例**：per-block ErrorBoundary、blocks 全量 JSONL 持久化、`appendQuestionBlock`/`appendArtifactPreviewBlock` 先例。

---

## 已实施内容

### Phase 1 — 展示型卡片框架（纯前端，Rust 零改动）✅

**提交**：`73dbab6b`

| 文件 | 改动 |
|---|---|
| `src/plugin-system/types.ts` | 新增 `PluginChatCardContribution`、`PluginChatCardProps`、`PluginChatCardComponent`、`PluginChatCardLoader`、`PluginChatCardMode`、`PluginChatCardStatus`；manifest `contributes.chatCards` |
| `src/plugin-system/pluginModuleLoader.ts`（新增） | 提炼 `loadModuleFromFile` + `resolvePluginEntryPath` 为 panel/card 共享 |
| `src/plugin-system/chatCardRegistry.ts`（新增） | 按 `mcp__{server}__{tool}` 匹配、懒加载缓存、按插件卸载、`registerBuiltin` |
| `src/plugin-system/registry.ts` | 接入 chatCards 自动注册（含 mcpServerId 归属保底校验）、`replaceInstalled` 清理、`listChatCardContributions` |
| `src/services/pluginDiscoveryService.ts` | `normalizeChatCards` + mcpServerId 归属校验（防劫持） |
| `src/types/chat.ts` | `PluginCardBlock` + 联合类型 + `isPluginCardBlock` 守卫 |
| `src/stores/conversationStore/types.ts` | `pluginCardBlockMap` 状态 + `appendPluginCardBlock`/`updatePluginCardBlock` 签名 |
| `src/stores/conversationStore/createConversationStore.ts` | append/update 实现 + 初始化/重置 map + 历史恢复 pending→declined |
| `src/stores/conversationStore/eventHandler.ts` | `tool_call_end` 中按注册表匹配 result 模式追加卡片；`parseCardData`（structuredContent 优先） |
| `src/components/Chat/chatBlocks/PluginCardHost.tsx`（新增） | 懒加载 + Suspense + 加载失败/未命中双兜底 + ErrorBoundary |
| `src/components/Chat/chatBlocks/index.tsx` | `plugin_card` case 路由 |
| `src/utils/messageCompactor.ts` | 注释更新（plugin_card 不压缩） |
| `src/plugin-system/index.ts` | 导出新成员 |

**数据流（result 模式）**：

```
tool_call_end 事件
  → eventHandler: chatCardRegistry.match(event.tool) 命中且 mode=result
  → parseCardData(event.result)（structuredContent 优先 → fenced json → JSON.parse → 原值兜底）
  → appendPluginCardBlock({ status:'ready', data })
  → PluginCardHost 懒加载插件组件渲染（工具调用卡照常渲染，双卡并存）
```

### Phase 2 — PRD 预览迁移（验收用例）✅

**提交**：`73dbab6b`

| 文件 | 改动 |
|---|---|
| `src/plugins/prd-preview/manifest.ts` | 声明 `chatCards`（tools: `preview_html`, `read_preview`，mode: `result`） |
| `src/plugins/prd-preview/PrdPreviewCard.tsx`（新增） | 薄适配层：从 `data`（structuredContent = PreviewArtifact 对象）提取字段 → 复用 `ArtifactPreviewRenderer` 完整 UI |
| `src/plugin-system/builtinPlugins.ts` | 手动注册内置卡片 loader（无 installPath） |
| `src/stores/conversationStore/eventHandler.ts` | **删除 `parseArtifactPreview` 嗅探** + `optionalString` + `ArtifactPreviewBlock` import |

**保留**：`artifact_preview` block 类型与 `ArtifactPreviewRenderer` 渲染 case 保留——旧会话 JSONL 里的历史消息恢复时仍可渲染，只停新生成。Rust `prd_preview_mcp_server.rs` 不改（payload 照旧，匹配方式从嗅探 `artifactType` 标记变为按工具名）。

---

## 后续实施计划

### Phase 3 — 交互型通道（Rust + 前端回填）⏳

**目标**：让 `mode: interaction` 的卡片能完成"渲染 → 用户操作 → 回填 tool_result 给 AI 同回合继续"。

#### 3.1 Rust 后端

| 位置 | 改动 |
|---|---|
| `src-tauri/src/services/ask_listener.rs`（或提炼 `interaction_hub.rs`） | `handle_connection` 帧类型 match 增加 `"card"` / `"card_cancel"` 分支；`pending_plugin_cards` 状态 + oneshot（payload 透传）；**3 分钟超时** tokio task，超时自动按 declined 回填 |
| `src-tauri/src/state.rs` | `pending_plugin_cards` 容器 + `register_card_answer_sender` / `take_card_answer_sender`（仿 `pending_questions`） |
| `src-tauri/src/models/ai_event.rs` | `PluginCardEvent`（emit 给前端，Tauri emit + WebSocket broadcast 双通道，仿 question 事件） |
| `src-tauri/src/commands/chat.rs` + web 路由 | `respond_plugin_card` command + HTTP 端点（仿 `answer_question`，Tauri command + `/api/chat/respond-plugin-card` 双通道，web 模式兼容） |
| `src-tauri/src/services/mcp_config_service.rs` | `expand_external_mcp_template` 增加 `{{polarisPort}}` / `{{polarisToken}}`（可选 `{{sessionId}}`）模板变量 |

**帧协议扩展**（与 ask 共存，复用同一端口/token）：

```
card 帧（client → server）:
  { "type":"card", "token":"<uuid>", "sessionId":"...", "callId":"...",
    "pluginId":"...", "cardId":"...", "payload": <任意 JSON> }

card_answer 帧（server → client）:
  { "type":"card_answer", "declined": bool, "result": <任意 JSON> }

card_cancel 帧（client → server）— CLI 发 notifications/cancelled 时
```

**端口/token 分发**：插件在 argsTemplate 里自行声明，如 `["{{pluginDir}}/mcp/server.js", "--polaris-port={{polarisPort}}", "--polaris-token={{polarisToken}}"]`。一处改动，三引擎生效。

**验证方式**：`cargo check --lib`（本机 `cargo test --lib` 受 Tauri 原生 DLL 限制无法启动）+ 帧解析纯函数单测。

#### 3.2 前端

| 位置 | 改动 |
|---|---|
| `src/ai-runtime/event.ts` | `PluginCardEvent` 类型（与 Rust `PluginCardEvent` 对齐） |
| `src/stores/conversationStore/eventHandler.ts` | 处理 `plugin_card` 事件 → `appendPluginCardBlock({ mode:'interaction', status:'pending', data:payload, sessionId })`；处理 `plugin_card_answered` → `updatePluginCardBlock` |
| `src/services/tauri/chatService.ts` + `transport/httpTransport.ts` | `respondPluginCard(interactionId, result)` 封装（Tauri command + HTTP 端点） |
| `src/components/Chat/chatBlocks/PluginCardHost.tsx` | interaction 且 `status==='pending'` 时注入 `respond` 回调（调用 `respondPluginCard`，成功后本地 update 状态） |

**数据流（interaction 模式）**：

```
插件 MCP server 收到 tool call
  → TCP 连宿主（端口/token 来自 argsTemplate 新模板变量）
  → 发 card 帧
  → 宿主 interaction hub: 注册 pending + oneshot + 3min 超时 task → emit plugin_card chat-event
  → 前端 appendPluginCardBlock({ mode:'interaction', status:'pending', data:payload })
  → 用户在插件卡片内操作 → respond(result)
  → invoke('respond_plugin_card', { interactionId, result })
  → oneshot 回填 → 宿主写 card_answer 帧 → 插件 MCP server 返回 tool_result → AI 同回合继续
  → 前端 updatePluginCardBlock({ status:'answered', response:result })

超时/cancel 路径：
  → 3min 超时 / card_cancel 帧 / oneshot drop → 按 declined 回填 → block 置 declined
```

### Phase 4 — 示例插件与文档 ⏳

| 位置 | 改动 |
|---|---|
| `examples/plugins/demo-mcp-plugin` | node MCP server 增加交互工具（TCP `card`/`card_answer` 帧协议参考实现）+ `cards/demo-card.js` 组件 |
| `docs/mcp/` | 增补：chatCards 贡献点、PluginChatCardProps 契约、帧协议、`{{polarisPort}}` 变量、大 payload 约定、3 分钟超时说明 |
| `@polaris/plugin-sdk`（可选） | TS 类型声明包，含 props/帧协议类型，供外部插件开发 |

---

## 设计决策记录

1. **双卡并存**（默认）：工具调用卡 + 插件卡片同时追加。可选的 `hideToolCall`（插件声明后折叠默认工具卡）列为 Phase 1 之后的优化项。
2. **超时**：interaction 模式默认 3 分钟无应答自动 declined，由宿主强制兜底（插件 MCP server 可自行实现更短超时）。
3. **匹配方式**：按工具名声明式匹配（manifest `chatCards[].tools`）。按 payload 标记匹配（现 `artifactType` 嗅探的泛化）作为后置进阶。
4. **组件形态**：React 组件（复用 panel 同款 loader，安全模型一致——本地安装即信任）。声明式 JSON 模板与 sandbox iframe 作为补充后置。
5. **大 payload**：`plugin_card.data` 全量进 JSONL 与内存。约定 data 建议 <64KB，大内容传文件路径由组件按需读取。Phase 1 不参与 messageCompactor 压缩，data 纳入压缩列为后续优化。
6. **信任模型**：外部插件卡片 JS 在宿主上下文运行，与 panel 同级。缓解：仅卡片进入视口才懒加载 + fallback 优先。
7. **Web/移动端**：事件双通道、HTTP command、readFile 走后端文件 API 均有先例，外部插件卡片支持度与 panel 完全一致。

## 风险与约束

- **interaction 阻塞回合**：与 ask 一致，挂起期间 AI 等待；超时策略由宿主兜底（3 分钟）+ 插件自决。
- **token 落盘**：`{{polarisToken}}` 写入 workspace 配置，本地信任模型，与 ask 现状一致；per-plugin token 列为后续强化项。
- **Rust 测试限制**：本机 `cargo test --lib` 无法启动（Tauri 原生 DLL），用 `cargo check --lib` 验证编译 + 帧解析纯函数单测。

## 提交记录

| Phase | 提交 hash | 说明 |
|---|---|---|
| Phase 1 + 2 | `73dbab6b` | 展示型卡片框架 + PRD 预览迁移 |
| Phase 3 | _待实施_ | 交互型通道（Rust + 前端回填） |
| Phase 4 | _待实施_ | 示例插件与文档 |
