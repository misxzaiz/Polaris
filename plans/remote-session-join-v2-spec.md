# 跨端会话交互优化 v2——对话导航入口 + 一键加入会话窗口（spec）

> 状态：方案规划（待确认后实施）· 2026-10-24
> 背景：批 3/5 落地后用户反馈两点——①「其他设备进行中」藏在会话历史抽屉里，查看路径太深；②只读 overlay 无法把远端会话接进本端窗口。用户建议入口放在「对话导航」（ChatNavigator，消息区右缘悬浮球，悬停展开对话轮次目录）。
> 关联：`ai-session-fix-adjudicated-plan.md` §7（批 3/5 实施记录）

---

## 1. 现状与差距分析

### 1.1 入口位置：藏在二级抽屉

- 现状：`RemoteSessionsStrip` 挂在 `SessionHistoryPanel` 顶部（右滑抽屉），必须先打开历史面板才能看到远端会话。
- 用户路径：进行中 → 想看另一设备 → 点历史按钮 → 抽屉 → 找条带 → 点开 overlay，四步。
- **对话导航（ChatNavigator）** 是消息区右缘常驻悬浮球（`navigator.title`=「对话导航」），悬停展开对话轮次目录——它已经是为「当前会话上下文内快速跳转」设计的组件，且用户视线天然停留在这个区域。差距：导航目前只服务「轮次跳转」，无跨端信息；且仅在多轮会话时渲染（`SessionMessagesView` 中 `conversationRounds.length > 1`），新会话/单轮时不可见。

### 1.2 能力缺口：只读 vs 加入

- 现状：`RemoteSessionOverlay` 是旁路只读视图（不进 conversationStore），看得见摸不着——不能发送、不出现在 MultiSessionGrid 会话格、关闭 overlay 即中断跟踪。
- 用户期望：「直接加入当前会话窗口」——远端会话变成本端一个正式会话格，实时同步且可交互。

### 1.3 关键技术前提（已源码验证，全部成立）

| # | 前提 | 证据 |
|---|---|---|
| 1 | 跨端事件路由已就绪：本端持有 conversationId 的 store 自动接收实时事件 | 批 5 反向索引路由（sessionStoreManager dispatchEvent 通用反查投递） |
| 2 | 「加入」有现成骨架：`createSessionFromHistory(messages, conversationId, metadata)` 建会话并把 conversationId 挂上 store | sessionStoreManager.ts:208-228 |
| 3 | 消息源现成：`message_read`（后端 SQLite，含批 1 落库的卡片块/错误文本，墓碑过滤） | 批 5 kernel snapshotSource 已示范同源读取 |
| 4 | 发送自动续接：store 有 conversationId 时 sendMessage 走 `action:'continue'` 到同一引擎会话 | createConversationStore.ts:2289 |
| 5 | 双端并发安全：后端 `session_try_start` 事务化排他已在 continue 入口强制，后到者被拒（reason 带启动设备） | 批 2（acbfa954） |
| 6 | 流式状态校正管线现成：查 `is_chat_session_running` → `setStreaming(true)` + 快照合并 | webReconnectResync.resyncSession 同款逻辑 |
| 7 | 会话元数据（标题/引擎）可查：sessions_index 投影批 3b 已注册 | `session_index_list` |

结论：**「加入」零新增后端代码**——这是批 5 反向索引路由的直接红利；前端复用恢复管线即可。

---

## 2. 方案设计

### 2.1 优化 A：入口前移到对话导航（≈0.5 天）

**ChatNavigator 悬浮面板顶部新增「其他设备进行中」区块**：

```
┌─ 对话导航 ──────────────┐
│ ◉ 其他设备进行中 (1)        │  ← 新区块（无远端会话时不渲染）
│ ┌─────────────────────┐ │
│ │ ● a1b2c3…  Claude     │ │  ← conversationId 短标识 + 引擎
│ │   始于 3 分钟前         │ │
│ │   [查看]  [加入窗口]    │ │  ← 两个动作
│ └─────────────────────┘ │
├─────────────────────────┤
│ 1  帮我分析项目结构…       │  ← 现有轮次列表（不变）
│ 2  继续，处理第二个问题     │
└─────────────────────────┘
```

设计要点：
1. 数据源：直接订阅 `remoteSessionFollower.store`（单一数据源；历史面板条带保留——两处服务不同场景：导航=「当前进行」，历史=「找历史」，数据同源不重复实现）。
2. **渲染条件放宽**：`SessionMessagesView` 的 ChatNavigator 渲染条件从 `conversationRounds.length > 1` 放宽为 `> 1 || hasRemoteRunning`（否则新会话看不到入口）。
3. 「查看」= 现有只读 overlay（保留价值：不扰动本地窗口布局的快速窥视）。
4. 「加入窗口」= 优化 B 的新能力。
5. 移动端紧凑模式沿用 ChatNavigator 既有 `isCompact` 面板布局（bottom:60px 全宽）。

### 2.2 优化 B：一键加入会话窗口（≈1 天）

**`remoteSessionFollower.joinSession(conversationId)`**，流程（复用既有管线，四处新代码）：

```
点「加入窗口」
  ① 查会话元数据：session_index_list 投影 → title/engineId
     （miss 时降级：message_read 首条用户消息 generateTitleFromMessage）
  ② 建本端会话：createSessionFromHistory(
        message_read(conversationId) → ChatMessage[],
        conversationId,                     ← 关键：store 挂上引擎会话 id
        { title, engineId })
     → useViewStore.addToMultiView(sessionId)   ← 出现在 MultiSessionGrid 会话格
     → switchSession(sessionId)
  ③ 校正流式状态（复用 webReconnectResync.resyncSession 管线）：
     is_chat_session_running ? setStreaming(true) : 正常收尾
  ④ Follower 清理：sessions.delete(conversationId)
     （反向索引路由此后自动把实时事件投进本端 store——isLocalConversation
      过滤已天然阻止 Follower 再收录该会话，防双入口/双渲染）
```

