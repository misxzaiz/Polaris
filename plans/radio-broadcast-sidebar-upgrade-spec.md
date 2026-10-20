# AI 连续语音播报 · 侧边栏入口 + 引擎/模型可配置 + 播放时长/轮次 — Spec（增量规划）

> 关联：`plans/radio-broadcast-spec.md`（基线 spec，覆盖「方向→AI 连续生成→mimo-tts 合成→句间连续播放→停止」闭环，已实现）。
> 本 spec 是**增量规划**，不改基线已实现行为，只扩展三件事：
> 1. **入口改版**：右下角悬浮浮层 → 左侧边栏（ActivityBar + LeftPanel）入口。
> 2. **配置扩展**：支持选择 AI 引擎、模型供应商（Profile）、模型。
> 3. **自动停止**：支持设置播放时间上限或轮次上限（到限自动停止）。
>
> 状态：**已实施（2026-10-20）**。三项全部落地：① 入口改走内置侧边栏面板；② 引擎/供应商/模型可配置（默认跟随全局 + 可覆盖）；③ 轮次/时长自动停止。验证：`tsc --noEmit` ✅、`pnpm lint`（改动文件 0 error）✅、`cargo check` ✅、vitest 41/41 全绿（voiceBroadcast 套件，含 3 个新增自动停止用例）。实施对照见 §七；验收清单已勾选。

---

## 一、目标

| 需求 | 现状 | 目标 |
|---|---|---|
| 入口 | 右下角悬浮按钮（`RadioBroadcastPanel` 根 `fixed bottom-5 right-5 z-[500]`，App.tsx:498 挂根）| 左侧边栏 ActivityBar 图标 + LeftPanel 面板，复用既有 `viewStore.leftPanelType` 切换/保活/MRU 机制 |
| 引擎/供应商/模型 | 固定用 `config.defaultEngine`（controller:307）| 用户可选引擎、供应商（Profile）、模型，会话级生效 |
| 播放时长/轮次 | 无限循环，仅手动停止 | 可选「播 N 轮」或「播 N 分钟」自动停止（优雅收尾，不卡状态机）|

验收（对应下文）：侧栏可打开播报面板；面板可选引擎/供应商/模型且生效；设置轮次/时长后到限自动回 idle，无残留播放/生成。

---

## 二、所有者与边界（增量）

### 2.1 入口：内置面板，不改插件体系

调研结论：播报是 Polaris 固有能力，走「**内置面板**」路径（`corePluginManifest.contributes.views` + App.tsx 传 content prop），不插件化。理由：
- 播报控制器 `radioBroadcastController` 是全局单例，无插件无关性；做成插件需额外成本且无收益。
- 内置面板即可完整获得 ActivityBar 图标、TabStrip tab、MRU、懒挂载保活。

**新增注册项**（`src/plugin-system/builtinPlugins.ts` `corePluginManifest.contributes.views`）：
```
{ id: 'radio-broadcast.panel', area: 'activityBar', panelType: 'radio-broadcast',
  icon: <PluginIconId 白名单之一，如 'Activity'|'Film'>, labelKey: 'labels.radioBroadcast',
  order: <尾部，如 80> }
```
> 注意：`icon` 必须在 `PluginIconId` 17 值白名单内（`src/plugin-system/types.ts:7-26`），否则 ActivityBar 渲染空图标（`pluginIconMap[icon]` undefined）。i18n labelKey 需在 `src/locales/{zh-CN,en-US}/*.json` 补 `labels.radioBroadcast`。

**App.tsx 改动**：
- `LeftPanelContent` 加 prop `radioBroadcastContent={<Suspense fallback={loadingFallback}><RadioBroadcastPanel /></Suspense>}`，`builtinPanels` 表加 `'radio-broadcast'` 一行（`LeftPanelContent` 第 250-263 行查表）。
- 移除 App.tsx:498 的根挂载 `<RadioBroadcastPanel />`。

**RadioBroadcastPanel 样式改造**：
- 删根 `fixed bottom-5 right-5 z-[500]`，改面板内自适应容器（`h-full flex flex-col`）。
- 「未播报且未展开 → 悬浮小按钮」语义重设计：左栏里不再需要悬浮形态，未展开态 = 面板显示配置视图。即去掉 `idleAndCollapsed` 分支的悬浮按钮，常显配置/播报卡片。
- 播报进行中用户关闭左栏：`LeftPanelContent` 懒挂载保活（关闭仅 `display:none`，状态不丢），播报继续后台跑。是否需要全局角标提示属可选（TabStrip 高亮已能给「面板存在」的暗示），本 spec 不做角标。

### 2.2 配置扩展：引擎/供应商/模型

**数据与可复用组件**（调研结论）：
- 引擎列表：`useEngineMetadataStore(s => s.metadatas)`（`src/stores/engineMetadataStore.ts`）。
- 供应商 Profile：`useModelProfileStore` → `ModelProfile[]`，`isProfileForEngine(profile, engine)` 过滤，`profileModelOptions()` 取模型列表。
- 选择 UI：**复用 `SessionConfigSelector`**（`src/components/Chat/session/SessionConfigSelector.tsx`，`variant='panel'` + `visibleTypes`）。引擎下拉照抄 `CreateSessionModal`（:299-330）样板。

