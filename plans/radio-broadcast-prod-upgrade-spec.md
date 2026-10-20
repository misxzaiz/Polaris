# AI 连续语音播报 — 生产级升级 Spec（布局 + 交互）

> 关联：`plans/radio-broadcast-sidebar-upgrade-spec.md`（已实施：侧栏面板 + 引擎/模型配置 + 轮次/时长自动停止 + 段级 lookahead）。
> 本 spec 是**生产级打磨**，把「可用」提升到「生产级」：信息架构、布局、交互反馈、可恢复性、i18n、可测性。

---

## 一、现状差距（勘察结论）

功能已可用（43 测试绿），但距生产级有明显差距：

### 布局 / 信息架构
- 配置视图是**长表单**（方向→内容→音色→引擎→供应商/模型→自动停止→开关→按钮），全在一条垂直流里，无分组、无层级。
- 播报中视图与配置视图**整体互斥切换**（`idle/error ? 配置 : 播报`），播报中想改配置不可达；想暂停查看配置也切不走。
- 顶部标题「AI 连续播报」硬编码中文，**无 i18n**（面板 label 有，内部文案没有）。
- 引擎 grid 用 `grid-cols-2`，引擎多时挤；无「当前生效引擎」的明确指示。

### 交互 / 反馈
- 无任何 Toast：start 失败（API Key 缺失）、到限自动停止、error 都**静默**，用户不知道发生了什么。
- 配置**不持久化**：每次重开面板默认值重置（方向回「经济学基础」、音色回「冰糖」）。
- **无恢复**：error 后虽然显示「重试」，但 `directionText` 等内容若用户改过会丢（state 在组件里，error 切视图不丢，但刷新面板丢失）。
- 输入无校验提示：轮次/时长填非法值（0、负数、非数字）静默忽略，无反馈。
- 播报中视图缺少关键信息：**当前段摘要进度**、剩余时长/轮次（设置了上限时）、累计时长。
- 移动端 base64 模式开关与「为何要开」解释不足；桌面用户误开会降速。

### 可测性 / 稳健性
- 面板组件**无单元测试**（controller 有，UI 层没有）。
- 无无障碍：按钮无 `aria-label`、状态徽标无 `aria-live`。

---

## 二、升级方案

### 2.1 布局：分组卡片 + 双视图可达

**配置视图重排为 4 个语义分组**（卡片化，复用主题 token）：

```
┌──────────────────────────────┐
│ AI 连续播报            [●播报中] │  ← 头部（i18n + aria-live 状态）
├──────────────────────────────┤
│ ① 内容                        │  ← 方向 pill + 自由文本
│   [学习][故事][技术][新闻][自定义]  │
│   播报内容 [input              ] │
│ ② 声音                        │  ← 音色 select + 音量 slider
│   音色 [冰糖 — 温婉      ▼]      │
│   音量 [───●───────]            │
│ ③ 模型                        │  ← 引擎 grid + 供应商/模型 selector
│   AI 引擎 [Claude][Simple][…]   │
│   供应商/模型 [selector]          │
│ ④ 控制                        │  ← 自动停止 + 开关
│   自动停止  播N轮 [ ] 播N分钟 [ ]  │
│   语音口令 [✓] 移动端模式 [✓]      │
│ [▶ 开始播报]                    │
└──────────────────────────────┘
```

- **分组卡片**：`rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.4)]`，组内 label 上浮，缩进层次清晰。
- **双视图可达**：播报中视图顶部加「配置」胶囊按钮，点击**平滑切到配置视图**（播报**不中断**——配置视图内禁用 start，只允许查看/修改待下次生效的配置 + 显示「播报进行中」徽标 + 返回按钮）。这样用户播报中也能调整下一次的配置。

**播报中视图增强**：

```
│ 内容：学习 · 经济学基础              │
│  ▾ 正在朗读                        │
│  「…当前句文本（滚动）…」             │
│  进度：句 12 · 段 3 · 累计 4:32      │  ← 新增
│  上限：播 5 轮（已 3）｜剩余 ~2 分钟     │  ← 新增（有设置时）
│ [⏸ 暂停] [■ 停止]                  │
```

### 2.2 交互：反馈 + 持久化 + 校验 + 恢复

**Toast 反馈**（`useToastStore`）：
- start 成功 → `success`「播报开始」
- start 失败（预检 mimo-tts 不可用）→ `error`「无法开始：mimo-tts 不可用（检查 API Key）」
- error 态（连续失败）→ `error` 带原因
- 到限自动停止 → `info`「已播满 N 轮，自动停止」
- 语音口令停止 → `info`「已停止播报」

**配置持久化**（新增 `radioBroadcastPrefsStore`，localStorage）：方向 kind/text、音色、音量、开关项、轮次/时长、引擎/profile/model。重开面板恢复。

**输入校验**：
- 轮次/时长：`min=1`、解析失败或 ≤0 时字段红框 + 下方「请输入 ≥1 的整数」提示；start 前校验，非法则阻止 + toast warning。
- 方向 text 为空时禁用 start（或 fallback 到 kind label）。

**恢复 / 重试**：error 视图保留当前配置（已满足），「重试」按钮 + 「回配置」按钮双路径。

### 2.3 无障碍 + i18n

- 所有 icon 按钮加 `aria-label`；状态徽标 `aria-live="polite"`。
- 全量文案 i18n：`radioBroadcast.*` key 入 `zh-CN/en-US common.json`（面板内部不再硬编码中文）。

