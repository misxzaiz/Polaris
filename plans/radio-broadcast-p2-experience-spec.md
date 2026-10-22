# 无限畅听电台 — P2 体验层子 spec

> 上游：`plans/radio-broadcast-infinite-listening-master-spec.md`（总纲）。
> 前置：P1 资产层已落地（cap.voice + 三页签 + 段自动入库 + 回听 replay）。
> 本文为 P2 实施权威；范围收敛，不承诺 P3。

## 目标

把「连续播报」升级为「可对话的电台」：换台、插话、续播入口与北极星埋点。四件事全部围绕**既有控制器单例**扩展，不引入第二个播放路径。

## 非目标（边界）

- 不做 P3（多设备接力、语音克隆声纹保护、跨端同步等）。
- 插话 v1 = 半双工文本/语音输入，不做实时打断音频淡入淡出混音。
- 预生成 jobs v1 = 前台预生成 + 启动预取，不做后台常驻 headless 进程。

## 1. P2-1 换台（switchTopic）

**行为**：播报中用户改方向/直接「换台」→ 不停声、不重建会话；向同一 AI 会话发岔题指令，代际 Poll++；新段继续无缝入队。

- 控制器新增 `switchTopic(direction)`（方向 kind+text 变更或复选预设时调用）：
  - 更新 `this.direction` + snapshot emit；
  - 复用 `requestNextSegment` 的 prompt 注入路径，但首条 prompt 用「岔题指令」模板（`promptForSwitchTopic`）：
    「用户换台了。立即切换主题并接续播报新方向：<text>。不要总结旧话题，直接开始新内容。」
  - 段落代际不重置播放器（不断声）；`segmentIndex` 续数不归零；
  - MediaSession 标题更新（`player.setOptions mediaTitle`）。
- 守卫：仅 `running && sessionId` 时生效；replay 模式下换台 = 退出回听并 start() 正常播报（面板接线时处理）。
- 事件顺序：sendMessage(岔题) → kernel running → 下降沿 → onSegmentEnded 入队（与正常段完全同路径，唯一权威）。

## 2. 插话（barge-in，半双工）

**行为**：播报中用户点「插话」（或按住说话/输入文本）→ 暂停播放 → 提交文本（v1：文本输入框 + 语音转写文本均可）→ AI 回复下降沿 → 直接把回复入队继续播（不作为新段，不计 round）。

- 控制器新增 `interject(text)`：
  1. 仅 `running && sessionId` 有效；`player.pause()`（半双工：不抢话）；
  2. sendMessage(text)（带固定提示：「这是听众插话，简短回应（≤2 句），然后接续当前话题播报。」）；
  3. 复用 `waitKernelSessionStreamEnd` + onSegmentEnded 路径入队；回复播完继续正常段循环；
  4. 插话期间 UI 状态 = `generating`（复用既有子状态，不新增状态机态）。
- 不与 stop/interrupt 抢时序：插话不做 abort；用户仍可随时 stop()（三路中断幂等）。

## 3. P2-2 预生成（预取增强）

v1 收敛为两点（无新后端）：

- **启动预取**：start() 首段请求前先把 `DIRECTION_PRESETS` 命中方向的开场 2 句入 `voices.presets` …（**废弃此路**——见下）。
- 简化为：**段间预取加深** — `SEGMENT_LOOKAHEAD_SENTENCES` 已有段级提前量；本项新增「启动时立即请求首段的空窗优化」已有（start 即发首段）。故 P2-2 缩减为**续播入口**（见 §4）+ **库回听零成本**（P1 已完成）。

结论：P2-2 实施内容并入 §4 与 P1，不再单列后端 jobs.*（不做）。

## 4. P2-3 续播入口（面板）

- 内容库空态/列表上方显式提示「畅听内容自动入库，可随时回听」（P1 已有）。
- 新增：**「上次畅听」快捷恢复**——面板 idle 时若 `localStorage.polaris.radioLastSession` 存在（{direction, voice, ts}），显示「继续上次畅听：<topic>」按钮 → 直接 `start()` 复用参数。控制器 stop('manual'|'sleep'|上限) 时写入。

## 5. P2-4 埋点（北极星指标）

- 位置：`radioBroadcastController` 关键节点写 localStorage（`polaris.radioMetrics`，JSON）：
  - `listenMs`（累计收听时长；onStart 句打点累计 + 1s watchdog）
  - `sessionCount`（start 次数）、`dayKeys`（活跃日去重 set，最多保留 30 天）
  - `replayCount`（playLibraryItem 次数）、`switchCount`（换台次数）、`interjectCount`（插话次数）
- 只在控制器内写（唯一写入方），面板只读展示（P3 再做 UI，本期不展示）。
- 三方隐私约束：只存本机 localStorage，无上传。

## 变更文件（预估）

- `radioBroadcastController.ts`：switchTopic / interject / lastSession 持久化 / metrics 写点
- `constants.ts`：`SWITCH_TOPIC_SUFFIX`（岔题指令模板）、`INTERJECT_SUFFIX`
- `RadioBroadcastPanel.tsx`：换台即时调用（方向/预设点击在播报中 → switchTopic）、插话输入框、继续上次畅听按钮
- `voiceBroadcastPanel.test.tsx` / `radioBroadcastController.test.ts`：新用例

## 验收

- [ ] 播报中点击新方向：不中断当前句、旧话题内容在 ≤1 段内切换、`switchCount` 计数
- [ ] 插话回复直接入队插播（不增 round），期间状态 generating，播报不中断会话
- [ ] idle 显示「继续上次畅听」，点击复用上次 direction/voice 成 start
- [ ] `polaris.radioMetrics` 持机累计 listenMs 正确（重启不丢）
- [ ] 门禁：tsc / vitest（controller+panel 全绿）/ cargo check 两道
