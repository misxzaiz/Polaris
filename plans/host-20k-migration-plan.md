# 宿主 20k 迁移总纲（2026-11-17 勘探定稿）

> 目标：主仓宿主代码（前端 `src/` + Rust `src-tauri/src/`）收敛到 **≤20k 行**。
> 方法：延续 core-slimdown / K 系列纪律——每波独立 spec、四门禁（tsc 0 错 / vitest 绿 / lint 无新增 error / cargo check + web-only）、grep 断言、可回退。
> 上游：`plans/kernel-5k-all-plugin-architecture.md`（形态定案）、`plans/host-kernel-roadmap.md`（50k 第一里程碑）、`plans/core-slimdown-plugin-extraction-plan.md`（B1/B2/B3 已完成批次）。

## 一、基线（2026-11-17 逐目录实测）

- 前端 `src/`：62,654 行（其中测试 10,115）→ 非测试 52.5k
- Rust `src-tauri/src/`：102,637 行 → 非测试 ~80k（127 个文件含 `#[cfg(test)]`）
- **合计 ~165k，目标 20k，需净减 ~145k**

### 前端分层实测（非测试）

| 层 | 行数 | 判定 |
|---|---|---|
| plugin-system（注册表/loader/桥 API） | 5,777 | 核，保留（可微瘦身） |
| services/transport + dialogStorage | 3,687 | transport 核；dialogStorage 随会话域归属再议 |
| services/ 其余（discovery/observers/桥转发） | ~7,200 | 大部分为插件桥转发，随出仓收缩 |
| services/tauri（命令包装） | ~1,900 | 随域出仓收缩 |
| stores/（42 个） | 6,770 | 一半是 appCoreBridge 转发源；随插件自持收缩 |
| components/Layout + Common + UiFrame + Theme | ~7,400 | Layout/Common 壳保留；UiFrame/Theme 出仓 |
| components/Settings | 4,791 | **整域出仓**（settings-desk） |
| components/Workspace | 1,077 | **出仓**（workspace-manager / chat-desk） |
| components/Developer | 525 | **出仓**（dev-desk） |
| components/Notification + FocusMode + Preview + Plugins | ~700 | Notification/FocusMode 出仓；Preview 留（tab 渲染兜底） |
| hooks/ | 1,751（含 390 测试） | useAppInit 瘦身；其余保留 |
| types/ | 6,396（含 665 测试） | 协议类型保留；chat/context 等随域去重 |
| utils/ | 7,736（含 ~1,300 测试） | **cache.ts 705 死代码删**；toolConfig/toolSummary 等随消费方走 |
| App.tsx + main.tsx + i18n + mobile | ~1,700 | 保留（壳） |

### Rust 分层实测（非测试约数）

| 模块 | 行数 | 判定 |
|---|---|---|
| services/router/（38 cap） | 19,038 | **核**（总线+权限+审计）；ui_render/config 大 capability 可评估下沉 |
| ai/（engines + registry + launcher + event_parser） | 21,513 | **K-R1：simple-ai（9.1k）进程化出仓；claude.rs 1.8k 评估随引擎插件化** |
| services/proxy/ | 5,039 | **K-R2：供应商代理出仓**（模型网关插件/独立进程） |
| services/ai_chat_core/ | 3,042 | 会话编排核（cap.ai.chat 执行面）——保留但随引擎外移收缩 |
| services/ask_listener/ + ask_mcp_server + ask_listener_meta | ~3,000 | ask 域：ask-stove 插件已存在；宿主保留最小 form/question 仲裁或整体出仓（K-R3 复评） |
| services/nexus_pipeline + form + context_core + nexus_verdict | ~3,300 | 流水线域：随 ai 编排出仓评估（K-R4 复评） |
| services/session_db + session_state + turn_persist + dialog_index | ~5,300 | **存储执行体，核**（日志即真相）——保留 |
| services/plugin_service + supervisor + mcp_config_service 等 | ~9,000 | 插件运行时核——保留（mcp_config 1.9k 可随 builtin MCP 收口瘦身） |
| services/computer_control + computer_mcp_server | ~1,500 | computer 插件已承接面板；引擎核按 B1-5 定案保留给 SimpleAI |
| services/ 其余（config_store/data_root/logger/usage_db/…） | ~8,000 | 基础设施核——保留 |
| commands/（21 文件） | 5,657 | K-R5 已收口大半；残余薄壳继续清退 |
| web/（server/ipc/ws） | 5,241（含 1,640 集成测试） | 核（ipc.rs 1,405 为 75 分支透传，可随总线收口瘦身） |
| models/ + contracts/ + capabilities/ + state.rs + lib.rs | ~8,700 | 协议与装配核——保留 |

## 二、勘探中确认的死代码 / 断链（W1 直接处理）