**会话级生效（关键，零 sendMessage 改动）**：
`createSession`（conversationStore/types.ts:744 `CreateSessionOptions`）已支持 `engineId?/modelProfileId?/model?`，写入 `SessionMetadata`；`resolveSessionEngine`/`resolveEffectiveProfileId`/`normalizeModelForProfile` 在每次 sendMessage 从 metadata 解析 → **引擎/供应商/模型只须在建会话时传一次，后续每轮自动沿用**。无需改 sendMessage 签名。

**控制器/UI 改动链**（4 层）：
1. `radioBroadcastController.ts:42` `RadioBroadcastControllerOptions` 加 `engineId?/modelProfileId?/model?`。
2. `controller.createSession`（:306-330）把三字段传入 `createSession({...})`（:315-324）。
3. `radioBroadcastStore.ts:20` + `useRadioBroadcast.ts:24` 的 start opts 类型同步透传。
4. `RadioBroadcastPanel.tsx` 配置视图加 `SessionConfigSelector(variant='panel')`（引擎 + 供应商 + 模型），选择写回本地 state，handleStart 传给 start。

**风险（必须遵守）**：
- `updateSessionEngine`（sessionStoreManager.ts:362-378）拒绝「已有 messages/streaming 的会话」切引擎 → 引擎必须在**首次 sendMessage 前**定死，建会话时传入是唯一干净路径。播报在 start 时建会话、之后只续聊，天然满足。
- `normalizeModelForProfile`（modelProfile.ts:355）会清空 Profile 不认的模型名 → model 须与所选 Profile 的 `modelOptions` 一致（用 `profileModelOptions()` 提供）。
- `CreateSessionOptions` 无 `profileMode` 字段 → 选第三方 Profile 走默认 `mode='profile'` 即可，无需补。
- 引擎选择应默认跟随 `config.defaultEngine`（`useConfigStore(s => s.config?.defaultEngine)`），用户显式选才覆盖。

### 2.3 自动停止：轮次上限 / 时间上限

**循环收敛点（唯一守卫位）**：`requestNextSegment()`（controller:396-427）——`start`、`handleQueueDrained`(:382)、`afterSegmentFinished`(:430) 三条续段路径都收敛到这里，单点守卫全覆盖。

**轮次上限**：
- 计数器用既有 `segmentIndex`（:81，`onSegmentEnded` :375 递增）= 已播段数。
- `requestNextSegment()` 入口（:396-398）加 `limitReached()` 守卫：`this.maxRounds && this.segmentIndex >= this.maxRounds` → 置 `this.limitReached = true`，不再请求新段。
- **优雅停机（关键坑）**：到限后**不能**直接置 `running=false`（:383 的 `if (this.stopped || !this.running) return` 会让 status 卡 playing）。正确做法：在 `handleQueueDrained`/`afterSegmentFinished`「队列已空且无在途合成」时（:435 判定）调 `this.stop()`，让当前音频播完、走完三路中断回 idle。
- 段生成在途时到限：靠 `hasSegmentInFlight()`（:467）等当前段收尾再判定，避免请求一半。

**时间上限**：
- `start()` 初始化块（:158-165）记 `this.startedAt = Date.now()`；`this.maxSeconds?: number` 存配置。
- 累计已播时长挂玩家 `onEnd` 回调（:185-187，每句结束触发）累加 `audio.duration`，或简单用 `Date.now() - startedAt`（够用）。
- 同样在 `requestNextSegment` 入口守卫：`this.maxSeconds && (Date.now() - this.startedAt) >= this.maxSeconds*1000` → 置 limitReached，走上面的优雅停机。
- 语音口令 / 按钮停止与限流并发：`stop()` 幂等（:247-252），三路收敛到 stop 无冲突。

**固定时长 vs 固定轮次的关系**（给用户的推荐语义）：
- 「播 N 轮」：简单直观，语义清晰（N 段内容）。推荐做轮次。
- 「播 N 分钟」：需要提示词软约束（每段 150~350 字 ≈ 40~60 秒/段）+ 播放器时间硬上限双轨；软约束不可控，硬上限负责兜底。若用户不特别需要「精确分钟」，轮次即可满足「设置播放时间」的意图。
- 方案：**两者都做**，轮次为默认语义；时长作为可选的兜底上限（到点即停，不等当前段播完也停——但为体验优先「当前句播完再停」）。

---

## 三、接口（增量）

| 能力 | 接口 | 说明 |
|---|---|---|
| 左栏入口 | `viewStore.toggleLeftPanel('radio-broadcast')` / `switchToLeftPanel` | 复用既有动作；图标经 `listViewContributions('activityBar')` 出现 |
| 播报配置 | `controller.start(opts)` 扩展 | `opts` 增 `{ engineId?, modelProfileId?, model?, maxRounds?, maxSeconds? }` |
| 会话创建 | `createSession({engineId, modelProfileId, model, kind:'radio-broadcast', silentMode:true})` | metadata 写入，后续轮次自动沿用 |
| 状态订阅 | `useRadioBroadcastStore` 现状 | 无需扩展（段数/状态已暴露） |

