# 主题 Phase 3/4 — 管道补齐与 legacy 协议删除

承接 `theme-slimming-phase1-spec.md` 与 2026-10-25 多 agent 分析（评审 agent 修正后的路线）。

## Phase 3：管道补齐（让「AI 操作 + 插件承载」从可用到好用）

1. **AI import 校验加固**：`applyUiThemeAction('import')` 经 `mergeThemes` 以 Dark 兜底
   归一（AI 可只给部分字段）；`themeService` 的 `getUserThemes/getTheme` 读取点同样
   归一——修复评审坑 2（残缺主题持久化 + `flattenAndInject`/渲染层裸解构致 DOM 半切换）。
2. **dispatchCapUiAction 双向化**：cap.ui 域在后端是无状态转发（状态真相在前端
   store），此前直调仅得 `{forwarded:true}` 不生效。现 dispatch（权限 gate + 审计）
   通过后本地应用并回传 `applied` 结果——横幅/插槽按钮点击链真正生效。消费与直调
   共用 `applyCapUiTarget` 路由。
3. **`__POLARIS_THEME_API__` 宿主委托 API**（`src/plugin-system/themeHostApi.ts`，
   对标 `__POLARIS_WORKSPACE_API__`）：插件面板正规读写主题的通道（list/get/
   template/save/remove/apply/subscribe/syncFromRemote），`template()` 提供完整
   88 维 ThemeDefinition 作生成模板（弥补 schema 无导出通道）。结构化数据回传由
   本 API 承担，cap.ui.theme 保持轻转发。
4. **cap.ui.theme 补 `delete` 动作**（后端校验+审计+测试，前端 store 落地，内置
   拒删）——AI 可全生命周期管理主题，主题列表不再只进不出。
5. **主题存储跨端化**：localStorage（同步缓存，防 FOUC 链路不可异步化）+
   DataRoot 权威镜像（经 cap.kv `ui-themes:v1` 键落 `<DataRoot>/stores/kv.db`，
   权限 gate+审计随总线）。对账 = 按 id 并集 + updatedAt LWW；时机 = 启动
   （useAppInit post-auth）/打开设置页（ThemeManager 挂载）+ 写入即推送（防抖
   500ms）。修复跨端不可见（APK 造主题桌面端重启即丢）。实时广播不做（低频，
   下次对账可见）。旧 localStorage 存量在对账时自动上推迁移。
6. **指南改写 + 导入按钮退役**：ThemeTab 指南改为「AI 直调」工作流（列出全部
   动作 + 告知需开启「AI 界面控制」+ import payload 是裸 theme 对象）；ThemeManager
   删导入按钮/fileInput/importError；`importThemeFile`/`store.importTheme` 死代码
   删除。导出（备份）/删除（清理）保留。
7. **PluginPanelHost 渲染期 ErrorBoundary**：面板 render 抛错不再冒泡炸全屏，
   按面板隔离降级 + 重试。

## Phase 4：spidermanTheme legacy 协议字段删除

- Rust：`SpiderManThemeConfig` struct、`spiderman_theme` 字段与默认值（config.rs/
  config_store.rs）删除；`theme` 短名字段保留（dark/light 迁移仍用）。
- 前端：`SpiderManThemeConfig`/`DEFAULT_SPIDERMAN_THEME`/`spidermanTheme` 字段
  （types/config.ts）、configStore 的 localStorage 同步、themeEngine
  `saveLegacySpiderManConfig`、SettingsPage dirty-key、config-refactor.test 用例。
- 兼容性：PolarisConfig 无 `deny_unknown_fields`，旧 config.json 残留
  `spidermanTheme` 键被 serde 静默忽略，无需迁移。
- 刻意保留：`public/spiderman/*.jpg` 资产、`--spiderman-*` CSS 变量别名层
  （通用沉浸主题消费）、`spiderman-brightness` 亮度缓存键（改名丢缓存无收益）。

## 验收

- `pnpm typecheck`/eslint 0 error；vitest 全量除 2 个已知存量失败
  （pluginLifecycleSubscriber，与本域无关）外全绿；新增用例：import 归一×2、
  delete×3、uiControl 消费门控、cap.ui.theme delete Rust 校验。
- `cargo check`、`--no-default-features` 双门控 0 error；lib 测试目标存量编译错
  维持 4（全部位于本次未触碰文件）。
