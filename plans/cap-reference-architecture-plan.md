# /cap 轻量引用与引用映射库 —— 架构方案（引用库·注册表延伸）

> **状态：已实施（2026-10-26，实施记录见 plans/reference-mapping-spec.md）**
> 日期：2026-10-26
> 结论来源：三候选方案 + 多评审记录 + 发送链路勘察（材料随任务给定）；本文撰写时对全部关键行号做了源码抽查复核（见文末「核实声明」）。
> 胜出方案：**引用库·注册表延伸**（评审共识排名第一，两轮完整评分 8.6 / 8.4，第三位评审五维合计 43，均居三案之首）。

---

## 一、背景与用户需求原话

### 1.1 背景

Polaris 输入框当前存在多条「内容注入通道」，其中 `/cap` 斜杠命令的现状是**双轨且都往消息前部灌大块 JSON**：

- **轨道一（选中即展开）**：键入 `/cap 待` → 建议列表点选 `cap.todo` → `buildCapDetailBlock(entry)` 生成的完整 describe JSON（30+ 行）经 `setLocalText` 直接灌进 textarea 正文（`src/components/Chat/input/ChatInput.tsx:1191-1214`），正文只能追加在 JSON 之后，滚动查找、易误删协议；
- **轨道二（发送时展开）**：`/cap ...` 命令文本不点建议直接发送 → `chatCommandRouter` 兜底把 describe 块拼在**正文前部**（`src/components/Chat/input/chatCommandRouter.ts:73-74`，速查分支 `:85`）。
- 同为引用机制的 TCB（浏览器圈选上下文块）也把「引导语 + @path」拼在消息**前部**（`ChatInput.tsx:1456-1458`）。

而既有注册表 `contextBlockRegistry.ts:4-6` 声明了「新增来源只需注册 kind 处理器，输入框 / 草稿 / 发送拼接链路零改动」，`types.ts:86-95` 也声明了 `ContextBlockKindSpec`（icon/render/format/dedupe）——但实际 `formatContextBlock` 是硬编码 switch（`contextBlockRegistry.ts:68-94`），全仓无注册 API，`ContextBlockPreview.tsx:55` 硬编码 `marquee-context` 判断。**机制壳子在、接线没做。**

### 1.2 用户需求原话（勘察材料留存的表述）

> 以下为勘察材料中留存的用户需求表述（非完整逐字记录，按材料原样引用）：

- 做一个「**引用和映射库**」；
- 输入框**只显示轻量引用**（而非把完整内容灌进正文）；
- 「**实际发送时在消息末尾包含**」引用内容（正文在前、引用在后）；
- 「**不只 /cap，其他来源（文件等）也走类似机制**」——机制要可注册、可扩展。

### 1.3 需求规格要点（勘察材料·requirementSpec 摘录）

- **数据模型**：引用项 = `{ refId, source, title, 去重键(source+dedupeKey), 预览数据, materialize() }`；引用状态单一 owner，跟随现有草稿链（`ChatInput.tsx:293-298` debouncedPersistDraft）。
- **必须支持的操作**：add（幂等登记，同 source+dedupeKey 覆盖旧项）、remove(refId)、list()（chip 展示序 = 发送拼装序，单一排序权威）、preview(refId)、persist/restore、expandAtSend()（发送时单点物化，对队列派发路径同样生效）。
- **发送拼装契约**：所有引用统一物化并拼在**用户正文之后**（消息末尾）；物化失败不得阻塞发送、不得丢正文。
- **降级链统一**：有工作区 → 优先落盘 `.polaris-handoff/` + @path 引用；无工作区或落盘失败 → 末尾直拼文本。
- **单一权威约束**：cap 协议内容实时来自 cap.help（`capCatalogStore`，前端不做第二份协议文档）；新增来源只注册 kind/spec 处理器，兑现 `contextBlockRegistry.ts:4-6` 既有声明。
- **协议保守约束**：引擎侧零改动（引用块是普通消息文本）；旧草稿/旧消息向后兼容；AGENTS.md 4.1 协议无运行时 schema 校验，关键枚举与必填字段不漂移。
- **UI 与跨端约束**：chip 用主题 token 不硬编码颜色；移动端 Web 一等公民（纯前端实现，不经 Tauri 专属 API）；cap.help 三端同源注册且未被 Remote deny（主会话核实结论，本轮未复测）。
- **验收口径**：`pnpm exec tsc --noEmit` 0 错误 + 改动文件 eslint 0 新增；capSlashCommand 存量测试通过 + 新增引用库 vitest；手工验收六项（见 §4.4 阶段 2）；不要求回退工作区在途未提交改动。

---

## 二、现状勘察摘要

### 2.1 发送链路图（用户点发送 → 模型收到文本）

> 摘自勘察材料 `sendPath.flowDiagram`，桌面/Web 同构，差异见 2.5。行号已抽查复核（标注 ▸ 的为本会话亲验）。

