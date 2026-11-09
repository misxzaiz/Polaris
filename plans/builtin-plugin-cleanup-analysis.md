# 内置插件清理·确定分析报告

> 状态：分析完毕（仅分析，未实施）· 日期：2026-11-09
> 对象：`plans/builtin-plugin-cleanup-prompt.md`（交接单）的 §2 边界判定 + §3 锚点实测 + 外移三项可行性
> 基线：主仓 HEAD `dc88f3b5`（工作树未提交改动仅版本号 bump，不涉插件域）；插件仓 `main` @ `1836ba6`
> 方法：6 路只读探索（cap.todo/bus、dispatch、agent-gallery、锚点核验、插件仓、文档测试 i18n）+ 关键判定本机 grep 复核。所有结论以实测为准，grep 证据见各节。

---

## 0. 结论速览

1. **§2 边界判定全部闭合**，7 插件的「可删集 / 必留集」已精确到文件（§5、§6）。
2. **交接单需修正 4 处**（§3 勘误）：SchedulerPanel 归属误记、aiChatDispatch 撞名、session-v2 撞名、`web/api/ipc.rs` 桥接层整类遗漏。
3. **两个重大边界发现**（交接单未预见的）：
   - `computer_control/` 业务核被 SimpleAI 引擎原生工具（`simple_ai/tools/computer.rs`）共用 → **computer 外移不能删 computer_control**，只删 MCP server 面。
   - 专家自助维护 MCP 工具（`save_agent`/`find_expert`/`save_roster` 等六件套）寄生在 `dispatch_mcp_server.rs` → 删 dispatch server 会连带切断 AI 写专家通道。
4. **agnes 外移基本零重建**：外置 v0.1.1 工具面与内置 5/5 同名对齐，剩余工作 = 主仓删码 + 插件仓删 legacy 迁移分支 + 修 update.json drift。
5. **computer 外移是唯一硬骨头**：Node 不可行；SPEC 无平台声明字段（`deny_unknown_fields`，加字段整个 manifest 装不上）；zip 带 exe 机制可行（imgforge 带原生 dll 先例）但无 exe 先例。
6. **polaris-bus 绝不可删**（宿主通用实锤）：`bus_dispatch` 全量放开 18+ cap + MCP Bridge 自愈；其前端声明寄生在 todo manifest，删 todo 后声明消失但后端注入不受影响。
7. **需求承接确认**：needs 插件数据面完全自包含（本地 md + tmp/rename 原子写），与主仓 requirements 后端**零依赖**，删 requirements 不断 needs。

---

## 1. 现状基线

- 12 个内置插件（`src/plugin-system/builtinPlugins.ts:121-141`）：core / todo / requirement / computer / personal-hub / agnes / agent-gallery / ask / dispatch / browser / scheduler / contracts。清理后剩 **core / ask / browser / scheduler / contracts**（另 `polaris.ui-frame` 仅 chatCard 精确注册，不在 registry）。
- 内置 MCP server 全部由 `polaris-mcp` 单 bin 子命令提供（`bin/polaris_mcp.rs`：requirements:63 / agnes:67 / ph:71 / computer:75(cfg windows) / bus:79 / scheduler:90 / ask:96 / browser:100 / dispatch:108）；前端 manifest 写的 `polaris_*_mcp` command 是名义伪名（`mcp_config_service.rs` 结构无 command 字段，真实 command 于 :489/:600 生成）。交接单该说法实测成立。
- 插件仓：128 个插件条目（index.json）；agnes v0.1.1 在售（:373 起）；needs 为 http 常驻服务形态（反模式参照）；imgforge 证明 zip 可携带原生二进制（sharp 的 dll/.node/wasm 随包）。

---

## 2. §2 边界判定——polaris.todo

