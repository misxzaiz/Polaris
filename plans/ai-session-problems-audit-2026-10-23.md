# AI 会话域问题全景审计（bug + 交互不友好清单）

> 状态：只读分析，未实施任何修复 · 2026-10-23
> 方法：5 路并行源码核查（多端事件路由 / 前端会话状态 / 持久化恢复 / 聊天 UI 交互 / 后端会话核心），关键高危结论已抽查原文复核。
> 关联：`plans/session-multi-device-diagnosis.md`（跨端架构诊断）、`plans/plugin-multichat-mvp-spec.md`（MultiChat MVP）
> 标注约定：每条问题附【严重度】【确定/推测】与 file:line 证据；推测 = 代码路径确定、触发频率依赖时序。

---

## 0. 总体结论

1. **多端问题的本质**：传输层是「全端总线」（chat-event 广播给所有连接端，无会话/设备寻址），状态层是「端内孤岛」（每个端各有一套内存 store，路由 key 是各端本地生成的 UUID）——于是「全员听得到、无人路由得到」。唯一能穿透 store 的口子（plugin_card 兜底投递到活跃会话）恰好会把**别的端/别的会话的卡片塞进你正在看的会话**，这就是「app、浏览器、桌面挤在一个会话」观感的直接来源之一。
2. **数据丢失类问题比预想严重**：messages.db 两个模块共用同一文件且 schema 版本互不相同（1 vs 2），各自「版本不符→删库重建」——SQLite 消息兜底实际处于被反复清空的危险状态；删除流式中的会话会「复活」；regenerate 的旧消息恢复时会从尾部复活。
3. **前端 bug 的复发模式**：同类修复只打一个卡片类型/一个入口（question 修了、form/plugin_card/tool_call 没修；sendPendingNow 加了代际校验、interrupt 定时器没加）——结构性必然继续复发。
4. **交互问题的重心**：失败路径的用户反馈缺失（权限卡提交失败静默、发送失败丢草稿、流式中编辑丢字、Web 断线无横幅）+ 中文 IME 回车直发 + 「后端就绪、UI 断线」的死功能（重新生成按钮永不出现）。

---

## 一、多端/多设备问题（用户点名核心）

### 1.1 广播无寻址 + 路由 key 是端本地 UUID —— 跨端互不可见的根因

- chat-event 经 `event_broadcast` 单一总线广播给**所有**端：web WS `should_send` 空订阅=全发（`src-tauri/src/web/api/ws.rs:255-264`）；桌面 webview 也由中继任务收全量并 `handle.emit("chat-event")`（`src-tauri/src/lib.rs:602-638`）。
- 但事件信封的 contextId 是**发起端**的 `session-<本地UUID>`（`createConversationStore.ts:2122`、`sessionStoreManager.ts:86,122`），id 由各端 `generateUUID()` 本地生成、从不跨端共享；即使两端从历史恢复同一会话，`restoreFromHistory` 也各自生成新前端 UUID（`historyService.ts:470-474`）。
- 于是 B 端事件的 `_routeSessionId` 在 A 端永远查不到 store → `sessionStoreManager.ts:573` 丢弃。**听得到、路由不到**。【高｜确定】

### 1.2 plugin_card 兜底投递 = 跨端/跨会话污染放大器

- `sessionStoreManager.ts:550-569`：routeSessionId 匹配不到 store 时，`plugin_card/plugin_card_answered` 兜底投给本端 `activeSessionId`（df9fd515 为修单端外部入口而加）。
- 但该事件是全端广播的：**每个端都会执行同一兜底**。①甲端会话拉起插件卡 → 乙端把卡投进乙端活跃会话；②外部 MCP 入口触发 → 所有端各自投进各自活跃会话；③MultiSessionGrid 多开时，后台会话的卡片投进当前前台会话。【高｜确定】

### 1.3 `main` 前缀兜底是「必丢」终点

- contextId 缺失/非白名单前缀的事件（`approve_plan/reject_plan` 恒为 main：`ai_chat_core.rs:2354,2401`；无 contextId 的 chat：`ai_chat_core.rs:1142-1147`）走旧 handler 路径后，因 payload 无 `_routeSessionId` 在 `sessionStoreManager.ts:541-545` 再次丢弃。`plan_approval_result` 永远到不了发起会话（本机靠乐观更新掩盖）。【中｜确定】