---

## 四、时序（文字图）

### 4.1 左栏入口 → 播报
```
用户点 ActivityBar 图标
  → viewStore.toggleLeftPanel('radio-broadcast')
  → LeftPanelContent.builtinPanels['radio-broadcast'] 渲染 RadioBroadcastPanel
  → 用户配方向/音色/引擎/供应商/模型/轮次 → 点开始
  → controller.start({engineId, modelProfileId, model, maxRounds, ...})
  → createSession(metadata) → requestNextSegment()
```

### 4.2 自动停止（限轮/限时）
```
requestNextSegment() 入口
   ├─ limitReached()（segmentIndex>=maxRounds 或 超时）→ 置 limitReached，return（不再请求）
   └─ 正常 → 继续生成
→ 当前段播完 → handleQueueDrained / afterSegmentFinished
   ├─ limitReached && 队列空 && 无在途合成 → this.stop() → 三路中断 → idle
   └─ 否则 → requestNextSegment() 续段
```

### 4.3 幂等边界
- 引擎/模型/供应商：建会话时定死，`updateSessionEngine` 拒绝中途切换是**特性**不是 bug（播报不能播到一半换引擎）。
- 自动停止 vs 语音口令/按钮：都收敛到 `stop()`，幂等（:247-252）。
- 到限时 AI 段在途：等 `hasSegmentInFlight()` 归零再停，不请求一半。

---

## 五、验收清单（增量）

- [x] **入口**：ActivityBar 出现「播报」图标；点击开/关 LeftPanel；面板切换/保活正常；关闭面板时播报不中断（LeftPanelContent 懒挂载保活，display:none 不卸载）。
- [x] **引擎/供应商/模型**：面板可选引擎（默认跟随 `config.defaultEngine`）+ 供应商 + 模型；选非默认引擎后播报实际走该引擎/Profile/模型（createSession metadata 写入，后续轮次自动沿用）；模型列表随供应商过滤（SessionConfigSelector 复用）。
- [x] **轮次上限**：设「播 1 轮」→ 播完 1 段自动停止回 idle，无残留队列/生成，无状态卡死（vitest「轮次上限」用例）。
- [x] **时长上限**：设极小值 → 启动即超时自动停止回 idle（vitest「时长上限」用例）。
- [x] **回归**：默认配置（不选引擎/不限轮次）行为与现状一致（无限连续播报 + 手动/语音停止）；轮次未满不提前停（vitest「轮次未满」回归保护用例）。
- [x] **门槛**：`pnpm exec tsc --noEmit` ✅、`pnpm lint`（改动文件 0 error）✅、`cargo check` ✅；vitest voiceBroadcast 套件 41/41 全绿（3 个新增自动停止用例实际执行）。

---

## 六、不做（本规划明确排除）

- **不插件化**：不做独立插件 manifest，播报保持内置面板（控制器单例特性决定）。
- **不做全局角标**：播报中关闭面板不新增全局浮动角标（依赖 TabStrip 高亮 + 保活）。
- **不做每轮新会话**：维持单会话续聊（续聊越讲越深，适合学习/故事；每轮新主题是另一档需求，不并入本规划）。
- **不做语速/音量细粒度**：mimo-tts style 已有自然语言风格承载；音量 slider 已有（player.setVolume），UI 已有则保留，无新增。
- **不动 mimo-tts 插件**、**不动 edge-tts 链路**、**不扩 `PROTECTED_SESSION_KINDS`**（与基线 spec 一致）。

---

## 七、改动文件清单（落地时对照）

| 文件 | 改动 |
|---|---|
| `src/plugin-system/builtinPlugins.ts` | `corePluginManifest.contributes.views` 加 `radio-broadcast.panel` |
| `src/App.tsx` | 移除 :498 根挂载；`LeftPanelContent` 加 `radioBroadcastContent` prop + `builtinPanels` 行 |
| `src/components/RadioBroadcast/RadioBroadcastPanel.tsx` | 根容器 `fixed→h-full`；去悬浮按钮态；加引擎/供应商/模型选择 + 轮次/时长输入 |
| `src/services/voiceBroadcast/radioBroadcastController.ts` | `ControllerOptions` 加 5 字段；`createSession` 透传；`requestNextSegment` 加 limitReached 守卫；优雅停机 |
| `src/stores/radioBroadcastStore.ts` | start opts 类型透传（`RadioBroadcastControllerOptions`，import 自 controller） |
| `src/stores/radioBroadcastStore.ts` | start opts 透传 |
| `src/hooks/useRadioBroadcast.ts` | start opts 透传 |
| `src/locales/{zh-CN,en-US}/*.json` | `labels.radioBroadcast` + 配置项文案 |
| `src/services/voiceBroadcast/radioBroadcastController.test.ts` | 新增：轮次上限/时长上限守卫 + 优雅停机用例 |
| `src/services/voiceBroadcast/voiceBroadcastPlayer.test.ts` | 如涉时长硬限，补用例 |