| 符号 | 判定 | 关键证据 |
|---|---|---|
| `cap.todo`（`router/todo_capability.rs`，8 action，Sqlite `stores/todo.db`） | **功能专属，可随插件删** | 注册点仅 `state.rs:506`（主进程）+ `bus_mcp_server.rs:130`（bus 进程）+ `router/mod.rs:41,78`；无任何 Rust 内部 dispatch 调用方；前端唯一调用方 `simpleTodoService.ts` |
| `bus_mcp_server.rs`（polaris-bus） | **宿主通用，绝不可删** | 4 工具（bus_help / bus_dispatch / bus_mcp_status / bus_mcp_regenerate）；bus_dispatch 全量放开本进程 18+ cap（http/fs/bash/kv/ui/registry/git/context…），todo 仅 1 项；兼 MCP Bridge 自愈 |
| polaris-bus 前端声明 | **归属错位**：后端挂 `polaris.bus`（`mcp_config_service.rs:28,246-254`），前端唯一声明在 `todo/manifest.ts:13` | 删 todo 壳 → 前端失去 bus 开关 UI；后端注入链（`ai/launcher.rs:111→795`）只认后端 registry，不受影响 |
| AI todo 事件协议（`src/ai-runtime/event.ts` todo_* 六事件） | **死代码** | 后端 `models/ai_event.rs` 零 todo 变体；全仓无 emitter/consumer；`eventHandler.ts:1053` 显式 no-op。可顺手清 |
| Chat 的 `TodoWriteRenderer`（26 处） | **宿主通用，勿动** | 渲染 Claude Code 引擎 TodoWrite 工具块，与 cap.todo 零关联 |
| `form_flow.rs:33` FORM_TARGET_WHITELIST / `uiDispatchService.ts:293` 白名单 | 宿主通用机制，**仅摘 cap.todo 一个元素** | ask form 工具 / AI 注入 UI 按钮的低危 target 白名单 |

**todo 删码联动清单**（能力一并删的完整面）：`router/mod.rs:41,78`、`state.rs:397,506`、`bus_mcp_server.rs:38,130,557(MODULE_DOMAINS "todo" 行)、826(测试)`、`form_flow.rs:33`、`ask_mcp_server.rs:225,259,273`（文案）、`models/prompt.rs`（`PromptModuleType::TodoManagement` + :288-298 模块内容——教 Bash+jq 读旧 `.polaris/todos.json`，与 todo.db 早已脱节）、`structuredExtractionService.ts` 的 `extractTodos`(:175)+TodoCreateParams import（`cli_extract_structured` 命令本身通用，保留）、`LeftPanel.tsx:220,242,266` + `App.tsx:49,319` 硬编码分支、`toolSwitcherData.tsx:23-24`、`ToolSwitcher.tsx:55`（'todo'→automation 分组）、AGENTS.md §三 cap 清单（28→27）+ `plans/two-bus-architecture.md`。

**决策点 D1（polaris-bus 声明去向）**：推荐**后端 registry 不动、前端声明随 todo 壮士断腕**。代价 = 设置页失去 bus 的插件级开关（`disabled_builtin_mcp_server_names` 按 pluginId=`polaris.bus` 查 PluginState 将永远查不到禁用记录）；兜底仍在：`conversationStoreUtils.ts:76-86` 硬编码 `'polaris-bus'`（uiControl 模式摘除）+ `mcp.sessionDefaults` 会话白名单。替代方案（把声明迁到一个仍叫 `polaris.bus` 的前端 manifest）等于造隐形壳，违反反模式，不推荐。

---

## 3. §2 边界判定——polaris.requirements

**整域删除成立，无宿主通用消费者**（本机复核实锤）：

