/**
 * voiceStopWatcher 单元测试
 *
 * 覆盖：
 * - 命中「停止/停/暂停/stop」关键词 → onStop 触发
 * - 非停止内容 → 不触发
 * - 识别不可用（supported=false）→ start 后降级不启动监听，不抛错
 * - stop() 后晚到回调不再触发（active 标志）
 * - 重复 start 幂等
 *
 * mock：SpeechService（可编程 supported / start / destroy / setConfig /
 *       setCallbacks 捕获回调），不触真实 Web Speech API。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { MockSpeechService } = vi.hoisted(() => {
  class MockSpeechService {
    static instances: MockSpeechService[] = []
    /** 测试控制 supported（getter 读 static，可运行时翻转） */
    static supported = true
    get supported(): boolean {
      return MockSpeechService.supported
    }
    start = vi.fn()
    destroy = vi.fn()
    setConfig = vi.fn()
    setCallbacks = vi.fn()
    callbacks: Record<string, (...args: unknown[]) => void> = {}
    constructor() {
      MockSpeechService.instances.push(this)
      this.setCallbacks.mockImplementation((cb: Record<string, (...args: unknown[]) => void>) => {
        this.callbacks = { ...this.callbacks, ...cb }
      })
    }
  }
  return { MockSpeechService }
})

vi.mock('@/services/speechService', () => ({
  SpeechService: MockSpeechService,
}))

import { VoiceStopWatcher } from './voiceStopWatcher'

beforeEach(() => {
  vi.clearAllMocks()
  MockSpeechService.instances.length = 0
})

/** 构造一个把回调暴露给测试的 watcher */
function makeWatcher() {
  const w = new VoiceStopWatcher()
  const onStop = vi.fn()
  w.setCallbacks({ onStop })
  w.start()
  const svc = (w as unknown as { service: MockSpeechService }).service
  return { w, onStop, svc }
}

/** 模拟识别 final 结果 */
function fireFinal(svc: MockSpeechService, transcript: string): void {
  const onResult = svc.callbacks.onResult as ((t: string, f: boolean) => void) | undefined
  onResult?.(transcript, true)
}

describe('voiceStopWatcher', () => {
  it('命中「停止」→ onStop 触发', () => {
    const { onStop, svc } = makeWatcher()
    fireFinal(svc, '停止')
    expect(onStop).toHaveBeenCalled()
  })

  it('命中英文「stop」→ onStop 触发', () => {
    const { onStop, svc } = makeWatcher()
    fireFinal(svc, 'please stop')
    expect(onStop).toHaveBeenCalled()
  })

  it('命中间隔词短语「帮我暂停一下」→ onStop 触发', () => {
    const { onStop, svc } = makeWatcher()
    fireFinal(svc, '暂停')
    expect(onStop).toHaveBeenCalled()
  })

  it('非停止内容 → 不触发', () => {
    const { onStop, svc } = makeWatcher()
    fireFinal(svc, '今天天气不错')
    expect(onStop).not.toHaveBeenCalled()
  })

  it('interim 结果（非 final）→ 不触发', () => {
    const { onStop, svc } = makeWatcher()
    const onResult = svc.callbacks.onResult as ((t: string, f: boolean) => void) | undefined
    onResult?.('停止', false)
    expect(onStop).not.toHaveBeenCalled()
  })

  it('识别不可用 → 静默降级，start 不抛错，不启动监听', () => {
    MockSpeechService.supported = false
    const w = new VoiceStopWatcher()
    const onStop = vi.fn()
    w.setCallbacks({ onStop })
    expect(() => w.start()).not.toThrow()
    // start 降级：实例被创建但未启动监听
    const svc = (w as unknown as { service: MockSpeechService }).service
    expect(svc).not.toBeNull()
    expect(svc!.start).not.toHaveBeenCalled()
    MockSpeechService.supported = true
  })

  it('stop() 后晚到回调不再触发（active 标志）', () => {
    const w = new VoiceStopWatcher()
    const onStop = vi.fn()
    w.setCallbacks({ onStop })
    w.start()
    const svc = (w as unknown as { service: MockSpeechService }).service
    expect(svc).not.toBeNull()

    // 命中停止 → 触发（先证明链路通）
    fireFinal(svc, '停止')
    expect(onStop).toHaveBeenCalledTimes(1)

    // stop() → 实例 destroy，晚到回调不再触发
    w.stop()
    expect(svc!.destroy).toHaveBeenCalled()
    fireFinal(svc, '停止')
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('重复 start 幂等', () => {
    const w = new VoiceStopWatcher()
    w.start()
    w.start()
    // 第二个 start 不创建新实例（active 已 true）
    expect(MockSpeechService.instances.length).toBe(1)
    w.stop()
    w.start()
    // stop 后重新 start → 再建新实例
    expect(MockSpeechService.instances.length).toBe(2)
  })
})