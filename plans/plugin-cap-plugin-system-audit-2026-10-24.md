# 插件与 Cap 机制全面审计（plugin-cap-plugin-system-audit）

> 目标：对照用户提出的六个关注点（插件提供 cap、仅装 cap 的插件、插件启动/端口管理、cap 的 AI 使用说明、插件注册 skill、插件改造样式布局），全面审查 cap 总线与插件机制的**代码现状问题**。
> 方法：5 个并行分析方向（cap 总线架构 / 插件生命周期与端口 / manifest 契约 / AI 可见性 / 插件 UI 与样式），关键 P0 结论已在源码二次抽查验证。
> 性质：**审计报告（只分析，不实施）**。行号以 2026-10-24 工作区为准。
> 日期：2026-10-24

---

## 0. TL;DR

- **cap 总线骨架是好的**（注册表驱动 + describe 自描述 + 统一 gate/审计 + 动态注册即时可见），但**只实现了 L1 命名自由**：插件无法提供真正的 cap 逻辑（`DynamicHandler` 仅 `Forward` 别名，禁覆盖）。`plans/plugin-cap-full-freedom-v1.md` 的 L2/L3 规划与代码现状逐条吻合、尚未实施——且该方案的地基（PluginServiceManager）自身带 P0 bug，方案的多个前提（超时护栏、RealContext、PSM 可靠拉进程）现状缺失。
- **「仅装 cap 的插件」契约上已可行**（商城已有 4 个实例），但设置页没有能力提供者展示面、executors 无启停门控、manifest 校验只覆盖 2/11 块。
- **插件生命周期治理是最薄弱环节**：端口是「10000 起计数器、不探测不查冲突」；`stop_service` 存在竞态导致**停止/重启后旧进程变僵尸继续占端口**；应用退出产生孤儿进程；Web 模式下插件服务完全不可管理。
- **cap 的 AI 使用说明问题确认**：三个入口三个名字、硬编码动作枚举已过时、bus_help 自相矛盾、prompt_snippet 对 AI 是死数据、工具 schema 靠人工重建 bin。
- **插件注册 skill 无通道**（宿主已有健康的 SKILL.md 机制，但 `deny_unknown_fields` 下插件写了 skills 块会整体装不上）；改造面小。
- **「改造任意位置样式布局」缺三个地基**：CSS 作用域（现状全局裸注）、布局/插槽贡献协议（视图区只有 activityBar 一个值、六套挂载机制各自为政）、插件 JS 零沙箱（同 window、`__POLARIS_HOST_INVOKE__` 可调任意 command）——不补齐无法安全放开。
- **两个用户未点名但必须前置处理的 P0**：动态转发可洗白 Remote deny 基线（安全）；流式回退分支零审计 + 审计内容过薄。

---

## 1. 现状架构速览（分析基线）

### 1.1 cap 总线

- **静态装配约 27 个内置 cap**：`state.rs:432-629`（cap.hook/kv/http/todo/bash/fs/prompt_snippet/context/data_root/git/pluginDiscovery/pluginServiceManager/config/stream.echo/help/ui.theme/ui.chat/ui.input/self.inspect/self.mutate/mcp/voice/registry + 持久化动态重建）+ `lib.rs:583-601`（cap.ai.chat 流式、cap.history、cap.ui.render）。
- **三入口**：Tauri IPC `router_dispatch`（`commands/router.rs:73-142`，Source 按 webview label 后端判定）、Web HTTP `/api/ipc`（`web/api/ipc.rs:2812-2848`，Source=Remote+token）、MCP 帧（polaris-dispatch / polaris-bus，`dispatch_mcp_server.rs` / `bus_mcp_server.rs`）。
- **双进程**：主进程与 bus-mcp 独立进程各持一份 RouterBus（bus 进程缺 cap.config/plugin*/mcp/voice/ai.chat/history/ui.render，`bus_mcp_server.rs:97-188`）；动态 cap 经共享 kv 持久化双方重建。
- **权限**：`PolicyPermission` = config 规则 + 内置 Remote deny 基线（cap.data_root*/plugin*/http*/bash*/fs*/ui*/self.mutate*，`policy_permission.rs:170-196`）；无匹配默认 Allow。
- **审计**：tamper-evident JSONL 链（`audit_sink.rs`），但字段仅 capability/source 变体/action/hash。

