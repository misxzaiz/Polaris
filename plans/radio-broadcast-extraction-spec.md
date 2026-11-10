# spec：语音电台/伴播插件化改造（B2-1）

> 状态：**方案已定，待实施** · 2026-11-10
> 上游：`plans/core-slimdown-plugin-extraction-plan.md` §4.2 B2-1、`plans/radio-broadcast-*.md` 系列。
> 用户定案（2026-11-10）：确定改造为插件的方案；实施另需批准。本文只定方案，不改代码。

## 1. 目标与边界

- 目标：电台/伴播/语音输入输出域整体出主仓，落 `Polaris-plugin/plugins/radio-broadcast`（新建；插件仓已有 `mimo-tts` 作 TTS 先例，避免重复造引擎）。
- 不做：不改播报/合成/打断语义；不动 Chat 主链路；不重命名 `cap.voice`。
- 保留宿主薄通道：锁屏/媒体键/系统通知、音频焦点（如属宿主能力）留薄层，见 §5。

## 2. 四问判定（core-slimdown §3）

| 问 | 结论 |
|---|---|
| Q1 宿主性 | 否——不属宿主本体 |
| Q2 边界性 | 是——面板 + 控制器 + 自有资产/缓存/偏好存储 |
| Q3 通道性 | 基本满足：已走 `cap.voice`（RouterBus 公共通道）+ `cap.ai.chat`，仅少量 store 直连与根层浮层需改 |
| Q4 收益 | 高：前端 ~9.3k + 后端 1.2k，radio-broadcast P0-P3 刚收尾，发布解耦收益最大 |

## 3. 现状清单（2026-11-10 实测）

后端：`src-tauri/src/services/router/voice_capability.rs` 1,229（`cap.voice`：synthesize / voices / library / design / clone，含磁盘缓存与音色库）。

前端 9,337 行（含测试）：
- `components/RadioBroadcast/` 2,044（Panel 1,533 + test 511）、`components/VoiceCompanion/` 476
- `services/voiceBroadcast/` ~3,100（controller 1,024 + test 793、player 496 + test 452、voiceService 247、voiceStopWatcher 78+140、synthCache 107、constants 130、types 105）
- `services/speechService.ts` 683、`ttsService.ts` 617、`voiceCompanion/streamingTts.ts` 309 + `companionPrompt.ts` 71
- `hooks/useVoiceCompanion.ts` 620、`useVoiceDictation.ts` 238、`useRadioBroadcast.ts` 133
- `voiceNotificationService.ts` 241、`voicePackageService.ts` 211、`voiceLatencyMeter.ts` 265、`nativeSpeechService.ts`、`audioFocusManager.ts`
- stores：`radioBroadcastStore.ts`、`radioBroadcastPrefsStore.ts`、`voiceCompanionStore.ts` 149、`voiceInputStore.ts` 66

宿主接线：`builtinPlugins.ts` 的 `radio-broadcast.panel` view、`App.tsx` 的 `radioBroadcastContent` / `VoiceCompanionOverlay`、`stores/conversationStore/types.ts:795-838` 的 `kind: 'radio-broadcast'` 会话标记、`session-v2/hooks/useKernelSessionState.ts`、locales、`hooks/useAppInit.ts`。

> 2026-11-10 已随 B2-3 移除 `src/petOverlay/aiChannel.ts`（原 `cap.voice` 消费方之一）。

## 4. 分层路径

**L1 前端外移**（收益最大、风险最低，建议首批）：面板 + 控制器/播放器/服务 + stores → 插件 `dist/panel.js` + `service/`；宿主交互走 `cap.voice` / `cap.ai.chat` / `cap.kv`（偏好与资产索引）/ `cap.ui.chat`（发送到会话）。`builtinPlugins.ts` 摘 `radio-broadcast.panel`；`App.tsx` 摘 `radioBroadcastContent` 与 `VoiceCompanionOverlay`；`conversationStore/types.ts` 的 `kind:'radio-broadcast'` 属会话元数据枚举，**保留在宿主**（插件经既有 `onSendToChat`/chatCards 机制标注），不随迁。前置地基：hostInvoke 白名单（§6-1）、manifest 校验（§6-2）。