### 1.4 `question_answered` 广播对不上任何前端 store

- 信封按 `session-<引擎conversationId>` 包裹（`ai_chat_core.rs:1991-2000,2162`），前端 id 是本地 UUID → 多设备下 B 端的问题卡片永远停在待答态（本机靠乐观更新掩盖）。【中｜确定】

### 1.5 桌面端对「任何端」的流结束弹系统通知

- `lib.rs:617-631` 判定 `session_end` 不区分会话与来源端：手机/web 上跑完的会话，桌面弹「AI 回复已完成」。【中｜确定】

### 1.6 会话列表跨端零感知

- 新建/重命名/删除会话全是端内本地操作（`sessionStoreManager.ts:84-206,228-275,341-360`），无后端调用、无事件广播；历史列表纯拉取（`historyService.ts:344-435`），无订阅/轮询。A 端新建会话 B 端要刷新才可见。【中｜确定】

### 1.7 WS 断线补齐三个缺口

- seq/resume 机制真实覆盖 chat-event（缓冲 2000 条/8MB，`event_broadcaster.rs:93-105`、`ws.rs:201-251`、`httpTransport.ts:189-255`），但：
  - **缺口1**：tokio broadcast 容量仅 256（`state.rs:368`），客户端消费慢触发 Lagged 时仅 warn 继续，不知丢、不 resume（`ws.rs:169-171`）；
  - **缺口2**：页面重载 `lastSeq===0` 不发起 resume（`httpTransport.ts:193-197`），需手动触发恢复；
  - **缺口3**：自动恢复只处理「后端仍 running」的会话（`webReconnectResync.ts:67-73`）——断线窗口内流已结束且缓冲被淘汰的收尾增量永久丢失。【中｜确定】

### 1.8 中断无设备归属校验

- `session_state_commands.rs:91-100` 注释自认「当前实现任何设备都可中断」。双刃：多端是能力，错配/误触是风险。【低｜确定】

### 1.9 宿主桥无来源校验 + 插件面板非沙箱（安全）

- `main.tsx:17,20` 把 `invoke`/`listen` 裸挂 `window.__POLARIS_HOST_INVOKE__/LISTEN__`，无包装、无白名单；插件 JS 经 Blob URL 动态 import 进主窗口**同源上下文**（`plugin-system/pluginModuleLoader.ts:52-66`），window 全量可达。
- 后果：任意面板脚本可监听**所有会话（含其他端）的 chat-event 明文**，并调用全部后端命令（桌面=裸 Tauri IPC 40 个命令；web=`/api/*` 白名单内含 `router_dispatch`，可打 cap.bash/cap.fs）。【高（安全）｜确定】

---

## 二、持久化与数据丢失

### 2.1 messages.db user_version 互删 —— SQLite 消息兜底整体失效（灾难级）

- 两个模块打开**同一个** `<DataRoot>/session-v2/messages.db`：`commands/session_messages.rs:24-26` 与 `commands/session_state_commands.rs:28-30`。
- `session_db.rs:30` SCHEMA_VERSION=**1**，`session_state.rs:50` SCHEMA_VERSION=**2**，各自「版本不符→drop conn→删库重建」（`session_db.rs:91-103`、`session_state.rs:241-253`）。
- 推演：上轮退出时磁盘 user_version=2（state 库最后写）→ 本次启动消息库先开（`lib.rs:861-864`）→ 2≠1 → **删库重建，session_messages/session_events/session_records/sessions_index 全清空** → `recover_pending_turns` 在空库上"无残留可恢复"。之后 state 库开（1≠2）再删……乒乓。`session_state.rs:36-38` 注释自认该陷阱但只约束了"新增表不升版本"，v1/v2 基线互删本身未解决。
- 已抽查复核属实。【高｜确定】

### 2.2 删除流式中的会话会「复活」