### 1.2 插件的五条既有通道（互不统属）

| 通道 | 方向 | 作用层 | 证据 |
|---|---|---|---|
| `contributes.mcpServers` | 宿主→插件 | AI 引擎工具层（stdio MCP） | `mcp_config_service.rs:636-726` |
| `contributes.services` | 宿主拉插件进程 | 后台常驻服务（tokio process） | `plugin_service_manager.rs:169-283` |
| `contributes.toolProviders` | 插件替换内置 | 工具域 MCP server 替换 | `mcp_config_service.rs:931-982` |
| `contributes.executors` | 插件注册执行器 | ExecutorRegistry（定时任务等） | `state.rs:349-361` |
| `cap.registry register`（动态 cap） | 任意→既有 cap | RouterBus 别名转发 | `registry_capability.rs:113-189` |

**没有任何一条是「插件提供 cap」**。`capabilities/registry.rs` 里的 Provider 覆盖链 CapabilityRegistry 是无调用方的死代码骨架。

---

## 2. 按用户关注点逐项审查

### 2.1 插件注册提供 cap —— 现状只有 L1，方案未实施，且地基有洞

**现状**：
- `DynamicHandler` 只有 `Forward` 单变体（`dynamic_capability.rs:41-51`）；`do_register` 强校验 `handler.type == "forward"`，其余直接报错（`registry_capability.rs:126-131`）。
- 覆盖被三重封死：`check_id_available` 拒绝任何已注册 id（`registry_capability.rs:56-64`）；`do_unregister` 拒卸非动态能力（`:203-206`）；SENSITIVE_TARGETS 黑名单仅 4 项（`:41`）。
- 持久化健康：persist=true 默认落 kv 域 `cap.registry`，重启双方进程重建（`state.rs:533-571`、`bus_mcp_server.rs:154-170`），有端到端测试。

**与 `plans/plugin-cap-full-freedom-v1.md` 的差距**：方案自述的 L1/L2/L3 现状盘点与代码完全吻合。方案未实施（P0-P5 均未动工）。

**方案落地前必须先补的地基（方案未充分覆盖）**：
1. **【P0·安全】动态转发洗白 Remote deny**（已验证）：`DynamicCapability::invoke` 转发时把 source 无条件改写为 `Source::Plugin{caller:"dynamic:<id>"}`（`dynamic_capability.rs:121-130`）。cap.registry 不在 Remote deny 名单，远程/未鉴权 webview 可注册一个指向 `cap.bash`/`cap.fs`/`cap.http`/`cap.data_root`/`cap.plugin*` 的别名，再调别名即以 Plugin 身份过 gate——整条 Remote 收紧被洗白，`defaults` 还能预埋 payload。放开 L2/L3 之前必须先修（保留原始 source 链，或敏感目标转发要求原 source 具备权限）。
2. **【P0·可靠性】超时护栏在 dispatch 层完全不存在**：同步 `invoke` 可无限阻塞（`spawn_blocking` 池可被占满）；流式泵在能力永不断流时永不广播 `dispatch.end`（`router/mod.rs:301-317`）。方案 §3.5 的「强制 30s 超时」目前一处都没有。
3. **RealContext 三处占位**：`check_permission` 恒 Allow、`resolve_cap` 未实现、`caller_id` 恒 "core"（`router/mod.rs:655-674`）——未来插件 handler 拿到的 ctx 是残缺的，方案假设的「能力内二次权限裁决」不成立。
4. **PSM 地基不稳**：方案 P1 假设「复用 cap.pluginServiceManager 拉插件进程」，但 PSM 自身有 P0 停止竞态与孤儿进程问题（见 §2.3）。
5. **register_handle 不查重 id**（`router/mod.rs:594-599`）：同 id 双注册后 dispatch 取序不定；运行期防线只在持久化重建路径（`state.rs:549-555`）。覆盖链改造（方案 §3.2 把 handles 改 Vec）顺带要解决这个。