### 2.4 控制器层（补齐信息）

`RadioBroadcastSnapshot` 扩展暴露：
- `startedAt`（开始时刻）→ 前端算累计时长
- `segmentIndex` 已在 snapshot 的 segment 里；补 `maxRounds/maxSeconds`（有设置时）→ 前端显示「已播 N/M 轮」「剩余 ~M 分钟」

---

## 三、文件清单

| 文件 | 改动 |
|---|---|
| `src/stores/radioBroadcastPrefsStore.ts`（新） | 配置持久化（localStorage + zustand）|
| `src/components/RadioBroadcast/RadioBroadcastPanel.tsx` | 布局分组、双视图、音量、进度/上限展示、Toast、校验、aria |
| `src/services/voiceBroadcast/radioBroadcastController.ts` | snapshot 补 startedAt/maxRounds/maxSeconds；自动停止时 emit 停止原因 |
| `src/services/voiceBroadcast/types.ts` | `RadioBroadcastSnapshot` 扩展字段 |
| `src/hooks/useRadioBroadcast.ts` | 透传新字段 + 持久化初始值 |
| `src/locales/{zh-CN,en-US}/common.json` | `radioBroadcast.*` 文案 |
| `src/components/RadioBroadcast/RadioBroadcastPanel.test.tsx`（新） | 布局/交互/校验/i18n 快照 + 行为测试 |

---

## 四、验收

- [x] 配置视图分组清晰，播报中可切配置不中断（双视图可达，切配置播报不中断）
- [x] start/error/到限/口令停止均有 Toast 反馈（start 成功 + 各停止原因 + error）
- [x] 配置刷新面板后保留（localStorage，radioBroadcastPrefsStore）
- [x] 非法轮次/时长输入有红框 + 提示，start 被阻止（warning toast + aria-invalid）
- [x] 播报中视图显示累计时长、进度、上限剩余（ProgressInfo）
- [x] 全文案 i18n；icon 按钮 aria-label；状态 aria-live
- [x] 新增面板组件测试（9 用例）+ controller snapshot 测试，voiceBroadcast 套件 52 全绿
- [x] `tsc --noEmit`、`pnpm lint` 通过；`cargo check`（未动 Rust，前端验证为主）

---

## 五、不做

- 不做播放列表/队列 UI（段内句已顺序播，用户不编辑队列）
- 不做播报计划任务/定时
- 不改 mimo-tts 插件、不动移动端 base64 链路（除展示优化）

---

## 六、后续打磨（2026-10-20 追加）

上轮已落地：分组布局/双视图/音量/进度/Toast/校验/持久化/i18n（`4f3b0925`）。

### 6.1 配置视图保留播报控制（双视图完整闭环）

**缺口**：播报中切到配置视图后，无停止/暂停入口——用户想停止必须先「返回播报」再点停止，可用性缺陷。

**方案**：配置视图在 `rb.isActive` 时，控制分组底部渲染一条「迷你播放控制条」（暂停/继续 + 停止 + 当前句缩略），与播报视图控制条同语义、同 token。双视图任何时刻均可停止/暂停，无需切回。
✅ 已实施（`PlaybackControls` 共用组件；配置视图内嵌迷你控制条）

### 6.2 引擎选择解除播报中禁用

**缺口**：引擎按钮在 `rb.isActive` 时 `disabled`，与「音量/音色/内容修改下次生效」的设计语义矛盾（引擎是唯一被禁的项）。

**方案**：解除 `disabled`，与其余项一致「修改下次生效」。文案从「播报中不可切换引擎」改为「播报中修改将在下次播报生效」；`SessionConfigSelector` 的 profile/model 选择不变（已可改下次生效）。
✅ 已实施

### 6.3 引擎 grid 自适应换行

**缺口**：固定 `grid-cols-2`，引擎多时拥挤。

**方案**：改 `flex flex-wrap` + 按钮自适应宽度（与方向 pills 同模式），消除固定列数。
✅ 已实施

### 6.4 单句合成失败自动重试（降低偶发丢句）

**缺口**：合成失败/超时 → 单句直接跳过。网络闪断、mimo-tts 偶发 5xx 会让听众丢一整句。

**方案**：合成失败（`callMimoTts` res.error / catch / 超时）后，若该句未重试过，重置为 `pending` 再合成一次（`QueueItem.synthAttempts`，0→1）；重试仍失败才 `failed` + `onSynthError` 跳过。**播放失败不重试**（音频已合成放不出，重试合成无意义）。`onSynthError` 仅最终失败时触发（controller 的 `consecutiveErrors` 计数不受单次重试污染）。
✅ 已实施（`markSynthFailed` 统一收口 + `SYNTH_MAX_RETRIES=1`；2 新用例：失败重试后跳过、偶发失败重试成功不丢句；超时用例更新为双周期断言）

### 6.5 播报中视图音频级波形动画（增强「正在播报」感知）

**缺口**：播报中只有文字，无音频级可视化；「正在播报」的感知偏弱。

**方案**：现在时不引入画布级波形（成本高），用 CSS 动画音柱（`AudioWaveform` 已用静态图标部分）：播报中/生成中的提示图标加轻微跳动动画（`animate-pulse` 或等宽音柱 keyframe），低成本提升活跃感知。
✅ 已实施（`index.css` 新增 `eq-bars` keyframe 音柱动画，播放中替换静态图标；尊重 `prefers-reduced-motion`）