- 删除是硬删（`dialog_storage.rs:317-324`）+ 只调 `turn_persist::forget` 清当前缓冲（`session_messages.rs:119-123`）；但后续 Token 事件 `mutate_turn` 会 `or_insert_with` **重建** Turn 继续写库（`turn_persist.rs:322-331`），SessionEnd → `archive_conversation` **重建 JSONL**（`turn_persist.rs:633-699`）。前端删除入口不先 interrupt（`SessionHistoryPanel.tsx:385-389`）。
- 结果：删除正在流式输出的会话 → 稍后带着半截回复重新出现。另：**Web IPC 删除路径根本不调 forget**（`web/api/ipc.rs:2327-2334`）。【高｜确定】

### 2.3 SQLite append-only 无墓碑 → regenerate/编辑的旧消息「复活」

- turn_persist 只 append/revise 无删除路径；regenerate 后前端 JSONL 已移除旧分支，但 SQLite 行还在；恢复时 `mergeBackendMessages` 把"归档没有而 SQLite 有"的尾部追加（`historyService.ts:40-66`），内容指纹只挡完全同文本 → 旧回答（文本不同）通过过滤，**追加到对话末尾**（位置错乱）。【高｜确定】

### 2.4 轮末双写者共用同一 tmp 文件名，覆写竞态可致整文件丢失

- 前端 session_end → `saveDialog` 整写 JSONL（`eventHandler.ts:402`）与后端 `archive_conversation` 整写同一 JSONL（`turn_persist.rs:467-508,696`）都走 `dialog_write_inner`，tmp 文件名固定 `{name}.tmp` 无唯一后缀、无跨进程锁，序列 `write(tmp)→remove(target)→rename`（`dialog_storage.rs:138-153`）。交错时序可落盘半截文件或 rename 失败致会话文件不存在。前端 per-file 队列（`service.ts:61-71`）只串行化前端进程内。【中｜确定（竞态窗口）/推测（命中率）】

### 2.5 JSONL 写入无 fsync + remove→rename 非原子窗口

- `dialog_storage.rs:138-153` `fs::write(tmp)` 后直接 remove+rename，无 `sync_all`；断电/崩溃在窗口内 → 会话文件整体消失；tmp 残留无回收。首行 meta 损坏 = 会话从列表不可见（`jsonlCodec.ts:203`）。写失败（磁盘满）前后端都只 log（`eventHandler.ts:1196-1200`、`turn_persist.rs:696-698`）。【中｜确定】

### 2.6 新会话 id 首轮 session_end 才落盘 → 流式中崩溃会话蒸发

- JSONL 仅在 session_end 由 saveDialog 创建；conversationId 首个引擎事件才确定（`turn_persist.rs:52-58`）；用户消息在首事件前只在内存队列（TTL 30s、上限 4 条，`turn_persist.rs:73-75`）——引擎启动失败或首事件前刷新，连用户消息都不剩。【中｜确定】

### 2.7 置顶/星标/归档标注只存 index.db，任何重建即全丢；重命名只在内存

- `history_mark_inner` 只写 index.db（`dialog_index.rs:1125-1170`）；`with_conn` 对任何错误删 index 重建（`dialog_index.rs:158-187`），重建只从 JSONL meta 恢复，**标注列不可再生**。重命名仅改内存 sessionMetadata，随下次 saveDialog 才落盘（`sessionStoreManager.ts:341-360`）。【中｜确定】

### 2.8 一次性静默会话残留历史列表

- 标题生成（`titleGenerationService.ts:173-184`，kind='title-generation'）与压缩交接会话用完即毁内存，但 session_end 无条件 `saveDialog`（`eventHandler.ts:402` 无 kind 门控），`deleteSession` 不删 JSONL（`sessionStoreManager.ts:228-278`）→ 历史列表出现「生成标题」垃圾条目。【中｜确定】

### 2.9 turn_persist 覆盖面缺口

- 不落库：Plan* 全系、Question/PermissionRequest、表单卡、AgentRun*、TaskProgress、Usage、图片附件（对照 `turn_persist.rs:160-259` match 分支）；错误文本本身不落库（`turn_persist.rs:252-255` 只 finalize）→ 恢复后只见"已中断"不知为何。
- **用户消息归属是全局 FIFO 启发式**：start 路径按"首个内容事件到达弹队首"归属（`turn_persist.rs:58-75,108-134`），多会话并发时 A 会话可能出现 B 的提问；>4 路并发最早的用户消息被静默丢弃。【中-高｜确定（机制）】

