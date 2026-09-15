# 全局语音唤醒（Global Voice Wake）需求分析

> 状态：分析稿（v2）｜日期：2026-09-16｜范围：桌面端 Tauri App（含 Web 降级）
> v2 新增：非全屏悬浮面板（Voice Panel）+ 消息是否在 AI 对话窗口打开的可选性

## 1. 背景与目标

### 1.1 现状（已有能力）

Polaris 已具备一整套「语音伙伴」能力（`src/components/VoiceCompanion/*`、`src/hooks/useVoiceCompanion.ts`、`src/services/speechService.ts`）：

- **唤醒词**：`WakeWordConfig`（`src/types/speech.ts`）支持多词、同音容错（`matchWakeWord`），唤醒后播报回应（`voiceNotificationService.notifyWakeResponse`）。
- **语音对话状态机**：`standby → listening → thinking → speaking → cooldown`，含半双工/全双工回声治理、语音打断、字幕气泡。
- **TTS 朗读**：`streamingTts`（edge-tts）流式逐句朗读 AI 回复。
- **音频焦点仲裁**：`audioFocusManager`，伙伴/听写/通知互斥。

### 1.2 现状的关键限制

| 限制 | 说明 | 位置 |
|---|---|---|
| 必须打开全屏通话界面 | `isOpen=false` 时整个编排不运行（`useVoiceCompanion` 的启动 effect 依赖 `isOpen`） | `useVoiceCompanion.ts:401` |
| 只挂靠当前活跃会话 | `sendMessage` 走 `useActiveSessionActions`，永远发到活跃会话；无「按绑定参数创建/切换会话」通道 | `useActiveSession.ts:383` |
| 唤醒词不可绑定资源 | 唤醒词只有 enabled/words，不能绑定工作区/引擎/供应商/音色 | `types/speech.ts:157` |
| 无全局常驻 | 无托盘、无全局快捷键、无窗口隐藏后保持识别的手段 | `useWindowManager.ts`（仅窗口内 keydown） |
| Web Speech 后台节流 | 失焦可用，但最小化/隐藏时可能被浏览器暂停/节流 | `speechService.ts` |

### 1.3 目标（本需求）

> 支持设置**全局唤醒词**；每个唤醒词可绑定 **工作区 / AI 引擎 / 模型供应商 / TTS 音色**（可部分绑定，未绑定的项回退到当前生效值）；唤醒后进入**纯语音对话**（不开 AI 聊天窗口），AI 回复自动语音朗读；识别/朗读在窗口**失焦、最小化时仍尽量可用**。

### 1.4 界面形态（v2 核心决策）

全局唤醒的界面**不再是全屏通话界面**，改为**可拖拽的悬浮面板（Floating Voice Panel）**，与普通桌面 App 的「画中画/悬浮球」体验一致：

- **默认形态**：紧凑悬浮面板（约 320×420，可拖拽、可贴边收起为小圆球），展示唤醒状态、当前唤醒词、实时字幕、会话策略；不遮挡主工作区，用户可边干活边语音对话。
- **AI 对话窗口解耦**：语音会话与聊天窗口**不再强绑定**。每次对话产生的消息可以选择「是否同步/打开到 AI 对话窗口」：
  - **仅语音面板**（默认）：消息只在悬浮面板气泡区展示，不打扰聊天窗口；AI 回复自动朗读。
  - **同步到 AI 对话窗口**：语音会话的消息同时出现在主聊天消息流（会话历史），用户可在聊天窗口继续文字交互。
  - **打开聊天窗口**：唤醒/某轮回复后，主动把对应的 AI 会话切到前台聊天窗口（用户想看代码、工具调用详情时手动点）。
- 与「语音伙伴小陈」（全屏 Overlay）**并存**：全局唤醒 = 轻量悬浮；小陈 = 沉浸式全屏。两者共用同一套语音核心（ASR/TTS/回声治理），麦克风焦点互斥。

### 1.5 非目标（v1 不包含）

- 唤醒词触发的复杂多轮任务编排（那是「干活」模式 + 调度器的范畴）。
- 自定义唤醒音效/铃声音乐。
- 跨设备唤醒词同步（配置本身走全局 Config 后天然可同步，但功能开关属本机）。