### 2.2 仅安装 cap 的插件 —— 契约已可行，体验与治理粗糙

**已可行的证据**：
- `contributes` 各块均可空（`models/plugin.rs:136-164`）；`validate_manifest_fields` 不要求 views 非空（`plugin_service.rs:1628-1645`）；安装不因无 views 失败（`:1252-1265`）。
- 商城已有 4 个纯能力插件实例：capability-runtime、animation-3d、douyin-publish、zcode-adapter（均无 UI）。

**粗糙点**：
1. **无「能力提供者」展示面**：纯能力插件在设置页只剩 MCP server 开关；`listToolProviderContributions` 有数据但无专门 UI 语义。
2. **executors 三处不一致**（`state.rs:349-361`）：注册不看启停状态（禁用插件的执行器仍可被 IPC 调用）；只扫 User scope（项目级插件的 executors 不注册，而 MCP 侧带 workspace 扫描）；只在启动时注册（装新插件不重启不生效）。
3. **manifest 校验只覆盖 2/11 块**（views + mcpServers，`plugin_service.rs:1608-1661`）：services/executors/toolProviders/styles 等写错字段延迟到运行时静默失败。
4. **权限模型不匹配**：permissions 固定 6 布尔（`plugin.rs:456-471`），承载不了「提供 cap」的分级授权诉求（full-freedom 方案已规划 OVERRIDE_LEVELS）。

### 2.3 插件启动/端口/生命周期管理 —— 最薄弱环节，多个 P0/P1

**架构现状**：两条进程通道完全独立——`contributes.services` 由宿主 PSM 拉常驻进程（应用级单例）；`contributes.mcpServers` 由 AI 引擎按轮次 spawn（每条消息 spawn/kill 一轮全部 server，`chat_loop.rs:114-140`）。

**用户抱怨逐条实锤**：

