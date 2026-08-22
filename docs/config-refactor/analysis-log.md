# 配置系统重构 — 分析日志

自主攻坚任务(无用户介入,生产级目标)。

## 轮次记录格式
每轮:范围 / 勘察文件 / 结论 / 证据(file:line)

---

## Phase 1: 深度分析(20轮)

### R01 configStore 副作用链全量测绘
- 范围: src/stores/configStore.ts L65-148 loadConfig
- 勘察: configStore.ts / themeStore.ts / modelProfileStore.ts / sessionConfigStore.ts
- 结论: loadConfig 含 7 处副作用 import 链,分散在 L76/L96/L108/L121/L131。每处都是 `import().then()` 异步,无错误处理(仅 `.catch(()=>{})`)。新增配置项需在此手写一行,易漏。
- 证据: configStore.ts:76(i18n) / :80(spiderman) / :84(theme) / :96(modelProfile) / :108(activeModelProfileId→sessionConfig) / :121(providerGroup→sessionConfig) / :131(cliInfo)
- 修复点: 提取 applyConfig(config) 统一入口,三处(loadConfig/updateConfig/updateConfigPatch)复用

### R02 sessionConfigStore persist 字段实测
- 范围: src/stores/sessionConfigStore.ts
- 勘察: L57-135 persist + L122 partialize + L126 merge
- 结论: persist `polaris-session-config` 到 localStorage,字段含 agent/model/effort/permissionMode/modelProfileId/profileMode/providerGroupId。其中 modelProfileId/profileMode/profileMode 是 configStore 的派生镜像(configStore.loadConfig L108-128 会注入),双写。
- 证据: sessionConfigStore.ts:122-123 partialize config 全量;configStore.ts:108 setModelProfileId 注入;:121 setProfileMode 注入
- 修复点: modelProfileId/profileMode/providerGroupId 从 persist 移除(派生自 configStore),仅保留 agent/model/effort/permissionMode(本机会话偏好)

### R03 workspaceStore 双写实测确认
- 范围: src/stores/workspaceStore.ts
- 勘察: L7-8 注释 / L49 persistToServer / L316-322 persist
- 结论: 注释自承"双向写入"。persist 存 workspaces/currentWorkspaceId/contextWorkspaceIds 到 localStorage,每次 create/switch/delete/update 又 persistToServer 写 config.json。真实双写。
- 证据: workspaceStore.ts:49 updateConfigPatch;:316 persist name 'workspace-store';:317-321 partialize
- 修复点: persist 仅保留 contextWorkspaceIds/viewingWorkspaceId(纯本机 UI 态),workspaces/currentWorkspaceId 改派生自 configStore.syncFromServer

### R04 Web 模式配置写入链路勘误
- 范围: src/services/transport/httpTransport.ts L425 / src-tauri/src/web/api/settings.rs / src-tauri/src/web/api/ipc.rs L412
- 勘察: httpTransport L44-46 commandToPath 映射 update_config/update_config_patch → '/api/settings';L425 特化为 PATCH 方法
- 结论(勘误): Web 端 update_config/update_config_patch **不走 ipc.rs**,走 RESTful `/api/settings` PATCH,由 settings.rs:18 handle_update_settings 处理,调 config_store.patch 落盘正常。之前判断"Web 模式无 update_config 分支"是错的。
- 但发现真实缺口: handle_update_settings 只调 config_store.patch,**缺 refresh_engine_configs + emit_config_changed**(对比 lib.rs:190 Tauri command 有这三步)。Web 端改配置后引擎不刷新、不广播 config-changed 事件。
- 证据: settings.rs:22-24 仅 patch;lib.rs:181-183 有 cascade/refresh/emit
- 修复点: handle_update_settings 补 refresh_engine_configs + emit(但 Web 模式无 app_handle,emit 需走 WebSocket 广播或省略)

### R05 单字段 setter 回滚缺失实测
- 范围: src-tauri/src/services/config_store.rs L237-252
- 勘察: set_work_dir/set_claude_cmd/set_engine/set_session_dir
- 结论: 四个 setter 都是 `self.config.xxx = xxx; self.save()`,无 old_config clone + 失败回滚。对比 update(L187)/patch(L207) 有回滚。save() 失败时内存已改磁盘未写,状态不一致。
- 证据: config_store.rs:237-239 set_work_dir 直接赋值+save;:187-203 update 有 old_config 回滚
- 修复点: 四个 setter 套用 update 的回滚模式