```
┌─ 输入框态（ChatInput.tsx，三通道并存）───────────────────────────────
│ ① 文本通道 value（本地 state） ⇄ store 草稿 inputDraft{text,attachments,contextBlocks} ▸
│    · 草稿三通道持久化：updateInputDraft(...) ChatInput.tsx:295(300ms防抖)/479/567；
│      store 内存态 createConversationStore.ts:176-180、setter :455-456（未发现磁盘持久化）
│    · /cap 选中即展开（本轮要取代的交互）：ChatInput.tsx:1191-1214 ▸ →
│      buildCapDetailBlock/buildCapDigestBlock（capSlashCommand.ts:95-101/82-92 ▸）全文 JSON 灌入输入框；
│      目录未就绪退回 `/cap ...` 文本（:1196，发送时 chatCommandRouter 兜底）▸
│    · @对话 选中：ChatInput.tsx:1215-1255 → packForReference 落盘 .polaris-handoff/*.md
│      （conversationPackager/index.ts:197-208）→ 文本替换为 @relPath（:1241 ▸）——已是「轻量引用」形态
│    · @file/@工作区：插入 @relPath / @ws:path 文本（:1257-1268）
│ ② TCB 平行通道：contextBlocksRef（圈选上下文块），不进文本
│ ③ 附件通道：attachments（content/textContent），不进文本
│    /cap 数据源：useCapCatalogStore.ensure → invoke router_dispatch("cap.help",index)（capCatalogStore.ts:68-70 ▸）
├─ 发送前改写点（handleSend，ChatInput.tsx:1286-1506）——★引用内容在此被展开/落盘
│    分支 A 流式中 :1312-1383 → TCB 双轨（有工作区：packContextBlocksAsReference 落盘
│       .polaris-handoff/tcb-*.md + 「引导语+@relPath」【前缀】拼入 messageContent；▸
│       无工作区/失败：formatContextBlocks 全文【前缀】）→ enqueuePending（队列项已含展开文本 :1352）
│       ⚠️ 流式守卫 :1313-1319 仅拦 /nexus /agent /dispatch /assault ▸——/cap 文本原样字面入队
│    分支 B 本地斜杠 :1387-1405 ▸ → tryHandleSlashCommand（chatCommandRouter.ts:42-86 ▸）：
│       /cap 唯一命中 → sendText = describe JSON 块 + \n\n + 正文（:73-74）；
│       不命中 → 全量速查块 + \n\n + rest（:85）。
│       ⚠️ 此分支 TCB 块被直接丢弃（:1392-1394 清空未物化 ▸，不落盘不拼接）
│    分支 C 编辑重发 :1431-1439 → onEditSend → editAndResend（createConversationStore.ts:2698-2770）。
│       ⚠️ editMode 下 TCB 块同样被静默丢弃（:1492-1495 ▸）
│    分支 D 普通发送 :1441-1487 ▸ → TCB 双轨同 A（引用【前缀】）→
│       commitPromptHistory(trimmed) 只记原文（:1479 ▸）→ onSend(messageContent, workspaceDir, attachments)（:1480）
│    onSend 签名：ChatInput.tsx:139 (message, workspaceDir?, attachments?) ▸——contextBlocks 不进参数，
│    全部在发送前被改写进 message 文本
├─ Store 拼装点（conversationStore.sendMessage，createConversationStore.ts:2172-2363）——★@引用归一化在此
│    · UI 消息 userMessage.content = 原始 content（:2212-2224 ▸）——界面显示与引擎收到的文本已不同
│    · parseWorkspaceReferences（:2194-2199 ▸；实现在 src/services/workspaceReference.ts:51-186，
│      WORKSPACE_REF_PATTERN 通配任意 @token :23 ▸）：@relPath / @ws:path → @绝对路径（processedMessage）；
│      ⚠️ 全仓库 Rust 侧无 parse_workspace_references（grep src-tauri 无结果）——@ 改写是纯前端行为
│    · 系统提示旁路通道：workspacePrompt + oneTimeParts（pendingBriefing :2300-2314）→
│      appendSystemPrompt——不进消息流的一次性注入先例
│    · normalizeForInvoke(processedMessage)（conversationStoreUtils.ts:244-250 ▸）：
│      ⚠️ 真实换行 → 字面 "\n" + trim——引擎收到的一律是单行文本
│    · aiChatDispatchStream({action:'continue'|'start', message, options}) → invoke('router_dispatch_stream')
├─ 传输层
│    桌面 Tauri：tauriTransport IPC → commands/router.rs；
│    Web/移动：POST /api/router-dispatch-stream → axum fallback ipc bridge（web/router.rs:140）→
│       web/api/ipc.rs:326-328 按命令名分发 → dispatch_router_dispatch_stream（ipc.rs:3002-3025）
│       → 同一 RouterBus.dispatch_stream。payload 全量透传，改写只发生在端上
├─ 能力层（cap.ai.chat，ai_chat_capability.rs）
│    解析 {action,message,options}（:250-267）→ start/continue_chat_inner；AIEvent 经 chat-event 回流
├─ 后端消息拼装（ai_chat_core.rs）——★附件内容在此嵌入
│    · start: turn_persist::record_user_request(&message)（:1026-1032）先落库存 message 参数——
│      落库/历史的用户文本 = 前端 processedMessage，不含附件嵌入段
│    · process_attachments（:216-387）：图片→image_data；文本<30KB→embedded_sections；
│      ≥30KB/二进制→存 .polaris/file_N.ext + file_references
│    · build_message_with_attachments（:404-435）final_message 结构：
│      [附件嵌入段] → [用户消息] → [「请使用 Read 工具查看」引用段]（嵌入在前、引用在后 ★先例）
├─ 引擎读取态
│    ClaudeCode：final_message 包成 stream-json user 消息写 stdin（claude.rs:734-785）；
│      @绝对路径由 Claude CLI 原生读取（Polaris 侧无解析代码）
│    SimpleAI：engine 目录 grep '@' 无任何引用预处理——@path 只是字面文本，
│      模型须自行调 read_file 工具（simple_ai/tools/fs.rs:37-63）才能取到落盘内容
└─ 消费回顾（三态分叉，现状即如此）
     UI 历史 = 原始 content；turn_persist/归档 = processedMessage（含 @abs、TCB 引导语）；
     引擎实际文本 = final_message（附件嵌入段+processedMessage+Read 提示）。
     「引用映射库」方案必须显式决定每一处存哪一侧（见 §4.3 openQ-6）。
```

### 2.2 引用机制清单（现存 7 条通道）

| # | 机制 | 显示形态 | 发送展开 | 存储 | 耦合要点 |
|---|---|---|---|---|---|
| 1 | **@file 文本引用** | 输入框字面 token「@相对路径」，无 chip | 发送时前端改写：`sendMessage` 内调 `parseWorkspaceReferences`（createConversationStore.ts:2194，全仓唯一机械调用方）把 @rel→@abs | 仅草稿 text 与消息文本 | 通配正则 `WORKSPACE_REF_PATTERN`（workspaceReference.ts:23）会吞任意 @token，新 @ 形态须在 handleInputChange 先行拦截（ChatInput.tsx:925-944 ▸）；token 含空格即断裂 |
| 2 | **@对话 引用** | 键入「@对话」弹历史会话列表，选中后 token 被替换为 `@.polaris-handoff/<标题>-<id8>[-summary].md`（ChatInput.tsx:1240-1241 ▸） | 无独立展开点——落盘后与 @file 同链路 | 打包 markdown 落盘到工作区 `.polaris-handoff/`（3000 token 阈值选全文/摘要，conversationPackager/index.ts:197-208，经 `create_file`） | 落盘工作区 = 源对话工作区\|\|当前会话，两者皆空 toast 拒绝；`create_file` 是 legacy command 双端可用但未经 RouterBus gate；插入走防抖回写（与 @专家/agent 即时路径不一致，300ms 窗口有丢插入风险） |
| 3 | **TCB contextBlocks（注册表+chips+落盘）** | 不进文本；输入框顶部 ContextBlockPreview 卡片链（折叠 chip=标题+来源徽标+备注+展开/移除） | ChatInput.handleSend 内改写：有工作区→`packContextBlocksAsReference` 落盘 `tcb-<ts>.md` + `buildTcbReferencePrompt`「引导语+@path」拼在消息【前部】；无工作区/失败→`formatContextBlocks` 全文【前部】。空闲/流式两分支重复同一段代码 | per-session `inputDraft.contextBlocks`（addContextBlock 按 source+dedupeKey 去重覆盖，createConversationStore.ts:482-489 ▸），内存态；marqueeStore 平行镜像双写 | 「注册表」实为 switch 内联；`ContextBlockKindSpec` 声明未接线；发送即清空、onSend false 时已落盘文件成孤儿；editPending 撤回强制 `contextBlocks:[]`（:2156-2163 ▸）；marquee-context 双字段兼容（顶层 regions/url 与 data.\* 并存）是统一数据形状的最大兼容负担 |
| 4 | **attachments 附件通道** | 输入框顶部 AttachmentPreview 胶囊链，与 TCB 平行不混排 | onSend 第三参 → `attachmentsForBackend` → 后端 `process_attachments`（图片原生 image_data / ≤30KB 嵌入 / >30KB 落盘+引用） | 前端 Attachment 对象进 inputDraft.attachments（内存态）；限额 10 个/单图 20MB/单文件 50MB/总 100MB | 拼装在 Rust 侧、前端不可控；与 TCB 刻意双轨（ContextBlock 不进附件管线）；归档只存附件元数据，内容不进 JSONL |
| 5 | **skill-/mcp- 内联 token** | 「/」建议选中后替换光标 token 为字面文本 | 无发送端展开——token 原样进消息，语义靠引擎侧技能索引对齐 | 纯草稿 text | 无机械消费者（token 改名即静默失效）；replaceSlashToken 单 token 正则对「命令+参数」双 token 形态有盲区（/cap 双 token 缺陷 0392e24e 即此因，ChatInput.tsx:1115-1120 ▸） |
| 6 | **/cap 斜杠命令（现状双轨，待被取代）** | ① 键入 /cap 弹建议列表（参数补全 ChatInput.tsx:812-835 ▸）；② 选中即展开：describe JSON/全量速查直接灌进输入框（:1191-1214 ▸） | 文本残留 /cap 时 tryHandleSlashCommand 在 handleSend 展开（唯一命中 detail+正文，不命中 digest+rest，均拼【前部】）；目录未就绪 toast 重试 | capCatalogStore 会话级缓存（ensure → router_dispatch('cap.help', index) 单一权威）；注入内容仅存在于草稿 text | 双轨并存=同一能力两种发送形态，两轨注入块都在消息前部；prompt 历史在斜杠分支记展开后全文（:1400，召回看到的是膨胀文本）；/cap 只认消息首（parseCapSlashCommand ^\/cap） |
| 7 | **压缩交接简报 pendingBriefing（第五条注入通道补充）** | PendingBriefingCard 一行折叠卡挂在输入框上方，可展开/编辑/移除，不进文本 | sendMessage 时拼进 oneTimeSystemPrompt→appendSystemPrompt 通道（createConversationStore.ts:2300-2314），随本次请求带出、不进用户气泡，发送后置 null | per-session store 字段，内存态 | 唯一走系统提示词通道的注入机制——「引用在消息末尾包含」的约定须对它显式收编或排除（本方案：排除，见 §4.5） |