- Rust 侧消费者全部在删除域内：`bin/polaris_mcp.rs:31,65`、`commands/requirement.rs`、`web/api/ipc.rs`（**交接单未列**：:296-302 四个 path 分支 + :1900-1906 `get_req_repo` + :1918/:1961/:1966 dispatch 函数）；其余命中全为注释（`simple_ai/mcp/{client,types}.rs` 头注释、`computer_mcp_server.rs:3`、`legacy_storage_migrate.rs:296`）。
- 前端封闭：`requirementService.ts`/`requirementStore.ts` 仅被 `RequirementPanel.tsx` + `stores/index.ts`（barrel）引用。
- needs 插件（承接方）自包含实锤：三层代码 grep 零 `requirement` 依赖，宿主面仅 cap.kv（token）+ cap.http（面板转发）；主仓删 requirements 后端不断 needs。
- 删除集：`src/plugins/requirement/`、`components/RequirementPanel/`（~1888 行）、`requirementService.ts`(298)、`requirementStore.ts`(309)、`types/requirement.ts`(321)、`commands/requirement.rs`(420)、`requirements_mcp_server.rs`(646)、`unified_requirement_repository.rs`(624)、`models/requirement.rs`(131)、ipc.rs 桥接、`polaris_mcp.rs` requirements 子命令、mcp_config_service 常量+manifests+registry 条目、locales ×2(184 行)、mcp.test.ts。

---

## 4. §2 边界判定——polaris.dispatch 与 polaris.agent-gallery

### 4.1 dispatch：三档删除粒度（核心结论）

| 粒度 | 内容 | 后果 |
|---|---|---|
| **A 档（推荐）** | 插件壳 `src/plugins/dispatch/`(仅 manifest) + `dispatch_mcp_server.rs`(1116 行,12 工具) + `polaris_mcp.rs` dispatch 子命令 + mcp_config_service 条目(:15,:24,:158-161,:210-218,:874) + `toolConfig.ts:277` 显示名 + `chatBlocks/index.tsx:26,56-59` DispatchTaskCard 接线与卡片 | **AI 失去全部 12 个派发工具**；`/dispatch` 斜杠命令与 `/nexus` 专家团**完整可用**（走 `invoke('dispatch_create_task')` 与 nexus_pipeline，绕过 MCP） |
| B 档（顺带清理） | A + `commands/dispatch.rs` 的 `dispatch_list_tasks`/`dispatch_delete_task`（**前端 0 调用方**，实锤）；`dispatch_create_task`/`dispatch_report_status` **必须保留**（命令路径地基） | 无额外损失 |
| C 档（**禁**） | 连 `dispatchTaskService.ts`/`dispatchStore.ts`/`ask_listener.rs` 派发帧/`state.rs` DispatchedTask 注册表一起删 | `/dispatch`、`/nexus`、报告回流注入（`createConversationStore.ts:2387-2392` formatPendingDispatchReports）全断 |

**交接单证伪/证实**：
- ❌ SchedulerPanel.tsx 属 dispatch → **误记**，实属 `polaris.scheduler`（builtinPlugins.ts:153-155，保留插件）。
- ❌ `aiChatDispatch.ts` 属 dispatch → **撞名**，是 cap.ai.chat RouterBus 客户端（v2-kernel/engines/桌宠/Scheduler 全依赖），严禁删。
- ❌ `session-v2/kernel/*` 涉及 dispatch → **撞名**，19 处全是 `dispatchEvent` 事件路由，0 处 import 插件。
- ⚠️ conversationStore 62 处 dispatch 词汇中**仅 2 处真实相关**（`eventHandler.ts:97-115` isBusDispatchTool 识别 cap_dispatch 分支、报告回流注入），其余是消息队列派发撞名。
- ✅ DispatchTaskCard 由 `mcp__polaris-dispatch__dispatch_task` tool_call 触发；`/dispatch` 用户命令路径本就不产卡片（后端命令不 emit 事件，`commands/dispatch.rs:152`），故 A 档删卡片无用户可见 UI 损失（实施时复核一次）。

**决策点 D2（专家自助维护工具的去向）**：`dispatch_mcp_server.rs` 12 工具中含 roster/agent 六件套（`dispatch_roster`/`find_expert`/`save_agent`/`delete_agent`/`list_agents`/`save_roster`）与 `cap_dispatch`/`cap_list`（AI 自改造 UI 的**第二通道**，且是「前端挂载门只摘 polaris-bus、挡不住 polaris-dispatch」的治理旁路——`state.rs:418`、`policy_permission.rs:158` 注释指认）。删 A 档后：
- AI 失去**自建/维护专家**能力（`save_agent` → ask_listener 帧 → `agent_corpus.rs` 链路断；专家只能手建 `<DataRoot>/agents/<slug>.md` 文件）；
- AI 失去 cap_dispatch 旁路（对安全治理是**收益**）；
- `ask_listener.rs:1640-1790` 的 agent_save/agent_delete/agent_list/roster_save 帧处理成死代码，可随 A 档顺带删（联动 grep 确认无其它发帧方）。
若用户想保留 AI 自助维护，需把六件套迁去别的 server（如 polaris-bus）——**这是新功能开发，超出本次「清理」范畴，默认随定案移除**。

