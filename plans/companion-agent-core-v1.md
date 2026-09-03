# Companion Agent — 心灵伙伴核心模块设计方案

> **v1.1**（Phase 0 简化：入口改为用户手动触发，感知守护进程后移）

## 定位

> **一个在用户主动触发时，感知当前状态、读取关于用户的记忆、用 AI 做出有温度的回应，主动判断该说什么、说什么让用户快乐或做有价值的事。**

**不做的事（当前阶段）：**
- 不自动感知触发——用户手动点按钮或输入 `/gotme` 命令
- 不提供通知工具——留给 AI 自己想办法
- 不做规则驱动的"到点就说话"

---

## 核心设计哲学

**"他想要找你，他就要自己想办法去通知你"**

决策输出是**意图**（"我想告诉用户 X"），不是对通知 API 的调用。通知的实现方式由 AI 自行发现和使用。

---

## 入口设计

两种触发方式，二选一或同时提供：

### 1. 命令触发：`/gotme`

在 Polaris 对话输入框输入 `/gotme`，Companion 立即：
1. 采集当前状态快照
2. 读取记忆
3. 调用 AI 决策
4. 输出回应到当前对话

### 2. 按钮触发

在侧边栏或设置中放一个按钮，点击即触发上述流程。

---

## 架构

```
用户 /gotme 或点按钮
         │
         ▼
┌─────────────────────┐
│   采集状态快照      │  ← 一次性读取，不是持续守护
│   (idle/app/session) │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│   读取记忆          │  ← memory.jsonl，最近 N 条
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│   AI 决策           │  ← LLM 判断：说什么？有什么新记忆？
│   (reach / message) │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│   输出回应          │  ← 到当前对话 / 新面板 / 由 AI 决定
└─────────────────────┘
```

---

## 1. 状态快照采集（Snapshot）

触发时**一次性采集**，不是持续守护。

### 采集内容

| 数据 | 读取方式 |
|------|---------|
| 键盘鼠标空闲时长 | `GetLastInputInfo` (Windows) |
| 前台应用名称 | `GetForegroundWindow` + 进程名 |
| Polaris 会话状态 | 是否有活跃会话 |
| 当前时间 | `chrono` |
| 距离上次 `/gotme` 多久 | 从 memory 中读取上次交互时间 |

### 输出格式

```json
{
  "keyboard_idle_sec": 180,
  "foreground_app": "code",
  "session_active": false,
  "hour": 15,
  "day_of_week": "wednesday",
  "min_since_last_gotme": 45
}
```

---

## 2. 记忆层（Memory）

### 文件位置

```
{data_root}/companion/memory.jsonl
```

### 记忆类型

| 类型 | 含义 | 写入时机 |
|------|------|---------|
| `project` | 当前在做的项目/卡点 | AI 从对话推断后写入 |
| `interest` | 用户的兴趣 | AI 从对话提取 |
| `pattern` | 工作节奏/作息 | AI 从快照中学习 |
| `preference` | 明确偏好 | AI 从对话提取 |
| `interaction` | 上次回应内容和用户反应 | 每次 `/gotme` 后记录 |
| `fact` | 关于用户的事实 | AI 从对话提取 |

### 读写

- **读：** 决策前读取最近 100 条
- **写：** 决策返回时附带 `new_memories`，追加写入
- **去重：** 简单字符串包含检测（AI 也可自行判断）

---

## 3. AI 决策层

### 输入给 LLM 的 prompt

```
你是一个心灵伙伴。以下是当前状态快照和关于用户的记忆。

状态快照：
{snapshot_json}

最近记忆（最近 100 条）：
{memory_entries}

请你判断：
1. 该跟用户说什么？（如果有话想说）
2. 有什么新的认知需要记住？

输出 JSON：
{
  "reach": true,
  "message": "你想对用户说的话",
  "priority": "high" | "medium" | "low",
  "new_memories": [{"type": "...", "content": "..."}]
}

如果你没有什么想说的，输出：
{
  "reach": false,
  "reason": "为什么现在不说"
}
```

