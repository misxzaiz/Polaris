# 插件化新版 AI 对话 —— 可行性分析（不实施）

> 状态：方案分析 · 2026-10-23 · 仅评估，不实施
> 背景：深思熟虑的路线——「不直接改造现有 AI 对话，用插件实现新版对话，Phase 1 只做开启对话/继续对话，再通过 hook/插件支持工作区、模型供应商」
> 关联：`plans/session-multi-device-diagnosis.md`、`plans/session-rearchitecture/`

---

## 1. 结论先行

**插件化对话完全可行，且是现有架构下最干净的路线。** 但有一个关键约束决定方案形态：

> ⚠️ **插件面板是「自包含 React 组件」**：从插件安装目录加载磁盘 JS，只重写 `react`/`react/jsx-runtime` 的 import 指向宿主 shim。**其他依赖（`@/services`、`@/stores`、UI 库）必须由插件自带**，不能依赖宿主 `@/` 路径。

这意味着插件对话面板不能直接 `import { aiChatDispatch } from '@/services/aiChatDispatch'`，必须通过**宿主桥**（cap 总线 / MCP / window 注入）调能力。这是设计第一约束。

---

## 2. 可行性证据（已核实）

### 2.1 插件已有能力（全部在工作）

| 扩展点 | 位置 | 说明 |
|---|---|---|
| `contributes.views` | `plugin_service.rs:1628` | 插件贡献面板视图，`PluginViewContribution`（id/area/panel_type/icon） |
| `contributes.panel` | `models/plugin.rs:143` | `PluginPanelContribution.entry` = 面板入口文件 + `supports_fullscreen` |
| `contributes.engines` | 多处 | **插件可贡献 AI 引擎**（现成机制，`plugin_engine.rs`） |
| `contributes.hooks` | `hook_registry.rs:15` | `ai.session.start/end`、`ai.tool.before/after` |
| `contributes.mcp_servers` | `mcp_config_service.rs:660` | 插件带 MCP server |
| `contributes.configuration`/`config` | `models/plugin.rs:156/167` | 插件设置项 |
| `contributes.services` | `plugin_service.rs:742` | 插件服务 |
| `contributes.styles` | `models/plugin.rs:208` | 样式 |

### 2.2 插件面板渲染机制（已核实源码）

- `PluginPanelHost.tsx`：按 `panelType` 动态加载插件面板组件，Suspense + ErrorBoundary，传入 `pluginId` + `onSendToChat`
- `pluginModuleLoader.ts`：从插件安装路径读 JS → 重写 react import → Blob URL 动态 import → `entry.default`
- `panelRegistry.ts`：注册/缓存/卸载面板组件

**含义**：插件面板是**活的 React 组件**，可渲染输入框/消息流/设置表单，可持有本地 state、调 cap 能力。

### 2.3 现有 AI 会话链路（拟绕过的历史包袱）

| 文件 | 规模 | 问题 |
|---|---|---|
| `createConversationStore.ts` | 2660 行 | 生命周期全塞入（messages/progress/attachment/notification/running） |
| `eventHandler.ts` | 1186 行 | 30+ 事件类型，修复式补丁堆叠（toolCallDedup、dedupMessages、id 漂移指纹） |
| `sessionStoreManager.ts` | 955 行 | 单一 activeSessionId 全局态 |
| S1-S5 跨端同步 | 已回滚 | 多设备方案做过又推翻 |

**插件对话绕过这一切**，自建轻量会话层（发消息 + 收流式 + 持久化），不碰现有 store。

---

## 3. 插件对话架构草案

### 3.1 宿主桥（Plugin-Bridge，核心新机制）

插件面板无法直接 `@/` import，需要一个**宿主注入的桥**。两种形态：

**形态 1：`window.__POLARIS_HOST__` 注入（推荐，零后端改动）**

```ts
// 宿主在 app 初始化时挂到 window
window.__POLARIS_HOST_BRIDGE__ = {
  // 发送消息（走现成 cap.ai.chat，别碰 createConversationStore）
  sendChat: async (req) => { /* invoke aiChatDispatch → turn_persist */ },
  // 订阅流式事件（按 plugin-sessionId 路由，不自污染现有会话路由）
  subscribeStream: (sessionId, cb) => { /* 监听 chat-event，过滤 plugin 命名空间 */ },
  // 持久化（插件自建会话文件 / 走 cap.kv）
  persist: {...},
  // 配置（模型/供应商/工作区）
  config: {...},
}
```

**形态 2：插件自带 MCP server + cap 总线**（复用现成机制，但每轮对话走 MCP RPC 开销大）

> 建议 Phase 1 用形态 1（window 桥），把 AI 对话数据平面走现有 `cap.ai.chat` + `cap.kv`，插件面板只管 UI。

### 3.2 插件自带的对话数据模型（Phase 1 最小）

```
命名空间：plugin-chat/<pluginId>/<sessionId>
存储：cap.kv（现成能力，跨端同步可用）
字段：
  id, title, messages[], engineId, modelProvider, workspaceId, createdAt, updatedAt
```