### 2.3 chip 体系三层现状（勘察材料·chipCapabilities 摘录）

1. **ContextBlockPreview（活，唯一在用）**：增=外部经 `store.addContextBlock`（source+dedupeKey 去重覆盖；当前唯一生产者是 BrowserPanel 圈选）；删=双入口（chip × 按钮 / ChatInput.removeContextBlock，两者都同步清 marqueeStore 镜像）；备注=updateContextBlockNote 内联编辑；预览=折叠 chip 头 + 按 kind 展开详情两级。**局限**：仅认识 marquee-context 一种 kind，未知 kind 走 JSON 降级（ContextBlockPreview.tsx:190-203 ▸）；`types.ts:86-95` 的 ContextBlockKindSpec render/format/dedupe 声明了但管道未通（contextBlockRegistry.ts:68-94 ▸ 实为 switch）；无已发送态，发送即全清。
2. **marqueeStore（活，平行镜像）**：按 browserLabel 去重、每浏览器标签保留最新一块；与 inputDraft.contextBlocks 双写无单点权威，靠 ChatInput 在移除/发送时双向同步；纯内存不持久化。
3. **ContextChip/ContextChips + types/context.ts（死代码）**：六型 + 展示 helper，完全没有发送映射能力；组件无人 import。复用需补发送格式化 + 增删接线 + 落草稿通道，不能当现成能力。

### 2.4 草稿持久化现状

草稿三通道 = `inputDraft.{text, attachments, contextBlocks}`，per-session Zustand store，**内存态、无磁盘持久化**（重启/崩溃即丢）。写入路径三形态全在 ChatInput：① 防抖 300ms；② 即时 updateInputDraft（语音追加、TCB 移除、建议选中插入、版本栈操作前 syncDraftNow）；③ 发送/清空整体清零。三通道仅在 handleSend 汇合，各走各的发送路径。已知坑：@对话 插入仍走防抖路径不一致；prompt 历史召回刻意不写草稿；editPending 恢复队列项时 contextBlocks 强制 []；发送失败（onSend false）时草稿已清零、TCB 已清、handoff 文件已落盘，仅 prompt 历史回滚——失败重试已无材料。

### 2.5 跨端与引擎差异（勘察材料·surfaceDifferences 摘录）

- **桌面 vs Web/移动**：发送链路同一 payload、两条管道（Tauri IPC / HTTP router-dispatch-stream → 同一 RouterBus）；引用落盘用的 `create_file` 双端同命令名（Web 侧 ipc.rs:243 分发）。**方案中所有改写保持在「发送前」（ChatInput/sendMessage 内），双端自动一致。**
- **引擎差异**：Claude CLI 原生消费 @绝对路径；SimpleAI 无任何 @ 解析，靠模型主动 read_file——`buildTcbReferencePrompt` 的「请查看 @path 并结合该内容协助我」引导语是两种引擎通吃的措辞。
- **全引擎共同约束**：normalizeForInvoke 把换行拍平成字面 `\n` + trim——注入块若含多行 JSON，发送后全部变单行字面 `\n`。
- **路径三态分叉**：同一消息在 UI（原文）/ turn_persist（processedMessage）/ 引擎（final_message）三处文本不同；引用状态若只存前端内存态，跨端跟随/重载后不可回放——已知缺口，方案须显式声明（见 §4.7 R2）。
- **未验证项（如实声明）**：cap.help 是否被 Remote deny 未在本链路复核（任务给定事实：未被 deny；权限层 policy_permission.rs 未读）；inputDraft 是否有会话级磁盘持久化未发现（仅确认内存态与 300ms 防抖回写）。

### 2.6 已知缺陷清单（勘察材料·gaps 摘录）

1. **输入框污染**：/cap 选中即展开把完整 describe JSON（30+ 行）灌进正文，与「只显示轻量引用」直接冲突；而 TCB 已有 chip 形态可参照，/cap 无任何 chip 化。
2. **注入位置在前部**：/cap 两条展开路径与 TCB 双分支全部把引用拼在正文**前**，与「末尾包含」目标相反。
3. **无结构化引用项**：发送产物是纯拼接文本，草稿/聊天显示/prompt 历史三个层面都无法区分「用户正文」与「引用内容」。
4. **四套引用机制各自为政**：/cap 纯文本拼接、TCB chip+落盘、@对话 落盘+@path、@file 正文 token——统一注册表只按 kind 分发格式化，没有引用项概念。
5. **注册表声明未兑现**：`contextBlockRegistry.ts:4-6` 声称「注册即接入、链路零改动」，实际只服务 marquee-context 一种来源，新 kind 必须改 registry 源码。
6. **去重/排序不统一**：addContextBlock 仅对 TCB 有去重；/cap 无去重（重复选中即重复注入整块全文）；多来源引用无统一排序权威。
7. **无工作区降级语义各自为政**：TCB→降级全文拼入，@对话→toast 拒绝，/cap→纯文本不依赖工作区。
8. **拼装逻辑分散且有路径漏展开**：TCB 拼装在空闲/流式两分支重复两份；流式入队分支不拦 /cap（字面入队），队列派发 sendPendingNow 直发不经命令展开——**流式期间输入的 /cap 会以字面文本发出**。

---

## 三、三候选方案对比表（含落选原因）

### 3.1 总览

