# 任务派发插件化改造：活动栏面板 + MCP 控制 + 设置迁移

> 状态：📋 规划中（未实施）
> 日期：2026-09-27
> 目标：把"任务派发"从「设置-通用」中迁出，以内置插件形态提供
>       （① 活动栏面板查看/管理任务与队员预设 ② MCP 全量可控 ③ 移除设置面板项）。
> 关联现状：`docs/dispatch-phase2-plan.md`（P0-P3 已实施，派发闭环成型）。

---

## 1. 背景

派发功能（dispatch_task MCP → 后台静默会话执行）已完整可用，但**管理入口割裂**：

- 任务列表只有一个 **340px 状态栏弹窗**（DispatchCenter），无活动栏常驻面板；
- 派发策略 / 结果注入 / 队员预设等配置埋在 **设置-通用**（DispatchSettingsSection）；
- MCP 侧能"派发/查询/续派"，但 **读不到、改不了** 策略/预设/开关配置；
- 对任务的 **中断/删除/重派** 没有 MCP 工具，AI 只能操作 派发/查询/续派。

产品诉求：以 **mcp 面板形式** 统一承载（活动栏面板 = 任务情况 + 配置管理），
支持 MCP 控制，并 **移除设置面板里的派发设置**。

---

## 2. 现状盘点（2026-09-27 核实）

### 2.1 已插件化的部分

| 模块 | 现状 | 位置 |
|---|---|---|
| 内置插件声明 | `polaris.dispatch`，**只声明了 mcpServers**，无 views/panel/configSchema | `src/plugins/dispatch/manifest.ts` |
| MCP server | stdio → TCP 回连主进程，12 工具（dispatch/check/continue/roster/find_expert/save|delete|list_agent/save_roster/cap_dispatch/cap_list/list_dispatch_targets） | `src-tauri/src/services/dispatch_mcp_server.rs` |
| 任务注册表 | 后端持久化（`<config_dir>/dispatch_tasks.json`，上限 100 条），启动加载、终态标记 | `src-tauri/src/state.rs`（`dispatched_tasks`） |
| 前端执行链路 | `dispatch-task-request` 事件 → 创建静默会话 → start_chat → 状态回报 | `src/services/dispatchTaskService.ts` |
| 实时状态层 | dispatchStore（tasks + pendingReports 队列） | `src/stores/dispatchStore.ts` |
| 聊天卡片 | DispatchTaskCard 三态卡片（打开会话/中断/追加指令/让 AI 处理结果） | `src/components/Chat/dispatch/DispatchTaskCard.tsx` |

### 2.2 未插件化的部分（本次改造对象）

| 模块 | 现状 | 位置 |
|---|---|---|
| 任务查看 | 状态栏火箭按钮 + 340px 弹出层（非活动栏面板） | `src/components/Chat/dispatch/DispatchCenter.tsx` |
| 配置管理 UI | 设置-通用 内联区块：policy / autoInjectReports / presets CRUD | `src/components/Settings/tabs/DispatchSettingsSection.tsx`、`GeneralTab.tsx:68` |
| 配置存储 | `config.json → dispatch` 段（Rust `DispatchConfig`，后端 `register_dispatch_task` 直接读它解析 role/provider） | `src-tauri/src/models/config.rs:1294`、`ask_listener.rs:1001` |
| MCP 配置读写 | **无**。cap.config 白名单没有 dispatch 段；dispatch MCP 无配置工具 | `src-tauri/src/services/router/config_capability.rs:109` |

### 2.3 关键事实