### R06 applyConfig 提取点测绘
- 范围: src/stores/configStore.ts loadConfig(L65-148) / updateConfig(L155-184) / updateConfigPatch(L186-216) / submitToken(L335-386)
- 勘察: configStore.ts L65-386 全段
- 结论: 四处函数有三块完全相同的副作用代码,逐字复制:
  1. **语言同步**: `if (config?.language) { i18n.changeLanguage(config.language) }` — 四处完全相同(L76/L161/L190/L346)
  2. **spiderman 兼容**: `if (config?.spidermanTheme) { saveLegacySpiderManConfig(config.spidermanTheme) }` — 四处完全相同(L80/L165/L194/L350)
  3. **主题应用**: `if (config?.activeThemeId) { useThemeStore.getState().applyThemeById(...) } else if (config?.theme) { ... }` — 四处完全相同(L84-91/L169-176/L198-205/L354-361)
  - 另有两块副作用仅 loadConfig 独有,其余三处缺失:
  4. **modelProfileStore 同步**: 仅 loadConfig L96-103,updateConfig/updateConfigPatch/submitToken 均缺(三处改 modelProfiles 后 modelProfileStore 不刷新)
  5. **sessionConfigStore 同步**: 仅 loadConfig L108-128(activeModelProfileId + providerGroupId),其余三处缺
  6. **cliInfoStore 刷新**: 仅 loadConfig L131-133,其余三处缺(cliInfo 不刷新可接受,因 CLI 路径变更后需手动 retry)
  - **可提取为 applyConfig(config)**: 块 1-3 是明确的提取目标(零条件、纯副作用、四处复制)。块 4-5 应一并纳入 applyConfig 以消除三处缺失(否则 updateConfigPatch 改 modelProfiles 后 modelProfileStore 不刷新是 bug)。块 6 可选纳入或留 loadConfig 独有。
- 证据: configStore.ts:76(i18n load) / :80(spiderman load) / :84-91(theme load) / :96-103(modelProfile load) / :108-128(session load) / :131-133(cliInfo load); :161-176(update 三块复制); :190-205(patch 三块复制); :346-361(submitToken 三块复制)
- 修复点: 提取 `applyConfig(config: Config): void` 统一入口,包含块 1-5。loadConfig/updateConfig/updateConfigPatch/submitToken 四处调用 applyConfig(savedConfig) 替代内联副作用。

### R07 themeStore 与 configStore 的反向依赖
- 范围: src/stores/themeStore.ts setThemeById(L287-296)
- 勘察: themeStore.ts 全文
- 结论: themeStore 通过 `await import('./configStore')` 动态导入 configStore,调 `useConfigStore.getState().updateConfigPatch({ activeThemeId: id })` 持久化。这是 **themeStore → configStore 反向依赖**。
  - 同时 configStore → themeStore 正向依赖:loadConfig/updateConfig/submitToken 调 `useThemeStore.getState().applyThemeById(config.activeThemeId)` (configStore.ts L85/L169/L199/L355)。
  - 形成循环: configStore ⇄ themeStore,靠动态 import 打破编译期循环,运行时靠异步时序兜底。
  - **合理性判断**: 反向依赖不合理。themeStore 的职责是 DOM 渲染 + localStorage,持久化应由 configStore 驱动。当前 setThemeById 既写 DOM 又写服务端配置,双重职责。
  - **applyConfig 提取后协调方案**: setThemeById 改为仅 applyThemeById(DOM + localStorage),不调 configStore。服务端持久化由调用方(Settings 页面)调 configStore.updateConfigPatch({ activeThemeId }),applyConfig 内部回调 themeStore.applyThemeById 闭环。循环依赖消除。
- 证据: themeStore.ts:291-292 `import('./configStore')` + `updateConfigPatch({ activeThemeId: id })`;configStore.ts:85/169/199/355 `useThemeStore.getState().applyThemeById`
- 修复点: setThemeById 移除 configStore 反向依赖(仅 DOM + localStorage)。applyConfig 统一处理 activeThemeId → themeStore 正向同步。