| | ① 引用库·注册表延伸（胜出） | ② 内联令牌引用库 | ③ 统一引用库方案 |
|---|---|---|---|
| **核心思路** | 不新建平行体系——/cap 收编为 ContextBlock 新 kind，把 `ContextBlockKindSpec` 从声明壳接成真注册表，发送收敛为单点末尾物化 | 引用即文本：`@cap:todo` 轻令牌与 @file/@专家 同构留在正文流，发送时由可注册的令牌展开器单点物化、统一追加末尾 | 引用项是一等数据：新建 ReferenceItem/ReferenceKindSpec 平行体系按 kind 收编来源（/cap→TCB→@对话），唯一展开点在 sendMessage 末端 |
| **协议面** | **零**新类型、零协议变更（复用 InputDraft.contextBlocks + ContextBlock 既有字段） | 零 schema 变更（令牌随 inputDraft.text） | 最大：onSend 加第 4 参 + InputDraft/SendMessageOptions/PendingMessage/UserChatMessage 四处新增字段（全可选但无运行时校验） |
| **改动面** | 最小：前端 5 文件 + 2 新文件，任一阶段可独立 revert | 中等：新增 refToken 模块与 sendMessage 接线，与 chip 通道并存 | 最大：约 12 文件、5 新建模块、11 存量测试迁移 |
| **交互达标** | chip 可展开核对 describe、可备注、可移除；正文零标记 token | 令牌裸文本，无预览/备注，「轻量引用」可视性弱 | 最 full：chip+预览+备注+发送失败恢复+气泡只读 chips |
| **多端一致性** | 纯前端双端同构；有工作区 file-first、无工作区直拼 | 最优（双评审 9 分）：cap 恒 inline 无工作区依赖，移动端首获引用能力；单漏斗结构性修复流式盲区 | referencesAppended 保证 JSONL 字节级回放，跨端同 payload |
| **与 AGENTS.md 契合** | 最高：兑现代码库自声明的休眠契约，单一权威即期成立 | 方向正确但令牌+chip 两套机制并存 | 张力最大：平行体系阶段 1-2 双通道并存，单一权威兑现被推迟 |
| **评审一**（均分） | **8.6**（契合9/通用8/多端8/风险9/交互9） | 7.6（8/7/9/7/7） | 7.0（6/9/7/4/9） |
| **评审二**（均分） | **8.4**（9/8/8/9/8） | 8.0（8/7/9/8/8） | 7.8（7/9/9/6/9） |
| **评审三**（五维合计） | **43**（9/8/8/9/9） | 40（8/8/9/7/8） | 40（7/9/9/6/9）* |
| **共识排名** | **①** | ② | ③ |

> \* 评审三对③的 score 字段填 6，与其五维分项合计（7+9+9+6+9=40）不一致，按分项如实呈现；该评审未给出均分。

### 3.2 ② 内联令牌引用库 —— 落选原因（排名第二）

**优势（评审共识）**：多端一致性最优——令牌即纯文本，草稿持久化零 schema 变更、流式入队盲区（流式守卫仅拦四命令、/cap 字面入队 → 队列直发）经 sendMessage 单漏斗结构性修复；cap 恒 inline 不依赖工作区，无工作区会话/移动端首次获得引用能力；命名空间碰撞分析精确（`@cap:self.inspect` 命中 looksLikeFilePath 的点号判定，若用户恰有名为 cap 的工作区会被误改写；`@cap:todo` 恒被跳过），缓解方案（expandRefTokens 先于 parse 执行 + 测试固化）成立。

**落选原因**：

1. **交互达标度最弱**：正文内无 chip 对象、无发送前预览/备注，气泡与历史只见 `@cap:todo` 字面，「轻量引用」可视性弱于 chip；用户误改令牌 id 即改引用目标且无 UI 提示。
2. **统一度不足**：库只覆盖 token 形来源，TCB 结构化圈选仍是第二套 chip 机制，末尾引用区由 TCB（ChatInput 先拼）与令牌块（sendMessage 后拼）两源合成，顺序靠约定非单一权威；截图等非 token 来源被排除在外。
3. **精细回归点**：新增 `@cap:` 建议分支需插进 handleInputChange 拦截优先级链（@对话/@专家 与 file partialMatch 之间），该链对顺序敏感。
4. **触碰在途文件与存量测试**：直接改写 sendMessage（评审时 createConversationStore.ts 在途），存量测试需部分迁移。

### 3.3 ③ 统一引用库方案 —— 落选原因（排名第三）

**优势（评审共识）**：终态抽象最完整（ReferenceKindSpec{icon,renderPreview,materialize,restore} 四元组，@file 不收编的边界论证与源码事实吻合）；交互最 full（chip+预览+备注+发送失败恢复+气泡只读小 chips）；referencesAppended 挂消息保证 JSONL 字节级回放；cap 恒 inline 移动端友好。**作为长期演进蓝本价值最高。**

**落选原因**：

1. **平行体系违背单一权威的即期状态**：新建 ReferenceItem/ReferenceKindSpec 与既有 ContextBlock 高度同构，阶段 1-2 `inputDraft.references` 与 `contextBlocks` 双通道并存，单一权威兑现被推迟到阶段 2。
2. **协议面最大**：onSend 加第 4 参并需包 wrapper（App.tsx:379 直传桥）+ 四处类型新增字段（虽全可选）——正落在 AGENTS.md 4.1「协议无运行时 schema 校验」已知缺口区；referencesAppended 进 JSONL 重建链属最重协议动作。
3. **回归面最大**：约 12 文件、11 存量测试迁移到新契约；双通道期 sendPendingNow 与 editPending 两条队列路径都必须带上 references（editPending 现强制清块），漏一处即复现丢失；TCB 迁移须保住 marqueeStore 双写同步链；发送失败恢复等顺带改进每个都是回归向量。
4. **与在途改动直接碰撞**：评审时实测其必改文件 App.tsx 与 createConversationStore.ts 均在途修改（本会话复核：App.tsx 仍在途）。
5. **事实精度一处偏差**：其称「prompt 历史只记正文（:1479 现记展开文是缺陷）」——实测 `ChatInput.tsx:1479` 普通分支已记 trimmed 原文，真正记展开文的是斜杠分支 `:1400`（材料引用正确但正文表述混淆），说明该案对现状发送链的勘察有一处未落到实测。

---

## 四、胜出方案详案：引用库·注册表延伸

### 4.1 一句话哲学

> 不新建平行体系——/cap 收编为 ContextBlock 新 kind，把 contextBlockRegistry 从「声明的壳」接成真注册表（`types.ts:86-95` 的 ContextBlockKindSpec 落地），发送收敛为单点末尾物化；「引用映射库」就是 InputDraft.contextBlocks + kind 注册表本身的自然延伸。

### 4.2 交互设计

**【显示形态】**
键入 `/cap 待` → 建议列表（ChatInput.tsx:812-835 既有，不动）；点选 cap.todo 后输入框正文变回**空**（`/cap 待` 前缀被移除，不再灌 describe JSON——取代 ChatInput.tsx:1191-1214 的 setLocalText 展开），输入框容器顶部 ContextBlockPreview 链（ChatInput.tsx:1820-1824 既有位置 ▸）出现一枚轻量引用 chip：⚡ 图标 + 「cap 协议 · 待办」标题 + `cap-slash` 来源徽标（ContextBlockPreview.tsx:77-99 既有折叠 chip 结构 ▸），可展开核对 describe JSON（:190-203 未知 kind JSON 降级渲染天然可用 ▸）、可加备注、可移除。