1. **已有插件面板范式**：scheduler / todo 均为"后端命令 + 面板组件全内置主仓库，manifest 只声明 views+mcpServers"——本改造沿用同一范式，**不需要把代码搬到插件安装目录**。
2. **面板注册机制现成**：`builtinPlugins.ts` 内 `pluginPanelRegistry.register('scheduler', ...)` 模式；`contributes.views` 声明 activityBar 入口，`panelType` 即 `LeftPanelType`。
3. **双轨配置存储**：`config.dispatch`（全局配置段，后端直读）与 `plugins[polaris.dispatch]`（插件命名空间，`plugin_get/set_config` 读写）是**两套存储**。迁移方向是本次最大决策点（§4.5）。
4. **消费方耦合**：`AgentGalleryPanel` 按 roster + dispatchId 从 `useDispatchStore.getState().getTask()` 取任务视图；`DispatchTaskCard` 订阅单任务。**dispatchStore 数据契约不能动**。
5. **cap.config 白名单**：目前只有 core/performance/web/permissions 四段，`dispatch` 段不在其中 → AI 经 `cap_dispatch → cap.config` 无法读写派发配置。

---

## 3. 目标形态

```
┌─ 活动栏 ──────────────┐
│  🚀 任务派发(新入口)    │  ← manifest views 声明，图标复用 Rocket 心智
├──────────────────────┤
│  DispatchPanel        │  ← 懒加载面板组件（builtinPlugins 注册）
│  ┌ 任务列表（实时+历史）│  ← 复用 DispatchCenter 数据源/渲染逻辑
│  ├ 派发策略 / 结果注入 │  ← 从设置迁移
│  └ 队员预设 CRUD       │  ← 从设置迁移
└──────────────────────┘

MCP（polaris-dispatch 扩展）：
  dispatch_task / check / continue          已有
  list_dispatch_targets                     已有（只读）
  get/set_dispatch_config  （新增）          策略/注入开关/预设读写
  dispatch_interrupt / dispatch_delete（新增，可选）任务操作
```

---

## 4. 方案设计

### 4.1 manifest 扩展（`src/plugins/dispatch/manifest.ts`）

```ts
contributes: {
  mcpServers: [...],            // 保留
  views: [{
    id: 'dispatch.panel',
    area: 'activityBar',
    panelType: 'dispatch',
    icon: 'Rocket',             // 若 icon 集合无 Rocket 则用现有枚举（如 ClipboardList）
    labelKey: 'labels.dispatchPanel',
    labelDefault: 'Dispatch',
    order: 45,                  // 建议插在 scheduler(50) 之前
  }],
}
```

配套：
- `src/plugin-system/builtinPlugins.ts`：`pluginPanelRegistry.register('dispatch', 'polaris.dispatch', () => import('@/components/Dispatch/DispatchPanel'))`；
- `src/plugin-system/icons.ts`：确认 icon 枚举（`PluginIconId` 无 Rocket，需新增或复用现有 `ClipboardList`）；
- i18n：`src/locales/*/settings.json` 或 chat.json 增加 `labels.dispatchPanel`。

### 4.2 面板组件（新建 `src/components/Dispatch/DispatchPanel.tsx`）

三段式布局（参考 SchedulerPanel 的左栏/主区结构）：

1. **任务列表**（主体）：复制 `DispatchCenter.tsx` 的记录渲染逻辑
   - 数据源：`invoke('dispatch_list_tasks')` 后端持久化记录 + `useDispatchStore` 实时合并；
   - 操作：打开会话 / 中断 / 重新派发 / 删除记录（逻辑原样复用，抽出为面板内部函数）；
   - 空态：`/dispatch` 引导。
2. **派发策略 + 结果注入**（顶部设置区）：从 `DispatchSettingsSection` 迁移
   - policy select（auto/ask）、autoInjectReports 开关，继续写 `config.dispatch`（若走方案 B，§4.5）；
   - 通过现有 `configStore`/`onConfigChange` 通道或 `configDispatchService` 读写。
3. **队员预设 CRUD**（底部）：`DispatchSettingsSection` 现有表单原样迁移。

共享 UI 辅助：状态徽标样式（STATUS_STYLES）、formatTime、`EngineOption` 列表均可内聚或抽取。

### 4.3 移除设置面板项

- `src/components/Settings/tabs/GeneralTab.tsx`：删除 `<DispatchSettingsSection>` 引用（:68）；
- `src/components/Settings/tabs/DispatchSettingsSection.tsx`：删除文件（逻辑已迁入 DispatchPanel）或保留为面板引用的共享组件；
- i18n：`src/locales/*/settings.json` 的 `dispatch.*` 段迁移到面板所在命名空间（chat.json 的 dispatch.* 保留，卡片/中心仍在用）。