### R08 plugin manifest configSchema 现状
- 范围: src/plugin-system/types.ts PolarisPluginManifest(L300-323) + src/plugins/*/manifest.ts(12 个内置插件)
- 勘察: types.ts L300-323;todo/agnes/personal-hub/scheduler/engine-test manifest
- 结论:
  1. **contributes 下无 configSchema 字段**: PolarisPluginManifest.contributes 的联合类型(L309-318)仅含 views/mcpServers/services/panel/chatCards/engines/toolProviders/styles,无 configSchema 或 config 选项。插件无法声明自己的配置 schema。
  2. **appConfigRead/appConfigWrite 权限位被声明但无消费 API**: PluginPermissionDeclaration(L277-284) 定义了 `appConfigRead?: boolean` / `appConfigWrite?: boolean`,但:
     - todo manifest(L33-36): `appConfigRead: true, appConfigWrite: true`
     - agnes manifest(L48-51): `appConfigRead: true, appConfigWrite: true`
     - scheduler manifest(L32-35): `appConfigRead: true, appConfigWrite: true`
     - personal-hub manifest(L25): `appConfigRead: true`(无 write)
     - engine-test manifest(L23): `permissions: {}`(空)
  3. **MCP server 获取配置靠 argsTemplate 模板变量**: 插件 MCP server 通过 `argsTemplate: ['{{appConfigDir}}', '{{workspacePath}}']` 获取 configDir 路径(todo L28 / agnes L35 / scheduler L28),MCP server 进程自行从该路径读取 config.json。插件 **没有** 声明式配置字段读取 API,只能靠 CLI 参数透传整个 configDir 路径。
  4. **configSchema 缺失影响**: 插件若需自有配置(如 agnes 的 API key、personal-hub 的 Supabase 凭证),只能自行在 configDir 下创建独立 JSON 文件(如 agnes 在 `<appConfigDir>/agnes/config.json` 读取,见 agnes manifest L8 注释),无法纳入 Polaris 统一 config.json 体系。
- 证据: types.ts:309-318(contributes 无 configSchema);:278-281(appConfigRead/Write 权限);todo manifest:28(argsTemplate);agnes manifest:8(独立 JSON);agnes manifest:48-51(权限);personal-hub manifest:25(仅 read)
- 修复点: contributes 新增 `configSchema?: PluginConfigSchema` 字段,允许插件声明配置字段 + 默认值 + 校验。applyConfig 增加插件配置分发回调,或插件 MCP server 通过新模板变量 `{{configField:xxx}}` 读取指定字段。

### R09 插件 MCP server 参数模板与配置读取
- 范围: src-tauri/src/services/mcp_config_service.rs expand_external_mcp_template(L1000-1022) + build_mcp_server_args(L1159-1205)
- 勘察: mcp_config_service.rs L1000-1022 / L1159-1205 / L806-895
- 结论:
  1. **模板变量清单(6 个)**: expand_external_mcp_template(L1000-1022) 支持 6 个占位符:
     - `{{pluginDir}}` — 插件安装目录
     - `{{workspacePath}}` — 工作区路径
     - `{{appConfigDir}}` — Polaris config.json 所在目录
     - `{{polarisPort}}` — ask listener TCP 端口
     - `{{polarisToken}}` — ask listener 鉴权 token
     - `{{sessionId}}` — ask route session id
  2. **无 config.json 字段读取能力**: 模板替换仅做字符串 replace,不解析 config.json 内容。插件 MCP server 若需读取 config 字段(如 API key),只能通过 `{{appConfigDir}}` 获取目录路径后自行打开 config.json 解析,或自行管理独立配置文件。
  3. **内置 MCP args 固定**: build_mcp_server_args(L1159-1205) 内置 MCP server 走 McpServerArgsMode 枚举:
     - ConfigDirAndWorkspace: `[subcommand, configDir, workspacePath]` — 传 configDir 但不传 config 内容
     - WorkspaceOnly: `[subcommand, workspacePath]`
     - AskListener: `[subcommand, --polaris-port, port, --polaris-token, token, --polaris-session?, sessionId]`
  4. **外部插件 argsTemplate 灵活但有限**: resolve_external_plugin_mcp_servers(L830-892) 遍历 plugin.contributes.mcp_servers,对 command 和每个 arg 调 expand_external_mcp_template。插件可在 manifest 声明 `argsTemplate: ['{{appConfigDir}}/my-config.json', '{{workspacePath}}']`,但拿不到 config 字段值。
- 证据: mcp_config_service.rs:1015-1021(6 个 replace);:1169-1175(ConfigDirAndWorkspace);:806-895(外部插件解析);:815(app_config_dir 传参)
- 修复点: 如需插件读取 config 字段,两种路径:(A) 新增模板变量 `{{configField:performance.fileWatcher}}` 在 expand 时从 config 取值注入(需 config 引用);(B) 启动 MCP server 时通过 stdin/env 注入配置 JSON(无需新模板变量,但需改 spawn 逻辑)。路径 A 更简单。

### R10 config-changed 事件消费方测绘
- 范围: 全项目 grep `config-changed`(emit + listen)
- 勘察: src-tauri/src/lib.rs L248-269;src/stores/performanceHotSwitchStore.ts;src/hooks/useAppInit.ts;src/types/config.ts L477;src/components/Settings/tabs/PerformanceTab.tsx
- 结论:
  1. **emit 方(1 处)**: 仅 lib.rs:261-269 `emit_config_changed`,且 `#[cfg(feature="tauri-app")]` 门控(Web 模式不编译)。payload 仅含 `{ performance: config.performance }`,不广播其他配置字段。
  2. **listen 方(1 处)**: 仅 performanceHotSwitchStore.ts:50 `listen<{ performance?: PerformanceFeatures }>('config-changed', ...)`,只消费 `event.performance` 字段。
  3. **其他引用均为注释/文档**: useAppInit.ts:174 注释"初始化性能开关热切换监听";config.ts:477 注释"变更通过 config-changed 事件热切换";PerformanceTab.tsx:5 注释"配置变更通过 config-changed 事件热切换"。
  4. **polaris-pocket 子项目有独立事件**: `pocket-config-changed`(polaris-pocket/src/pages/SettingsPage.tsx:161,192),与主项目 `config-changed` 无关,仅 pocket 内部用。
  5. **结论: config-changed 事件当前只有一个消费方(performanceHotSwitchStore),且 payload 只带 performance 字段**。其他配置变更(语言/主题/modelProfiles/workspaces 等)不通过事件广播,靠 configStore.updateConfigPatch 内联副作用同步。
  6. **Web 模式缺口(与 R04 交叉验证)**: Web 模式 settings.rs 不 emit config-changed(R04 已发现),且 lib.rs 的 emit_config_changed 有 `#[cfg(feature="tauri-app")]` 门控,Web 编译期直接不存在此函数。
- 证据: lib.rs:261-269(唯一 emit,tauri-app 门控);performanceHotSwitchStore.ts:50(唯一 listen);useAppInit.ts:174(注释);config.ts:477(注释);settings.rs:22-24(Web 模式不 emit,见 R04)
- 修复点: 若 applyConfig 提取后需要多模块感知配置变更(如 themeStore/modelProfileStore 被外部调用 updateConfigPatch 后需刷新),应扩展 config-changed payload 或新增 config-patched 事件带完整 patch。但当前单消费方架构下,applyConfig 内联调用比事件广播更简单可控,不建议过早引入事件总线。

### R11 ConfigPatch 类型定义
- 范围: src/types/config.ts ConfigPatch(L583-586) + Config interface(L389-456)
- 勘察: config.ts L389-456 / L583-586
- 结论:
  1. **ConfigPatch 定义**: `export type ConfigPatch = Partial<{ [K in keyof Config]: Config[K] | null }>` (L584-586)。注释 L583 "只包含要更新的顶层字段,null 用于清空可选字段"。
  2. **结构**: Partial 包装一个 mapped type,每个顶层字段值类型为 `Config[K] | null`。Partial 使所有字段可选(可不传),null 用于显式清空 Option 字段。
  3. **顶层字段合并语义**: 后端 config_store.rs:605-611 `merge_json_object` 遍历 patch_object 的 key,对每个 key 做 `target_object.insert(key, value.clone())` — **顶层字段整体替换,不递归深合并**。例如 patch `{ codexCode: { cliPath: "new" } }` 会把整个 `codexCode` 对象替换为 `{ cliPath: "new" }`,丢失 codexCode 的其他字段。
  4. **null 语义**: 后端 patch(L207-234) 接收 `serde_json::Value`,null 值经 merge_json_object 替入 target,再 `serde_json::from_value::<Config>` 反序列化时 Option 字段遇 null 变 None(L747-762 测试 `patch_can_clear_optional_fields_with_null` 验证)。非 Option 字段遇 null 会反序列化失败报错。
  5. **类型安全缺口**: ConfigPatch 允许传任何 Config 顶层字段的 Partial,但无法阻止传 null 给非 Option 字段(如 `defaultEngine: null`),这种 patch 会在运行时反序列化失败。类型层面 `Config[K] | null` 过宽。
- 证据: config.ts:584-586(ConfigPatch 定义);:389-456(Config interface);config_store.rs:605-611(merge_json_object 顶层替换不深合并);:747-762(patch_can_clear_optional_fields_with_null 测试)
- 修复点: (1) 后端 merge_json_object 可选改为递归深合并(对 Object 类型递归 merge,非 Object 替换),避免子字段丢失。(2) ConfigPatch 可拆为 `ConfigPatch` 和 `ConfigNullablePatch`,Option 字段允许 null,非 Option 字段不允许 null,类型层面更安全。但深合并语义变更可能破坏现有调用方(如 retryConnection L298-304 传 `codexCode: { ...config.codexCode, cliPath }` 手动全量),需评估影响面。

### R12 现有测试覆盖
- 范围: src-tauri/src/services/config_store.rs #[cfg(test)] mod tests(L689-763)
- 勘察: config_store.rs L689-763 全部测试
- 结论:
  1. **现有测试(4 个)**:
     - `resolves_windows_cmd_shim_from_appdata_npm` (L694-715, Windows-only) — 测 resolve_windows_cmd_shim 路径解析,与配置 patch 无关
     - `does_not_resolve_windows_cmd_shim_for_explicit_paths` (L718-722, Windows-only) — 同上
     - `patch_preserves_unrelated_config_fields` (L725-744) — 测 patch 单字段更新(defaultEngine)不丢失其他字段(cli_path/window_opacity)
     - `patch_can_clear_optional_fields_with_null` (L747-762) — 测 patch 传 null 清空 Option 字段(gitBinPath)
  2. **覆盖缺口**:
     - **update() 回滚无测试**: update(L187-204) 有 old_config clone + 失败回滚,但无测试验证回滚行为(需 mock save 失败)
     - **patch() 回滚无测试**: patch(L207-234) 有 old_config + 回滚,但无测试验证 save 失败后 config 恢复旧值
     - **set_work_dir/set_claude_cmd/set_engine/set_session_dir 无测试**: 四个单字段 setter(L237-252/L466-470)无回滚(R05 发现),也无测试
     - **merge_json_object 深合并行为无测试**: merge_json_object(L605-611) 顶层替换语义无独立测试(patch_preserves_unrelated_config_fields 间接验证但未测子对象替换)
     - **validate() 调用无测试**: patch(L220) 和 new(L38) 调 validate(),但无测试验证非法配置(如非法 EngineId)被 validate 拒绝
     - **applyConfig 收敛后需补**: 若提取 applyConfig,需补"applyConfig 后 themeStore/modelProfileStore/sessionConfigStore 同步"的前端集成测试
  3. **测试环境限制**: 本机 cargo test --lib 无法运行(Tauri 原生 DLL 依赖,见 rust-lib-test-env-limit.md 记忆),只能用 cargo check --lib 验证编译。新测试需在 CI 或可运行环境验证。
- 证据: config_store.rs:694-715(cmd shim 测试);:725-744(patch 保留字段);:747-762(patch null 清空);:187-203(update 回滚无测试);:207-234(patch 回滚无测试);:237-252(四 setter 无测试无回滚)
- 修复点: 补 6 个测试点:(1) update save 失败回滚 (2) patch save 失败回滚 (3) set_work_dir/set_claude_cmd/set_engine/save 失败行为 (4) merge_json_object 子对象替换语义 (5) validate 拒绝非法 EngineId (6) applyConfig 前端集成(若实施)