用户继续在正文打字「建三个任务」，正文与引用互不干扰——**正文无任何标记 token，chip 是纯平行通道**（同 TCB 现状，BrowserPanel→addContextBlock 范式）。

**【发送展开】**
点发送 → handleSend 单点调用 `materializeContextBlocks`（新）把全部 chips 统一物化并拼在用户正文**之后**：

- 有工作区 → 全部块落盘为一个 `.polaris-handoff/tcb-<ts>.md`（复用 contextBlockRegistry.ts:36-53 既有 create_file 机制 ▸），消息末尾追加一句：
  「以下是随消息附带的引用内容（已保存为上下文文件），请查看 @.polaris-handoff/tcb-<ts>.md 并结合该内容协助我。」（句式沿用 buildTcbReferencePrompt :60-63 ▸ 的两引擎实测措辞，仅从前部移到末尾）；
- 无工作区/落盘失败 → 末尾追加「[随消息附带的引用内容 · N 项]」+ 按 kind 格式化全文（formatContextBlocks :99-104 既有 ▸）。

发送后 chips 全清（既有行为），prompt 历史只记正文原文（commitPromptHistory(trimmed)，ChatInput.tsx:1479 既有 ▸）。

键入 `/cap ...` 命令文本不点建议直接发送 → chatCommandRouter 兜底路径**保留**（chatCommandRouter.ts:42-86 ▸），仅把注入位置从正文前改为正文后（:73-74 / :85 两行对齐）；流式期间键入 /cap 由字面入队改为同样转 chip+正文（收编勘察 gap 8 的字面直发缺陷）。

### 4.3 数据模型

**【注册表条目】** 复用 `src/stores/conversationStore/types.ts:86-95` ▸ 已声明未接线的 ContextBlockKindSpec，**不新增类型**：

```ts
{ icon?: string; render?: (b) => ReactNode; format?: (b) => string; dedupe?: (a, b) => boolean }
```

新增注册机制：contextBlockRegistry.ts 内 `const kindRegistry = new Map<string, ContextBlockKindSpec>()` + `registerContextBlockKind(kind, spec)` / `getKindSpec(kind)`；formatContextBlock（:68-94 ▸）从 switch 改为 `getKindSpec(block.kind)?.format(block) ?? 未知JSON降级`（降级分支原样保留）。

**【注册者】** 内置 kind 在 contextBlockRegistry.ts 模块加载时自注册两条：

- `marquee-context`（icon 🎯，format=formatMarqueeContextBlock 既有）；
- 新 kind **`cap-help`**（icon ⚡，format = 按 `data.mode` 分发到既有纯函数 buildCapDetailBlock(entry) / buildCapDigestBlock(caps)，capSlashCommand.ts:95-101 / :82-92 ▸ **零改动复用**）。

后续来源（@对话/截图/插件）各自注册，输入框/草稿/发送链路零改动（兑现 contextBlockRegistry.ts:4-6 ▸ 的既有声明）。

**【cap 引用项】** = 一条 ContextBlock（types.ts:56-79 ▸ 既有字段全部够用，**不扩协议**）：

```ts
{
  id: crypto.randomUUID(),
  kind: 'cap-help',
  title: entry ? 'cap 协议 · 待办' : 'cap 能力速查',
  source: 'cap-slash',
  dedupeKey: entry?.id ?? '__digest__',
  data: { mode: 'detail' | 'digest', entry?: CapCatalogEntry, caps?: CapCatalogEntry[] }
}
```

**【openQ-2 答复·快照语义】** data 内存的是**选中时刻的 CapCatalogEntry 快照**（capCatalogStore.ensure 所得），format 读快照不重拉——所见即所发、离线可发、目录中途变化不影响已挂引用；要新鲜内容重新点选即可（dedupeKey=cap.id，addContextBlock 既有覆盖语义 createConversationStore.ts:482-489 ▸ 原位覆盖刷新快照）。

**【生命周期】** 注册（模块 import 一次性）→ 产生方 upsert 进 per-session `inputDraft.contextBlocks`（内存态，草稿三通道既有，ChatInput.tsx:295 ▸ 防抖回写）→ 发送时 materializeContextBlocks 单点物化（落盘或直拼，追加正文末尾）→ 清空；handoff 文件与现况一致不清理。

**【openQ-3 答复·降级链】** 不设新体积阈值，沿用既有统一降级链「有工作区一律落盘 @path（不论大小）/ 无工作区或失败一律末尾直拼」——与 TCB 现状完全同构（ChatInput.tsx:1450-1472 ▸），避免引入第二套分级逻辑。

### 4.4 文件级改动清单

#### 改动① 注册表核心：壳→真注册表 + 单点末尾物化

**文件**：`src/components/Chat/input/contextBlockRegistry.ts`、`src/components/Chat/input/contextBlockRegistry.test.ts`（新建）

1. 新增 `kindRegistry` Map + `registerContextBlockKind`/`getKindSpec`，formatContextBlock 改为查表分发（未知 kind JSON 降级 :85-91 原样保留），模块尾部自注册 marquee-context 与 cap-help 两条内置 kind（cap-help.format 复用 buildCapDetailBlock/buildCapDigestBlock，从 block.data 快照取参）；
2. 新增纯函数 `upsertContextBlock(blocks, block): ContextBlock[]`——抽出 createConversationStore.ts:482-489 ▸ 的 source+dedupeKey 原位覆盖/追加逻辑为单一权威；
3. 新增 `materializeContextBlocks(blocks, workspacePath?): Promise<{ trailing: string }>`——blocks 空返回空串；有工作区→packContextBlocksAsReference（:36-53 既有 ▸，文件名仍 `tcb-<ts>.md` 不改）成功→trailing=「以下是随消息附带的引用内容（已保存为上下文文件），请查看 @relPath 并结合该内容协助我。」；失败/无工作区→trailing=`[随消息附带的引用内容 · N 项]\n\n`+formatContextBlocks(blocks)；**不再提供 buildTcbReferencePrompt 的前部形态**（导出删除，全仓仅 ChatInput 两处调用，grep 证实无测试引用 ▸）；
4. **openQ-4 答复**：块序=inputDraft.contextBlocks 数组序（插入序），chip 展示序与落盘/直拼序同源（ContextBlockPreview.map 与 formatContextBlocks.map 消费同一数组），不做来源优先级、不做用户重排（后续可加）；cap 与 marquee 混排进同一文件/同一直拼段，不分组；
5. **openQ-5 答复**：TCB 前部引导语退役，其语境说明职能由末尾固定句式承担；**openQ-1 答复**：chip 与正文完全解耦——正文零标记 token，remove(refId) 仅删块（removeContextBlock ChatInput.tsx:472-480 既有 ▸），无正文联动需求。

**验收**：新增 vitest 覆盖 upsert 原位覆盖/追加、materialize 三分支（落盘成功→末尾 @path、无工作区→末尾直拼、空块→空串）、cap-help format 快照渲染；`pnpm exec tsc --noEmit` 0 错误。

#### 改动② ChatInput 接线：/cap 选中改 chip、发送双分支收敛、斜杠分支补物化

**文件**：`src/components/Chat/input/ChatInput.tsx`

