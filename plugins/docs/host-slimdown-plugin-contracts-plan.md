# 宿主删减与插件注册能力规划 —— 以压缩交接为解剖样本

> 状态：**规划文档，未实施** · 日期：2026-11-06
> 来源：用户定案——「删减宿主实现内容，将非核心一切内容移到插件中实现」；本文档以压缩交接（compact handoff）为解剖样本，产出**通用契约规划**，使这一类「会话域编排功能」可外移，同时为其他插件开放更多宿主能力。
> 上游关联：
> - `plans/core-slimdown-plugin-extraction-plan.md`（存量迁移总方案，本文件修订其 §4.3 不拆清单中压缩交接条目的判定前提）
> - `plans/compact-handoff-pre-start-race-fix.md`（空窗竞态修复，其语义将进入 cap.session.waitStreamEnd 契约）
> - `AGENTS.md` §五（新增能力须同步 cap 清单与 `plans/two-bus-architecture.md`）

---

## 1. 定位与判定前提（先说清楚）

前一版分析（2026-11-06 会话内）结论是「压缩交接不宜插件化」。**该判定的前提是现有契约面**：
四问判定中 Q3（通道性）为否——压缩交接依赖的全部是 renderer 内部接口，零 cap 通道。

本规划的核心是**补齐契约面**，把 Q3 从「否」翻成「是」：

| 契约落地前 | 契约落地后 |
|---|---|
| 会话创建/静默/销毁 = renderer store 内部 | `cap.session` 公共通道 |
| 简报注入 = `setPendingBriefing` 私有状态 | `cap.session.setAction` 注入动作 |
| 等待流式结束 = `waitKernelSessionStreamEnd` 内部 API | `ai.stream.end` hook 插桩点 |
| Chat 状态栏入口 = App.tsx 硬编码组件 | `contributes.chatActions` 贡献点 |

**诚实交代**：契约落地前外移仍是负收益（要 hack 同 window 零隔离的洞，或复制竞态易发代码）；
落地后外移才成立。所以顺序必须是 **P1 契约 → P2 外移**，不能倒置。

外移的收益论点有一个被近期事实强化的项：**插件仓有 `update.json` 热更新通道，主仓功能跟主程序发版**。
压缩交接三天内连修两个竞态（a5213717 归档竞态、2a170c5f 空窗竞态），都在编排层——外移后这类
修复走插件热更，不再绑定主程序版本。对「编排复杂度高、修复频率高」的功能，这是结构性收益。

---

## 2. 压缩交接模块解剖（1319 行逐层判定）

挂载点实测：`CompactHandoffButton` → ChatStatusBar（App.tsx:406）、`CompactHandoffProgress` →
全局右下胶囊（App.tsx:435）、`Modal` + `PendingBriefingCard` → ChatInput、编排器 → 前端 service。

| # | 模块 | 行数 | 现状依赖 | 判定 | 外移前提 |
|---|---|---|---|---|---|
| 1 | UI 层（Button/Modal/Progress/PendingBriefingCard） | 649 | App.tsx/ChatInput 硬编码挂载、core store | **可外移** | §3.3 chatActions + §3.2 注入契约 + 通用进度/通知通道 |
| 2 | 任务/进度层（compactHandoffStore） | 152 | toast、AbortController | **可外移** | 现有 cap.kv 即可承载任务态 |
| 3 | 编排层（contextCompactHandoff） | 308 | createSession(silentMode)/deleteSession/setPendingBriefing/waitKernelSessionStreamEnd | **可外移（最大块）** | §3.1 cap.session 全套 + §3.4 hook |
| 4 | 策略层（默认简报模板 + sanitizeBriefing 后处理） | ~60 | i18n | **可外移** | §3.5 策略贡献点（优先级最低） |
| 5 | 共享打包器（conversationPackager） | 210 | ChatInput @对话引用、sessionHandoff 续接、压缩交接**三方共用** | **留核心** | — |
| 6 | 核心钩子（pendingBriefing 消费 ~15 行、silentMode 语义、kernel 状态权威） | — | session-v2 | **留核心** | — |
| 7 | 协议件（ContextCompactRenderer，引擎 /compact 事件渲染） | 35 | AIEvent 协议 | **留核心** | — |

可外移合计约 **1.1k 行**；主仓保留的残余是「契约 + 语义」（§3.2 注入的消费端 ~15 行 + 状态权威），
即该功能从主仓的「实现」降级为「契约」。

---

## 3. 通用契约规划（核心章节：每个契约 = 压缩交接缺口 × 其他插件受益）

### 3.1 `cap.session` —— 会话生命周期（最大缺口，最高价值）

现状：router 28 个 capability 无一会话生命周期条目；会话创建只在 `cap.ai.chat` start/continue
内隐式发生（且不产生宿主会话列表条目）。

动作协议（对齐既有 cap 惯例：`{ action }` + describe 自描述 + 审计入链）：