### 4.2 agent-gallery：壳极薄，专家系统是宿主通用

| 符号 | 判定 | 证据 |
|---|---|---|
| `src/plugins/agent-gallery/`(仅 manifest,24 行) + `AgentGalleryPanel.tsx`(1036) + builtinPlugins.ts:12,136,144-145 | **功能专属，可删** | `polaris.agent-gallery` 全仓仅 2 处字符串命中（manifest 自身 + 注册行）；Panel 无其它 importer；i18n 的 `labels.agentGalleryPanel` key 本就不存在 |
| `commands/agent_corpus.rs`(262) | **宿主通用，保留** | AI MCP save_agent 通道（ask_listener.rs:1662-1775 四帧调 `*_inner`）+ web IPC 桥（ipc.rs:82-130 七处）+ 引擎数据层薄封装（`simple_ai_list_agents_inner` 直调 `simple_ai::list_agents()`）；数据 = `<DataRoot>/agents/*.md` + `rosters-user.json`，与引擎读同一份 |
| `capabilities/subagent.rs`(61) | **宿主通用，保留** | Phase 2 引擎能力 seam（未接线但非死代码：`simple_ai/tools/agent.rs` dispatch_agent 真实现，seam 为插件覆盖预留） |
| `stores/agentStore.ts`(161) | **宿主通用，保留** | Chat 主链路 4 消费点（ChatInput `@专家`/斜杠补全、chatCommandRouter、SessionConfigSelector、useAppInit 预载） |
| `services/agentSlashCommand.ts`(106) | **宿主通用，保留** | `/agent` `/dispatch` `/nexus` 解析与 slug 重写，Chat 输入链路依赖 |
| `services/tauri/agentCorpusService.ts`(150) | **混合，裁剪保留** | 专家 CRUD（agentStore 依赖）保留；nexus 管道封装（`startRoster` 等仅画廊调用）可裁——`/nexus` 命令直调 `transportInvoke('nexus_start_roster')` 不经它 |

**与 dispatch A 档联动**：agent_corpus 保留不等于 AI 写专家通道存活——通道入口（save_agent MCP 工具）在 dispatch server，见 D2。

---

## 5. 外移三项落地方案评估

### 5.1 agnes（#6）——不要重建，核对后删码

- 外置 v0.1.1（index.json:373）**已具备接管条件**：stdio MCP + 面板 + media-card + configSchema 齐全，工具名 5/5 与内置一致（generate_image/generate_video/query_video/get_config/set_config）。
- 差异仅：server id（polaris-agnes vs agnes-mcp）、配置路径（`<dataRoot config_dir>/agnes/config.json` vs `<appConfigDir>/config.json` 的 `plugins["agnes"]`）、面板数据面（Tauri command vs cap.http 转发，v0.1.1 已修跨域）。内置版已 `deprecated:true` + `enabledByDefault:false`。
- 插件仓动作：① 删 `mcp/server.js:92-99` 旧 `agnes/config.json` 迁移分支（含 :8-9 注释、:69 legacy 读取）——「不做历史兼容」；② 修 update.json argsTemplate drift（plugin.json 2 参数 vs update.json 3 参数，**以 plugin.json 为准**）；③ server.js 变更 → 版本 bump（0.1.2）+ pack + index.json/sha256/tag 四处同步。
- 主仓动作：纯删码——`src/plugins/agnes/`(1385) + `agnes_mcp_server.rs`(875) + `commands/agnes.rs`(471) + `polaris_mcp.rs` agnes 子命令 + mcp_config_service 条目 + builtinPlugins 三处注册（:11,135,150-152）+ chatCardRegistry.registerBuiltin(:168-177) + toolConfig 显示名 + chatCardRegistry.test fixtures。