1. **【P0】`stop_service` 竞态，几乎从不真正杀进程**（已验证）：`spawn_process_watcher` 启动即 `child.take()` 拿走子进程（`plugin_service_manager.rs:497-503`），之后 `stop_service` 的 `take()` 恒得 `None`，kill 分支跳过（`:318-322`）——状态标 Stopped、端口已释放、**进程继续运行**。`restart` = stop(不杀) + start(新进程) → 同服务双进程并存，旧进程占端口。
2. **【P0】应用退出产生孤儿进程**：主窗口关闭直接 `std::process::exit(0)`（`lib.rs:857-870`），`stop_all`（`:418-429`）全仓库无调用方，无 Windows Job Object——`kill_on_drop` 在 exit 下失效。
3. **【P0】端口已释放但僵尸进程仍占 → 再分配冲突**：问题 1 的下游——PSM 把端口分给新服务，未死进程仍 bind，新进程 bind 失败但宿主照样标 Running。
4. **端口无治理**（用户所述「没有跟随端口管理」的直接证据）：manifest 声明端口仅记账不查冲突（`plugin_service_manager.rs:607-612`）；未声明则 10000 起纯计数器分配（`:590-605`），无 OS bind 探测、不避宿主端口（9830/56496-60098）、不避 Windows 保留段；与 ask_listener 已有的「端口池 + 落盘自愈」体系（`ask_listener.rs:131-196`）完全脱节。
5. **默认什么都不启动**：`performance.pluginAutoStart` 默认 false（`useAppInit.ts:100-121`）；`ensureServiceRunning` 无生产消费方；唯一常态触发是用户切插件开关（`usePluginServiceSync.ts:30-104`）。
6. **restart_count 只增不减**：跨手动重启保留，累计满 maxRestarts(默认3) 后自动重启永久失效（`:246-252`）。
7. **healthCheck 形同虚设**：失败只写 last_error，不改状态不重启（`:476-483`）；仅 http 型启用；spawn 即 Running 无就绪门槛。
8. **【P1】Web/浏览器模式插件服务完全不可管理**：`cap.plugin*` 对 Remote deny + Web 前端一律 Remote（`web/api/ipc.rs:2797-2826`）→ autostart/启停调用全被拒，功能变桌面专属。
9. **【P1】更新不停服务**：`apply_local_plugin_update` 直接 rename 换目录（`plugin_service.rs:462-602`），运行中进程持有旧文件，Windows rename 高概率失败；运行中服务继续跑旧代码。
10. **【P1】MCP server stderr 不消费**：piped 但从不读取（`mcp/transport.rs:99`）→ 爱写日志的插件 server 写满管道缓冲区后永久阻塞。
11. **「让 AI 重启」现状是无门控裸权限**：`cap.pluginServiceManager` 有 start/stop/restart/stop_for_plugin/autostart（`plugin_service_manager_capability.rs:146-242`），`bus_dispatch` 无白名单且 Plugin 来源无 deny（`bus_mcp_server.rs:220, 235-261`）→ 任意 AI 会话可停服务、甚至 uninstall（杀进程+删目录，`plugin_service.rs:639-927`），只有审计没有审批。且 dispatch 的 `Prompt` 裁决在 Phase 0 直接失败（`router/mod.rs:436-455`）——想做「AI 重启需用户确认」目前没有可用的审批通道。
12. 其他：服务状态仅内存（重启丢失、不回推前端，UI 长期陈旧）；uninstall 兜底按「命令行含插件目录」匹配可能误杀无关进程、非通用运行时按映像名全局 taskkill、wmic 在新 Windows 已移除；manifest 不校验 services 块；PSM 无任何单元测试。

### 2.4 cap 的 AI 使用说明 —— 问题确认，集中在「静态文本与动态注册表并存的最后一公里」

1. **一个总线三个名字**：AI 视角 `cap_dispatch`（polaris-dispatch）/ `bus_dispatch`（polaris-bus）/ 前端 `router_dispatch`；cap id 清单在三处手抄（`dispatch_mcp_server.rs:465-467`、`bus_mcp_server.rs:557`、`ask_listener.rs:1209`），好在 cap_list 动态兜底。
2. **硬编码动作枚举已过时**：`cap_dispatch` 的 payload description 抄死的动作清单缺 `form_submit/form_skip/form_template_*` 等（`dispatch_mcp_server.rs:481` vs `ai_chat_capability.rs:89-106`）——这是给 AI 的第一手参数说明。
3. **bus_help 自相矛盾**：同文件 :532 说「全量放开无白名单」、:557 仍写「白名单」。
4. **describe 质量分层**：cap.bash/cap.help/cap.ai.chat 好；cap.prompt_snippet 差（params 写「content/name 等」无逐字段说明，`prompt_snippet_capability.rs:259`）。几乎没有「何时不用」说明。
5. **prompt_snippet 对 AI 是死数据**：无提示注入、无使用引导，只能主动 cap_list 发现。
6. **工具列表会话级缓存**（`simple_ai/mcp/mod.rs:42-99`）：动态注册的 cap 对已启动会话不可见。
7. **schema staleness 风险仍在**：工具 schema 硬编码在各 MCP server、双二进制拷贝（dev target/debug 与 polaris-web/ 各一份），AGENTS.md:109 只是流程约定无构建校验。
8. **指引与通道脱节**：SimpleAI persona 教 AI 用 cap.bash，但该指引隐式依赖 dispatch server 在场（enableMcpTools=false 时被静默跳过）。
9. **工具面偏胖**：polaris-dispatch 12 工具里混了 6 个与能力桥无关的专家管理工具；form 工具描述 45 行；每会话 MCP 工具总量易膨胀。
10. **bus-mcp 进程忽略用户权限配置**：`PolicyPermission::from_config(None)`（`bus_mcp_server.rs:77`），同机两套权限语义。