### 2.10 `kernel.resyncSession` 名不副实

- 注释称"与后端消息库对账"，实际快照源仍是 JSONL（`v2-kernel.ts:366-382,517-519`），真正补全靠 `loadMessagesForItem` 的 merge。语义误导。【低｜确定】

---

## 三、后端会话核心与中断

### 3.1 `start` 返回临时 uuid 被 dispatch 注册表当 conversationId 永久存盘

- Claude 路径 start 返回 temp_id（`claude.rs:1245,1265`）→ `dispatchTaskService.ts:296-311` 当真实 id 写入 dispatch_tasks.json 持久化（`commands/dispatch.rs:78-83`）；事件内真实 id 从不回填（session_end 回报不带 conversationId）→ 重启/驱逐后点「追加指令」必失败。【高｜确定】

### 3.2 Claude 用户中断在协议层表现为 error，非 Aborted

- `claude.rs:1048-1077`：EOF 后无 session_end/result → 发 `AIEvent::error` + `SessionEndReason::Error`；全仓只有 opencode 正确实现 mark_interrupted→Aborted（`opencode.rs:1393-1422`）。
- 前端靠 `isInterrupting` 标志掩盖（`eventHandler.ts:623-630` 注释自认）；时序不对/另一端收到 → 弹「Claude CLI 异常退出」红错；后台 dispatch 任务被误判 failed（`dispatchTaskService.ts:206-213`）。【高｜确定】

### 3.3 continue 按 engineId 路由的双向错配（误杀 / 失忆）

- 误杀：engineId 错配（scheduler 自动建/历史恢复缺 engineId，`ai_chat_core.rs:1926-1930` 注释自认错配源）时 continue 判 `is_resident=false` → `try_interrupt_all`（`ai_chat_core.rs:1810-1816`、`registry.rs:257-265`）命中 SimpleAI 的 latch → **正在流式的轮次被截断**。
- 失忆：反向错配时 SimpleAI `session 不存在`静默以空历史开跑（`simple_ai/mod.rs:524-535`，无 warn 事件）→ 同一 conversationId 下历史分叉，模型突然失忆。【高｜确定（路径）】

### 3.4 排他锁状态崩溃后不恢复 → 会话永久 running

- running = 有 start 无 end（`session_state.rs:1119`）；启动只做 turn_persist 恢复，**无 session_state running 清理**（`lib.rs:858-864`）→ 后端被强杀后该会话所有 continue 永远被「会话已在运行中」拒绝，除非用户恰好点一次停止。【高｜确定】

### 3.5 `is_session_active` 双向失真

- Claude/OpenCode 会话自然退出后**永不从 SessionManager 移除**（`claude.rs:1431-1433` 只查 map 存在）→ 已结束会话查得 running=true（Web 重连永远转圈）；SimpleAI 没覆写 `has_active_session`（`traits.rs:729-731` 默认 false）→ 正在流式查得 false（被标完成）。【中｜确定】

### 3.6 SimpleAI panic 无监督 → 永远转圈 + 永久 running

- `tokio::spawn` 的 JoinHandle 被丢弃，无 catch_unwind（`simple_ai/mod.rs:388-443,503-596`）：panic → 无 SessionEnd 无 error，叠加 3.4 该会话后续 continue 全被拒。【高（护栏缺失）｜确定】

### 3.7 引擎注册表全局互斥锁跨会话持有，锁内含子进程探测/睡眠

- 同一 `engine_registry.lock().await` 横跨所有会话的 start/continue/interrupt（`ai_chat_core.rs:1469-1470,1811-1816,1892-1895,1924`）；锁内有 CLI 探测子进程（`claude.rs:1483-1714` npm/pnpm root -g）与 100ms sleep（`claude.rs:1302`）→ 多开时 A 启动期间 B 的「停止」被阻塞。【中｜确定】

### 3.8 start 无排他 → 双发两条流交织

