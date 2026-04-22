# 模块：语音与通知

> ID: speech-voice | 复杂度: 中 | 变更频率: 低
> 依赖: edge-tts-universal, Web Speech API, configStore | 被依赖: Chat 交互层

## 概述

前端语音模块：TTS（edge-tts-universal）、STT（Web Speech API）、语音通知编排、短音频预缓存。Singleton Service + Hook Adapter 架构。

## 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| TTSService | services/ttsService.ts | edge-tts 驱动 TTS |
| SpeechService | services/speechService.ts | Web Speech API 封装 |
| VoiceNotificationService | services/voiceNotificationService.ts | 优先级通知编排 |
| useTTS | hooks/useTTS.ts | TTS → React Hook |

## 设计决策

1. edge-tts-universal：纯 JS，无需本地引擎
2. Web Speech API：浏览器原生
3. Base64 data URL 缓存音频
4. Config Getter 注入避免循环依赖

## 已知陷阱

1. ttsService.destroy() 有死代码
2. TTS/STT 语言类型不匹配
3. VoicePackageService 缓存无淘汰
4. edge-tts 需要网络，离线不可用
5. TTS speak() 无队列机制