### 5.2 personal-hub（#5）——Node 重写工作量低

- 金标：`personal_hub_mcp_server.rs`(884) 5 工具 ph_list/create/get/update/delete，**Supabase 纯 REST**（非 SDK）；`personal_hub_crypto.rs`(141) = AES-128-CBC + PKCS7 + OpenSSL "Salted__" 盐格式 + EVP_BytesToKey(MD5)，仅加密 description 字段，**与 crypto-js 完全兼容**。
- Node 版 300-400 行零依赖可 1:1 复刻（fetch + node:crypto 自实现 EVP_BytesToKey ~40 行）；面板 bundle 自包含改造（去 `@/` 宿主 imports，参考 agnes vite.config）；configSchema 承载 supabase url/anon key/session token/encryption key；**session_token 获取约定需重新设计**（主仓=前端登录后写 config；外置版=面板登录后经 appConfigWrite 写 config，MCP 读 config）。
- 主仓删除集：`src/plugins/personal-hub/` + `components/PersonalHub/`(8 文件 1619) + `services/personalHub/`(403) + `personalHubAuthStore.ts` + `hooks/personalHub/useLinkFilter.ts` + `Settings/tabs/PersonalHubTab.tsx` + SettingsPage/Sidebar 注册点（SettingsSidebar.tsx:66、SettingsPage.tsx:26,56,100,327）+ `personal_hub_crypto.rs` + `personal_hub_mcp_server.rs` + `polaris_mcp.rs` ph 子命令 + mcp_config_service 条目 + `models/config.rs:120-123` personal_hub 字段 + locales（settings.json personalHub 节 ~40 行、common.json labels.personalHubPanel）+ builtinPlugins 注册（:10,134,147-149）+ toolSwitcherData :31-32。

### 5.3 computer（#4）——唯一硬骨头，先拍方案

- **Node 纯 JS 不可行**：inspect_ui/click_element/set_text 深依赖 Windows UI Automation（enigo 0.6 / uiautomation 0.25 / windows-sys 0.59 / xcap）。
- **SPEC 无平台声明字段**：`PluginManifestFile` 带 `deny_unknown_fields`（models/plugin.rs:620-621），manifest 加 platforms/os 字段整个插件装不上。非 Windows 端只能「装上后 MCP 启动失败→server 不出现」（宿主容错表现需实施时验证）或 README 声明。
- **zip 带 exe 机制可行**：pack.js 无二进制排除/大小限制；command 支持 `{{pluginDir}}` 展开（`mcp_config_service.rs:691-692`）→ `command: "{{pluginDir}}/bin/computer-mcp.exe"` 可跑；imgforge 带原生 dll 先例。无 exe 直接先例。
- **方案 a（推荐）**：主仓 `src-tauri` 新增独立 bin target（computer_control + computer_mcp_server + 最小 main，cfg(windows)），release 构建产物拷入插件仓 zip。金标单源保留；代价 = 新 bin 对 dev 循环的构建时间影响（对照「禁裸 cargo build」纪律，构建走手动/CI 一次性命令）。
- 方案 b（PowerShell/.NET System.Windows.Automation + P/Invoke）：技术上有路径但 19 工具逐一重写工程量大、金标对齐难，不推荐。
- **重大边界：`computer_control/`(934 行) 必须保留在主仓**——SimpleAI 引擎原生 computer 工具（`ai/engine/simple_ai/tools/computer.rs`，247 行，cfg windows）复用同一 `ComputerController`，属 AI 引擎能力不随 MCP server 外移。主仓实际只删：`computer_mcp_server.rs`(592) + `polaris_mcp.rs` computer 子命令 + mcp_config_service 条目 + manifest + toolConfig 显示名（前端无面板，壳仅 manifest.ts 35 行）。

---

## 6. 交接单勘误与锚点补遗