- 排他仅 per-conversation 且只罩 continue（`ai_chat_capability.rs:186-196,617-626`）；start 无 try_start → 双击/重试产生两个引擎进程、两个 conversationId，事件路由进同一 store 交织渲染。【中｜确定（无闸）】

### 3.9 流式通道满时事件静默丢弃

- `pump_callbacks` 用 `tx.try_send`（512 缓冲，`ai_chat_capability.rs:71,589`）`let _ =` 丢弃：慢客户端下 token 甚至 session_end 可被丢 → 缺字/卡流式态。【中｜确定（代码）】

### 3.10 晚到 stop 覆盖完成语义

- 对已自然结束的会话，kill 死 PID 被当成功（`session.rs:333-347` taskkill 非零仍视为已处理）→ 无条件补写 `session_end(aborted)`（`ai_chat_core.rs:1962-1968`）覆盖 completed。【低｜确定】

### 3.11 ai_event 协议演进遗留

- 29 枚举变体 + ad-hoc kebab-case 事件 + 前端动作回声三族混流；语义重复对：Token vs AssistantMessage(is_delta)、Result vs SessionEnd（前端干脆忽略 Result）、Progress vs TaskProgress、Question/PermissionRequest/PlanApprovalRequest 三套"问用户"；`SessionEndEvent.reason` 各引擎可选性不一致；`type` 字段双重打标（serde tag + 内部 event_type，当前恰好一致故无害，任一侧改名即静默漂移）。【中｜确定】

---

## 四、前端会话状态 bug（单机也触发）

### 4.1 interrupt 5s 兜底定时器不区分轮次代际 → 误杀新一轮

- `createConversationStore.ts:2205-2222`：定时器条件只查 `conversationId !== conversationId`（防切会话），不防**同会话新一轮**。用户停止 → 1s 内正常 session_end → 立刻追问 → 5s 定时器到期发现 isStreaming=true（新一轮）→ 强制 `isStreaming=false + finishMessage` → **新回复被无声截断**。session_end 清了 isInterrupting 但没有机制取消定时器（句柄未保存）。与 sendPendingNow 的"代际补丁"同款问题只修了一处。【高｜确定】

### 4.2 晚到 tool_call_end/agent_run_end/plugin_card_answered 在归档后被丢弃 → 工具卡永久 running

- `updateToolCallBlock:934-936`、`updateAgentRunBlock:1403-1405`、`updatePluginCardBlock:1265-1268` 都是 `if (!currentMessage) return`，无 form/question 已修复的跨 messages[] 搜索（对照 `1179-1233`）。session_end 与 end 事件乱序（桌面双通道真实存在）→ 历史消息里工具卡**永久转圈，且写入 JSONL 永久化**。【高｜确定】

### 4.3 form/plugin_card 归档后重发 → 幽灵双卡

- `appendFormBlock:1157`、`appendPluginCardBlock:1243` 幂等只查 currentMessage；session_end 后重放同事件 → 新建幽灵 assistant 消息装重复卡片且永 running。question 已修全局查重（`1033-1043`，测试 `toolCallDedup.test.ts:183-214` 锁定），这两个没同步修。【中｜确定】

### 4.4 sendMessage 失败不回滚用户消息 → UI/引擎上下文永久分叉

- `createConversationStore.ts:2034` addMessage 在 try 之前，`2163-2172` catch 不回滚：失败消息留在界面、从未进引擎上下文，但随下次成功轮次写入 JSONL → 用户以为 AI 能看到，实际看不到。ErrorBanner 重试再追加一条 → 内容重复出现。【中｜确定】

### 4.5 regenerate/editAndResend 先删后发，失败丢历史

- `2376-2384` 先 slice 删旧回复 → `2396-2398` await sendMessage 失败不恢复 → 下次 session_end 整体覆写 JSONL → 被删消息永久丢失。【中-高｜确定（链路）】

### 4.6 token 前端零幂等

- `eventHandler.ts:436-451` 纯 append；`webChatResilience.regression.test.ts:104-113` 明文记录"去重是后端 seq 责任"——后端 seq 一旦出 bug（如 3.9 丢弃、1.7 Lagged），前端无防线，文本直接重复。【中｜确定（设计自认）】

### 4.7 streaming 中同内容外来消息被误去重