| action | 载荷 | 语义 |
|---|---|---|
| `create` | `{ type, title, workspaceId, engineId, silentMode, modelProfileId?, model? }` | 创建会话，返回 sessionId。`silentMode=true` 为静默会话（不进列表、不激活、不落盘，B1.f 语义） |
| `delete` | `{ sessionId }` | 删除会话（**仅限本插件经 create 创建的会话**，所有权记账，见 §5） |
| `setPendingContext` | `{ sessionId, text }` | 向会话输入区挂「待发送上下文」（现 pendingBriefing 语义泛化），下次发送作为一次性系统上下文带出并清空 |
| `getStatus` | `{ sessionId }` | 查询运行状态（复用 session_get_status 权威源） |
| `waitStreamEnd` | `{ sessionId, timeoutMs }` | **长操作**：阻塞至 running→idle/error 下降沿。**契约内置 requireRunEvidence 语义**（2a170c5f），插件不得也不需要自造等待逻辑 |
| `interrupt` | `{ sessionId }` | 中断（仅限自建会话） |

权限与安全（详见 §5）：Remote 内置 deny（对齐 cap.app.autolaunch / cap.http 先例）；
manifest permissions 新增 `sessionManage` 布尔；静默会话强制 bypassPermissions 的事实由宿主
在审计链打标（静默+bypass 是权限绕过风险面，必须可追溯）。

**其他插件受益**：task-runner（定时任务驱动真会话执行）、自动标题/摘要类、多会话编排、
watchtower（会话观测增强）、任何「后台跑一段 AI 再把结果交回用户」的形态——这正是当前
「dispatch 任务」内部机制的开普勒化。

### 3.2 待发送上下文注入（并入 cap.session.setAction，UI 归宿主）

`PendingBriefingCard`（136 行）渲染的是「待发送上下文」这个**宿主概念**。外移后：
宿主保留一个**插件无关**的通用卡片（「待发送上下文：随下一条消息发出，可编辑」），
内容由 `setPendingContext` 注入，来源（哪个插件）在卡片上标注。
ChatInput 的消费钩子（createConversationStore:2415-2429）保留在核心，~15 行。

**其他插件受益**：context-pack（打包结果直发聊天的增强形态）、prompt 起草类、翻译类——
「生成内容 → 预填输入框等用户确认」是高频需求，当前只有硬编码一条通道。

### 3.3 `contributes.chatActions` —— Chat 界面动作注册（新贡献点）

现状：贡献点 11 块（views/commands/services/chatCards/mcpServers/styles/...）没有 Chat 域入口；
`CompactHandoffButton` 挂在 ChatStatusBar 是 App.tsx 硬编码。

设计：manifest 声明
```jsonc
"chatActions": [{
  "id": "compact-handoff",
  "area": "statusBar" | "sessionMenu" | "messageContext",
  "title": "压缩交接", "icon": "Scissors",
  "when": { "sessionType": ["project"], "isStreaming": false },   // 声明式显隐条件
  "invoke": { "kind": "panel", "panelId": "compact-handoff.panel" }  // 或 mcp tool
}]
```
宿主 ChatStatusBar / 会话菜单渲染注册项（懒加载，对齐 builtinPlugins 惯例）。

**其他插件受益**：time-sift（对话级考古入口）、repo-lens（会话体检）、导出/翻译对话类——
所有「对当前会话做一件事」的插件获得统一入口形态。

### 3.4 `ai.stream.end` hook 插桩点 —— 流式结束事件桥

现状：hook_registry 插桩点仅 `ai.tool.before/after` + `ai.session.start/end`。
压缩交接外移后需要感知「这轮跑完了」——正是 `waitKernelSessionStreamEnd` 的语义。

设计：在 session_end 收尾处（eventHandler session_end 分支或后端 dispatch 收尾）增加
`ai.stream.end` 插桩：`{ sessionId, conversationId, reason, error? }`。插件经
`contributes.hooks` + `cap.hook.register` 订阅（机制现成，只加插桩点）。
requireRunEvidence 语义由宿主插桩保证（事件只在真实下降沿发），插件侧无竞态面。

**其他插件受益**：任务完成通知、会话归档、用量统计——所有需要「会话跑完了」信号的插件。

### 3.5 `contributes.compactStrategies` —— 压缩策略贡献点（P3，可选）

`{ id, instruction 模板, sanitizer 规则声明, 建议 engineId }`。宿主压缩动作读取激活策略。
优先级最低：模板本身在 i18n 中仅几十行，等 P2 稳定后再评估是否开放。

### 3.6 通用进度/通知通道（轻量，可后置）

`CompactHandoffProgress` 胶囊外移需要宿主提供「插件后台任务进度」的通用展示位。
两个选项：(a) 扩展现有 toast 支持进度态；(b) `cap.ui.progress` 新能力（注册/更新/移除任务胶囊）。
倾向 (a)——toast 已有 sessionId 跳转联动，扩进度态改动最小。

---

## 4. 分阶段路线（每阶段独立验收、可叫停）