### 勘误（§2/§3 表述修正）
1. SchedulerPanel.tsx 归 `polaris.scheduler`（非 dispatch）；dispatch 的 UI 是 `Chat/dispatch/DispatchTaskCard.tsx`（chatBlocks 硬编码接线，非插件注册）。
2. `aiChatDispatch.ts` / session-v2 kernel 的 dispatch 词汇 = 撞名，不在删除域。
3. `src/plugins/todo/manifest.ts` 的 mcpServers 声明的是 **polaris-bus**（复用），todo 无独立 server——删 todo 与 bus 判定强联动。
4. `builtin_plugin_mcp_manifests()`(:144-179) **本就不含 polaris-bus/agent-gallery**，仅 8 条且只被自身测试消费——它是死重声明面，可考虑连测试一起删。

### 锚点补遗（交接单未列）
- **`web/api/ipc.rs` 桥接层整类**：requirements :296-302,:1900-1918,:1961,:1966（删）；agent_corpus :82-130（**保留**，专家数据层）；dispatch :72-81,:167-171（**保留**，基础设施桥）；nexus_dispatch_group :159（保留）。
- `ai/launcher.rs:163` 注释、`state.rs:654`、`mcp_config_service.rs:541,593` 注释中的插件 id。
- `plugin_events.rs:307` 第二处 polaris.todo 测试引用（交接单只列了 :301）。
- `chatCommandRouter.ts`（/dispatch /nexus /agent 入口，保留域）；`useAppEvents.ts:25,94`（dispatch-task-request 监听，保留）。
- `ToolSwitcher.tsx:40-55` getToolGroup 分组映射；`LeftPanelTabStrip`/`narrowTabStore` 实测无命中（无需改）。
- `polaris_mcp.rs:118` 未知子命令错误消息漏列 bus（内部不一致，实施时顺带修）；辅助函数判定：`parse_config_dir_args` 删 requirements/agnes/ph 后仍被 bus+scheduler 使用**保留**；`parse_ask_listener_args` 删 dispatch 后仍被 ask/browser 使用**保留**。
- 简单 AI MCP client（`simple_ai/mcp/{client,types}.rs`）头注释以 requirements_mcp_server 为镜像范例——纯注释，顺手改。

---

## 7. 测试 / i18n / 文档同步清单（要点）

**测试**：`mcp.test.ts`（默认启用断言 + it.each 表删 requirements/computer 行，对照项换 scheduler）、`pluginStore.test.ts:19`（polaris.todo fixture 换中性 id）、`chatCardRegistry.test.ts`（polaris-agnes fixture）、`uiConsumeLink.test.ts`（cap_dispatch 通道用例随 A 档失效；bus_dispatch + cap.todo 负例随 D1/D-c todo 判定）、`formBlock.test.ts`（cap.todo fixture，条件）、`uiControlGate.test.ts`/`toolConfig.displayName.test.ts`（polaris-dispatch/bus 条目）、`dispatchTaskService.test.ts`/`agentSlashCommand.test.ts`/`agentStore.test.ts`（**保留**——基础设施）。registry*.test.ts 实测零引用（交接单猜测项降级）。Rust：`mcp_config_service.rs:1623,1639`、`audit_sink.rs:457,619,628`、`policy_permission.rs:475`、`plugin_state_service.rs:71`、`plugin_events.rs:301,307`。

**i18n**：删 todo.json×2(127)、requirement.json×2(184)、common.json labels（todoPanel:47/requirementPanel:51/personalHubPanel:56/agnesPanel:57）、menu.json:35、chat.json todo 节(:162-172)、settings.json personalHub 节(:29,:644-684)、tools.json names.computer(:50)、en-US/systemPrompt.json:7 文案（提及 requirements library）；`src/i18n/index.ts:9,18,28,37,49,58,69,78` 删 import 注册。**易误删**：chat.json dispatch 节(:2-31) 属保留的派发文案；tools.json todoList(:41,101,105,106) 属核心 TodoWrite 工具显示名。