1. **`src/utils/cache.ts`（705 行）零消费**——全仓无任何 import（LRUCache 消费方用的是 `utils/lru-cache.ts`）。删除。
2. **`src/stores/tokenAnalyticsStore.ts`（231 行）零消费**——仅 stores/index.ts barrel 导出，无业务引用（model-desk 用自己的 cap.usage 服务）。删除 + barrel 清理。
3. **files-desk 构建损坏**：`src/Editor/{EditorPanel,MarkdownEditor}.tsx` 的 `import { CodeMirrorEditor } from '../Editor'` 应为 `./Editor`（9afc3ee 修错方向）。已在插件仓修复并重新构建通过（dist 9.4MB）——需提交。
4. **chat-desk `useWorkspaceFilter` 运行时炸弹**：`shims/misc.ts:86` 将其挂为 `new Proxy({}, {get})`（不可调用），而 QuickSwitchPanel/CreateSessionModal/NewSessionPanel 共 5 处直接 `useWorkspaceFilter(...)` 调用 → TypeError。修法：改为与宿主函数一致的 callable forward（`(...args) => core().components.useWorkspaceFilter(...args)`）。
5. **工具用量观测断链**：宿主 `pluginToolUsageObserver` 订阅宿主 aiEventBus 的 `tool_call_end`，但事件源在 chat-desk 插件内 `ai-runtime/event-bus` 的独立单例（sessionStoreManager.ts:704 补发也发到插件内实例）→ 宿主永远收不到，`plugin.toolusage.*` 停记。修法（择一）：插件补发时同时经 `__POLARIS_APP_CORE__.services` 桥转发到宿主 bus；或观测逻辑随域迁入插件、经 cap.kv 落盘（倾向后者，宿主更瘦）。
6. **appCoreBridge 缺 `hooks` 键**：files-desk `deps.ts:48` `core().hooks.useTransitionState` 会炸；当前 ConfirmDialog 等用本地实现未触达（死转发），修复时一并补挂或删转发。

## 三、波次规划（每波独立可回退）

| 波 | 内容 | 预计净减 | 风险 |
|---|---|---|---|
| **W1** | 死代码删除（cache.ts、tokenAnalyticsStore）+ 插件仓修复（files-desk import、useWorkspaceFilter、观测断链）+ 勘探记录入库 | ~1.0k | 低 |
| **W2** | **Settings 域出仓**（settings-desk 插件）：SettingsPage/Sidebar/12 tabs/EngineExpandDetail/EngineInstallActions + 相关 service；PluginTab 的插件管理面与 marketplace 插件合并 | ~5.3k | 中（tab 路由 + config 保存分域）——**✅ 已完成（2026-11-17，主仓 c43adfca -4.9k 行 + 插件仓 5c4df2d）** |
| **W3** | Workspace/Developer/Notification 出仓（FocusMode/UiFrame 缓办）| ~1.6k | 中 |——**✅ 已完成（2026-11-17，主仓 8a915c3d + 真机验证修复 9f49a597 + 插件仓 c750880a/0a2122d2；浏览器实测 QuickSwitch/dev-desk 接管/消息中心三域渲染通过）**
| **W4** | **前端桥收敛**：appCoreBridge/stores/services 中纯转发件随插件自持删除（chat-desk 已回挂 sessionRestore/sessionHandoff/aiChatDispatch/dispatchTaskService 等，宿主副本可删）；agentStore/cliInfoStore/skillStore/snippetStore 随 chat-desk 自持化出仓；promptHistory/sessionExport/conversationPackager/newSessionPrefs 删宿主副本 | ~8k | 中高（需插件侧先自持）——**W4-1~4 部分完成（2026-11-17，主仓 183fd21a/1888e0d1/dc4229e9/f746f1a1 + 插件仓 f45f9393/1b8e52ba/00c1c5a8/b9f2456e）：9 个纯总线服务宿主副本已删（promptHistory/newSessionPrefs/claudeSettings/imageSave/streamRateTracker/cliSlashCommands/agentSlashCommand/workspaceReference/conversationPackager，约 -1.1k 行），chat-desk shims 改本地转发；stores 批次：snippetStore/skillStore/agentStore 已随 chat-desk 自持出仓（W4-5/6/7，ec41c3e9/64829806/09fc1d0a）；cliInfoStore（启动期 cli_init 监听时序）与 modelProfileStore（configStore 核消费）留宿主。**W4 桥收敛完毕：前端非测试 45.3k→43.1k** |
| **W5** | **K-R2 proxy 出仓**（5.0k）+ **K-R1 simple-ai 进程化**（9.1k）：按 host-kernel-roadmap 既有 spec 方向 | ~14k | 高（重写级，单独立项） |
| **W6** | **Rust commands/web ipc 继续清退** + ask/nexus/form 域终裁（ask-stove 承接面评估）+ ai_chat_core 编排下沉 | ~8k | 中高 |
| **W7** | 核内瘦身：router capability describe 精简、models 协议去重、types 去重（chat/context 等 9 文件与插件 host/types 零差异，宿主留单源） | 持续 | 低 |

