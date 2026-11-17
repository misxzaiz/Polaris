# W3 域出仓 spec（Workspace / Developer / Notification / FocusMode / UiFrame）

> 目标：宿主 `src/components/` 五个域迁出到插件仓，前端净减 ~4.4k 行。
> 沿用 W2（settings-desk）范式：插件面板经 `__POLARIS_APP_CORE__` 桥取宿主 store/service 单例；桌面 IPC 通道验证；四门禁全绿；可回退。

## 1. 现状勘探结论（2026-11-17）

| 域 | 文件 | 行数 | 消费方 | 去向 |
|---|---|---|---|---|
| Workspace | CreateWorkspaceModal(419)/WorkspaceQuickSwitch(295)/WorkspaceSearchInput(129)/WorkspaceSelector(234)/index(7) | 1,084 | App.tsx（CreateWorkspaceModal）；TopMenuBar（WorkspaceQuickSwitch）；appCoreBridge（WorkspaceSearchInput/useWorkspaceFilter/CreateWorkspaceModal → workspace-manager 插件桥面） | **删除 WorkspaceSelector（死代码，仅 index barrel 导出无消费者）**；其余迁 workspace-manager 插件 |
| Developer | DeveloperPanel(519)/index(6) | 525 | App.tsx developerContent → LeftPanel builtinPanels['developer'] | 迁 dev-desk 新插件；宿主 builtinPanels['developer'] 改 PluginPanelHost 兜底 |
| Notification | NotificationCenterPanel(164)/NotificationBell(40)/index(6) | 210 | App.tsx overlay | 迁 notification-desk 新插件；NotificationBell 消费 toastStore 留核 |
| FocusMode | FocusOverlay(106) | 106 | App.tsx、useWindowManager（快捷键 toggle）、focusModeStore(119) | FocusOverlay 迁 focus-desk 插件（或并入现有插件）；focusModeStore 留核（useWindowManager 消费） |
| UiFrame | UiFrameCard(588)/uiTemplateNodes(259)/chartNodeView(243)/test(106) | 1,196 | chatCardRegistry.registerBuiltinExact('ui.render')；uiFrameTypes(166, plugin-system) 留核 | **暂缓**（内置 cap 帧渲染器，属 plugin-system 内置插件面；W3 不动，登记后续评估） |

## 2. 各域方案

### 2.1 Workspace → workspace-manager 插件（已有插件）

- **删除死代码**：`WorkspaceSelector.tsx`（234 行，无消费者）。
- **CreateWorkspaceModal / WorkspaceSearchInput / useWorkspaceFilter / WorkspaceQuickSwitch** 迁入 `plugins/workspace-manager/src/host/`，deps.ts 走 appCoreBridge（Button/Icons/useWorkspaceStore/useViewStore/pluginPanelRegistry/fsDispatch…）。
- appCoreBridge 的 components 桥面（WorkspaceSearchInput/useWorkspaceFilter/CreateWorkspaceModal）改为指向插件命名空间或直接删除（插件自持后）。
- 宿主 TopMenuBar 引用改从插件桥面取；App.tsx 的 CreateWorkspaceModal 懒加载改插件面板内自持。
- 风险：TopMenuBar 首屏依赖 QuickSwitch——插件未启用时入口需兜底（对齐 WorkspaceQuickSwitch 现有 `pluginPanelRegistry.has` 守卫）。

### 2.2 Developer → dev-desk 新插件

- DeveloperPanel 仅依赖 `getEventBus`（宿主 aiEventBus 单例）+ uuid + types/aiEvent——无后端命令，迁移低风险。
- 新插件 `dev-desk`：`contributes.views[].area='activityBar'`、`panelType='developer'`、`slot='developer'`（对齐 terminal-desk 的 slot 接管模式——LeftPanel shadow 接管逻辑已存在，插件启用即接管 builtin 'developer' 席位，禁用即回宿主兜底）。
- 宿主 `App.tsx` developerContent 改为 PluginSlotPlaceholder 兜底（插件禁用时显示）；懒加载 import 删除。

### 2.3 Notification → notification-desk 新插件

- NotificationCenterPanel 依赖 toastStore + sessionDirectoryStore（走 `__POLARIS_APP_CORE__.stores.sessionDirectoryStore`，已有桥位）+ types。
- App.tsx 的 overlay 挂载改席位判定（对齐 settings overlay 模式：viewStore.showNotificationCenter 命中 + isPluginUiEnabled → PluginPanelHost；否则宿主兜底）。保活（notificationCenterKept）语义保留在宿主 overlay 层。
- NotificationBell（40 行，TopBar 未读角标）**留核**：高频全局 UI，依赖 toastStore 直连。

### 2.4 FocusMode → focus-desk 插件（并入现有插件仓新插件）

- FocusOverlay 纯渲染层（portal + mousemove），仅依赖 focusModeStore。
- focusModeStore(119 行) 留核：useWindowManager 快捷键 toggle 直连（高频、无 UI）。
- App.tsx `<FocusOverlay/>` 改插件面板挂载（全局 overlay 类插件，参考 pet-overlay 模式）或先留核（106 行，收益小）→ **决定：W3 先留核，登记 W4 评估**。

## 3. 不做 / 后续

- UiFrame 域（1,196 行）：内置 cap.ui.render 渲染器属 plugin-system 内置面，出仓需连带 chatCardRegistry builtin 注册改造，风险高于收益，**W3 不动**。
- FocusOverlay（106 行）：收益小，W3 留核。

## 4. 预期净减

| 项 | 行数 |
|---|---|
| WorkspaceSelector 删除 | -234 |
| Workspace 其余迁出 | -850 |
| Developer 迁出 | -525 |
| Notification 面板迁出（Bell 留核） | -170 |
| 合计 | **~1,780** |

## 5. 验收

- [ ] tsc 0 错 / vitest 绿 / lint 无新增 error / cargo check + web-only 过
- [ ] grep 断言：`src/components/Workspace`、`src/components/Developer`、`src/components/Notification/NotificationCenterPanel` 无残留
- [ ] 浏览器实测：workspace-manager 面板、developer 席位（插件接管）、通知中心 overlay 打开正常
- [ ] 插件仓提交 + dist 同步两个数据根