1. selectSuggestion 的 cap 分支（:1191-1214 ▸）重写：entry 命中→构造 cap-help 块（快照=capCatalogStore 当前 entry），经 upsertContextBlock 并入 contextBlocksRef/setLocalContextBlocks，并 updateInputDraft **立即整体回写**（{text, attachments, contextBlocks}，仿 removeContextBlock :472-480 ▸ 即时路径，防 300ms 竞态），正文把 `/cap <查询>` 前缀整体移除（cap 恒在消息首，仿 agent 分支 :1176 整条替换，规避 replaceSlashToken 单 token 盲区 :1115-1120 ▸）；目录未就绪/空目录→保留现文本回退（`/cap ...` 命令文本，发送时 chatCommandRouter 兜底），与今日 :1196-1203 等价；
2. handleSend 双分支替换：isStreaming（:1322-1351）与普通发送（:1445-1473 ▸）两段重复的 TCB 前部改写代码，收敛为一次 `const { trailing } = await materializeContextBlocks(contextBlocksRef.current, currentWorkspace?.path)`，`messageContent = trailing ? (trimmed ? `${trimmed}\n\n${trailing}` : trailing) : trimmed`——**末尾拼接即用户「在最后包含」的硬要求**；流式入队分支 enqueuePending 的 text 同样存末尾改写后全文（PendingMessage 只有 text/attachments 字段，无块字段，维持现状传递方式）；
3. 斜杠分支（:1387-1405 ▸）：cmd.sendText 存在时先把当前 chips 物化追加到 sendText 末尾再 onSend（3 行，**修复该分支今日静默丢弃 TCB 的洞** :1392-1394 ▸）；
4. 流式 /cap 收编：isStreaming 守卫列表（:1313-1319 ▸）后追加 parseCapSlashCommand(trimmed) 命中且目录 loaded → 复用①的注册逻辑转 chip、入队文本取 remainder；未 loaded 维持字面入队（记录为残余限制）；
5. **openQ-6 答复**：聊天流 user 气泡显示「正文+末尾引用段」全文（userMessage.content=sendMessage 收到的 message，createConversationStore.ts:2212-2224 ▸ 既有分叉不动）；prompt 历史记正文原文（:1479 ▸ 既有）；编辑重发（:1431-1439）与队列撤回（createConversationStore.ts:2156-2163 ▸ 强制 contextBlocks:[]）维持现状丢 chip 语义，不做 chip 逆解析。

**验收**：`pnpm exec tsc --noEmit` + 改动文件 eslint 0 新增；手测六项——/cap 选中正文无 JSON、发送消息正文在前引用在后、无工作区降级、删 chip 后发送不含该内容、草稿切会话往返 chip 仍在、流式入队 /cap 不再字面直发。

#### 改动③ 发送时兜底路径对齐末尾契约

**文件**：`src/components/Chat/input/chatCommandRouter.ts`

/cap 分支两处拼接改为正文在前：唯一命中 :73-74 `sendText = capCmd.remainder ? `${capCmd.remainder}\n\n${detail}` : detail`；不命中/无 token :85 `sendText = capCmd.rest ? `${capCmd.rest}\n\n${buildCapDigestBlock(caps)}` : buildCapDigestBlock(caps)`。

**openQ-7 答复**：保留键入 /cap 命令文本作为 chip 交互的降级路径（chip 是唯一主入口、命令文本是兜底，不非法化）；多命中 toast 语义不变（:76-83）；目录未就绪 toast 重试不变（:49-56）。

**验收**：capSlashCommand.test.ts 存量 11 测试不动即绿（纯函数未改；`grep -c` 实测 11 ▸）；手测键入 `/cap 待办 建任务` 直接回车，消息为「建任务在前、协议块在后」。

#### 改动④ chip 渲染接线（零新组件）

**文件**：`src/components/Chat/input/ContextBlockPreview.tsx`

第 55 行 ▸ `const spec = block.kind !== 'marquee-context' ? undefined : marqueeSpec` 改为 `const spec = getKindSpec(block.kind)`（marquee 仍自注册 icon 🎯，Target 图标分支 :79 不动避免视觉回归）；cap-help 由此获得 kind-known 样式与 ⚡ 图标，展开详情继续走既有未知-kind JSON 降级渲染（:190-203 ▸，describe 本就是 JSON，零组件新增）。render 字段本轮不接组件（保持声明，未来来源用）。

**验收**：`pnpm exec tsc --noEmit`；手测 cap chip 折叠/展开/备注/移除四操作。

#### 改动⑤（可选小重构）去重语义单一权威

**文件**：`src/stores/conversationStore/createConversationStore.ts`

addContextBlock（:470-496 ▸）的重复判定改为调用 upsertContextBlock 纯函数（逻辑同源，删 ~8 行重复）。**注**：评审时该文件在途未提交；本会话 `git status --porcelain` 实测其已不在在途列表 ▸，冲突风险低于评审时判断，但该项仍为可选——ChatInput 本地注册已自带同语义 upsert，双份容忍至后续收敛，不影响主方案。

**验收**：若实施，pnpm test:run 的 conversationStore 相关测试通过。

#### 改动⑥ spec 先行（AGENTS.md 核心原则 4）

**文件**：`plans/reference-mapping-spec.md`（新建，实施阶段 0 产出）

落简短 spec：目标（/cap 轻量引用化 + 末尾包含 + 注册表延伸）、所有者与接口（上列 5 处）、8 个 openQuestion 的答复、验收口径。遵循 cap-slash-command-spec.md 先例：locale 零改动（i18n 走 defaultValue），不要求回退工作区在途改动（主改 4 文件 git status 干净 ▸）。

### 4.5 通用化路径（机制即映射库）

**【机制即映射库】** 本轮之后「引用映射库」= ①**数据面**：InputDraft.contextBlocks（types.ts:104-114 ▸ 既有三通道之一，去重键 source+dedupeKey，插入序即发送序）+ ②**行为面**：kind 注册表（新 kind 注册 icon+format 即接入 显示/草稿/落盘/降级/末尾拼接 全链，零改动区域覆盖 ContextBlockPreview 通用 chip、materializeContextBlocks 单点物化、无工作区统一降级）。

**【迁移顺序】** cap-help（本轮）→ marquee（已在库内，本轮顺势收编进注册表）→ @对话（下轮：选中后不再往正文插 @path token（ChatInput.tsx:1241 ▸），改注册 kind `conversation-handoff`，落盘沿用 packForReference 阈值机制 conversationPackager/index.ts:197-208，fileRef 存 data）→ 预留 kind text-selection/screenshot（types.ts:42-43 ▸ 已留位）→ @file 最后（不动理由见 openQ-8）。

**【openQ-8 答复】** @file/@工作区 本轮不收编：其 token 是「正文内文本 + 引擎侧 parseWorkspaceReferences 改写」（createConversationStore.ts:2194-2199 ▸、src/services/workspaceReference.ts:23 ▸ WORKSPACE_REF_PATTERN 通配任意 @token），chip 化会触及引擎解析链与 @对话/@专家 的拦截优先级（ChatInput.tsx:925-944 ▸），回归面远大于本轮收益；spec 中把库的 source 边界写死为「**本轮=cap-help+marquee，@\* 文本 token 机制保持现状**」，@file 未来若收编需连 WORKSPACE_REF_PATTERN 优先级一起评估。