- **发消息**：桥.sendChat({ pluginSessionId, text }) → 宿主转 `cap.ai.chat`（借现有引擎执行）→ 事件回 `chat-event`，按自定义命名空间路由回插件面板
- **继续对话**：恢复会话 = 读 cap.kv → 重建消息上下文 → 再次 sendChat
- **流式渲染**：面板内 state 拼装 token/thinking/tool_call（自建轻量 reducer，或复用 `eventHandler` 概念但只保留增量拼装部分）

### 3.3 挂载点

- **方式 A**：`contributes.views` + `contributes.panel` → 插件面板出现在侧栏/独立标签页（最自然，现成机制）
- **方式 B**：`cap.ui.render` 注册模板 → 插件卡片渲染（但卡片非完整对话 UI，不推荐做聊天主界面）
- **方式 C**：独立标签页/工作区视图（若 `area` 支持 `"tab"`，可全屏对话界面）

### 3.4 设置工作区/模型供应商（通过 hook/插件，是否可行？）

查证结果：
- **`contributes.configuration`** ✓ 插件设置项（可在设置页渲染表单）
- **`cap.config`** ✓ 能读写配置（provider、model、workspace 相关）
- **`contributes.hooks`** 目前只有 `ai.session.start/end`、`ai.tool.before/after` —— **没有「对话消息发送前」钩子**，但 Phase 1 对话由插件面板自行调 `sendChat` 时带上工作区/模型参数即可，无需新钩子
- **`cap.ui.input`** 能调输入区（AI 控制即时调节）

**结论**：工作区/模型供应商的设置**不需要新 hook**——插件面板自己就是设置表单（读 `cap.config`），发送时参数随请求带。hook 扩展点（如 `ai.session.start`）可作为"发送前注入系统提示词/上下文"的进阶机制。

---

## 4. 方案优势

| 维度 | 插件化 | 直接改造现有 |
|---|---|---|
| 风险 | 低（不碰现有 store，失败可卸载） | 高（触碰 2660+1186 行巨文件，S1-S5 先例） |
| 迭代速度 | 快（插件独立演化） | 慢（需回归整个会话生态） |
| 多设备 | 可顺带实现（cap.kv 跨端） | 需重做 S1-S5 |
| 与生态契合 | 「核心可替换、一切皆插件」理念 | 修老架构 |
| 复杂度 | 中（需建宿主桥） | 高 |

## 5. 风险与边界

1. **插件 self-contained 约束**：插件 JS 只能依赖自带依赖 + window 桥。UI 组件库（lucide 等）需插件自带或桥注入。
2. **双会话体系并存**：插件对话是"第二套会话"，与现有历史会话生态（dialog_index 搜索、历史侧栏）不互通。Phase 1 可接受，后续可桥接。
3. **引擎复用**：借 `cap.ai.chat` 现有引擎（claude-code/simpleai/pi/opencode）执行，**不改引擎**——这是最大复用点。
4. **跨端**：cap.kv 已跨端同步，插件会话天然可多设备；但"实时流式跨端"仍需 `chat-event` 广播方向改造（属第二期）。
5. **React 版本/依赖冲突**：插件面板若带 React 生态依赖（如 react-hook-form），会与宿主重复打包；建议宿主桥暴露常用 hooks（useState 已 shim，但其他需注入）。

---

## 6. Phase 建议（不实施，供后续决策）

**Phase 0（本次分析）**：已确认插件面板是自包含 React 组件；确认 `onSendToChat` 只能发到现有聊天、插件需走宿主桥才能自立。✅ 完成

**Phase 1（MVP：开启对话 + 继续对话）**
- 宿主加最小 `window.__POLARIS_HOST_BRIDGE__`（sendChat / subscribeStream / kv 持久化）
- 插件对话面板（UI：输入框 + 消息流 + 会话列表）
- 发消息走 `cap.ai.chat`（复用引擎），流式回渲染
- 会话存 cap.kv，恢复 = 续聊

**Phase 2（工作区 / 模型供应商 / 设置）**
- 插件面板内设置表单（读 `cap.config` 写配置）
- `contributes.configuration` 注册设置项展示
- 发送参数带 workspaceId / modelProvider / model

**Phase 3（进阶）**
- `contributes.hooks` 扩展「对话发送前」钩子（注入上下文/系统提示词）
- 历史与会话索引桥接现有 dialog_index（可选）
- 跨端实时流式（可选，依赖广播改造）

---

## 7. 待确认问题

1. **`window.__POLARIS_HOST_BRIDGE__` 这种宿主桥**是否接受？桥的生命周期随主前端，插件面板须用尽力而为方式调用（面板可能的加载时机与桥初始化竞态）。
2. **插件对话数据放哪**？cap.kv（跨端同步）vs 自带 JSONL（插件独立数据根）。Phase 1 建议 cap.kv。
3. **对话 UI 形态**？侧栏面板（views+panel）vs 独立标签页。若 `area` 支持 `tab` 更接近"新版对话界面"。
4. **是否仍要接现有引擎的事件类型**（AIEvent 30+ 类型），还是插件面板自建简化协议（自定义 event 子集）？建议后者——只在插件会话内定义管子协议。