### 2.5 插件注册 skill —— 宿主机制健康，插件通道为零

- **宿主已有 skill 机制**（SimpleAI Phase 4c）：扫描 `<work_dir>/.polaris/skills/` 与 `<DataRoot>/skills/`（项目级覆盖全局，`simple_ai/skill.rs:25-48`）；SKILL.md = YAML frontmatter + body；索引注入 + `read_skill` 按需加载（progressive disclosure）——模式健康。
- **插件无通道**：`PluginManifestContributes` 无 `skills` 键且 `deny_unknown_fields`——外部插件写了 skills 块**整个 manifest 装不上**；`discover_skills` 只读固定目录不读插件 installPath。
- 最接近的现有通道按接近度：mcpServers（无 progressive disclosure）→ cap.registry forward（仅别名）→ cap.prompt_snippet（AI 不可见）。
- **改造面最小的路径**：`contributes.skills` 声明块 + `discover_skills` 扫描插件 installPath + 命名空间与启停门（模式类比 contributes.styles）。`plans/plugin-system-zcode-compat-and-ai-ops-spec.md:100` 的 `plugin_skill_pack` 是已有远期规划（未实施）。

### 2.6 插件改造任意位置样式布局 —— 渲染协议完整，三个地基缺失

**已有呈现方式（5 类）**：A 侧边面板（views+panel，宿主 React 渲染）；B 聊天卡片（chatCards + plugin_card 事件，有 mcpServerId 归属校验防劫持）；C cap.ui.render 帧卡片（五帧 + v2 模板 DSL，≤64 节点白名单，明确「不做任意 HTML/JS」）；D 沙箱 iframe HTML 卡片（唯一真沙箱，cap 白名单仅 todo/kv）；E 零散挂载点（fileExplorerToolbarSlot、editorExtension 等，多为内置插件编译期专用）。

**三个地基缺失**：

1. **CSS 作用域**：`contributes.styles` 已声明已消费，但**全局裸注 head 末尾**（`src/plugin-system/styles.ts:27-47`）；`target:'slot'` 有名无实（只写 dataset，文档声称 scoped 与实现不符）；无 Shadow DOM / 前缀改写 / 内容校验（大小、@import、url() 外联）；与 `theme-custom-css` 的先后顺序无保证；全清全注无 diff。恶意 CSS 是现成的点击劫持/UI 重定向面。
2. **布局/插槽贡献协议**：`PluginViewArea` 只有 `'activityBar'` 一个合法值（`src/plugin-system/types.ts:5`）；shadow/chain/append 也只作用于 activityBar；无 dock/底栏/顶栏/聊天区/状态栏贡献协议；无 layout 贡献点；**六套挂载机制各自为政**（panelRegistry / chatCardRegistry / fileExplorerToolbarSlot / editorExtensionRegistry / pluginTabRendererRegistry / uiSlotStore），其中两个外部插件不可用；cap.self.mutate 插槽白名单仅 3 槽 × 3 预置组件。
3. **安全边界**：插件面板 JS 与宿主**同 window 零隔离**——`pluginModuleLoader.ts:43-62` 读盘重写 react import 后 Blob URL 动态 import；`__POLARIS_HOST_INVOKE__` 可调任意后端 command 无插件级白名单（`main.tsx:17`）；permissions 六布尔并非代码层强制边界。不建立作用域与能力分级之前，「任意改造」无法安全放开。

**附带缺口**：`DynamicHandler` 无 `ui-render` 变体（plugin-cap-inject-render-v1 §2.2 与 full-freedom §3.1 两处规划均悬空）；cap.ui.theme patch 只覆盖 colors + 10 个排版键（`uiDispatchService.ts:32-81`），L3 motion / L4 immersive / L5 layout / L6 customCss 无 API；manifest 无 theme 贡献点。