加入后的行为（全部由既有机制承接，零新代码）：
- **实时同步**：远端 token 事件 → 反向索引投递 → 本端 store currentMessage 实时追加（同格内看到逐字流式）。
- **可发送**：输入框直接用；sendMessage 走 continue 到同一引擎会话。远端仍 running 时后端仲裁拒绝 → ErrorBanner/toast 显示「会话已在运行中（由设备 X 启动）」——**这就是 B5 单写者仲裁的最小可用形态**。
- **远端结束时**：session_end 经反向索引到达本端 → 正常收尾落盘；本端可继续追问。
- **轮末双写**：两端轮末各自 saveDialog 写同一 JSONL——批 1 原子写加固（唯一 tmp+fsync）+ 墓碑已使其安全（最后写者赢，内容等价）。

### 2.3 已知边界（诚实声明）

1. 加入时若远端正在流式，本端恢复的快照截止到 `message_read` 时刻，之后靠实时事件续上——极窄窗口内（快照读取与事件订阅之间）可能有 1-2 个 token 的缝隙，与 webReconnectResync 的既有恢复语义一致，可接受。
2. 「加入」后本端即成为会话的渲染主人之一（双端同看）——非 B5 的完整仲裁（光标/未读/输入互斥不做），双端**同时**发送由后端排他锁拒绝，先后发送无冲突。
3. 投影 title 可能为空（远端首轮未结束即加入）——降级为 conversationId 短标识，轮末 canonical 覆写后自然修正。

---

## 3. 验收标准

| # | 场景 | 验收 |
|---|---|---|
| N1 | 桌面流式中，浏览器打开本端 | 对话导航悬浮球出现（含脉冲标记），悬停面板顶部「其他设备进行中」可见远端会话 |
| N2 | 点「查看」 | 现有只读 overlay 打开，实时续流（不扰动会话格布局） |
| N3 | 点「加入窗口」 | MultiSessionGrid 出现新会话格并激活，格内展示已生成内容 + 实时续流 |
| N4 | 加入后本端发送消息（远端已结束） | sendMessage continue 到同一引擎会话，上下文无缝（AI 记得此前对话） |
| N5 | 双端同时发送 | 后到者被后端仲裁拒绝，提示「会话已在运行中（由设备 X）」，无双流交织 |
| N6 | 远端会话结束后本端继续对话 | session_end 正常收尾，本端续聊落盘一致 |
| N7 | 加入后 Follower 不再显示该会话 | 「其他设备进行中」列表移除该条目，无双入口 |

---

## 4. 实施顺序

1. **B**：`joinSession`（Follower 服务 + 恢复管线复用）——能力先行，A 的按钮才有落点。
2. **A**：ChatNavigator 区块 + 渲染条件放宽——纯 UI 接线。
3. 双端手测 N1-N7。

总计约 1.5-2 天；风险低（全部复用已验证管线，唯一新逻辑是 ④ 的 Follower 清理与 ② 的元数据降级链）。

---

## 5. 评估结论（2026-10-24，批 6/7 收尾项裁定）

### 5.1 插件面板隔离评估（批 7 完整形态）

**现状**：插件面板经 `pluginModuleLoader` Blob URL 动态 import 进主窗口**同源上下文**，且实现侧已无 sandbox 相关代码——插件对 window 全量可达。批 7 已落地的宿主桥白名单只约束「走桥的调用」，同源插件可直接 `import('@tauri-apps/api/core')` 绕过（桌面端 capabilities/default.json 仍约束 Tauri IPC 面，但 web 模式下 `/api/*` 白名单含 `router_dispatch`）。

**裁定：iframe/独立 origin 隔离不做强制迁移，理由**：① 现有 16 个插件全部按同源假设开发（共享 React 实例 `__POLARIS_HOST_REACT__`、直接读 localStorage/主题 token），隔离迁移是插件生态 breaking change，需与插件仓库协同分期；② 桥白名单已挡住「误用」面，恶意插件的防线应在**安装环节**（marketplace 审计/签名）而非运行时隔离。后续动作：marketplace 安装时展示权限清单（plugin.json permissions 已有），作为插件供应链的下一项独立工作。

### 5.2 ChatInput 拆分评估（批 6 遗留评估项）

**现状**：2136 行（本轮止血 +5 行为守卫后仍单文件）。拆分收益最大的是三块：IME/队列/编辑三态交织的 handleSend（~400 行）、附件校验管线、建议框定位。

**裁定：本轮不拆，触发条件挂起**——AGENTS.md 拆分克制原则（只拆「新增改动经常触碰」的文件）。会话域修复期已过（批 0-5 完成后 ChatInput 的改动频率显著下降），当前无持续触碰压力。若后续跨端交互 v2（导航入口/加入按钮）落地时再次大改 ChatInput，顺势拆出 `useChatSend` hook；否则保持现状。

### 5.3 后台会话完成通知的现状说明

批 0 已覆盖主路径：`notify_session_complete` 在主窗口失焦时弹系统通知（本端会话触发）。批 3b 后消息中心（NotificationCenterPanel）+ SessionCell toast（后台会话 addToNotifications）已承接「聚焦但非活跃」场景。剩余边际（聚焦时 Cell 徽标）已有流式脉冲点。**判定：已覆盖，不再追加。**