| 阶段 | 内容 | 主仓改动 | 验收 |
|---|---|---|---|
| **P0 地基** | slimdown §6 既有三项：hostInvoke 白名单、manifest 校验补齐、Web 插件服务放行 | 已立项，不重复 | — |
| **P1 契约** | cap.session（含所有权记账）+ ai.stream.end 插桩 + contributes.chatActions + toast 进度态 | 新增 1 capability + 1 hook 点 + 1 贡献点，**零删除** | 契约 describe 全量自描述；权限矩阵过评审；契约测试 |
| **P2 试点外移** | 插件仓新建 compact-handoff 插件（panel + 编排 + UI，~1.1k 行）；主仓删除实现，保留契约消费端 | 净删 ~1.1k | 行为等价：新旧路径对照冒烟（含空窗竞态场景回归）；主仓删除单独 commit，revert 边界干净 |
| **P3 策略开放** | contributes.compactStrategies | 贡献点校验 | 第三方模板可加载 |
| **P4 复制推广** | 续接 sessionHandoff、@对话引用评估走同一契约 | 再净删 ~400 行 | 同 P2 验收法 |

P2 完成的标志性语义：**压缩交接在主仓从「功能」变为「一个已安装插件」**，主程序不含其代码，
卸载插件即无此功能（保留导出能力可作灰度对照）。

---

## 5. 安全与边界分析（P1 评审重点）

高危面按序：

1. **静默会话 = 不可见运行**：silentMode + bypassPermissions 的组合是权限绕过风险面。
   约束：静默会话创建仅限 `sessionManage` 声明插件；宿主对每次静默 dispatch 在审计链打
   `silent+bypass` 标记；静默会话不进列表但**必须在审计/观测面可见**（对齐守望台 plugin.usage 双键经验）。
2. **输入注入 = 社工面**：`setPendingContext` 往用户输入框塞内容，用户确认后才发送（卡片可编辑语义
   天然是缓冲）。约束：注入来源标注；每会话仅一个 pending context 槽（后来的覆盖先来的并 toast 提示）。
3. **delete/interrupt = 数据面**：所有权记账——插件只能操作**自己经 cap.session.create 创建**的会话
   （宿主记 `creatorPluginId`，对齐 kv 域 mount 前缀经验）；对宿主/其他插件/用户会话一律拒绝。
4. **Remote/Web**：cap.session 全 action 内置 deny（对齐 cap.http / cap.app.autolaunch 先例），
   Web 端功能降级在插件描述中声明。
5. **面板同 window 零隔离**：P0 hostInvoke 白名单落地前，插件面板技术上可直调宿主任意 command——
   本规划的契约面是「正门」，白名单是「封侧门」，两者缺一不可。

---

## 6. 能力开放路线图（一次契约投入，N 个插件受益）

| 契约 | 已有插件直接受益 | 解锁的新形态 |
|---|---|---|
| cap.session | task-runner（定时驱动真会话）、watchtower、abacus | 后台 AI 代理类插件（自己开会话、跑完交结果） |
| setPendingContext | context-pack、prompt-matrix（结果回填聊天） | 「任意插件产物 → 输入框等确认」通用通道 |
| chatActions | time-sift、repo-lens、har-lens | 会话级工具的统一入口生态 |
| ai.stream.end | watchtower、log-lens | 会话生命周期感知的自动化 |
| compactStrategies | — | 简报风格社区模板 |

这条表是本规划「顺便提供规划，后面其他插件有更多能力」的落点：**契约按通用性设计，
压缩交接只是第一个受益者与验收样本。**

---

## 7. 风险与回滚

- **竞态责任转移**：等待/归档竞态外移后由契约兜底（waitStreamEnd 内置 requireRunEvidence、
  setPendingContext 消费端留宿主），插件不应也不必自造等待逻辑；契约文档明示此边界。
- **回滚**：P1 纯增量可 revert；P2 主仓删除单独 commit + 插件仓保留前一版本 zip（对齐 slimdown 回滚惯例）。
- **已知边界如实登记**：本机 `cargo test --lib` 不可用（契约 Rust 测试用 `cargo check` + 前端 vitest）；
  协议无运行时 schema 校验（契约全量 describe 自描述 + 关键枚举保守，对齐 AGENTS.md §4.1）。
- **判定前提可逆**：若 P1 契约评审被否（如静默会话风险面不可接受），本规划降级，
  core-slimdown 不拆清单恢复「压缩交接不拆」原判定——两文档互为修订关系，以后者落定为准。

---

## 8. 明确不做（防无收益外移）

- `conversationPackager`（三方共享原语，拆了反而增加契约面）
- pendingBriefing 消费语义 / silentMode 语义 / session-v2 状态权威（宿主本体）
- `ContextCompactRenderer` 与引擎级 `/compact`（AIEvent 协议件，非插件域）
- Chat / ChatInput 本体（slimdown §4.3 已定宿主本体）