**【插件来源】** ContextBlockKind 已是 string 透传（types.ts:44），插件经 addContextBlock（useActiveSession.ts:296 ▸ 既有）带自定义 kind，未注册 format 自动走 JSON 降级——安全参与落盘/末尾直拼，无需前端预注册，天然满足「不只 /cap，其他来源也走类似机制」。

**【协议保守】** 零后端、零新 IPC、零类型必填变更：引擎收到的是普通消息文本（plans/cap-slash-command-spec.md:28 既有决策沿用），双端（桌面 Tauri IPC / Web /api/router-dispatch-stream）同构自动一致。

**【第五条通道（pendingBriefing）边界】** 压缩交接简报走 appendSystemPrompt 系统提示旁路（createConversationStore.ts:2300-2314），契约本就是「不进消息流、不出现在 UI 历史」——与「引用在消息末尾包含」是两类语义，**显式排除在本库外**，维持现状。

### 4.6 实施顺序

- **阶段 0**：`plans/reference-mapping-spec.md` 落地（含 8 个 openQuestion 答复与本方案）——可验证产出：spec 文档存在且评审通过。
- **阶段 1**：contextBlockRegistry.ts 注册表化（Map+register/get+upsertContextBlock+materializeContextBlocks 末尾版+cap-help/marquee 自注册）+ 新建 contextBlockRegistry.test.ts——可验证产出：`pnpm exec tsc --noEmit` 0 错误 + 新增 vitest 通过（此阶段 ChatInput 旧调用仍走 buildTcbReferencePrompt 临时保留导出，或同 PR 内一步切换，二选一，避免中间态编译不过）。
- **阶段 2**：ChatInput.tsx 接线（cap 选中改 chip、handleSend 双分支收敛、斜杠分支补物化、流式 /cap 收编）+ chatCommandRouter.ts 末尾对齐 + ContextBlockPreview.tsx getKindSpec 接线；删除 buildTcbReferencePrompt 前部导出——可验证产出：tsc + eslint 0 新增 + `pnpm test:run` 全量通过（capSlashCommand.test.ts 存量 11 例不动即绿）+ 手测六项（见改动②验收）。
- **阶段 3（可选）**：createConversationStore.ts addContextBlock 复用 upsert——可验证产出：conversationStore 相关 vitest 通过；与在途改动冲突则跳过并记录。
- **边界（本轮明确不做，写入 spec）**：@file/@对话 文本 token 机制不动；editMode/队列撤回丢 chip 不修；handoff 文件清理不做；chips 跨端同步不做（维持前端 per-session 内存态）。

### 4.7 风险与缓解

| # | 风险 | 缓解 |
|---|---|---|
| R1 | **消息形态变化**（TCB/引导语从前部移到末尾）：grep 证实拼接位置无任何自动化测试断言（buildTcbReferencePrompt/packContextBlocksAsReference 仅 ChatInput 两处调用、无测试引用），回归面=人工手测 | 末尾句式沿用两引擎实测的「请查看 @path 并结合该内容协助我」措辞（contextBlockRegistry.ts:60-63 ▸）；「引用在后」与后端附件拼装先例方向一致（ai_chat_core.rs build_message_with_attachments :404-435 嵌入段在前、Read 提示在后）；Claude/SimpleAI 对位置均不敏感（Claude 原生读 @abs，SimpleAI 靠引导语调 read_file，simple_ai/tools/fs.rs:37-63） |
| R2 | **落库三态分叉维持现状**：UI 气泡=正文+末尾引用段全文、turn_persist=processedMessage 同文、prompt 历史=仅正文——与今日 TCB 前缀行为同构，不新增分叉维度；chips 仅前端内存、不跨端不跨重启（与今日 TCB/草稿一致，属已知缺口非回归，重载后 @path 文件仍在工作区可被历史回放） | 如实记录，本轮不扩大 |
| R3 | **在途改动共存的混流风险** | 本会话 `git status --porcelain` 实测 ▸：主改 4 文件（ChatInput/contextBlockRegistry/chatCommandRouter/ContextBlockPreview）干净；当前在途为 App.tsx、Chat/index.ts、SessionConfigSelector.tsx、DispatchCenter.tsx(删)、locales×2——方案对以上全部零触碰（locale 走 defaultValue 先例）；createConversationStore.ts 已不在在途列表，可选改动⑤现无冲突 |
| R4 | **直拼降级体积**：无工作区时 digest（全量速查）与多块 marquee 全文进消息末尾——与 TCB 既有降级同语义，体积可接受（单 cap describe 约 1-3KB） | 落盘路径下 describe 多行 JSON 完好存文件，仅消息里一行 @path（比今日直拼进正文更抗 normalizeForInvoke 拍平 conversationStoreUtils.ts:244-250 ▸，是改善而非风险） |
| R5 | **既有缺口如实记录、本方案不恶化**：① 流式 /cap 若目录未 loaded 仍字面入队（收编路径仅在 loaded 时生效）；② 发送失败（onSend false）chips 已清、handoff 文件已落盘、仅 prompt 历史回滚（ChatInput.tsx:1479-1481 既有事务语义不变）；③ 编辑重发/队列撤回丢 chip（:1492-1495、createConversationStore.ts:2156-2163 ▸ 既有）；④ cap.help Remote 可用性为主会话核实结论、本轮未复测（capCatalogStore.ts:68-70 ▸ 走 router_dispatch，与今日同一链路，方案不新增 deny 面） | 全部写入 spec 的已知边界清单 |
| R6 | **回滚成本低** | 全部改动限于前端 5 文件 + 2 新文件，无协议/后端/迁移，任一阶段可独立 revert；capSlashCommand.ts 纯函数零改动保证存量测试与建议列表不受牵连 |

### 4.8 效果示例（改前 / 改后）

**【改前（现状）】** 用户键入 `/cap 待` 选中 cap.todo → 输入框瞬间被灌入 30+ 行 `[cap 协议 · cap.todo（待办）...]` + ```json{...完整 describe...}``` 代码块，正文只能追加在 JSON 之后，滚动查找、误删协议、无法一眼看到自己要说什么；发送后协议块出现在消息【前部】。

**【改后】** 用户键入 `/cap 待` → ↓ 选中 cap.todo → 输入框变为空，正文直接开打「建三个任务并同步到周报」；输入框上方一枚 chip：`⚡ cap 协议 · 待办 [cap-slash]  💬 只看P0  查看▾ ✕`（可展开核对 describe JSON、可加备注）。点发送 → 聊天流 user 气泡显示：

```
建三个任务并同步到周报

以下是随消息附带的引用内容（已保存为上下文文件），请查看 @.polaris-handoff/tcb-1730000000000.md 并结合该内容协助我。
```

（有工作区；无工作区则为 `建三个任务并同步到周报\n\n[随消息附带的引用内容 · 1 项]\n\n[cap 协议 · cap.todo（待办）...describe JSON]`。）

引擎读到正文在前的任务指令 + 末尾引用，Claude 原生读 @abs 文件、SimpleAI 按引导语 read_file。↑ 召回 prompt 历史只有「建三个任务并同步到周报」；浏览器圈选的 marquee 块与 cap chip 并排显示、按插入序一起落进同一个 tcb-*.md。二次选中 cap.todo → 原位覆盖刷新快照不重复；流式回复中键入 `/cap 主题 换成暗色` → 同样转 chip 入队，不再字面直发。

---