**前后端类型漂移（实际影响插件生态）**：前端 `PluginViewContribution` 有 `slot/slotMode`、engines 有 `adapter`，Rust 侧均无此字段且 `deny_unknown_fields`——**这些功能只对前端内嵌 builtin 插件可用，外部磁盘 manifest 声明了直接判格式错误**（`types.ts:41-54` vs `plugin.rs:301-314`；`types.ts:222-223` vs `plugin.rs:362-392`）。

---

## 3. 横切高危问题汇总（用户未点名，但优先级高于功能扩展）

| # | 级别 | 问题 | 证据 |
|---|---|---|---|
| X1 | **P0 安全** | 动态转发洗白 Remote deny（远程可借 cap.registry 别名以 Plugin 身份调 bash/fs/http/data_root/plugin*） | `dynamic_capability.rs:121-130` + `policy_permission.rs:170-196`（已人工验证） |
| X2 | **P0 可靠** | stop_service 竞态：停止/重启后进程不死，僵尸占端口、双进程并存 | `plugin_service_manager.rs:497-503, 318-326`（已人工验证） |
| X3 | **P0 可靠** | 应用退出孤儿进程（exit(0) + stop_all 无调用方 + 无 Job Object） | `lib.rs:857-870` |
| X4 | **P0 审计** | dispatch 同步句柄 miss 后回退流式表的整段零审计（cap.ai.chat 同步动作是高频路径）；审计字段过薄（无 payload/资源/时长/结果）；`append` 失败三处静默吞掉（fail-open） | `router/mod.rs:540-579, 287, 515, 617` |
| X5 | **P0 可靠** | dispatch 层无超时、流式泵无 watchdog | `router/mod.rs:397-587` |
| X6 | **P1 安全** | toolProviders 的 `mcpServerId` 只在全局 external_servers 找，不校验属于本插件——插件 A 可指插件 B 的 server（前端注释声称的约束 Rust 未实现） | `mcp_config_service.rs:947` vs `types.ts:239-241` |
| X7 | **P1 安全** | Remote source 无 token 区分：内置浏览器空 token webview 与 config token Web 会话裁决相同；仅 cap.mcp 单点复核 token | `commands/router.rs:28-34`、`mcp_capability.rs:14-17` |
| X8 | **P1** | bus-mcp 进程忽略用户 permissions.rules（from_config(None)） | `bus_mcp_server.rs:77` |
| X9 | **P1** | Web 模式插件服务管理被 Remote deny 全面拒绝 | `web/api/ipc.rs:2797-2826` |
| X10 | **P1** | MCP server stderr piped 不读 → 管道缓冲区写满永久阻塞 | `mcp/transport.rs:99` |
| X11 | **P1 契约** | manifest 前后端类型漂移（slot/slotMode、adapter）+ transport 校验放行 http 但运行时只支持 stdio | 见 §2.6、`plugin_service.rs:54` vs `mcp_config_service.rs:670-677` |
| X12 | **P2** | register_handle 不查重 id（dispatch 取序不定）；`is_dynamic` 靠 describe 约定判定（伪造就可被卸载） | `router/mod.rs:594-599`、`registry_capability.rs:302-310` |

---

## 4. 与既有方案的对照（哪些已规划、哪些是空白）