- `eventHandler.ts:662-666`：无 clientId 时回退"最后一条 user 消息 content 相等"判定——B 端 streaming 中 A 端发来相同文本（如两次「继续」）被静默吞掉。且发送链路 `normalizeForInvoke` 把换行转义成字面 `\n`（`conversationStoreUtils.ts:244-250`），自己回显也可能比对失败 → 重复渲染。测试只覆盖了 idle 态分支（`multiDeviceSync.test.ts:311-337`，注释自认"字符串比对不可靠"）。【中｜确定】

### 4.8 引擎静默死亡无看门狗 → 永远转圈

- sendMessage 乐观 isStreaming=true（`2045`）后无任何 watchdog；引擎进程无声死亡（IPC 成功但无 error 无 session_end）→ 永久转圈，只有 interrupt 有 5s 兜底（且带 4.1 的 bug）。【中｜推测（依赖死亡方式）】

### 4.9 interrupt invoke 挂起 = 永久转圈 + 待发队列死锁

- interrupt 无超时（`2192-2205`，await 后才启动 5s 定时器）；后端死 → invoke 永不 resolve → isStreaming/isInterrupting 永久 true；且 `sendPendingNow` 持 `queueDispatching` 锁贯穿 `await interrupt()`（`1897-1932`）→ 整个待发队列死锁到刷新。【中｜结构确定】

### 4.10 progressMessage 清理点不收敛

- session_end 清（`eventHandler.ts:396`），但 interrupt 超时兜底（`2217-2218`）、invoke 失败（`2229-2230`）、error 事件（`629-632`）三条路径不清 → 灵动岛持续显示"🔧 XX"转圈。【中｜确定】

### 4.11 会话元数据 status 与聊天区 error 判定不一致

- `sessionStoreManager.ts:624-626` 无条件置 status='error'（不看 isInterrupting），`eventHandler.ts:624-627` 静默——用户主动中断后列表/标签显示"错误"徽标，聊天区却无错。【低｜确定】

### 4.12 其他（低危）

- 首轮 conversationId=null 时 interrupt 静默 no-op（`2178`）；isInterrupting 期间真实 error 被吞（`eventHandler.ts:624-627`）；session_end 不失效 pending 权限卡（只靠下次 sendMessage 过期）；用户 clearPendingQueue 后失败回填复活已清消息（`1874-1876`）；sendPendingNow 会话未启动分支静默放回无提示（`1907-1925`）；streamRateTracker 按 sessionId 缓存永不清理（`streamRateTracker.ts:326-343` dropTracker 零调用）；卡片优先轮次 assistant id 漂移未根治（`232-243,1061-1067`）。

---

## 五、聊天 UI 交互问题

### 5.1 中文 IME 回车直发（中文用户几乎必踩）

- `ChatInput.tsx:1428-1441` Enter 分支只判 `!shiftKey`，未查 `isComposing`；同文件 `:1467` 方向键历史召回**有**防护，唯独 Enter 漏了。组词期按回车确认候选词 → 半截文本直接发出。已抽查复核属实。【高｜确定】

### 5.2 发送失败丢草稿 + 重试丢附件 + 重复消息

- 发送即清空输入不等结果（`ChatInput.tsx:1374-1390`）；失败不恢复草稿；ErrorBanner 重试只传 content 不传 attachments（`ErrorBanner.tsx:44-48`）且无条件追加 → 重复消息。与 4.4 联动。【中高｜确定】

### 5.3 切会话草稿串号（300ms 防抖窗口）

- 草稿防抖 300ms（`ChatInput.tsx:283-288`），`updateInputDraft` 在调用时刻才解析 activeSessionId（`useActiveSession.ts:236-244`），switchSession 不取消挂起防抖 → A 的草稿写进 B。【中｜确定】

### 5.4 流式中编辑消息改动被无声丢弃

- 编辑按钮无流式禁用（`UserBubble.tsx:95-103`），发送后无条件清空输入（`ChatInput.tsx:1333-1394`），editAndResend 流式中 early return 只 log（`createConversationStore.ts:2405-2408`）→ **用户输入丢失且零反馈**。【高｜确定】

