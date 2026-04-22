# 模块：语音与通知

> ID: speech-voice | 复杂度: 中 | 变更频率: 低
> 依赖: edge-tts-universal, Web Speech API, configStore, sessionStore | 被依赖: Chat 交互层

## 概述

前端语音模块，包含四个核心子系统：TTS 语音合成（edge-tts-universal）、语音识别（Web Speech API）、语音通知编排（优先级队列+回声消除）、预缓存短音频。采用 Singleton Service + Hook Adapter 架构，服务层脱离 React 生命周期，Hook 层桥接 React 状态。无 Tauri IPC 依赖，全部运行在 WebView 层。

## 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| TTSService | `src/services/ttsService.ts` | edge-tts-universal 驱动的文本转语音，单例，状态机管理 |
| SpeechService | `src/services/speechService.ts` | Web Speech API 封装，连续识别+自动重启+暂停/恢复协议 |
| VoiceNotificationService | `src/services/voiceNotificationService.ts` | 编排层：优先级模型、回声消除、5 种通知场景 |
| VoicePackageService | `src/services/voicePackageService.ts` | 短音频预缓存系统，app init 时批量生成 |
| TtsTextFilter | `src/services/ttsTextFilter.ts` | Markdown 清洗管道，提取可朗读文本 |
| Speech Types | `src/types/speech.ts` | 全部类型、常量、纯函数（checkVoiceCommand/matchWakeWord） |
| useTTS | `src/hooks/useTTS.ts` | TTS → React Hook 适配器 |
| useSpeechRecognition | `src/hooks/useSpeechRecognition.ts` | STT + 唤醒词 + 语音命令 → React Hook |
| SpeechTab | `src/components/Settings/tabs/SpeechTab.tsx` | 语音设置面板（输入/输出/通知三区） |
| ChatStatusBar | `src/components/Chat/ChatStatusBar.tsx` | 麦克风按钮 + TTS 按钮 + 命令分发 |

## 架构模式

### 1. Singleton Service + Hook Adapter

```
[Service Layer] 单例，脱离 React 生命周期
  ttsService / speechService / voiceNotificationService / voicePackageService
      ↓ callback 接口
[Hook Layer] React 状态桥接
  useTTS / useSpeechRecognition
      ↓ React state + dispatch
[UI Layer] 消费者
  ChatStatusBar / ChatInput / SpeechTab / eventHandler
```

服务层用 class + private fields 持有状态，通过 callback 接口通知变化。Hook 层在 useEffect 中注册回调，将状态同步到 React state。这种分层避免循环依赖，服务不导入任何 store。

### 2. Config Getter 注入

```
useAppInit.ts
  → voiceNotificationService.init(() => useConfigStore.getState().config)
```

VoiceNotificationService 不直接导入 configStore，而是在初始化时注入一个 `() => Config | null` 函数。这样服务层可以在非 React 上下文中读取最新配置，同时避免循环依赖和提升可测试性。

### 3. 双层回声消除

```
唤醒词匹配
  → muteRef.current = true     (Layer 1: 同步标记，立即丢弃所有 onResult)
  → speechService.pause()      (Layer 2: 异步停止识别器，有 timing gap)
  → 播放唤醒响应
  → speechService.resume()
  → setTimeout(300ms) → muteRef.current = false  (等待回声衰减)
```

Layer 1 用同步 ref 立即生效，Layer 2 异步暂停识别器。300ms 等待窗口覆盖识别器停止延迟和扬声器回声。

### 4. 优先级通知模型

```
[High Priority] speakAIResponse → ttsService.speak() → 中断当前播放
[Low Priority]  notify*()       → 检查 isPlaying() → 忙则跳过
```

高优先级通知（AI 响应朗读）会中断正在播放的音频；低优先级通知（发送确认、错误提醒）在 TTS 忙时静默跳过。

### 5. Base64 Data URL 音频缓存

```
edge-tts-universal stream → Uint8Array chunks → base64 (32KB 分块)
  → data:audio/mp3;base64,... → new Audio(dataUrl).play()
```

使用 base64 data URL 而非 Blob/ObjectURL，因为 Map<string, CachedVoice> 可直接缓存字符串，无需管理 ObjectURL 的 createObjectURL/revokeObjectURL 生命周期。32KB 分块避免 `String.fromCharCode.apply()` 栈溢出。

### 6. Markdown 清洗管道

```
AssistantChatMessage.blocks → filter(TextBlock) → join
  → cleanTextForSpeech: 13 步正则链（代码块、链接、图片、标题、粗斜体...）
  → shouldSpeakText: ≥2 字符检查
```

确保 TTS 只朗读纯文本内容，跳过代码块、图片、链接等不可朗读元素。

## 数据流

### TTS 播放流（AI 响应自动朗读）