### 系统提示词（片段）

```
你是用户的心灵伙伴。用户输入 /gotme 就是他在主动找你。

你不是一个被动回答问题的助手。你会：
- 观察他现在的状态（在忙吗？休息中？写代码？）
- 结合你记得的关于他的事
- 想一些真正想跟他说的话——可能是关心的、有趣的、或者帮他做点有用的事

你可以提议有用的事，也可以提议没用但快乐的事。
如果没什么想说的，就诚实说现在没话要说。
不要为了说话而说话。
```

---

## 4. 输出方式

`/gotme` 触发时：

| reach | 行为 |
|-------|------|
| `true` | 把 `message` 作为 AI 回复输出到当前对话（带一个特殊标识，比如一个 💜 emoji 前缀） |
| `false` | 输出"现在没想说什么，下次见"之类的简短回应 |

记忆写入 `memory.jsonl`，`interaction` 类型记录本次回应。

---

## 5. 技术实现

### 代码位置

```
src-tauri/src/services/companion_daemon.rs   → 核心模块
src-tauri/src/commands/companion.rs           → /gotme 命令入口
```

### 命令入口

注册为 Tauri command（同时通过 HTTP bridge 暴露给 Web 模式）：

```rust
#[tauri::command]
#[cfg(feature = "tauri-app")]
pub async fn companion_gotme(state: tauri::State<AppState>) -> Result<String> {
    // 1. 采集快照
    // 2. 读取记忆
    // 3. 调用 AI
    // 4. 写入新记忆
    // 5. 返回 message
}
```

前端通过 `invoke('companion_gotme')` 调用，或 `httpTransport` 走 `/api/companion/gotme`。

### `/gotme` 命令解析

在 IM 命令解析器（`commands.rs` 的 `CommandParser`）中增加：

```rust
BotCommand::CompanionGotme => // 调用 companion_gotme
```

---

## 6. 实施计划

### Phase 0：最小闭环（当前阶段）

| 内容 | 状态 |
|------|------|
| `companion_gotme` 命令 | 新建 |
| 快照采集（idle/app/session/hour） | 新建 |
| `memory.jsonl` 读写 | 新建 |
| LLM 决策（复用 SimpleAI provider） | 新建 |
| 输出到当前对话 | 新建 |

**验证标准：** 输入 `/gotme`，能得到一段有温度的回应，memory.jsonl 有记录

### Phase 1：体验优化

| 内容 | 说明 |
|------|------|
| 系统提示词迭代 | 调整 AI 的"个性"，让它更像伙伴 |
| 记忆去重与权重 | 减少重复，提高相关性 |
| 按钮入口 | 在 UI 中放一个一键按钮 |
| 回应格式 | 特殊标识（emoji / 卡片 / 独立面板） |

### Phase 2：感知守护进程（自动触发）

| 内容 | 说明 |
|------|------|
| 持续感知层 | 键盘/鼠标/前台应用持续采集 |
| 事件触发 | idle/app_switch/session_end 等事件驱动 AI 决策 |
| 冷却机制 | 避免频繁触发 |

### Phase 3：通知能力（AI 自主）

| 内容 | 说明 |
|------|------|
| AI 自主发现通知手段 | AI 通过 MCP/工具找到通知用户的方式 |
| 多渠道 | 桌面通知/浏览器/应用内 badge 等 |

---

## 附录：Phase 0 vs 完整版对比

| 能力 | Phase 0 | 完整版 |
|------|---------|--------|
| 触发方式 | 手动（/gotme + 按钮） | 自动（事件驱动） |
| 感知 | 一次性快照 | 持续守护 |
| 记忆 | ✅ | ✅ |
| AI 决策 | ✅ | ✅ |
| 通知 | 当前对话输出 | AI 自主选择渠道 |
| 冷却 | 无 | ✅ |