## 2. 术语

- **全局唤醒词（Global Wake Word）**：一个可独立配置的唤醒单元，含一组同音词 + 资源绑定。
- **绑定（Binding）**：`workspaceId / engineId / profileId / voice / rate` 的任选组合，未配置字段为「跟随当前」。
- **语音会话（Voice Session）**：按绑定参数创建/复用的后台会话（不弹聊天窗口，历史留消息流）。
- **当前值（Current fallback）**：未绑定时使用的运行时值——当前工作区（`workspaceStore.getCurrentWorkspace()`）、默认引擎（`config.defaultEngine`）、激活 Profile（`activeModelProfileId`，官方为 `OFFICIAL_API_PROFILE` 哨兵）。

## 3. 核心设计决策

### 3.1 常驻方式：Web 常驻为主 + 托盘为兜底（分两期）

- **P1（Web 层常驻）**：全局唤醒监听器注册到 `speechService`（单例），不依赖任何 Overlay；通过 `document.visibilitychange` 感知失焦。Web Speech 在失焦后台标签页仍可运行（Chromium 行为），最小化/完全隐藏时可能被节流——P1 接受此边界并明确告知用户。
- **P2（Tauri 托盘常驻）**：Rust 侧加系统托盘（`TrayIcon`）+ 全局热键（`GlobalHotKey`，如 `Ctrl+Shift+W` 切换监听）+ 窗口隐藏不挂起识别。Web 端无托盘则降级为 P1 行为。
- **技术备注**：`audioFocusManager` 已提供焦点仲裁，全局唤醒与语音伙伴/听写并发时由它裁决（伙伴优先）。

### 3.2 会话模型：每唤醒词一个「延续会话」，可切换「每次新建」

- 默认：每个唤醒词绑定参数相同则**复用同一会话**（上下文连续，像语音助理）。按 `(workspaceId, engineId, profileId)` 三元组缓存 `sessionId`。
- 可选：唤醒词可设 `sessionPolicy: 'continue' | 'new'`；「new」每次唤醒新建。
- 会话类型：有 `workspaceId` → `project`，否则 `free`（对齐 `sessionStoreManager.createSession` 现有逻辑）。
- 未唤醒时不创建会话（懒创建）。

### 3.3 配置归属：扩展 `config.wakeWord` 为「全局唤醒」区块，不动现有听写唤醒词

- 现状 `config.wakeWord` 是**听写唤醒词**（`SpeechTab`，填输入框）。直接改语义会破坏现有逻辑。
- 方案：新增 `config.globalWakeWord: GlobalWakeWordConfig`，设置页新增「全局唤醒」区块/tab；`WakeWordConfig` 保持兼容（听写唤醒词）不动。两个唤醒体系并存，麦克风焦点仲裁。

```ts
interface GlobalWakeWordEntry {
  id: string;                 // 唯一 ID
  words: string[];            // 唤醒词（含同音容错，如 ["小极","小姬","小机"]）
  enabled: boolean;
  workspaceId?: string;       // 未填 → 当前工作区
  engineId?: string;          // 未填 → config.defaultEngine
  profileId?: string;         // 未填 → activeModelProfileId（官方 = OFFICIAL_API_PROFILE）
  voice?: TTSVoice;           // 未填 → 语音伙伴默认音色
  rate?: string;              // 语速
  sessionPolicy?: 'continue' | 'new';  // 默认 'continue'
  systemPrompt?: string;      // 可选：唤醒词专属人格/指令
  /**
   * 消息展示策略（v2 新增）：
   * - 'panel'（默认）：消息只在悬浮面板气泡区展示，不打扰聊天窗口
   * - 'sync'：消息同时写入对应 AI 会话的消息流（可事后在聊天窗口继续）
   * - 'open'：唤醒/回复后主动把该会话切到前台聊天窗口
   */
  displayPolicy?: 'panel' | 'sync' | 'open';
}
}

interface GlobalWakeWordConfig {
  enabled: boolean;
  entries: GlobalWakeWordEntry[];
}
```

### 3.4 「未配置用当前」的解析顺序（关键语义）

逐字段解析，不整体回退：

