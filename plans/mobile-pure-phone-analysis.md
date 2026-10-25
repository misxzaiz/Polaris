# 纯手机端支持可行性分析报告(勘察,不实施)

> 生成:2026-10-25 · **v2**:响应独立审读员 20 条意见,逐条处理记录见文末 §10
> 性质:**只读勘察与路线决策分析,不含任何代码改动**
> 方法:五路证据勘察 → 三方案(A/B/C) → 三轮质询 + 作者回应 → 四票投票计票 → 独立审读修订
> 证据标注约定(v2 修订):§3 中**未特别标注的 file:line 事实默认为【读码】**——由前序勘察 ask 静态读取仓库源码确认;**【实测】**=前序勘察 ask 实际执行并在材料中记载的命令结果;**【复核】**=本报告撰写/修订会话实际执行的命令或文件读取(§3.8 附完整命令清单);**【外部】**=外部调研(附 URL;凡标注"搜索结果引用"均未抓取核实原文);**【推断】**=由事实外推;**【未验证】**=明确未核实。
> 如实声明:本报告为综合材料。【实测】(cargo check 通过、aarch64 交叉编译失败于 openssl-sys、vitest 11 测试通过)均为前序勘察 ask 的结果,本会话未重跑完整构建/测试;本报告撰写与修订会话实际执行的全部命令见 §3.8。

---

## 1. 结论摘要

1. **两种解读现状悬殊**:①"后端不在用户电脑"——headless 服务链路**代码已就位**(独立入口、无 Tauri 装配链、CI 已产 Linux 包;web-only 构建前序实测通过),核心对话/数据链路零新开发即可运行,但整体工程量级为**中**(P0 安全闸等十余项,见 §7);②"完全自包含手机"——当前**无任何运行路径**,APK 前端强制先配远端服务器才可用【读码】,且子进程域在 iOS 上 OS 级禁止、Android 上未打包未移植(工程缺口,非物理规律)。
2. **投票结果 A(30 分/4 首票)> C(16)> B(14)**(评分口径与局限见 §6 开头说明):推荐方案 A——云/家庭常开设备托管 polaris-web + 手机浏览器/PWA 薄客户端;与既有产品决策(2026-07-12"APK 直接复用 Web App")同向,数据单权威最干净,是唯一"现有代码即可让手机真机见效"的路线。
3. **A 的硬前提是 P0 安全部署闸**:默认配置(host=0.0.0.0 + token=None 即 API 全开放 + /api/files 服务任意绝对路径 + 无限速)直接公网暴露等于不设防;强制 token/拒绑非回环/文件根白名单/限速/TLS 反代必须先于任何对外部署。
4. **B/C 共享三道未过闸门**:Android 交叉编译(git2 vendored-openssl 阻塞,前序实测失败)、移动启动期 data_root 注入时序(OnceLock+expect 单点)、产品决策需用户显式推翻;C 另有 cap.relay(全仓 0 命中【复核】)与双权威数据孤岛,首版仅聊天。
5. **全部结论基于静态读码 + 材料内前序实测,无真机与 Linux 运行时一手证据**;方案 A 的阶段 0 Linux 实测(§7)是一切投入承诺的最终裁判,并附明确判定人与失败分支。

### 1.1 术语速查

| 术语 | 含义 |
|---|---|
| polaris-web | src-tauri 的独立 headless 二进制(src/bin/polaris_web.rs),不经 Tauri 桌面壳运行完整后端 + Web 前端静态服务 |
| axum | Rust Web 框架,polaris-web / 桌面内嵌 Web 服务的 HTTP+WS 底座 |
| RouterBus / cap 总线 | 后端统一能力通道(src-tauri/src/services/router/),前端经 router_dispatch 调用 cap.* 能力 |
| Source / SourceClass | cap 总线请求来源分级,仅 bootstrap(本地面板)/ remote(Web·HTTP 客户端)/ plugin(AI 会话)三类(services/router/policy_permission.rs:30-36);HTTP 调用一律 Source::Remote 且不可自声明 Bootstrap(web/api/ipc.rs:2842-2843)——本机回环 UI 也不例外 |
| P1-f/g/h | 远程权限"渐进放行"批次的内部编号(P1-f 插件服务管理、P1-g 动作级匹配、P1-h 插件发现只读);新放行照此范式走"精确 action allow + require_auth" |
| S7 spec | plans/session-rearchitecture/S7-消息存储统一重构.md;记录 JSONL 双写为"当前最安全终态"、删 saveDialog 调用为未做项 |
| session-v2 | 会话重构体系:后端 SQLite 消息/状态权威(messages.db/state.db)+ 事件日志 + 前端 Reconcile 对账("日志即真相,前端只是缓存") |
| M1/M2/M3 | 方案 C 的里程碑:M1=手机内嵌极简核本地闭环;M2=管理面 relay(指定 cap 动作转发在线宿主);M3=工具级 relay(bash/fs 等工具执行体可路由) |
| Polaris Pocket | 方案 C 的名称(会话权威随身 + 执行面按需外挂) |
| "http 传输" | 前端 transport 的**模式名**(detector.ts:50),指"HTTP 命令 + WebSocket 事件流"组合,与 Tauri IPC 模式相对;不指 URL scheme,WS 的 scheme 由 http/https 派生为 ws/wss |
| md5(token) 鉴权 | 现行凭据形态:服务端仅比较 md5(token),前端 localStorage 存的即是该 md5——持有 md5 即持有凭据 |

---

## 2. 问题定义与两种解读

**原始诉求**:『当前应用需要支持纯手机端、无需连接电脑使用』。仅分析,不实施。

**解读①:后端不在用户电脑上**(后端迁至云服务器 / NAS / 家庭常开设备,手机只是客户端)
- 当前代码形态已为此设计:polaris-web 独立 bin 自述"Designed for WSL/Linux headless server deployment"(src-tauri/src/bin/polaris_web.rs:1-18);CI 已持续产 Linux 包(.github/workflows/release-web.yml:22-46);Web 模式、远程权限分级、手机锁屏恢复链**均已实现**(材料记载,含注释级设计动机与传输层 vitest 通过;无 Linux 生产运行记录)。
- 对应方案 **A**(整条采纳),也部分构成 B/C 的"远端增强"面。

**解读②:完全自包含在手机**(后端跑在手机本机,零外部依赖)
- 当前**不存在**此运行路径。证据分两层,勿混:
  - 【读码·事实】APK 前端强制先配远端服务器才渲染 App:src/main.tsx:104-116(仅移动 Tauri runtime 包 MobileConnectionGate)、src/mobile/MobileConnectionGate.tsx:36-60(无 serverUrl+token 不放行)。
  - 【推断】Android 端无本地后端运行路径:依据 src-tauri/Cargo.toml:141 注释("Android 端是远程伴生端")+ 未查到任何本地启动/自发现代码 + 未逐行核 Android 连接层——此为"未查到"型推断,非逐行证明。