> 20k 达成路径：W1-W4 后前端预计 ~33k；W5-W6 后 Rust 预计 ~55k。距 20k 仍需 W7 持续滚动 + 存储/总线深度瘦身。**诚实结论：20k 是多阶段长期目标，本总纲先落 W1-W3（确定性高、风险低），W5-W7 按波推进并在每波后复测基线。**

## 六、进度实测（2026-11-17 W4 收官后复测）

- 前端非测试：52.5k → **42.2k**（W1 死代码 + W2 Settings 出仓 + W3 三域出仓 + W4 桥收敛 12 项 + utils/hooks 死代码清扫）
- Rust：102.6k → **101.8k**（prompt_store/cli_resolver 死模块 -841；其余按既有 spec 目录化收口，不降行数）
- 合计 ~144k。距 20k 需 S3（存储插件化）/S4（AI 业务插件化）级重构（kernel-5k-all-plugin-architecture.md），属多 PR 长期工程。
- W7 已落一类：chat-desk host/types 构建期同步脚本（sync-types.mjs，宿主单源 → 插件拷贝防漂移）。
- Rust 死代码扫尾结论：services/ models/ ai/ commands/ 均无更多零符号模块；capabilities/ 454 行为 Phase2 未接线 trait seam（架构预留，按死代码纪律保留）。

### W2 遗留（跨波次，不阻塞 W2 关闭）

- **Web 模式插件 bundle 读取被 cap.fs 内置 Remote deny 拦截**：K-R5 批F（e3eb8892，2026-11-16）把 `pluginModuleLoader.loadModuleFromFile` 的 bundle 读取链路（`readFileBinaryText`）从桌面 IPC 通道切到 `cap.fs downloadFileBinary`，而 cap.fs 对 `Source::Remote` 是内置 deny（policy_permission.rs「cap.fs 远程禁发」）。桌面主窗口走 Tauri IPC（`resolve_ipc_source("main")=Bootstrap`）不受影响；**Web/移动端模式所有插件面板（含 chat-desk/files-desk/settings-desk）加载失败**（浏览器实测：settings overlay 席位命中、isPluginUiEnabled 通过、面板 ErrorFallback「权限拒绝」；audit/dispatch.jsonl 证实 `cap.fs dispatch.deny:permission action=downloadFileBinary`）。config.json 手工加 `cap.fs remote allow` 规则也无效——规则落盘成功但运行实例的 PolicyPermission 是启动时快照（改盘需重启生效），且重启后内置 deny（同特异性后 push 覆盖 config allow）仍赢。**治理方向（归 W4 桥收敛）**：插件 bundle 读取走 plugin-scoped 专用能力（如 cap.pluginAsset，只允许读各插件 installPath 内文件、维持 Remote deny 边界）；或 cap.fs 动作级 require_auth 放行 `downloadFileBinary`（token=桌面信任级，对齐 install_remote 先例）。修复前 Web 模式是「插件面板全灭」回归。
- W2 本体验证（桌面 IPC 通道）：tsc 0 错 / vitest 60 文件 815 绿（含迁入的 SettingsSidebar 3 测试）/ cargo check + web-only 门控过；settings-desk dist 与两个数据根副本逐字节一致；浏览器（Web 模式）验证到「席位命中 + 状态门通过 + 走到 PluginPanelHost」为止，面板渲染本体待上述 cap.fs 治理后复验。

## 四、门禁与纪律（沿用 core-slimdown §7/§9）

- 每波：`pnpm exec tsc --noEmit` + `pnpm test:run` + `pnpm lint` + `cargo check` + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp`；动 MCP schema 则 `cargo build --bin polaris-mcp`。
- 插件仓改动同步：chat-desk/files-desk 修复须重新 `node build.mjs` 并回填 index.json sha256（如发布）。
- 席位契约保留：`files/git/browser/terminal/developer/integration/aiConsole` 占位不删，禁用插件时 PluginSlotPlaceholder 兜底。
- 一次改动一个主题；删除类与修复类分开提交。

## 五、W1 执行清单（本轮落地）

- [x] 删除 `src/utils/cache.ts`（零消费证实：全仓无 import）
- [x] 删除 `src/stores/tokenAnalyticsStore.ts` + stores/index.ts 两处导出
- [x] 插件仓：files-desk `../Editor`→`./Editor` 修复（已构建通过）
- [x] 插件仓：chat-desk `shims/misc.ts` useWorkspaceFilter 改 callable forward
- [x] 宿主：toolusage 观测断链修复（chat-desk 补发经桥转发宿主 bus）
- [x] 验证：tsc / vitest / cargo check