1. `workspaceId`：未填 → `workspaceStore.getCurrentWorkspace()?.id`；若当前无工作区 → 按 `free` 会话。
2. `engineId`：未填 → `normalizeEngineId(config.defaultEngine)`。
3. `profileId`：未填 → 设置页激活 Profile（`config.activeModelProfileId`；`OFFICIAL_API_PROFILE` 归一化为「官方」）；若绑定的 profile 已被删除 → 回退到当前激活并提示。
4. `voice/rate`：未填 → `DEFAULT_VOICE_COMPANION_CONFIG`。

解析结果缓存，运行期每次唤醒时重算（保证「当前值」实时生效）。

## 4. 架构与代码落点

### 4.1 新增模块

```
src/
├── types/globalWakeWord.ts            # 上述类型 + 默认值 + 解析函数
├── services/globalWakeWordService.ts  # 常驻监听编排（不依赖 UI）
├── hooks/useGlobalWakeWord.ts         # 供设置页/浮层读状态的轻 Hook（只读 store）
├── stores/globalWakeWordStore.ts      # 运行态（当前唤醒的 entryId、阶段、字幕、错误）
└── components/GlobalWakeWord/
    ├── WakeFloatingOverlay.tsx        # 唤醒后轻量浮层（非全屏）：状态 + 字幕 + 打断/挂断
    └── (P2) 托盘/热键入口
```

### 4.2 复用与改造

| 现有模块 | 复用方式 | 需要的改造 |
|---|---|---|
| `speechService` | 全局唤醒直接 `setConfig/setCallbacks/start` | 无（已是单例） |
| `streamingTts` / `voiceTts` | 回复朗读 | 无 |
| `audioFocusManager` | 全局唤醒持 `'global-wake'` 焦点 | 无 |
| `voiceNotificationService` | 唤醒回应播报 | 无 |
| `matchWakeWord` / `isLikelyEcho` | 唤醒匹配 + 回声过滤 | 无 |
| 回声治理逻辑（半双工 pause/cooldown） | 抽成共享函数 `speechSessionCore` | 从 `useVoiceCompanion` 提取为独立 service，两个场景共用 |
| `sessionStoreManager.createSession` | 按绑定参数建会话（已支持 workspaceId/engineId） | 无 |
| `useActiveSessionActions.sendMessage` | 仅发活跃会话 | **新增 `sendToSession(sessionId, text, opts)` 通道**（按会话 id 发送，支持 `runtimeOverride.profileId`） |

**v2 新增 — 悬浮面板与展示策略相关模块**：

| 模块 | 说明 |
|---|---|
| `components/GlobalWakeWord/VoiceFloatingPanel.tsx` | 可拖拽悬浮面板（默认右下，约 320×420，可贴边收起为圆球）；参考 `FileSearchModal.tsx` 钉住浮窗的拖拽实现 |
| `components/GlobalWakeWord/DisplayPolicyMenu.tsx` | 消息展示策略选择器（仅语音面板 / 同步到聊天窗口 / 打开聊天窗口），面板头部与设置页各一处 |
| `stores/globalWakeWordStore.ts` | 追加 `panelCollapsed / panelPosition / displayPolicy` 运行态 |
| `sendToSession` 返回本次会话 `sessionId` | 供「打开聊天窗口」策略直接 `switchSession(sessionId)` |

### 4.3 运行时流程

```
[常驻] speechService 持续识别（standby 语义：只听唤醒词）
  └─ 命中 entry.words → notifyWakeResponse 播报
      └─ 解析绑定（entry 覆盖 + 当前值回退）
          └─ 取/建语音会话（sessionPolicy 决定复用 or 新建）
              └─ 悬浮面板出现（非全屏，默认右下可拖拽）
              └─ setPhase(listening) 收集语音 → 停顿/发送命令
                  └─ sendToSession(sessionId, text, { oneTimeSystemPrompt?, runtimeOverride })
                      ├─ displayPolicy='sync' → 消息写入该会话消息流
                      ├─ displayPolicy='open' → switchSession(sessionId) 切前台聊天窗口
                      └─ isStreaming → streamingTts 朗读 → 回 standby
```

