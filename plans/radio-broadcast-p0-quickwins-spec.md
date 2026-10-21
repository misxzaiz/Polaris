# 无限畅听电台 P0 快赢 — 子 Spec

> 父 spec：`radio-broadcast-infinite-listening-spec.md` §五 P0。四段式：目标 / 契约 / 验收 / 不做。
> 分支：`feat/radio-infinite-listening-p0`（基于 main）。纯前端，不动 Rust / 插件 / 协议。

---

## 一、目标

把「播报中」体验从「能看到一句」提升到「可掌控的收听」：实时字幕跟读、倍速、睡眠定时（含播完本段 + 淡出）、锁屏控制、会话内合成缓存、动态音色列表。六项均为纯前端改动，数据源全部已存在。

## 二、契约（改动点与所有者）

| # | 项 | 所有者文件 | 要点 |
|---|---|---|---|
| P0-1 | 实时字幕跟读 | `voiceBroadcastPlayer.ts` 新增 `getTranscript()`（队列即文稿：句子 + 状态 + 当前索引）；`radioBroadcastController.ts` 快照扩展 `transcript` + **修复 onStart/onEnd 不 emit 的既有一次刷新缺口**（status 已是 playing 时 nowPlayingText 变化不达 UI）；`RadioBroadcastPanel.tsx` 播报视图滚动文稿（said/now/upcoming 三态，当前句居中自动滚动） | 类型 `TranscriptLine { id, text, status }` |
| P0-2 | 倍速 | player `setRate()`（当前音频即时生效 + 新建音频继承）；controller `setRate` 转发；prefs store 增 `speed`（持久化）；面板倍速 pill（1 → 1.25 → 1.5 → 2 → 0.75 循环） | start opts 增 `rate?`，开播即生效 |
| P0-3 | 睡眠定时 | controller `sleep({ minutes? , afterSegment? } | null)`：`sleepUntil`（1s 定时器检点 → 淡出 3s → `stop('sleep')`）+ `stopWhenDrained`（播完本段：不请求新段，队列播空即优雅停机）；`RadioBroadcastStopReason` 增 `'sleep'`；取消即清零 | 快捷档 15/30 分钟 + 播完本段；与配置字段 maxRounds/maxSeconds（既有语义不变）分治 |
| P0-4 | MediaSession 锁屏 | player 内（`'mediaSession' in navigator` 守卫，jsdom 无此 API 不触）：metadata（话题名 + 当前句）+ play/pause/stop action handler（stop → 回调 controller.stop） | player `setOptions` 增 `mediaTitle?` |
| P0-5 | 合成缓存（内存 LRU，**降级**） | 新文件 `synthCache.ts`：key = hash(text+voice+style+outputMode)，LRU 上限 200 条 / 50MB 估算；player 合成前查、成功后写；**跨 stop 保留**（重开同方向即命中） | **降级依据**：`cap.data_root` 仅有管理面 action（get_info/migrate/set_root），无通用文件写 → 持久缓存按父 spec 预案挪 P1（cap.voice 统一解），不为此提前动 Rust |
| P0-6 | 动态音色 | `mcpBridge.ts` 增 `listMimoVoices()`（cap.mcp → `mimo_tts_list_voices`）；`types.ts` `VoiceId` 放开为 `string`；面板音色下拉 = 动态列表 ∪ 静态预置兜底（拉取失败静默回退） | |

**快照扩展**（`RadioBroadcastSnapshot`）：`transcript: { lines: TranscriptLine[]; currentIndex: number } | null`、`sleepUntil: number`（0=无）、`sleepAfterSegment: boolean`。store `EMPTY_SNAPSHOT` 同步；hook 透传 + `setRate` / `sleep` action。

## 三、验收

- [ ] 字幕：播报中全文滚动文稿可见，当前句高亮并自动居中；已播句变灰；修复后连续句间 nowPlayingText 实时更新（回归缺口）
- [ ] 倍速：播报中切换即时生效（当前句 + 后续句）；重开面板保留
- [ ] 定时：15/30 分钟到点 → 淡出 3s → 停止，Toast「定时到」；「播完本段」→ 当前队列播完停止且不再请求新段；取消可清
- [ ] 锁屏：桌面浏览器 mediaSession 面板显示话题；停止/暂停可用（手动验证）
- [ ] 缓存：同句二次合成 0 API 调用（vitest 断言 callMimoTts 调用次数）
- [ ] 音色：面板下拉含动态拉取音色；断插件时回退静态预置不阻塞
- [ ] `pnpm exec tsc --noEmit`、`pnpm lint`（改动文件 0 新增告警）、`pnpm exec vitest run src/services/voiceBroadcast/ src/components/RadioBroadcast/` 全绿

## 四、不做

- 不做持久化磁盘缓存（P1 cap.voice）、不做点历史句跳播（stretch，本期能力留好）、不做 MediaSession positionState / artwork、不做换台/插话（P2）。