## 五、需用户拍板的开放问题

以下 8 项源自勘察材料 openQuestions，方案已逐条给出答案（§4.3/4.4/4.5）；**每项的方案答案需用户确认**，另附 3 项方案未覆盖、需用户额外拍板的事项。

| # | 开放问题 | 方案已选答案 | 需用户确认的点 |
|---|---|---|---|
| 1 | 引用与正文的 token 联动：正文是否保留可见标记？删 chip 时正文是否联动？ | **完全解耦**：正文零标记 token，remove(refId) 仅删块，无正文联动 | 是否接受「正文看不到任何引用痕迹，全部在 chip 通道」（对习惯所见即所发的用户是交互变更） |
| 2 | 草稿恢复后的引用生命周期：持久化元数据还是物化快照？cap 内容重拉还是用快照？ | **快照语义**：data 存选中时刻 entry，format 读快照不重拉（所见即所发、离线可发）；重选即刷新 | 评审指出快照与「cap.help 实时单一权威」纪律有轻微张力（describe 契约要求实时）——接受快照或改为发送时重拉，二选一 |
| 3 | 引用内容是否统一落盘为文件？阈值定在哪？ | **不设新阈值**，沿用统一降级链「有工作区一律落盘 / 无工作区一律末尾直拼」，与 TCB 现状同构；handoff 文件维持现状不清理 | 是否接受「无工作区会话引用全文进消息末尾」的体积；handoff 文件累积不清理（既有现状）是否继续接受 |
| 4 | 末尾多引用的拼装顺序？混排是否分组？ | **插入序**（chip 序=数组序=发送序），不分组、不重排、不做来源优先级 | 是否接受「无用户重排」（后续可加） |
| 5 | TCB 前部引导语收编后保留在哪？末尾块是否需要固定引导头？ | **引导语退役**，语境职能由末尾固定句式承担（「以下是随消息附带的引用内容……请查看 @path 并结合该内容协助我」） | 句式措辞是否需要调整（沿用了两引擎实测句式，但开头半句是新拟） |
| 6 | 发送后消息的展示形态与历史记录三态？编辑重发/队列撤回？ | 气泡=正文+末尾引用段全文；prompt 历史=仅正文；编辑重发/队列撤回**维持丢 chip**，不做逆解析 | 是否接受编辑重发丢 chip 本轮不修（现状即丢 TCB，不劣化）；气泡显示全文是否够用（不做气泡内只读 chip 卡片，那是落选方案③的能力） |
| 7 | /cap 命令文本形态去留？多命中 toast 映射？ | **保留为降级路径**（chip 是唯一主入口，命令文本兜底；含零命中自动注入全量速查的现状 :85 保留）；多命中 toast 不变 | 是否接受「键入 /cap 直接回车仍自动注入全量速查」（胜出方案保留了该行为；若要去掉需另议） |
| 8 | @file 是否纳入本轮？source 覆盖边界？ | **不纳入**：token 是正文内文本+引擎侧改写，chip 化触及引擎解析链与拦截优先级；spec 写死边界「本轮=cap-help+marquee，@\* 保持现状」 | 是否接受 @对话 收编排到下轮、@file 无限期靠后 |

**方案未覆盖、需用户额外拍板**：

- **A. 目录未就绪的流式 /cap**：目录未 loaded 时流式键入 /cap 仍字面入队（收编路径仅在 loaded 时生效）——残余缺口，接受或要求另设等待态。
- **B. 发送失败的事务缺口**：onSend false 时 chips 已清、handoff 文件已落盘、仅 prompt 历史回滚（既有事务语义不变）——失败重试已无材料，接受或列入后续（落选方案③有结构化恢复设计，可作蓝本）。
- **C. cap.help Remote 可用性**：「未被 Remote deny」为主会话核实结论，本轮未复测 policy_permission.rs——实施前是否要求补一次三端实测。

---

## 附：核实声明

**本会话实际执行的核查（2026-10-26，Windows / Git Bash）**：

- `git status --porcelain`：在途 = App.tsx(M)、Chat/dispatch/DispatchCenter.tsx(D)、Chat/index.ts(M)、Chat/session/SessionConfigSelector.tsx(M)、locales/en-US+zh-CN/chat.json(M)、plans/remove-statusbar-task-center-html-card.md(??)。**主改 4 文件干净；createConversationStore.ts 不在在途列表**（与评审记录当时状态不同，已在 R3 如实更新）。
- `sed -n` 逐行核对：`ChatInput.tsx`:139（onSend 三参签名）、:293-298（300ms 防抖回写）、:472-480（removeContextBlock + marqueeStore 同步）、:812-816（cap 参数补全）、:925-945（@对话/@专家 先于 partialMatch 拦截）、:1115-1120（replaceSlashToken 单 token 盲区）、:1191-1214（/cap 选中展开）、:1238-1244（@对话 → @path 替换 + 防抖回写）、:1312-1322（流式守卫仅 4 命令）、:1387-1405（斜杠分支 :1392-1394 清空 TCB 的洞）、:1444-1473（TCB 前部拼接 + 降级）、:1479（commitPromptHistory(trimmed)）、:1492-1495、:1818-1826（ContextBlockPreview 挂载）；`contextBlockRegistry.ts`:4-6（注册声明）、:36-53（packContextBlocksAsReference，`tcb-${Date.now()}.md`）、:60-63（buildTcbReferencePrompt 句式）、:68-94（switch + JSON 降级）、:99-104（formatContextBlocks）；`src/stores/conversationStore/types.ts`:40-43（kind 预留）、:56-79（ContextBlock）、:86-95（ContextBlockKindSpec）、:104-114（InputDraft）；`chatCommandRouter.ts`:42-86（/cap 分支，:73-74/:85 前部拼接）；`ContextBlockPreview.tsx`:55（硬编码 marquee）、:77-99（chip 结构）、:190-203（未知 kind JSON 降级）、:249（本地 marqueeSpec）；`capSlashCommand.ts`:43/:82/:95（三纯函数）；`capCatalogStore.ts`:57-84（ensure → router_dispatch('cap.help', index)）；`createConversationStore.ts`:470-496（addContextBlock 去重 :482-489）、:2154-2163（editPending 强制清块）、:2192-2199（parseWorkspaceReferences）、:2210-2224（userMessage.content 原文）；`conversationStoreUtils.ts`:244-250（normalizeForInvoke 拍平）；`useActiveSession.ts`:296（addContextBlock 透传）；`src/services/workspaceReference.ts`:23/:28（WORKSPACE_REF_PATTERN / looksLikeFilePath）。
- `grep -c "it(\|test(" src/services/capSlashCommand.test.ts` → **11**。
- `find src -name workspaceReference.ts` → `src/services/workspaceReference.ts`（材料引用省略路径，已按实际路径标注；材料中的 `types.ts` 实际为 `src/stores/conversationStore/types.ts`）。

**未执行项（如实声明）**：`pnpm exec tsc --noEmit`、`pnpm test:run`、`pnpm lint` 未执行——本轮为纯方案撰写，未改动任何代码；以上命令是各实施阶段的验收门槛（见 §4.4/§4.6），非本轮检查项。勘察材料中标注「未验证」的事项（cap.help Remote deny、SimpleAI image_data 消费方式、inputDraft 磁盘持久化）沿用材料结论并在文中如实标注。