**展示策略语义**：
- `panel`：仅悬浮面板气泡区展示；AI 会话照常在后台生成（历史保留，不打扰）。
- `sync`：消息写入会话消息流 → 与聊天窗口共享同一份历史，用户随时切过去文字继续。
- `open`：每轮主动把该语音会话切到前台（用于用户需要看工具调用/代码/长文本的场景），但仍保留悬浮面板可随时收起。
- 默认 `panel`；策略在悬浮面板头部可即时切换（图标按钮），切换立即对后续消息生效。

### 4.4 与现有「语音伙伴」的关系

- 并存不替代：语音伙伴是全屏「打电话」体验；全局唤醒是「随时喊一声」体验。
- 两者共用同一套 ASR/TTS/回声治理核心（提取后复用），各自持有焦点键互斥。
- 全局唤醒的会话**不弹聊天窗口**，但会话出现在消息列表/历史中，事后可点开查看或继续文字对话。

## 5. 风险与边界

| 风险 | 影响 | 对策 |
|---|---|---|
| Web Speech 最小化被节流 | 唤醒延迟/失效 | P1 明确提示「Polaris 需保持打开或非最小化」；P2 托盘兜底 |
| 回声误触发（外放） | 唤醒词被自己的播报触发 | 复用半双工：朗读期间暂停识别 + cooldown + `isLikelyEcho` 过滤；全双工需用户显式开启 |
| 多语音源并发 | 麦克风争抢 | `audioFocusManager` 仲裁；全局唤醒打开时听写按钮 disabled |
| 绑定 Profile 被删 | 请求失败 | 唤醒时解析回退 + 一次性提示 |
| 工作区路径失效 | 会话无上下文 | 按 `free` 会话回退并提示 |
| 隐私 | 常驻录音 | 托盘图标明示「监听中」；一键静音；设置页说明 |

## 6. 分期实施

### P1（核心闭环）
- 配置：`GlobalWakeWordConfig` 类型 + 设置页「全局唤醒」区块（增删词、绑定工作区/引擎/供应商/音色、展示策略、开关）。
- 运行时：`globalWakeWordService` 常驻监听（不依赖 UI）；命中 → 解析绑定 → 建/复会话 → 纯语音对话 + 流式朗读；`sendToSession` 通道；回声治理核心抽取共享。
- 悬浮面板：可拖拽、贴边收起为圆球、实时字幕 + 状态 + 打断/挂断/静音 + 展示策略切换（非全屏）。
- 展示策略：`panel`（默认，仅悬浮面板）→ `sync`（写入会话消息流）→ `open`（切前台聊天窗口）。
- 兼容：听写唤醒词（`config.wakeWord`）保持原行为。

### P2（常驻体验）
- Tauri 托盘图标 + 全局热键（切换监听/开关）+ 窗口隐藏不挂起。
- 唤醒后系统通知（原生 Notification）。
- 会话历史入口（从消息列表进到语音会话）。

### P3（增强）
- 唤醒词专属 systemPrompt/人格（复刻「心灵伙伴」协议思路）。
- 唤醒词可绑定「语音命令」前缀（如「小极，查一下」→ 触发命令路由）。
- 多唤醒词并行路由（不同词 → 不同会话并行）。

## 7. 验收标准（P1）

1. 设置页可添加/启用全局唤醒词，绑定工作区/引擎/供应商/音色，未绑定项回退当前值。
2. 不打开 AI 聊天窗口（无活跃会话时），喊唤醒词 → 播报回应 → 说一句话 → AI 回复并朗读。
3. 唤醒词命中后自动建会话；再次唤醒同一词 → 上下文延续。
4. 朗读期间不把 AI 自己的声音识别成用户输入（回声治理生效）。
5. 与语音伙伴/听写互斥（麦克风焦点仲裁）。
6. 听写唤醒词（旧 `config.wakeWord`）行为不变。
7. 悬浮面板可拖拽、可贴边收起为圆球、可静音/打断/挂断；面板出现不遮挡主工作区核心操作。
8. 展示策略 `panel/sync/open` 三态可切换：默认仅面板；切 `sync` 后消息进入聊天会话历史；切 `open` 后会话切到前台聊天窗口。
9. 唤醒后默认不打开任何 AI 聊天窗口；只有策略为 `open` 时才主动切换。
