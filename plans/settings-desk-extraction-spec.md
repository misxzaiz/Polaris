# W2：Settings 域出仓（settings-desk 插件）

> 状态：**实施中**（2026-11-17 立项） · 上游：`plans/host-20k-migration-plan.md` 波次表 W2
> 范围：主仓 `src/components/Settings/**`（4,791 行，含 87 行测试）整体出仓为插件仓 `plugins/settings-desk`，宿主保留 settings 覆盖层席位与打开/关闭事件桥。

## 1. 现状勘探（实测）

- `src/components/Settings/`：SettingsPage(310) + SettingsSidebar(113，含 87 行测试) + index.ts(1) + tabs/ 12 个文件(3,991) + EngineExpandDetail(206) + EngineInstallActions(170)。
- 唯一宿主消费方：`App.tsx`（lazy import SettingsPage + `SettingsTabId` 类型 + `polaris:open-settings` 事件 → settingsInitialTab）。
- tab 分发：`SettingsPage.tsx` 内 switch（plugins/ai-engine/theme/general/advanced/app-update/web/performance），保存走 `handleSaveCurrentTab`（configStore.applyPatch + applyWebServerIfNeeded）。
- 已出仓先例：model-desk（模型供应商/Token 统计两 Tab）、storage-desk（数据存储卡）、snippet-desk（PromptSnippetTab）均为 activityBar 席位插件；GeneralTab:177 已有「数据存储已迁出」注记。
- 事件链：chat-desk ContextMeter:471 `eventBus.emit('polaris:open-settings', {tab:'token-stats'})` → App.tsx:164 监听 → SettingsPage initialTab。eventBus.ts:33 已声明该事件。

## 2. 方案

1. 插件仓新建 `plugins/settings-desk`（id `polaris.settings-desk`？——**定案：`settings-desk`**，与 model-desk 等命名对齐），manifest 声明：
   - `contributes.views[]: { id: 'settings-desk.panel', area: 'settings', panelType: 'settings-desk' }` —— **新增 `settings` area**（宿主 registry `VALID_VIEW_AREAS` 扩一枚，双侧镜像）。
   - `permissions: { appConfigRead: true, appConfigWrite: true }`（config 保存经既有 cap.config patch；WebTab 的 apply_web_server 走 `router_dispatch('cap.config', 'apply_web_server')`？——**否**：apply_web_server 是独立 tauri 命令，插件经 `__POLARIS_HOST_INVOKE__` 白名单放行 `apply_web_server/get_web_server_status/get_local_ips/set_server_config/get_server_config`（均为只读/幂等配置面）。
2. 宿主 `App.tsx`：settingsRendering 区块改渲染 `PluginPanelHost panelType="settings-desk"`（overlays/shadow 机制复用），保留占位兜底（插件未启用 → 原SettingsPage？——**定案：不留内置回退**，Settings 域与 core 席位解耦后插件为唯一实现；未启用时渲染引导卡）。`SettingsTabId` 类型改由插件经 `polaris:open-settings` 事件 payload 透传（tab: string），宿主不再 import 该类型。
3. tab 全量搬迁：GeneralTab（语言/自启/移动端连接/FocusModeSettings/SystemPromptSection）、ThemeTab（ThemeManager）、AIEngineTab+EngineExpandDetail+EngineInstallActions、PluginTab（插件管理面：与 marketplace 插件分工——PluginTab 保留已装管理/启停/健康，marketplace 商城浏览安装）、AppUpdateTab、WebTab、PerformanceTab、AdvancedTab、PluginConfigForm。
4. 依赖桥面：configStore/useToastStore/useWorkspaceStore/usePluginStore/pluginServiceManager/mcpHealthService/pluginDiscoveryService（PluginTab 管理面用）/updateService/appUpdateService/autolaunchService——全部经 `__POLARIS_APP_CORE__`（桥上已挂或本波补挂）+ `__POLARIS_HOST_INVOKE__` 白名单扩容（`engine_install/engine_uninstall/fs_watch_*` 等插件面板所需命令）。
5. i18n：settings 命名空间词典随插件走（plugin contributes.i18n 或打包内嵌），宿主 locales/settings.json 保留兜底一个版本后删。

## 3. 门禁

tsc 0 错 / vitest 全绿 / lint 无新增 error / grep 断言（`src/components/Settings` 归零、`SettingsTabId` 宿主零引用）/ 真机验收（设置页 8 tab 打开+保存+主题切换+插件管理+Web 二维码）。

## 4. 预计净减

主仓 -4.8k 行（4,791 组件 + 类型/词典散件），插件仓 +~5.2k（含桥接 shim）。
