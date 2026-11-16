# model-desk 模型供应商管理台插件化 spec

> 日期：2026-11-16 · 状态：实施中
> 上位文档：`plans/ai-chat-plugin-extraction-spec.md`（插件化总纲）；方法论沿用 chat-desk P3→P6 与 terminal-desk 的「摘装配/删实现」纪律。
> 用户定案（2026-11-16）：「按推荐规划实施直到完成所有内容」——采纳盘点结论，出仓模型供应商管理域。

---

## 0. 目标与边界

把主仓 Settings 里最大的两块用户可见 UI 迁出为独立插件 **model-desk**（模型供应商管理台）：

| 迁出物 | 规模 | 说明 |
|---|---|---|
| `src/components/Settings/tabs/ModelProviderTab.tsx` | 1217 行 | Profile CRUD/连接测试/拉模型/预设画廊/快捷输入 |
| `src/components/Settings/tabs/TokenStatsTab.tsx` | 600 行 | 用量看板（summary/model/engine/daily/logs） |
| `src/components/Common/TimeRangePicker.tsx` | 281 行 | 唯一消费方是 TokenStatsTab，随迁 |
| `src/utils/timeRange.ts` | 91 行 | 唯一消费方是 TokenStatsTab，随迁 |

**留宿主**（会话组件与 configStore 消费，出仓风险大于收益）：
`modelProfileStore.ts`、`tokenAnalyticsStore.ts`、`types/modelProfile.ts`、`services/tauri/modelProfileService.ts`、`configStore.applyConfig` 的 modelProfile 灌入链。

**不做**：文件工作台（tabStore 跨域共享 + CodeMirror 懒载链刚稳定）、会话 chrome（窗口管理耦合深）——见盘点结论。

## 1. 插件形态（对齐 llm-probe 骨架）

- 仓库：`Polaris-plugin/plugins/model-desk/`
- 面板：activityBar 席位 `panelType: 'modelDesk'`，icon 用 lucide 内置名（`Server`），无后台服务、无 MCP（纯前端面板 + 宿主命令）
- 构建：esbuild 直出 `dist/panel.js`（external react/react-dom/react-i18next，经宿主 shim）；`npm run build` + `tsc --noEmit`
- i18n：宿主 `useTranslation` shim 同实例；迁出 `settings.json` 的 `modelProfile.*`（92 keys）与 `tokenStats.*`（48 keys）两节为插件自带词典（en-US/zh-CN），宿主词典暂保留（会话侧仍引用 nav.*；后续清理另立项）

## 2. 数据面（零后端改动 + 一个补口）

| 能力 | 通道 | 现状 |
|---|---|---|
| Profile 读写 | `router_dispatch → cap.config` patch（`modelProfiles`/`activeModelProfileId` 顶层 key） | ✅ 已通 |
| 用量统计 | `get_usage_summary/model_stats/engine_stats/daily_trends/recent_logs` | ✅ IPC + HTTP ipc.rs 双通道已通 |
| 连接测试 | `test_model_profile_connection` | ⚠️ 仅 Tauri IPC；**需在 `web/api/ipc.rs` 补 web 分发**（service 层无 feature 门控，直接调 `ModelProfileService::test_connection`） |
| 拉取模型列表 | `fetch_models_for_profile` | ⚠️ 同上，补 `ModelProfileService::fetch_models` 分发 |

插件内命令走 `__POLARIS_HOST_INVOKE__`（白名单需补上述 7 个命令；`router_dispatch` 已在）。

## 3. 主仓瘦身（P6 同款纪律）

1. `SettingsPage.tsx`：删 `ModelProviderTab`/`TokenStatsTab` import 与渲染分支，两 tab 改 `PluginSlotPlaceholder` 壳（指向 model-desk 面板）；`topLevelKeysByTab` 删两 key
2. `SettingsSidebar.tsx`：删 `model-provider`/`token-stats` 两项与 `SettingsTabId` 两成员
3. 删文件：`tabs/ModelProviderTab.tsx`、`tabs/TokenStatsTab.tsx`、`Common/TimeRangePicker.tsx`、`utils/timeRange.ts`（唯一消费方均随迁）
4. `appCoreBridge.ts`：无新增（store/types 留宿主，插件不依赖桥上这些条目）
5. `main.tsx` `HOST_INVOKE_ALLOWLIST`：补 `test_model_profile_connection`、`fetch_models_for_profile`、`get_usage_summary`、`get_usage_model_stats`、`get_usage_engine_stats`、`get_usage_daily_trends`、`get_usage_recent_logs`

## 4. 门禁

- 插件仓：`npm run build` + `tsc --noEmit`
- 主仓：`pnpm exec tsc --noEmit`、`pnpm lint`（不新增 error）、`pnpm test:run`（相关套件）、`cargo check`、`cargo check --no-default-features --bin polaris-web --bin polaris-mcp`
- grep 断言：主仓 0 命中 `ModelProviderTab|TokenStatsTab|TimeRangePicker|utils/timeRange`
- 真机（9827 dev + 9820 后端）：activityBar 出现 model-desk 面板；Profile 新建/编辑/删除/激活/连接测试/拉模型；Token 统计四视图渲染与筛选；Settings 两 tab 显示迁移壳；禁用插件 → 壳提示

## 5. 回滚

- 插件禁用 → Settings 壳提示（不回滚代码）
- revert 主仓删码 commit 即恢复内建 Tab（插件 dist 不回滚）