### 5.5 重新生成按钮永不出现（后端就绪、UI 断线）

- `SessionMessagesView.tsx:221-223` 只构造 onEdit；`AssistantBubble.tsx:127` `onRegenerate &&` 恒 false；而 kernel（`v2-kernel.ts:166`）与 store（`2343`）regenerate 完整可用。【中高｜确定】

### 5.6 权限卡/计划审批提交失败完全静默

- `PermissionRequestRenderer.tsx:313-317`、`PlanModeBlockRenderer.tsx:257-261,284-288`、灵动岛（`dynamic-island/index.tsx:195-197`）catch 仅 log，卡片停在待处理无任何提示；对照组 AskQuestionCard/FormCard 有回滚+toast 做对了。【中高｜确定】

### 5.7 编辑/重生成只删本地消息，不截断后端上下文

- `createConversationStore.ts:2423-2443` 本地 slice 后直接 continue：界面"改写了历史"，引擎上下文仍含旧消息旧回复 → AI 看到的与用户看到的不一致。【中高｜确定】

### 5.8 移动端/触屏：消息操作 hover-only 不可达

- 复制/编辑按钮 `opacity-0 group-hover:opacity-100`（`UserBubble.tsx:87`、`AssistantBubble.tsx:117`）+ 右键菜单（`MessageContextMenu.tsx`）——Web 手机上消息级操作全不可达。【中｜确定】

### 5.9 后台会话完成无任何通知；等待权限/表单时无徽标

- session_end 无 notification 调用（`eventHandler.ts:376-433`）；SessionCell 只有 hasPendingQuestion 黄点（`SessionCell.tsx:179-181`），权限/表单待处理无指示 → 切走后不知那边卡在等授权。【中｜确定】

### 5.10 Web 断线无横幅

- 断线后流式静默停住；唯一恢复入口是状态栏角落一个 title-only 的手动刷新小图标（`ChatStatusBar.tsx:574-588`）。与 1.7 缺口联动。【中｜确定】

### 5.11 其他（中低危）

- 无常驻「回到底部」按钮（`ScrollToBottomButton.tsx` 死代码；ChatNavigator 仅多轮会话渲染 `SessionMessagesView.tsx:289`）；思考块永远显示"思考中"（`ThinkingBlockRenderer.tsx:122` 不区分 isStreaming）；空会话仅一行字、富空态组件死代码（`EmptyState.tsx` 无使用方）；语音"停止/中断"命令空实现（`ChatStatusBar.tsx:267-272`）；删除消息无 UI 入口；复制失败静默；流式中附件按钮禁用与排队机制矛盾（`ChatInput.tsx:1743`）；流式中本地斜杠命令静默吞（`1215-1222`）；输入无长度上限；停止按钮无"正在中断"反馈态。

---

## 六、结构性根因（跨域共性，决定修复顺序的深层因素）

1. **补丁不同步**：同类修复只打一个类型/一个入口（question 修全局查重、form/plugin_card/tool_call 没修；sendPendingNow 加代际校验、interrupt 定时器没加；AskQuestionCard 有失败回滚、权限/计划卡没有）——历史 bug 反复复发的直接模式。
2. **轮次代际标识缺失**：无显式 turn token，interrupt 定时器、迟到 token、user_message 回显全在用 conversationId/内容/末条消息当代理变量。
3. **传输「全端总线」vs 状态「端内孤岛」**：无设备/workspace 身份、无会话寻址、无会话列表投影（S1-S5 回滚后空缺）；唯一穿透点（plugin_card 兜底）反而制造污染。
4. **乐观更新无事务**：sendMessage 失败不回滚、regenerate 先删后发、删除会话不先 interrupt。
5. **幂等责任外包**：token 去重全靠后端 seq，前端零防线。
6. **清理点不收敛**：progressMessage/权限卡/任务队列的清理散布多处且漏掉强制收尾路径。
7. **双数据源 + 共库版本互删**：JSONL（前端写）与 SQLite（后端写）并存，共用 db 文件的两个模块 schema 版本不同互相删库。
8. **6 套 id 体系、映射分散**：前端 sessionId / contextId / 引擎 conversationId / Claude 临时 uuid / dispatch 合成 id / session_state conversation_id——映射靠内存别名表与 JSONL 文件名，任何一环断裂即事件丢失或进错会话。