```
session_end 事件 (eventHandler.ts)
  → voiceNotificationService.speakAIResponse(message, { force: inputWasVoice })
    → extractSpeakableText(message)          // 过滤 TextBlock
    → shouldSpeakText(text)                  // ≥2 字符
    → cleanTextForSpeech(text)               // 13 步正则清洗
    → ttsService.speak(text, { force })
      → this.stop()                          // 中断前一个任务
      → new Communicate(text, { voice, rate }).stream()
      → 收集 Uint8Array chunks → base64 data URL
      → new Audio(dataUrl).play()
      → onStatusChange 回调 → React state 更新
```

### STT 语音输入流

```
用户点击麦克风 (ChatStatusBar)
  → useSpeechRecognition.start()
    → speechService.start()
      → new SpeechRecognition() { continuous:true, interimResults:true }
      → onresult 反复触发
        → checkVoiceCommand() → 匹配则 onCommand
        → matchWakeWord() → 匹配则激活 + notifyWakeResponse
        → 否则 onResult(transcript) → appendSpeechTranscript
```

### 语音命令流

```
识别最终结果 → checkVoiceCommand() 返回 'send'
  → setSpeechCommand('send') [sessionStore]
    → ChatInput useEffect dispatches handleSend()
    → voiceNotificationService.notifySendConfirm()
    → setSpeechCommand(null)
    → setSpeechWakeActive(false)
```

## 设计决策

| 决策 | 选择 | 原因 |
|------|------|------|
| TTS 引擎 | edge-tts-universal | 纯 JS 实现，浏览器端直接与微软认知服务通信，无需本地引擎或付费 API |
| STT 引擎 | Web Speech API | 浏览器原生，零依赖；Tauri WebView2 (Chromium) 原生支持 |
| 音频传递 | Base64 data URL | 字符串可直接缓存到 Map，无需管理 ObjectURL 生命周期 |
| 配置读取 | Getter 注入 | 避免循环依赖，服务层可在非 React 上下文读配置 |
| 回声消除 | 双层（sync ref + async pause） | 单层异步 pause 有 timing gap，双层确保零漏过 |
| 短音频缓存 | App init 预生成 | 固定文本（"已发送"/"在的"）可预缓存，AI 响应不可预缓存 |
| 状态机 | idle→synthesizing→playing→idle | 粒度足够 UI 展示，synthesizing 阶段提供缓冲等待反馈 |
| 中断控制 | currentTaskId + isStopped | 新 speak() 调用立即作废前一个 taskId，流式过程中检查 isStopped |

## 已知陷阱

1. **ttsService.destroy() 存在死代码**：关闭 `this.audioContext` 但 `audioContext` 从未初始化，AudioContext 字段声明后未使用

2. **TTS/STT 语音类型不匹配**：TTS 提供 19 种中文 Neural 音色，但 STT 支持 zh-CN/en-US/ja-JP/ko-KR 等多语言。可将 STT 设为日语但 TTS 只能说中文

3. **VoicePackageService 缓存无淘汰**：`Map<string, CachedVoice>` 无上限，频繁更换通知文本会导致缓存增长。虽有 `clear()` 方法但无自动调用

4. **`no-speech` 重试静默**：SpeechService 对 `no-speech` 错误自动重试一次，但不触发 `onStatusChange`，UI 保持在 `listening` 状态不反映重试

5. **`VOICE_COMMANDS` 废弃常量仍导出**：`src/types/speech.ts:133` 标记 `@deprecated` 但未删除，无代码引用

6. **edge-tts-universal 需要网络**：与微软服务器通信，离线不可用。UI 有提示但无降级方案

7. **TTS speak() 无队列机制**：新调用直接中断前一个，不会排队。连续快速触发会丢失中间的文本

8. **speechWakeActive 发送后重置但超时不重置**：`handleSend()` 重置为 false，但唤醒后不发送则永久保持激活状态

9. **shouldKeepListening 未公开**：SpeechService 的连续监听状态无公共 API 查询，消费者需自行追踪

10. **ChatStatusBar TTS 按钮状态复杂**：playing→stop, paused→stop+disable, idle/error→toggle enabled。行为不直观，用户可能困惑暂停时为何停止

11. **autoPlay 配置不由 TTSService 消费**：`TTSConfig.autoPlay` 字段存在但 TTSService 不使用，决策在上游 `voiceNotificationService.speakAIResponse` 的 `force` 参数

12. **暂停/恢复协议用 abort 实现**：SpeechService.pause() 调用 abort()（彻底停止），resume() 重新 start()。不是真正的暂停，中间的 interim results 会丢失

13. **唤醒响应播放期间所有识别结果被丢弃**：muteRef 阻断所有 onResult，包括用户在唤醒响应播放期间说的话。设计意图是避免回声，但也阻止了快速连续交互

14. **base64 32KB 分块是经验值**：避免 `String.fromCharCode.apply()` 栈溢出的分块大小，但没有精确计算最大安全值

15. **VoiceNotificationService 需在 useAppInit 中初始化**：如果初始化顺序错误或跳过，所有通知功能静默失败（config getter 返回 null）

## 最近变更

- 初始创建于 2026-04-20
- 文档升级至 A 级（2026-04-22）：补充 6 架构模式、3 数据流、8 设计决策、15 陷阱