### 4.4 MCP 控制增强（`dispatch_mcp_server.rs` + `ask_listener.rs` 帧协议）

新增 2~3 个工具，走现有"TCP 帧 → ask_listener 处理 → 回包"通道：

| 工具 | 作用 | 实现要点 |
|---|---|---|
| `get_dispatch_config` | 返回 { policy, autoInjectReports, presets } | 帧 `dispatch_config_get`，listener 读 config 返回（presets 含引擎/模型但不含密钥——本无密钥） |
| `set_dispatch_config` | patch { policy?, autoInjectReports?, presets? } | 帧 `dispatch_config_set`，listener 校验 + 写 config（复用 `update_config_patch` 副作用链） |
| `dispatch_delete_task`（可选） | 删除历史记录 | 帧 `dispatch_delete`，listener 调 `delete_dispatched_task` |
| `dispatch_interrupt`（可选） | 中断执行中任务 | 依赖 conversationId + 引擎 interrupt，与前端 `interruptDispatchedTask` 同路径 |

> 备选（更省）：把 `dispatch` 段加进 `cap.config` 白名单（config_capability.rs），AI 直接 `cap_dispatch → cap.config patch` 读写。
> 权衡见 §4.5 决策。

### 4.5 配置存储双轨 —— 核心决策点

| | 方案 A：迁移到插件命名空间 | 方案 B：保留 config.dispatch（推荐起步） |
|---|---|---|
| 面板写配置 | `setPluginConfig('polaris.dispatch', ...)` | 现有 `update_config_patch` / `configDispatchService` |
| 后端读取 | `register_dispatch_task` 改读 `plugins[polaris.dispatch]` | **零改动**（继续读 config.dispatch） |
| MCP 可控 | 需新工具（插件命名空间不在 cap.config 域） | 新工具 或 cap.config 白名单加段 |
| 数据迁移 | 需要 config.dispatch → plugins[...] 一次性迁移 + 旧段兜底读取 | 不需要 |
| 回归面 | 大（preset 解析、重派参数还原、跨设备同步） | 小 |

**建议：方案 B 起步（平滑、后端零改动、兼容所有既有行为）；方案 A 作为中期目标**
（届时后端读取 + MCP 工具 + 面板读写统一指向插件命名空间，配置真正"插件化"）。

### 4.6 状态栏入口去留

- 选项 1（推荐）：**保留** DispatchCenterButton 作为快捷浮层（与面板并存，互不冲突）；
- 选项 2：移除按钮，仅活动栏入口（面板化后弹窗冗余）；
- 选项 3：按钮改为"跳转活动栏面板"（点击直接 `switchToLeftPanel('dispatch')`）。

### 4.7 面板内新交互（可选增强）

- 面板内直接派发：输入框 + `/dispatch` 语法（复用 `parseDispatchSlashCommand` + `dispatchFromUser`）；
- 完成 Toast 保留（session_end 现有机制，与面板无关）。

---

## 5. 文件级改动清单

### 前端
| 文件 | 改动 |
|---|---|
| `src/plugins/dispatch/manifest.ts` | + views 声明 |
| `src/plugin-system/builtinPlugins.ts` | + panel 懒加载注册 |
| `src/plugin-system/icons.ts` | + icon 枚举（如 Rocket）或复用现有 |
| `src/components/Dispatch/DispatchPanel.tsx` | **新建**：任务列表 + 设置区 + 预设 CRUD |
| `src/components/Settings/tabs/GeneralTab.tsx` | 移除 DispatchSettingsSection 引用 |
| `src/components/Settings/tabs/DispatchSettingsSection.tsx` | 删除（逻辑迁入面板）或转为共享 |
| `src/components/Chat/dispatch/DispatchCenter.tsx` | 视决策：保留 / 移除 / 改跳转 |
| `src/services/dispatchTaskService.ts` | 按需：新增 interrupt/delete MCP 桥接（可选） |
| `src/locales/*/settings.json` / `chat.json` | i18n 迁移与新增 |