| 既有方案 | 状态 | 与本审计的关系 |
|---|---|---|
| `plugin-cap-full-freedom-v1.md`（L2 PluginRpc + L3 覆盖链 + 分级授权） | 待评审、未实施 | 现状盘点准确；但需前置补：X1 source 洗白修复、X5 超时护栏（方案 §3.5 有提但现状为零）、RealContext 补全、PSM 修复（方案复用它拉进程） |
| `plugin-manage-hook-inject-v1.md` / `plugin-cap-inject-render-v1.md` / `ui-template-runtime-v1.md` | P0-P3 基本已实现 | cap.ui.render 帧卡片、模板 DSL、cap.mcp 管理面、外部入口兜底已落地；唯 §2.2 ui-render 动态 handler 悬空 |
| `dynamic-capability-registry.md` | 已实现 | 即 cap.registry L1（forward + 持久化） |
| 插件生命周期/端口治理 | **无专门 spec（空白）** | §2.3 的 P0/P1 全部没有对应方案 |
| skill 插件化 | 仅 `plugin-system-zcode-compat-and-ai-ops-spec.md` 远期一句 | 空白，改造面小 |
| 样式作用域/布局插槽统一 | **无 spec（空白）** | §2.6 三个地基均无方案 |
| AI 使用说明治理 | 无 spec（bus 白名单根因修复有记录） | §2.4 问题多为漂移残留 |

---

## 5. 建议优先级路线（只排序，不实施）

**原则：先修地基（安全/生命周期），再放自由度（cap L2/L3、skill、样式布局）。**

### 第一梯队（P0，功能扩展前必须）
1. X1 动态转发 source 修复（保留原始 source 链或敏感目标转发按原 source 判权）。
2. X2/X3 进程停止竞态 + 退出孤儿进程（修 take() 所有权设计：watcher 不 take、stop 经由 watcher 协作 kill；应用退出跑 stop_all 或 Job Object）。
3. X4 审计补全（流式回退分支 + 字段增强 + append 失败 fail-closed 或告警）。
4. X5 dispatch 超时 + 流式 watchdog（full-freedom 方案 §3.5 的护栏先于 handler 扩展落地）。

### 第二梯队（P1，生命周期治理——用户核心痛点）
5. 端口治理：bind 探测 + 端口池 + 避让宿主端口与保留段 + 冲突显式报错（对齐 ask_listener 范式）。
6. healthCheck 接状态机、restart_count 稳定期衰减、Starting 态防双 spawn、服务状态回推前端。
7. X9 Web 模式插件服务管理放行（token 鉴权后开 Remote 子集）；X7 Remote token 分级。
8. 更新流程先停服务再换目录；X10 stderr 消费。
9. AI 操控插件的审批门：先让 dispatch 的 Prompt 裁决真正可用（当前 Phase 0 直接失败），再对 stop_for_plugin/uninstall 加确认。

### 第三梯队（P2，cap 自由度——按既有方案推进）
10. `plugin-cap-full-freedom-v1` P0→P2（覆盖链 + PluginRpc + OVERRIDE_LEVELS），前置补 RealContext 与 X6 toolProviders 归属校验；顺带 X12 register 查重。
11. manifest：新增 `contributes.capabilities`，同步补「能力提供者」设置页展示面；executors 三处不一致修复。

### 第四梯队（P3，AI 可见性）
12. describe 质量基线（每 cap 必填 params/returns/何时用/何时不用）；cap_dispatch 的 payload 枚举从注册表生成，消灭手抄；bus_help 去矛盾；统一三入口命名说明。
13. prompt_snippet 决定去留（注入 AI 或明确废弃）。

### 第五梯队（P4/P5，生态扩展）
14. skill 插件化：`contributes.skills` + `discover_skills` 扫描 installPath + 命名空间/启停门。
15. 样式布局自由度（顺序重要）：统一具名 slot 注册表（收敛六套机制）→ CSS scoped 注入真正落地（Shadow DOM 或前缀作用域 + 内容校验）→ theme/layout manifest 贡献点 → ui-render 动态 handler → 能力分级授权（参照 iframe cap 白名单先例）。插件 JS 沙箱（iframe/Worker 化）作为安全前提随第五梯队评估。

---

## 6. 验证方式说明

- 本报告全部结论来自对当前工作区代码的静态审查（5 个并行分析 + 2 处 P0 人工抽查验证：`plugin_service_manager.rs` child 所有权、`dynamic_capability.rs` source 改写），未运行时复现。
- 行号为 2026-10-24 工作区状态；后续改动可能漂移，引用时以符号名为准。
- 未实施任何修复。