**L2 后端外移**：`voice_capability.rs` 是否出仓见 D1；若保留则插件继续 `router_dispatch → cap.voice`；若出仓则插件 `service/` 用 Node 复刻 TTS/音色库/缓存，主仓删 capability 并同步 `AGENTS.md` §三清单（28→27）、`plans/two-bus-architecture.md`、`router/mod.rs` 注册行。

**L3 数据外移**：电台资产、合成缓存、偏好 → `<DataRoot>/plugins/<id>/` 或 `cap.kv`；遵守 `services/data_root.rs` 单点，卸载即清。

## 5. 宿主交界清单

| 交界 | 处置 |
|---|---|
| `cap.voice` | 阶段一保留（见 D1）；插件经 RouterBus 调用，权限/审计不变 |
| 锁屏控制 / 媒体键 / 系统通知 / 音频焦点 | 若属宿主能力，保留薄通道或由插件经 `cap.http`/服务自行接管，实施前逐项确认 |
| 根层语音浮层 | `VoiceCompanionOverlay` 挂在 `App.tsx` 根层 → 改由插件面板 + 宿主 slot 或 `cap.ui.render` 帧注入；**不保留根层硬编码** |
| `kind:'radio-broadcast'` 会话标记 | 保留宿主枚举，插件用公共机制标注 |
| Web 模式 | 音频播放可用；TTS 若依赖本地能力需显式声明降级 |

## 6. 主仓删除清单

`components/RadioBroadcast/`、`components/VoiceCompanion/`、`services/voiceBroadcast/`、`speechService.ts`、`ttsService.ts`、`services/voiceCompanion/`、`hooks/useVoice*.ts`、`useRadioBroadcast.ts`、`voiceNotificationService.ts`、`voicePackageService.ts`、`voiceLatencyMeter.ts`、`nativeSpeechService.ts`、`audioFocusManager.ts`、4 个 store、对应测试、i18n 节、`builtinPlugins.ts` view、`App.tsx` 三处、（D1 决定时）`router/voice_capability.rs` + 注册行。

## 7. 验收

- 主仓 `pnpm typecheck` + `pnpm lint` + `pnpm test:run` + `cargo check` + web-only 门控全绿。
- 净删 ≈ 10.5k（±20%）；无死 manifest / 死 i18n key / 孤儿 store。
- 插件仓 `node scripts/validate.js`；安装→启用→电台开播→TTS 合成→断点续播→锁屏/媒体键→AI 伴播→禁用；`update.json` 热更新验证一次。
- 双端（桌面 / Web）回归；Web 不可用能力在插件描述显式声明。
- 三处同步：主仓 / 插件仓 / `AGENTS.md` §五（若 cap.voice 增删）。

## 8. 风险与决策点

| # | 问题 | 推荐 |
|---|---|---|
| D1 | `cap.voice` 是否出仓 | **阶段一保留**。`bus_mcp_server` 的 `bus_dispatch` 允许以字符串动态指定 target，字面量 grep 无法证明零消费者；先保留薄通道，待独立 spec 审计 AI/插件动态调用后再决定删除 |
| D2 | 与 `mimo-tts` 插件关系 | 复用其 TTS 能力/约定，不新建第二个 TTS 引擎；若需插件间调用，走 `cap.http` 到其常驻服务或合并为同一插件 |
| D3 | `VoiceCompanionOverlay` 根层浮层 | 改 `cap.ui.render` 帧 / 面板 slot，不在 `App.tsx` 留硬编码 |
| D4 | 打断/停播幂等 | 电台 P0-P3 有 `voiceStopWatcher`；迁移不改 stop/interrupt 语义（AGENTS.md §4.2），逐项回归 |

## 9. 实施纪律

先补本 spec 的独立提交序列（①地基 ②主仓摘壳 ③插件仓实现 ④主仓删码 ⑤文档同步），不混批；不改协议字段仅搬移；一次一个主题（AGENTS.md §二.5 / §七）。