---

## 七、做得好的部分（如实记录，修复时不要破坏）

- 滚动跟随算法（用户上滚停跟随、流结束补偿贴底，`useMessageAutoScroll.ts`）；AssistantBubble 精细 memo + Virtuoso 虚拟化的长消息性能。
- 待发队列本体（顺序/失败放回/互斥，`pendingQueue.dispatch.test.ts` 全绿）。
- AskQuestionCard/FormCard 的失败回滚 + toast 模式（应作为权限/计划卡的修复范本）。
- interrupt 的 5s 强制收尾 + 失败 toast 思路（问题在于代际与覆盖面）。
- 权限卡过期机制（expireStalePermissionRequests + "已失效"紧凑条）。
- OPFS 迁移幂等设计（失败重试、同名 skip）。
- 标题生成 per-session 防重入、失败有占位。
- Claude EOF fallback 携带 stderr 尾摘要、continue 失败补写 session_end(error) 占位。
- WS seq/resume 机制本体（2000 条/8MB 缓冲 + resume 协议）——缺口只在三个边界场景。

---

## 八、优先级建议（按用户伤害排序，供决策，本期未实施）

**第一梯队（数据丢失/核心正确性）**
1. messages.db 拆文件或统一 schema 版本管理（2.1）
2. 删除会话先 interrupt + Web IPC 补 forget + conversation 级 tombstone（2.2）
3. SQLite 墓碑机制，否则 mergeBackendMessages 不安全（2.3）
4. Claude interrupt 补 mark_interrupted → SessionEnd(Aborted)（3.2，改动小消掉一整类前端兜底）
5. session_state 启动清理未配对 running + SimpleAI 补 has_active_session（3.4/3.5）

**第二梯队（高频交互 bug）**
6. IME Enter 拦截（5.1，一行判断，参照同文件 :1467 自家写法）
7. interrupt 定时器轮次代际（4.1）+ 归档后工具卡终态回写（4.2，跨 messages 搜索对齐 form/question）
8. sendMessage 失败回滚草稿/消息 + 重试去重带附件（5.2/4.4）
9. 权限/计划卡提交失败 toast+回滚，对齐 AskQuestionCard（5.6）
10. 重新生成按钮接线（5.5，UI 一行级改动，后端现成）

**第三梯队（多端体验，需先做方向决策——见 session-multi-device-diagnosis.md 方案 A/B/C）**
11. plugin_card 兜底改按 contextId 前缀寻址或收敛为「同端同会话才兜底」（1.2）
12. 事件广播加会话/设备寻址维度（订阅携带感兴趣的前缀集）（1.1）
13. question_answered/plan_approval_result 路由修复（1.3/1.4）
14. 会话列表跨端变更推送（1.6）+ WS 三缺口（1.7）
15. 桌面系统通知按端过滤（1.5）

**第四梯队（安全加固）**
16. 宿主桥白名单包装 + 插件面板 iframe/隔离评估（1.9）

---

## 附：分析覆盖范围

- 多端路由：eventRouter / transport(tauri+http) / ws.rs / event_broadcaster / lib.rs 中继 / ask_listener 广播 / sessionStoreManager 路由 / main.tsx 宿主桥 / historyService 列表 / webReconnectResync。
- 前端状态：createConversationStore / eventHandler / sessionStoreManager / dedupMessages / conversationStoreUtils / useActiveSession + 同目录 20 个测试档案。
- 持久化：session-v2 全部 / dialogStorage 全部 / historyService / sessionArchive / sessionHandoff / contextCompactHandoff / titleGenerationService / opfsMigration / 后端 session_db / session_state / dialog_index / turn_persist。
- UI 交互：Chat 目录（ChatInput 2090 行、SessionMessagesView、各 Renderer、ChatStatusBar、SessionCell、ErrorBanner、DynamicIsland）。
- 后端核心：ai_chat_core / ai_engine / claude.rs / simple_ai / opencode / session.rs / registry.rs / ai_chat_capability / ai_event.rs / session_state_commands。