**文档**：`docs/mcp/1-current-state.md`（:7,:38,:42,:71 更新）、`2-roadmap.md`/`3-execution-playbook.md`/`4-manifest-schema.md`（:129-136 对齐表重写为清理后清单；2-roadmap/4-schema 的 polaris.todo 表述本已失真）、`docs/personal-hub-mcp-server.md`（109 行，加历史归档标注）、`plans/plugin-visibility-plan.md`（与本次裁决冲突，加失效标注）、`plans/dispatch-plugin-panel-plan.md`（整案作废，加失效标注）、`plugins/docs/host-slimming-incremental-roadmap.md`（§4 基线表 :113-117 内置壳数 12→…、§7:146 与 §4:116 的 dispatch 终态矛盾需改）、`plans/core-slimdown-plugin-extraction-plan.md`（§4.1 批次表勾销 B1-2/3/4/5 并补记 todo/agent-gallery/dispatch；§4.3:105「dispatch 壳保留」需改）、AGENTS.md（§三:76 cap 清单、§一:31 vitest 计数）、`prd-preview-extraction-playbook.md` §6/§8 照抄执行（本文件保持归档）。

---

## 8. 验证门槛与残留 grep 基线（实施后对照）

- 门槛：`pnpm typecheck` + `pnpm lint` + `pnpm test:run` + `cargo check` + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp`（删 MCP 子命令必跑）+ `cargo build --bin polaris-mcp`（schema 变更）；插件仓 `node scripts/validate.js` + 真宿主双端冒烟（安装→启用→AI 调工具→面板开→禁用→工具消失）。
- 残留基线（清理前，`src` + `src-tauri/src`）：G1（7 个 plugin id）= **31**；G2（polaris-* 连字符）= **101**；G3（*_mcp_server/agent_corpus）= **45**；文档层 = 16。清理后要求业务代码零命中，仅历史归档文档保留。
- 注意遗留断言：G2 中 bus/scheduler 相关命中属保留域，验收口径按 id 分组而非总数归零。

---

## 9. 决策点汇总（实施前拍板）

| # | 问题 | 推荐 |
|---|---|---|
| D1 | polaris-bus 前端声明随 todo 删除后，设置页失去 bus 插件级开关 | 接受（后端 registry 不动；uiControl 硬编码兜底仍在） |
| D2 | dispatch A 档使 AI 失去 12 工具（含专家自助维护六件套、cap_dispatch 旁路） | 随定案移除；专家自助维护不迁移（迁移=新功能） |
| D3 | cap.todo capability 是否随 todo 一并删（AGENTS.md cap 清单 28→27） | 删（无其它核心消费者；bus 注册表同步摘） |
| D4 | computer 外移方案 a（Rust exe 随 zip）/ b（PowerShell） | a；主仓新增独立 bin target，产物拷入插件仓 |
| D5 | dispatch A 档连带的 `chatBlocks` DispatchTaskCard 接线 + 卡片删除 | 随 A 档删（/dispatch 用户路径本就不渲染卡片；实施时复核） |

## 10. 实施顺序建议（独立 worktree）

1. 先在 `plans/` 补简短 spec（引用本分析为附件），按 AGENTS.md §七。
2. **移除批**（1-2 commits）：todo 域（含 cap.todo + bus 联动 + 死代码顺手清）→ requirements 域（含 ipc.rs 桥接）→ agent-gallery 壳 → dispatch A+B 档（含 ask_listener 死帧清理）。每域跑门槛。
3. **agnes**：主仓删码 + 插件仓去 legacy/drift 修复 + 发版（同 commit 主题分仓）。
4. **personal-hub**：插件仓 Node server + 面板改造 + 发版 → 主仓删码。
5. **computer**：主仓 bin exe → 插件仓 zip + 发版 → 主仓删 MCP server 面（保留 computer_control）。
6. 文档/AGENTS.md/roadmap 对账同步收尾。

已知实施风险（记忆库）：worktree 缺 dist 坑（并行 UX 轮实录）、pnpm vitest 假失败用 npx 复核、cargo check 须在 src-tauri 下跑、junction 陈旧副本坑（插件仓 dev-link 冒烟时）。