### 后端
| 文件 | 改动 |
|---|---|
| `src-tauri/src/services/dispatch_mcp_server.rs` | + 新工具 schema + 帧构造 |
| `src-tauri/src/services/ask_listener.rs` | + 帧处理（config get/set、可选 delete/interrupt） |
| `src-tauri/src/services/router/config_capability.rs` | 若走 cap.config 路线：+ dispatch 段白名单 |
| `src-tauri/src/models/config.rs` | 若走方案 A：读取源调整 + 迁移 |

---

## 6. 影响面与回归风险

| 维度 | 风险点 | 对策 |
|---|---|---|
| dispatchStore 契约 | AgentGalleryPanel / DispatchTaskCard 依赖 tasks Map 结构 | 面板只读不改契约；**禁止改 store 字段** |
| 配置读写 | 面板迁移后必须与后端 preset 解析一致（role 匹配/权限模式） | 复用原 DispatchSettingsSection 校验逻辑，保存路径不变（方案 B） |
| i18n | settings.json dispatch.* 移除会影响其它引用（无） | 全局搜索 `dispatch.` key 确认引用面后再删 |
| 双入口 | 状态栏 + 活动栏并存 → 视觉冗余 | §4.6 决策后统一 |
| MCP 帧协议 | 新增帧需与 `MAX_FRAME_SIZE`、token 校验一致 | 沿用 `request_via_tcp` 通道，错误走 isError 返回 |
| 插件开关 | 插件被用户关闭时面板与 MCP 应同时消失 | 沿用现有 `isPluginUiEnabled` 门（manifest views 自动受控） |

---

## 7. 实施步骤（建议顺序，实施前复核）

1. **M1 面板骨架**：manifest views + builtinPlugins 注册 + 新建 DispatchPanel（先只放任务列表，复用 DispatchCenter 逻辑）→ 验证活动栏可开合、列表/操作可用。
2. **M2 设置迁移**：把 DispatchSettingsSection 三段迁入面板 → 移除 GeneralTab 引用与旧组件 → i18n 迁移 → 验证策略/开关/预设保存后派发行为不变。
3. **M3 MCP 配置工具**：get/set_dispatch_config（或 cap.config 白名单加段）→ 冒烟：AI 会话经 MCP 改策略/预设，立即生效。
4. **M4（可选）MCP 任务操作**：dispatch_interrupt / dispatch_delete。
5. **M5 收尾**：状态栏入口决策落地、双入口体验统一、回归清单执行。

---

## 8. 验收标准

1. 设置-通用 中不再出现"任务派发"区块；
2. 活动栏出现"任务派发"入口，面板显示：实时任务（状态/动态/操作）+ 历史记录（摘要/重派/删除）；
3. 面板内策略、注入开关、队员预设 CRUD 保存后，`/dispatch @角色` 与 AI `dispatch_task(role=...)` 行为不变；
4. AI 经 MCP 可读/写派发配置（新工具或 cap.config），变更立即生效且与面板 UI 一致；
5. `polaris.dispatch` 插件在设置页关闭后，活动栏入口消失（MCP 随之不注入）；
6. AgentGalleryPanel 专家团 pipeline 视图、DispatchTaskCard、结果回流三件套无回归；
7. 既有测试全绿（dispatchTaskService、plugin-system registry、conversationStore 等），新增面板/MCP 工具单测。

---

## 9. 开放决策（需拍板，不阻塞 M1）

1. **配置存储**：方案 B（保留 config.dispatch，推荐）还是方案 A（迁插件命名空间）？
2. **状态栏按钮**：保留快捷浮层 / 移除 / 改为跳转面板？
3. **MCP 范围**：只做配置读写（get/set），还是连任务操作（interrupt/delete）一起做？
4. **面板内派发**：是否加"面板直接输入派发"交互（超出最小诉求，可选）？