- 平台障碍分开表述(不以"物理不可行"一词覆盖两端):
  - **iOS:OS 级硬限制**——第三方 App 禁止 fork/exec,Tauri shell 插件移动端仅允许 open URL(https://v2.tauri.app/plugin/shell/ 【外部】)。
  - **Android:工程缺口**——node/claude CLI/polaris-mcp 均无 Android 打包/移植配置(未查到),需新工程;Android App 对自进程可 fork/exec(Termux 先例),方案 B 正是据此提出手机本机起 axum。
- 对应方案 **B**(全功能裁剪移植)与 **C**(分层混合:极简核装手机 + 执行面按需外挂)。

两种解读都成立为分析对象:①接近"部署运维 + 安全补课";②是"新移动工程 + 平台降级面",且需推翻既有产品决策。

---

## 3. 证据汇总

### 3.1 后端桌面硬依赖与 headless 可行性(勘察一路)

**事实**(未标注者均为【读码】,来源=前序勘察 ask 的静态读取):
- 构建矩阵:`default = ["tauri-app", "git", "lsp-index"]`(src-tauri/Cargo.toml:10【复核】);tauri-app 门控 7 个桌面依赖(Cargo.toml:17-25);Windows-only target 依赖单独隔离以避免 Linux CI 系统库负担(Cargo.toml:166-188);portable-pty 显式排除 android(Cargo.toml:190-191)。
- polaris-web 独立入口:CLI --port/--host/--token + env,优先级 CLI>env>config,默认 0.0.0.0:9830(polaris_web.rs:7,84);token 鉴权默认关闭(polaris_web.rs:16-18)。
- run_web_server 完整替代 Tauri 装配(lib.rs:1344 起,函数签名【复核】):三引擎注册、create_app_state(与桌面同一装配,注释"三端同源:桌面 tauri / headless polaris-web / MCP server",state.rs:555-556)、config_dir 用 data_root() 替代 Tauri path resolver、cap.ai.chat 等注册、SchedulerDaemon start_with_ctx、AskListener 绑 127.0.0.1 承接 cap_dispatch。
- Linux 发布线已存在:release-web.yml 在 ubuntu-22.04 构建,只装 libssl-dev+pkg-config,"不需要 webkit2gtk"。
- 数据根天然可移植:dirs::config_dir()→Linux=~/.config/Polaris;优先级 POLARIS_DATA_ROOT env > anchor.json > 默认;子目录全为相对拼接(data_root.rs:98,141,145-148,164-190,204-317)。
- 远程权限矩阵(三端同源装配内):内置 remote deny 覆盖 cap.data_root*/cap.http*/cap.bash*/cap.fs*/cap.ui*/cap.self.mutate*/cap.plugin*(policy_permission.rs:205-243;206/210/213 逐条【复核】);已鉴权 Remote 放行 pluginServiceManager 与 pluginDiscovery 六个只读动作(244-277);**config 精确 allow 可覆盖内置 deny**(198-200)——这是"服务器模式"不改动权限契约即可落地的机制基础。
- 引擎依赖面:SimpleAI=纯 HTTP(reqwest 直连 profile.base_url)零 CLI 依赖;Claude/Opencode 引擎 spawn 对应 CLI(服务器需装)。
- Windows-only 必砍域:computer_control 整模块仅 Windows 编译;非 Windows 的 polaris-mcp computer 子命令直接报错(src/bin/polaris_mcp.rs:226-232)。
- AppHandle 渗透极浅:services/ 全层仅 5 文件 15 处且全部 cfg(feature="tauri-app") 门控;AppState.app_handle 是 feature 字段(state.rs:296-297);web/api/ipc.rs 全文 0 处。
- 集成机器人(QQ/飞书/钉钉)半就绪:manager 的 AppHandle 全 cfg 门控,但 web IPC 桥里 init_integration 是 no-op、start/stop 未接入(ipc.rs:399-401)——"有壳无开关"。
- **data_root 单点前提的证据链(v2 补全)**:src-tauri/Cargo.toml:93 声明 `dirs = "5"`【复核】;Cargo.lock 解析为 dirs 5.0.1 → **dirs-sys 0.4.1**(Cargo.lock:1046-1052;同仓另有 dirs 6.0.0/7.0.0 走 dirs-sys 0.5.0,与本依赖无关)【复核】;质询员实读 registry dirs-sys-0.4.1/src/lib.rs:39-42:android/ios 下 home_dir fallback 返回 None【读码·材料内】;外部佐证 https://lib.rs/crates/sysdirs 【外部】。该行为绑定锁定版本 0.4.1,升级依赖时需复核。

**实测(材料内)**:`cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 于本机 Windows 通过(exit 0,54.47s,仅 crates/gate-queue 一个无关 unused_imports warning)。

**推断/未验证**:Android 端整体为伴生端定位系【推断】(见 §2 两层证据说明);polaris-web 未在真实 Linux 主机运行过【未验证】。

### 3.2 Web 模式与前端移动适配(勘察二路)

**事实**(未标注者均为【读码】):
- 鉴权机制:Bearer <md5(token)> 常量时间比较(web/middleware.rs:100-137);**token 为 None/空串 → API 完全开放**(middleware.rs:115【复核】);WS 走 ?token=;/api/auth/token 同时接受 raw 与 md5 双形态(web/api/auth.rs:44-70);**token 无自动生成**(web/auth.rs:1-7);全 web 目录无 rate limit(grep 0 命中)。
- **/api/files 的鉴权状态(v2 澄清,本会话核实)**:该端点**跳过中间件但 handler 内部自行鉴权**——middleware.rs:58-65 注释明示"由 handler 内部 authorized() 统一鉴权,同时支持 Authorization header 与 ?token= query 两种形态"(跳过中间件是为让 <img>/<video> 的 query token 能进入);files.rs:42-49 第一步即 `authorized()` 校验、失败 401;files.rs:7-11 安全模型注释同时写明"路径规范化+穿越防护,**不限定根**"。风险定性据此为:**设 token 时=持凭据者可读全盘任意绝对路径**(且凭据可走 URL query,会落反代日志/浏览器历史);**token 未设时=随 API 一同匿名开放**,即匿名全盘读。
- 传输安全:**服务端无 TLS**(裸 TcpListener,server.rs:183-196,228-251);访问 URL 恒 http://(server.rs:111);CORS 全 Any(router.rs:102-118);SPA 静态无鉴权(router.rs:144-151)。
- 默认配置即高危组合:host 默认 "0.0.0.0"、port 9830、enabled 默认 true(models/config.rs:1163-1165【复核】)。
- **传输通道口径(v2 澄清,本会话核实)**:前端 transport 的 "http" 是**模式名/传输家族**(detector.ts:50 `if (isMobilePlatform()) return 'http';`【复核】),指"HTTP 命令 + WebSocket 事件流"的组合,与 Tauri IPC 模式相对,**不指 URL scheme**;WS URL 由 `baseUrl.replace(/^http/, 'ws')` 派生(httpTransport.ts:116【复核】),事件流经 `new WebSocket(...)` 建连(httpTransport.ts:188【复核】)。因此"移动 UA 恒走 http 模式"与"锁屏断 WS→回连补发"**不矛盾**(WS 属于 http 模式内部的事件通道),且 https 源自动派生 wss,与 TLS 反代部署一致。
- 传输层已为手机场景实现(材料记载):移动 UA 走 http 模式(detector.ts:46-69);HTTP 超时 600s 适配弱网(httpTransport.ts:23);visibilitychange/online/focus 唤醒探活重连(319-367);服务端 EventBroadcaster 注释自述动机"手机浏览器锁屏后 WS 被系统断开,解锁重连时上报 lastSeq 补发"(event_broadcaster.rs:8【复核】),环形重放缓冲 2000 条/8MB。**未在真机实测**。
- compact 布局体系:阈值 500px,抽屉/窄 Tab 覆盖/聊天常驻(useWindowSize.ts:53;App.tsx:340-373;NarrowTabOverlay.tsx:1-14)。
- 触屏缺口是**结构性**的:全库 pointer:coarse/hover:none 0 命中、@media 宽度断点仅 1 处(index.css:422);文件树操作仅 onContextMenu(FileExplorer.tsx:442,540)触屏不可达;长按补丁仅覆盖聊天气泡;SettingsPage 无 compact 适配;手机横屏 >500px 落入桌面 hover 布局。
- **PWA 当前不存在(v2 修正证据命令)**:【复核】`grep -inE "manifest|serviceworker" index.html` → 无命中;`grep -rn "serviceWorker" src index.html` → 无命中;`ls public/` → 仅游戏 html/svg,无 manifest.json。manifest 与 serviceWorker 双确认缺失——推送/离线壳/Android WebAPK 安装全部零起点。
- 相机/麦克风需安全上下文(HTTPS 或 localhost):platform.ts:20-37、speechService.ts:5-7——手机浏览器经 http://<IP> 访问时语音输入/扫码全灭。
- 跨端双向同步(S3 五阶段)已被整体 revert,现存仅 remoteSessionFollower 只读跟随(main.tsx:94-97)。
- 产品决策:『用户确认:手机浏览器上完整 Web 体验已足够好,APK 应直接复用 Web App』(plans/app-mobile-multi-session-plan.md:13【复核】,2026-07-12)。

**实测(材料内)**:`pnpm exec vitest run src/services/transport/detector.test.ts src/services/transport/index.test.ts` → 2 文件 11 测试全部通过。

### 3.3 会话数据与多端协同(勘察三路)

**事实**(未标注者均为【读码】):
- 消息/状态真相已后端权威实现(材料记载:turn_persist 节流 600ms 落 SQLite + 轮末 JSONL 归档 + 启动恢复,turn_persist.rs:1-17,512-541;S6 spec 标注"已实施(简化版)");messages.db 幂等 append+墓碑防复活(session_db.rs:32-46);running 状态从事件日志计算(session_state.rs:54-103)。
- **JSONL 双写竞态窗口**:前端 saveDialog 与后端 archive_conversation 各自 read-merge-write,唯一 tmp 后缀只解决同进程互斥(dialog_storage.rs:149-152 注释明示),无跨进程锁;S7 spec 自称"当前最安全终态"。
- 设备身份失真:device_id 恒为字面量 "core"/"ipc"/"start"(turn_persist.rs:898;ai_chat_capability.rs:229-236,262-268)——仲裁 reason"由设备 X 启动"无法区分真实设备;审计 source 只落变体名 Remote(audit_sink.rs:66-72)。
- 并发写有仲裁:try_start 事务化单写者(BEGIN IMMEDIATE,session_state.rs:346-384),cap.ai.chat start/continue 已挂闸。
- 会话列表元数据(sessionMetadata)仅前端内存无持久化——冷启动"快速切换"为空,但历史面板走后端 dialog_index.db 可完整恢复。
- remoteSessionFollower 发现→只读跟随→加入接管全链路已实现并验证(remoteSessionFollower.ts:517-627),但**只在同一后端进程内有效**;多端共享同一份数据的唯一前提是连同一个后端。
- 数据根单机单点:data_root() OnceLock 进程内固定 + expect(data_root.rs:343-345【复核】);全仓未查到任何跨机同步/备份/导出层。
- WS 重放缓冲仅内存、seq 进程内单调,后端重启→前端全量 resync。

### 3.4 插件 / MCP / 语音三大扩展能力(勘察四路)

**事实**(未标注者均为【读码】):
- 插件=OS 子进程模型:后台服务 tokio::process 拉起 manifest command(plugin_service_manager.rs:273)、MCP 仅 stdio(mcp_config_service.rs:636-726)、引擎插件 spawn 适配器进程、插件管理面包装外部 `claude` CLI(plugin_service.rs:113-122)——目标平台无 node/claude 则全部插件执行面不可用(打包/移植层面,见 §2 平台区分)。
- 内置 MCP=独立二进制 polaris-mcp 十合一,运行期定位链依赖随包分发(mcp_config_service.rs:1101-1218);未查到 Android 打包包含它的任何配置;computer 子命令 Windows-only。
- **语音的两条独立通道(v2 澄清,勿混)**:
  - ①**后端合成**:cap.voice → mimo-tts(node 子进程插件)是 cap.voice 的**唯一后端实现**(voice_capability.rs:35-38,277-284)——无 node 的平台上电台/后端合成不可用;
  - ②**前端合成**:ttsService 使用 edge-tts-universal 在浏览器内合成(ttsService.ts:5,19【复核】),需 crypto.subtle 安全上下文,失败降级 speechSynthesis(ttsService.ts:13-15,27【复核】)——方案 C firstStep 中"ttsService 合成可用"验证的就是这条**前端**路径,与 mimo-tts 不是同一实现、无冲突。
- 播放侧:<audio>+MediaSession+base64/file 双模式已为移动端实现并调优(voiceBroadcastPlayer.ts:72-73,473-495);file 模式在 APK 内依赖 asset:// 协议(tauri.conf.json 无 assetProtocol 配置)。
- 语音输入:Web Speech API 需安全上下文;Android WebView 无 Web Speech API,原生回退 SpeechBridge.kt **仅存在于已废弃标注的 polaris-mobile 壳**,主仓 gen/android 无。
- 移动传输:移动 UA 恒走 http 模式且必须有已配置的 server URL(mobile-server-config.json,手填/扫码写入,mobile_config.rs:59-69)——**未查到"本机内嵌后端自发现"的任何代码**。
- 主仓 Tauri 2 Android 工程(gen/android)与 lib.rs:498 mobile_entry_point【复核】存在;polaris-mobile 壳为裸 tauri Builder 无 Polaris 后端,且工程不入库(.gitignore:111)。

### 3.5 移动平台外部事实(勘察五路,URL 引用)

- Tauri 2.0 stable(2024-10)支持 iOS/Android:https://v2.tauri.app/blog/tauri-20/ ;shell 插件移动端仅允许 open URL:https://v2.tauri.app/plugin/shell/ ;iOS 对第三方 App 禁 fork/exec 是 OS 级沙箱限制。
- iOS 后台是硬边界:切后台 WS 被断且可能不触发 onclose(https://stackoverflow.com/questions/13905536;https://github.com/enisdenjo/graphql-ws/discussions/290);SSE 后台化被取消读取(htmx#3634,https://github.com/bigskysoftware/htmx/issues/3634);后台定时器约 20s 停摆(https://apple.stackexchange.com/questions/280679)。
- iOS Web Push 前置链(缺一不可):HTTPS + manifest(display:standalone)+ Service Worker + 用户手动加主屏 + 手势授权;**无静默推送**,订阅闲置会失效:https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados
- iOS PWA:Background Sync 全不支持(https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide);锁屏音频历史性停播(https://prototyp.digital/blog/what-we-learned-about-pwas-and-audio-playback;iOS 26 回归仅为社区报告未独立核实);安装无 beforeinstallprompt,只能手动加主屏。
- 先例(自托管服务端+手机薄客户端):
  - Open WebUI 官方 PWA 安装与 HTTPS 反代配方(Cloudflare Tunnel/Tailscale/Caddy/Nginx;SSE 禁缓冲+读超时≥300s+WS Upgrade 透传):https://docs.openwebui.com/reference/https
  - code-server 安全暴露分级与密码限速:https://coder.com/docs/code-server/guide
  - Home Assistant=webview 壳+原生增强:https://community.home-assistant.io/t/why-the-android-app-companion-is-just-a-simple-webview/219609
  - LobeChat 多端同步必须 DB 模式+服务端鉴权(Logto/Clerk/next-auth):https://github.com/lobehub/lobehub/discussions/15221 、https://sliplane.io/blog/self-hosting-lobe-chat-the-easy-way 【外部·搜索结果引用,均未抓取核实原文】(v2 补 URL)
- Tauri iOS 白屏 bug(tauri#14371)2026-04 修复:https://github.com/tauri-apps/tauri/issues/14371
- Android 回环无 App 间隔离:https://localmess.github.io/ ;https://developer.android.com/privacy-and-security/local-network-permission

**未决外部事实**:iOS 26 PWA 音频回归未复现;EU PWA 政策来源冲突(采信 2024-03 反转说);Android Doze 下 WS 存活时长无量化;${usesCleartextTraffic} 占位符在 release 构建的解析值未查到(tauri-cli 为二进制)。

### 3.6 交叉编译与移动启动期的共享闸门(B/C 共同)

- **Android 交叉编译闸门未过**【实测(材料内),B/C 两作者独立复现同一结果】:git2 非 optional 且带 vendored-openssl(Cargo.toml:106【复核】)→ `cargo check --target aarch64-linux-android --lib` 失败于 openssl-sys 构建脚本(宿主 perl 缺 Locale::Maketext::Simple + 找不到 NDK clang),未到达 polaris_lib 自身代码——**polaris_lib 的 Android 编译通过性至今零证据**。
- 最小门控路径已被质询核实:git2 消费面仅 models/git.rs(models/mod.rs:4 未门控)+ services/git(已门控)+ commands/file_io.rs:13 借用 GitError,约 2-3 文件改动即可让编译到达 polaris_lib。
- **data_root() 初始化是启动期单点**:OnceLock+expect(data_root.rs:343-345【复核】),且首次初始化可能发生在 Logger::init 内部;dirs-sys 0.4.1(本仓锁定版本,证据链见 §3.1)在 android 下 config_dir 返回 None——POLARIS_DATA_ROOT 注入晚于 Logger 即启动 panic;需"mobile 启动顺序契约"。
- run() 无任何 cfg(desktop)/cfg(mobile) 分支:内含桌面窗口管理、事件中继、invoke_handler 全量注册;五个插件在 lib.rs:566-571 无条件注册——"零新增装配"说法已被作者撤回,run() 移动分支改造是新增缺口【中】。

### 3.7 本报告 v1 会话的抽查复核(【复核】汇总)

实际执行的命令与结果(全部命中材料断言):
- `grep` src-tauri/Cargo.toml → :10 default features、:106 `git2 = { version = "0.18", features = ["vendored-openssl"] }`
- `grep` src-tauri/src/lib.rs → :498 mobile_entry_point、:1344 `pub fn run_web_server(...)`
- `grep -rln "cap.relay" src-tauri/src` → **无输出(0 命中)**
- `grep` src-tauri/src/services/data_root.rs → :343-345 get_or_init + expect 单点
- `grep` src-tauri/src/models/config.rs → :1163-1165 默认 0.0.0.0 / 9830 / enabled=true
- `grep` src-tauri/src/web/api/files.rs → :10 "不限定根"
- `grep` src-tauri/src/web/middleware.rs → :115 "Token 为 None 或空字符串均视为未设置 → API 开放"
- `grep` src-tauri/src/services/router/policy_permission.rs → :206/210/213 远程 deny cap.data_root/cap.bash/cap.fs
- ~~`grep -c "manifest|serviceWorker" index.html` → 0~~ **v2 作废:BRE 下 `|` 为字面量,该命令不能证明任何东西;已用 -E 重跑,见 §3.2 PWA 条目**
- `grep` plans/app-mobile-multi-session-plan.md → :13 产品决策原文确认
- `grep` src-tauri/src/web/event_broadcaster.rs → :8,92 锁屏 resume 设计动机注释确认

### 3.8 本报告 v2 修订会话执行的验证(【复核】新增)

| 命令/读取 | 结果 |
|---|---|
| Read src-tauri/src/web/middleware.rs:50-94 | :58-65 注释确证 /api/files 由 handler 内部 authorized() 鉴权(header+query 双形态) |
| Read src-tauri/src/web/api/files.rs:1-60 | :7-11 安全模型注释(鉴权一致+?token= 回退+不限定根);:42-49 第一步 `authorized()` 校验失败 401 |
| `grep -inE "manifest\|serviceworker" index.html` | 无命中 |
| `grep -rn "serviceWorker" src index.html` | 无命中 |
| `ls public/` | 仅 polaris-*.html/spiderman/tauri.svg/vite.svg,无 manifest.json |
| `grep -n -A1 'name = "dirs-sys"' src-tauri/Cargo.lock` | 0.4.1 与 0.5.0 两个版本并存 |
| `grep 'name = "dirs"' -A8 src-tauri/Cargo.lock` | dirs 5.0.1→dirs-sys 0.4.1;dirs 6.0.0/7.0.0→dirs-sys 0.5.0 |
| `grep -n "dirs" src-tauri/Cargo.toml` | :93 `dirs = "5"`(→5.0.1→dirs-sys 0.4.1) |
| `grep -in "edge-tts" src/services/ttsService.ts` | :5/:13/:19/:27 确证前端 edge-tts-universal 合成路径 |
| `grep -n "replace(/^http\|new WebSocket" src/services/transport/httpTransport.ts` | :116 wsUrl 派生、:188 `new WebSocket(...)`——WS 属 http 传输家族内部 |
| `grep -n "isMobilePlatform" src/services/transport/detector.ts` | :50 `if (isMobilePlatform()) return 'http';`——"http"为模式名 |

未运行(如实声明):cargo check/clippy、Android 交叉编译、vitest、任何 Linux/真机运行时验证。

---

## 4. 三方案

### 4.1 方案主张概述(v2 补:被评估的三案各自完整主张)

**A——云端/家庭常开设备托管 polaris-web 服务端 + 手机浏览器/PWA 薄客户端**:把面向 Linux headless 设计的 polaris-web 独立 bin(入口与无 Tauri 装配链已就位,CI 已产 ubuntu 包)部署到云服务器或 NAS/盒子;手机只跑现有 Web 前端(compact 布局阈值 500px),经 TLS 反代或 Tailscale 访问。会话真相(session-v2 SQLite/JSONL)、AI 引擎、插件/MCP/TTS 子进程、调度器全部留在常开设备,数据根由 POLARIS_DATA_ROOT 定位,手机与桌面浏览器都退化为"视图+控制端"。链路本身零新开发即可运行;工程重心:公网安全层、远程权限"服务器模式"档、集成机器人接 web 桥、触屏适配补齐。

**B——Tauri 2 移动原生路线(裁剪后端装进手机本机)**:主仓 Tauri 2 Android/iOS 工程(gen/android 与 lib.rs:498 mobile_entry_point 已存在)承载前端与裁剪后端,复用 run() 内既有的 axum 装配链在手机本机起 API/WS,数据根经 POLARIS_DATA_ROOT 注入 App 沙箱。**本机保留**:SimpleAI(纯 HTTP)引擎、session-v2 后端权威存储、cap 总线、调度器、compact UI;**标记"需远端/不可用"**:插件 node 子进程、claude/opencode CLI 引擎、MCP stdio、polaris-mcp bin、mimo-tts、computer;**可选远端代理**:用户配置远端 Polaris 后经既有 Source::Remote 权限模型与 MobileConnectionGate 代理。前置闸门:git2/openssl 交叉编译、run() 移动分支改造、产品决策推翻、iOS 分期。

**C——Polaris Pocket(会话权威随身 + 执行面按需外挂,分层混合)**:把不依赖子进程的"对话核"(SimpleAI + session-v2 SQLite 会话权威 + ask/form/card 交互闭环 + WS 事件流)以内嵌进程跑进手机,前端 WebView 直连 127.0.0.1,手机升格为会话权威端;子进程域承认不可上机,改为经现成 /api/router_dispatch HTTP 桥向"在线宿主"(桌面机/云服务器/Termux)转发执行,宿主离线时显式降级、不阻塞核心。三个里程碑独立可交付:**M1 本地核**(SimpleAI+session-v2+ask 闭环+WS+语音降级链;中到大)、**M2 管理面 relay**(指定 cap 动作转发宿主 /api/router_dispatch + 配对授权与可撤销凭据;小到中,含跨权威审批通道这一隐藏主体工程)、**M3 工具级 relay**(bash/fs/http 工具执行体可路由,trait 双实现+结果流回传;大)。

### 4.2 对比表

| 维度 | A:常开设备托管 polaris-web + 手机薄客户端 | B:Tauri 2 移动原生(裁剪后端装手机) | C:Polaris Pocket(内嵌极简核 + 执行面外挂) |
|---|---|---|---|
| **核心思路** | polaris-web 部署到云/NAS 常开设备,手机跑现有 Web 前端(compact),会话/引擎/插件/调度全在服务器,手机=视图+控制端 | 主仓 Android/iOS 工程承载前端+裁剪后端,手机本机起 axum API/WS,子进程域标记"需远端",可选配对远端代理 | 会话权威(SimpleAI+session-v2+ask 闭环+WS)以内嵌进程进手机,执行域经 cap.relay(新增)转发"在线宿主",宿主离线显式降级 |
| **数据权威** | 服务器单权威+单数据根,手机零会话持久化,丢失不丢数据(最干净) | 手机单权威,数据落最易丢失设备且无备份/导出设计(数据丢失画像最差) | 手机+桌面双权威,天然数据孤岛,双栖用户历史分裂 |
| **复用** | 最高:headless 链路/CI 产物/传输层/compact/权限分级/锁屏恢复全现成,核心链路零新开发 | 中:gen/android+mobile_entry_point、SimpleAI、传输层、mobile_config 写通道现成;但 run() 桌面面需整层改造 | 中:run_web_server 装配链+SimpleAI+session-v2+传输层可复用;差异化主体 cap.relay 全仓 0 命中【复核】 |
| **缺口** | P0 安全闸(token/绑定/files 白名单/限速/反代感知)、PWA+推送零起点、JSONL 双写收敛、触屏逐页、机器人接 web 桥 | 编译闸(openssl)、run() 移动分支、前台服务+推送【大】、语音输入桥、备份/导出、凭据轮换、cleartext 未决 | 内嵌核自发现+回环 Source 扩展(必做契约变更)、cap.relay 整套(M2)、跨权威审批通道、TTS/语音输入双断、双权威同步 |
| **量级** | 中(作者修订:P0+单用户最小可用=中;权限档+触屏+PWA/推送=大) | 大(维持) | 大(维持;M1 由"中"修为"中到大") |
| **主要风险** | 默认不设防(配置默认态+md5 即凭据+cap.config get full 不脱敏 apiKey);iOS 后台/推送硬边界;服务器单点 | 推倒重来属性最强:iOS 半市场 OS 级不可交付(工程无法绕过)、构建链脆弱、与产品决策冲突、凭据/审计双薄弱 | 首版执行面空(仅聊天)、双权威孤岛、relay 凭据=宿主全权、能力矩阵三态长期维护成本 |
| **验证步骤(firstStep)** | 半天 Linux 实测:解包 release 产物→Caddy/Tailscale→手机流式对话→锁屏 resume→语音电台→记录 Remote deny 清单 | 已实测定位 openssl 闸;下一步 git2 门控后复跑 aarch64 check→debug APK 真机验证 axum 起来(前置:用户显式推翻产品决策) | 已实测同 openssl 闸;桌面零代码验证五项(token 登录/流式/重启恢复/resume/前端 ttsService 合成)→门控 git2 出 APK |
| **投票(4 票)** | **30 分 / 4 首票(7/7/7/9)** | 14 分(3/4/4/3) | 16 分(4/3/5/4) |

---

## 5. 质询要点(按方案归组)

### 5.1 方案 A

**质询共识(接受/部分接受)**:
- 【高】默认即公网不设防,必须列为 P0 部署硬闸而非补课项:host 默认 0.0.0.0+token 默认 None 即 API 开放(models/config.rs:1163-1165;middleware.rs:115【复核】)+/api/files 不限根(设 token 时持凭据全盘读、未设 token 时匿名全盘读,见 §3.2 澄清)+无限速+无 TLS;md5 即凭据本体(localStorage 存 md5、双形态接受)、cap.config get full 对 Remote 返回未脱敏 apiKey(config_capability.rs:288-291)——泄漏后果是全部 LLM 密钥外流。——作者接受,P0 化。
- 【高】"PWA"当前不存在(标题里写的是目标态不是现状):index.html 无 manifest/SW、无推送依赖【复核】——Android 无安装入口、无离线壳。——作者接受,补 gaps【中到大】。
- 【高】通知/推送零基建:切后台/锁屏即失联,"AI 跑完了吗"没有任何答案通道;iOS 无静默推送;resume 只在用户回页后补发。——作者接受为缺口;选民 2 进一步要求 PWA/推送与安全闸同级优先(本报告已采纳,见 §7 阶段 1B)。
- 【中】JSONL 双写收敛应为首迭代而非"可缓"——A 的产品形态(手机+桌面同连一台服务器)正是竞态触发条件。——作者接受,提前至首迭代。
- 【中】反代感知不是纯运维:X-Forwarded-Proto/Host 全仓 0 命中、URL 恒 http(server.rs:111),TLS 反代后二维码生成与 isSecureContext 判定需改 Rust 侧。——作者升【小到中】。
- 【中】审计只到"发生过"不到"谁干的":source 只落 Remote、device_id 恒字面量——token 泄漏后唯一痕迹是不分来源的 Remote 记录。

**作者反驳(被质询方/投票方采信为成立)**:"服务器模式档位=契约级变更"不成立——config permissions.rules 精确 allow 可覆盖内置 deny(policy_permission.rs:198-200),预设规则组+UI 即可,不动 SourceClass 枚举(术语见 §1.1)。effort 相应里程碑化。

**遗留未决**:iOS 真机 resume 链从未实测;files 白名单如何与 workspace/会话路径联动无设计;polaris-web 无 Linux 一手运行记录;集成机器人三 adapter 内部桌面假设未逐行核。

### 5.2 方案 B

**质询共识(作者全部或基本接受)**:
- 【高】"run() 零新增装配"撤回:run() 无 cfg(desktop)/cfg(mobile) 分支,桌面窗口管理/事件中继/invoke_handler/updater 无条件注册为桌面面,新增缺口【中】"run() 移动分支改造"。
- 【高】前台服务+推送是产品级必答:AndroidManifest 仅 INTERNET,锁屏即整 App(含内嵌后端)被杀,无通知兜底——升【大】。
- 【高】iOS 实际不可交付:OS 禁 fork/exec、aarch64-apple-ios 编译零验证、白屏修复依赖、商店审核未评估——建议 iOS 分期(先 Android)列为第 0 步。
- 【高】Android 回环不是隔离边界(localmess.github.io):叠加默认 0.0.0.0+token=None+cap.config 不脱敏,任意后台 App 可静默窃取密钥——需"移动首启强制 token+绑 127.0.0.1"(作者称其最重遗漏)。
- 【中】git2 最小门控路径(~2-3 文件)纳入 firstStep;【中】数据丢失画像最差(备份/导出/轮换全缺);【中】产品决策推翻应第 0 步用户显式决策;【低】${usesCleartextTraffic} release 解析值未查到(release 包存在"内嵌核物理不可用"的未排除可能)。

**结构性质疑(投票方 1)**:B 与 C 共享"HTTP 调用一律 Source::Remote 且不可自声明 Bootstrap"(ipc.rs:2842-2843,概念见 §1.1)这一契约事实——B 的回应完全未涉及本机 UI 同吃 Remote deny 的必做契约变更;一旦补上,其"本机核+远程执行"将向 C 的形态收敛,应合并评估。

### 5.3 方案 C

**质询共识(作者接受,自纠质量三案最佳)**:
- 【高】关键误读更正:SimpleAI 的 bash 工具**在场**(tools/mod.rs:7,13)且是 cap.bash 直通代理(tools/bash.rs:1-13)——M1 须显式不注册该工具,防 Android 上 spawn 失败;能力矩阵重做。
- 【高】首版执行面空:cap.relay 全仓 0 命中【复核】,到手只是 SimpleAI 聊天壳——作者承认单薄,M1 叙事改为"宿主用户的随身兜底"而非独立卖点(保留差异:本地会话权威离线可读写+ask/form 闭环)。
- 【高】跨权威审批断层:Remote 来源的 prompt 登记在宿主 PermissionPromptRegistry 且只广播宿主自身 WS 客户端(permission_prompt.rs:58-66,107-119),手机核无人应答、同步派发挂到超时——M2 需补跨权威审批通道(隐藏主体工程)。
- 【高】relay 凭据防线(可撤销配对/限速/动作白名单)升 M2 阻塞项,"安全面【小】"定级作废。
- 【中】Source 枚举扩展必做(ipc.rs:2940 HTTP 恒 Remote,回环 UI 同吃 deny 矩阵)——契约变更;【中】fs 工具直连 std::fs(tools/fs.rs:81 等)确证 M3=大;【中】前台服务+POST_NOTIFICATIONS 升 M1 前提;【中】产品决策冲突入 risks 首条,取舍判据:双栖用户为主选 A、随身兜底为主选 C。

**遗留未决**:crypto.subtle 于 tauri.localhost 仅注释断言无实测;git2 门控后 aarch64 复跑未执行;gen/android 工程陈旧(tauri.properties 10.8.0 vs Cargo.toml 10.9.2);relay 对流式动作(router_dispatch_stream)的转发设计缺失。

### 5.4 三案共同的前置要求(维护者口径)

1. **mobile 启动顺序契约**:data_root() OnceLock+expect 叠加"首次初始化可能发生在 Logger::init 内部"(证据链见 §3.1/§3.6)——无论 B/C 谁被选中,开工前先补此契约,否则 POLARIS_DATA_ROOT 注入晚于 Logger 即启动 panic。
2. **数据丢失闭环**:三案均未给出备份/导出验收标准,进入实施前必须先有(已落入 §7 阶段 1A ⑦)。
3. **产品决策门槛**:B/C 推翻 2026-07-12 决策的门槛应是**用户显式重新决策**,不能方案文档内自设 gate 了事。

---

## 6. 投票结果与分歧

**计票口径与局限(v2 补,如实声明)**:评审材料**未提供统一评分量表与计票规则**。下表分数为各投票人自报(观测分值范围 3-9,量表未公开,"10 分制"仅为推测、未获确认);总分=四人分数直接加总,首票数=该方案被排在第一位的票数,无排序复权。各票分数仅在投票人自述理由的语境下可比较,不可跨人精确比较。投票主体:四票来自工作流内的独立投票者,仅选民 1 自述"维护者视角"、选民 2 自述"用户视角",**选民 3/4 身份未标注**;投票人与被质询"作者"的重叠关系材料未提供,代表性与独立性无法复核。

**计票**:

| 方案 | 总分 | 第一票数 | 各票 |
|---|---|---|---|
| **A** | **30** | **4** | 7 / 7 / 7 / 9 |
| C | 16 | 0 | 4 / 3 / 5 / 4 |
| B | 14 | 0 | 3 / 4 / 4 / 3 |

**投票理由要点**:
- 选 A 的共同理由:唯一与现有架构同向(服务器=单一权威+单一数据根,手机=session-v2"日志即真相"的目标形态)、零新契约、唯一"现有代码即可让手机真机见效"、延续 2026-07-12 既有决策。
- 扣 C 分的共同理由:cap.relay 全仓 0 命中、双权威孤岛对双栖用户是每日可见倒退、M1 只是聊天壳、需推翻产品决策。
- 扣 B 分的共同理由:平台依赖翻车与半途而废风险最高(openssl 闸后 polaris_lib 零编译证据)、run() 桌面面改造漏算、iOS 半市场不可交付、直接冲突产品决策。

**保留意见(分歧所在)**:
1. **选民 1(维护者)**:B 补上 Source::Remote 这一课后会向 C 收敛,届时两案应合并评估而非并行;A 的 P0 项按 AGENTS.md 二.4 是行为/协议改动,动工前须先在 plans/ 落 spec——尤其 /api/files 根白名单与 cap.fs Remote deny 的交互需契约级方案而非参数收紧;mobile 启动顺序契约是前置要求;评分基于静态证据非运行时证明。
2. **选民 2(用户视角)**:通知是三案共同死穴,但只有 A 是结构性无解(iOS 无静默推送+PWA 零起点)——投 A 是投"现在能用",不代表接受"AI 跑完了我不知道";PWA/推送应与安全闸同级优先(本报告已采纳为阶段 1B);三案对无常开设备、不肯侧载 APK 的用户全部不可用;个人最短路径是 A+Tailscale(免公网 TLS/DDNS),但该路径未纳入本报告的阶段排期(本报告不做工期/关键路径估算,v2 修正原悬空表述)。
3. **选民 3(身份未标注)**:A 的 7 分以"P0 安全闸=部署硬闸"为前提,否则应降约 2 分;备份/导出验收标准是实施前置;未亲跑 Android 编译(采信 B/C 两作者独立复现的同一 openssl-sys 失败);${usesCleartextTraffic} 未查到意味着 B/C 的 release APK 存在分析阶段无法排除的"内嵌核物理不可用"可能。
4. **选民 4(身份未标注)**:A 的 9 分附带两前提——P0 先行、且"零改动跑通"至今无 Linux 一手运行记录,firstStep 半天实测是最终裁判;若产品把"桌面+手机数据一致"列为不可妥协项,A 的单权威模型会被否决,届时次优是 C 的 M1(随身兜底定位)而非 B。

---

## 7. 综合推荐

**推荐路线:方案 A 为主干,分阶段推进;B/C 归档并附重启条件。**

**显式边界(v2 补)**:对"无常开设备、不肯侧载 APK"的用户,**三案在当前产品形态下均无解**——A 需要常开设备+TLS 层,B/C 需要侧载 APK 且构建链未通。该场景超出本次三方案域,不因推荐 A 而被掩盖;可能的兜底方向(使用他人托管实例 / 桌面端"一键开服+内网穿透"引导 / 云端托管服务)列为开放问题 §8.13,不在本报告承诺范围。

**阶段 0——Linux 半天实测(一切投入的裁判,不写代码)**
在任一 Linux 云主机/NAS 解包 release-web 现成产物,`POLARIS_WEB_TOKEN=... polaris-web --host 127.0.0.1` + Caddy 一行反代(或 Tailscale serve),依次验证:①手机浏览器完成流式对话;②锁屏 30s→回前台 resume 补发不丢消息;③装 node 后语音电台端到端;④记录 Remote deny 面实际挡住的操作(作为"服务器模式权限档"需求清单);⑤公网反代与 Tailscale 各试一次,对比二维码配对与语音输入(isSecureContext)差异。

**阶段 0 判定机制(v2 补)**:判定人=本次分析的发起方(产品/维护者);判据=上列五项全绿→进入阶段 1;失败分支=失败点属安全层/部署层(反代、token、isSecureContext)→转入阶段 1A 修复后重测;失败点属核心链路(axum 起不来、WS/会话恢复失效)→推翻或降级对 A 的推荐,结论回写本报告并另行立 spec。

**阶段 1A——P0 安全部署闸(阻塞任何对外暴露;每项先落 plans/ spec,按 AGENTS.md 二.4)**
① 强制 token:未设 token 拒绑非回环 + 启动硬告警;② /api/files 根白名单(须先设计其与 workspace/会话路径联动,并处理凭据走 URL query 落反代日志/浏览器历史的问题);③ 登录限速;④ cap.config get full 对 Remote 脱敏 apiKey;⑤ TLS 反代配方 + 反代感知(X-Forwarded/URL 生成修正);⑥ **JSONL 双写收敛至后端单写者**(首迭代,同批处理 device_id 真实化);⑦ **备份/导出验收标准**(§5.4.2 前置要求落位:服务器到期/手机丢失/token 泄漏三场景的恢复路径)。

**阶段 1B——PWA 基建 + 通知/推送(产品级并行轨道;与 1A 同时启动,不阻塞首次受控部署)**
按选民 2 意见与安全闸同级优先:manifest/Service Worker/安装引导(Android WebAPK)/推送服务端;iOS 以"前台运行+无静默推送"做预期管理。量级【中到大】,故设独立轨道而非塞进阶段 2。

**阶段 2——体验补齐(可渐进拆小)**
① "服务器模式"权限预设(config 精确 allow 规则组+UI+风险提示,走 P1-f/g/h 范式,不动 SourceClass);② 触屏适配分批补齐(按 html-card-mobile-adapt-spec.md 范式,优先文件树/Settings/横屏);③ 集成机器人接 web 桥(常开设备最现成增值点)。

**B/C 处置:归档,不启动。** 若未来重启移动线,前置条件依次为:
1. 用户**显式重新决策**推翻 2026-07-12"APK 直接复用 Web App"(不能自设 gate);
2. 过三道共享闸门:git2 门控化最小路径(~2-3 文件)后复跑 aarch64 check 并记录剩余错误面;mobile 启动顺序契约(data_root 早于 Logger,证据链 §3.6);${usesCleartextTraffic} release 解析值验证;
3. B 必须先补"本机 UI 同吃 Source::Remote deny"这一课——届时与 C 合并评估(两者形态收敛),单独推进 B 已无意义;
4. C 若被选中,M1 叙事定为"宿主用户的随身兜底",并接受双权威孤岛与跨权威审批通道(M2 阻塞项)的代价。

**组合判据**:产品把"桌面+手机数据一致"列不可妥协 → A 成立;把"随身兜底/无服务器可用"列最高优先 → C 的 M1 是次优(在产品决策推翻之后);B 的全功能移植倾向在任何标准下排最后。

---

## 8. 开放问题

1. **真机空缺(最高优先)**:iOS Safari/Android Chrome 锁屏→回前台 resume 补发、iOS 锁屏电台(MediaSession)、${usesCleartextTraffic} release 解析值、crypto.subtle 于 tauri.localhost——四项均无一手实测。
2. **polaris-web Linux 运行时行为**零一手证据(notify inotify/portable-pty/rusqlite/审计链),阶段 0 实测即裁判。
3. **/api/files 根白名单 × cap.fs Remote deny 的交互设计**:白名单是否随 workspace/会话路径联动、URL query 凭据的替代方案,需契约级 spec。
4. **通知/推送架构选型**:Web Push 前置链(PWA 化)vs 原生壳 FCM;iOS 无静默推送的产品预期管理。
5. **备份/导出/机密轮换验收标准**:服务器到期/被封、手机丢失、token 泄漏后的检测与应急路径(阶段 1A ⑦ 的具体内容)。
6. **审计归因贯通**:真实 device_id(现恒 "core"/"ipc")、audit source 仅 "Remote"、token 泄漏后无法区分来源。
7. **Android 交叉编译剩余面**:git2 门控后 polaris_lib 剩余错误面未知;gen/android 不入库与工程陈旧(10.8.0 vs 10.9.2)的处置(入库 or CI 固定 init)。
8. **data_root() 启动顺序契约**:POLARIS_DATA_ROOT 注入必须早于 Logger::init 触发的首次 data_root(),需固化为文档/测试。
9. **ipc.rs ~245 分发臂与桌面 40 command 的覆盖差集**未量化;fs 写操作在 web 桥的可达性未验证。
10. **集成机器人三 adapter(QQ/飞书/钉钉)内部桌面假设**(本地回调 URL/端口)未逐行核。
11. **A 形态下的并发编辑产品语义**:桌面+手机同开一个会话,除 JSONL 双写收敛外,冲突呈现(最后写者赢?)与用户提示未定义。
12. **外部事实未决项**:iOS 26 PWA 音频回归、EU PWA 政策长期走向、Android Doze 下 WS 存活时长、Tauri 当前最新稳定 patch 号。
13. **无常开设备用户的兜底形态**(超出三方案域,见 §7 显式边界):他人托管实例、桌面端"一键开服+内网穿透"引导、云端托管服务——需要产品决策,本报告不展开。

---

## 9. 审读意见处理(v2)

| # | 审读意见 | 处理 |
|---|---|---|
| 1 | 移动端传输通道自相矛盾("恒走 http" vs 锁屏 WS) | **接受**。§3.2 新增"传输通道口径":http 是传输**模式名**(HTTP 命令+WS 事件流组合,detector.ts:50),非 URL scheme;WS 由 http/https 派生 ws/wss(httpTransport.ts:116,188 本会话复核),与锁屏 resume、TLS 反代均一致;§1.1 术语表补"http 传输"条目 |
| 2 | "接近零新开发"与量级"中"冲突 | **接受**。摘要 1 改为"核心对话/数据链路零新开发即可运行,但整体工程量级为中(P0 安全闸等十余项)" |
| 3 | "已投产/已打通"超出证据 | **接受**。全文"投产"改为"已实现(材料记载)/已就位",并在 §2 明示"无 Linux 生产运行记录" |
| 4 | PWA/推送"同级优先"表态与阶段 2 排期矛盾 | **接受**。§7 拆出阶段 1B(PWA 基建+通知/推送,与 1A 同时启动、不阻塞首次受控部署),原阶段 2 相应瘦身 |
| 5 | "APK 是纯远程客户端"证据地位不一 | **接受**。§2 拆为两层:【读码·事实】前端强制先配远端(main.tsx/MobileConnectionGate)与【推断】Android 无本地后端路径(Cargo.toml:141 注释+未查到,未逐行核连接层) |
| 6 | mimo-tts 与 edge-tts 指代冲突 | **接受**。§3.4 澄清两条独立通道:后端合成唯一实现=mimo-tts(node 插件);前端合成=edge-tts-universal(ttsService.ts:5,19 本会话复核);C firstStep 验证的是前端路径 |
| 7 | /api/files 鉴权状态无法判定 | **接受**。本会话读取 middleware.rs:58-65 与 files.rs:1-60 核实:跳过中间件但 handler 内部 authorized() 鉴权(Bearer+?token= 双形态);§3.2 给出两种风险定性(设 token=持凭据全盘读;未设 token=匿名全盘读) |
| 8 | `grep -c "manifest\|serviceWorker"` 缺 -E 证据无效 | **接受**。§3.7 将该命令标记作废并说明;§3.2 与 §3.8 记录重跑命令(`grep -inE`/`grep -rn "serviceWorker" src index.html`/`ls public/`),manifest 与 serviceWorker 双确认缺失 |
| 9 | 投票无评分制 | **接受**。§6 开头声明:材料未提供统一量表与计票规则,总分=直接加总、首票=排名第一的票数、无复权,分数不可跨人精确比较 |
| 10 | 投票主体不全 | **接受**。§6 声明:选民 3/4 身份未标注,投票人与质询作者的重叠关系材料未提供,代表性与独立性无法复核 |
| 11 | "物理不可行"措辞超出证据 | **接受**。§2 与摘要拆分:iOS=OS 级禁止 fork/exec(平台硬限制);Android=未打包未移植的工程缺口(Termux 先例、方案 B 即据此设计),不再使用"物理不可行"覆盖 Android |
| 12 | LobeChat 断言无 URL | **接受**。§3.5 补材料内来源 URL(github discussions/15221、sliplane.io),并标注"搜索结果引用,未抓取核实原文" |
| 13 | dirs-sys 断言无标签无版本 | **接受**。§3.1 补全证据链:Cargo.toml:93 `dirs = "5"`【复核】→Cargo.lock dirs 5.0.1→dirs-sys 0.4.1【复核】→质询员实读 registry dirs-sys-0.4.1/src/lib.rs:39-42【读码·材料内】+lib.rs/crates/sysdirs【外部】;注明行为绑定锁定版本、升级需复核 |
| 14 | "不在 A 工期估算关键路径上"悬空引用 | **接受**。§6 选民 2 引文改为"该路径未纳入本报告的阶段排期(本报告不做工期/关键路径估算)" |
| 15 | 术语/指代无定义 | **接受**。新增 §1.1 术语速查(polaris-web/axum/RouterBus/Source·SourceClass/P1-f/g/h/S7/session-v2/M1-M3/Polaris Pocket/http 传输/md5 鉴权) |
| 16 | "无常开设备用户"未进入结论 | **接受**。§7 新增"显式边界":该场景三案均无解、超出方案域;兜底方向列入 §8.13 |
| 17 | 阶段 0 之后无决策机制 | **接受**。§7 新增"阶段 0 判定机制":判定人=发起方;判据=五项清单;失败分支=安全层→回 1A,核心链路→重评推荐并回写报告 |
| 18 | B/C 方案正文缺失 | **接受**。新增 §4.1 方案主张概述(A/B/C 各一段,含 B 的保留/需远端清单与 C 的 M1-M3 内容) |
| 19 | 备份/导出验收未落入推荐路线 | **接受**。§7 阶段 1A 增第 ⑦ 项"备份/导出验收标准",与 §5.4.2 前置要求对齐 |
| 20 | 证据标注约定与执行脱节 | **接受**。约定改为"未标注的 file:line 默认【读码】"(§卷首),消除大面积漏标;关键缺失点补标(dirs-sys、/api/files、TTS、传输通道);§3.8 新增 v2 会话验证命令表 |

---

*本报告仅综合既有勘察材料与撰写/修订会话的抽查复核,未修改任何代码;所有"实测"均归属前序勘察 ask,本会话实际执行的命令清单见 §3.7/§3.8。*
