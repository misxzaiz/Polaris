/**
 * voiceBroadcastPlayer 单元测试
 *
 * 覆盖：入队切句、预取流水线（队头 ready 即播）、代际打断（stop 后晚到
 * 合成结果丢弃不播）、stop 清队列 + 中止合成、单句合成失败跳过不断链、
 * 队列空 onQueueDrained。
 *
 * mock：callMimoTts（不触 cap.mcp）、Audio（jsdom 无真实播放，手动驱动回调）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock callMimoTts：可编程的合成结果
const mockCallMimoTts = vi.fn()
vi.mock('./mcpBridge', () => ({
  callMimoTts: (...args: unknown[]) => mockCallMimoTts(...args),
}))

// mock Audio：jsdom 无真实播放；手动驱动 onplay/onended/onerror
type AudioInstance = {
  play: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  onplay: (() => void) | null
  onended: (() => void) | null
  onerror: (() => void) | null
  volume: number
  src: string
}
const audioInstances: AudioInstance[] = []
const MockAudio = vi.fn(function MockAudio(this: AudioInstance, src: string) {
  this.src = src
  this.volume = 1
  this.onplay = null
  this.onended = null
  this.onerror = null
  this.play = vi.fn(() => {
    // 立即触发 onplay（模拟播放开始）
    this.onplay?.()
    return Promise.resolve()
  })
  this.pause = vi.fn()
  audioInstances.push(this)
} as unknown as new (src?: string) => AudioInstance)
vi.stubGlobal('Audio', MockAudio)

// import after mock
import { VoiceBroadcastPlayer, splitSentences } from './voiceBroadcastPlayer'

beforeEach(() => {
  mockCallMimoTts.mockReset()
  audioInstances.length = 0
  // 每个用例前重新 stub（幂等覆盖）；不 unstub——jsdom 原生 Audio 无 onplay 驱动
  vi.stubGlobal('Audio', MockAudio)
})

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('splitSentences', () => {
  it('按句末标点切分', () => {
    expect(splitSentences('第一句。第二句！第三句？')).toEqual(['第一句。', '第二句！', '第三句？'])
  })
  it('过滤空白段', () => {
    expect(splitSentences('第一句。\n\n第二句；\n')).toEqual(['第一句。', '第二句；'])
  })
})

describe('VoiceBroadcastPlayer', () => {
  it('入队即预取合成，队头 ready 自动播放', async () => {
    const p = new VoiceBroadcastPlayer()
    // 每句合成立即 resolve 一个 url
    mockCallMimoTts.mockImplementation(async () => ({ ok: true, url: 'http://x/1' }))

    const onStart = vi.fn()
    p.setCallbacks({ onStart })
    p.enqueueSegment('第一句。第二句。')

    // 预取触发合成
    await vi.waitFor(() => {
      expect(mockCallMimoTts).toHaveBeenCalled()
    })
    // 队头 ready → 播放 → onplay → onStart
    await vi.waitFor(() => {
      expect(onStart).toHaveBeenCalledWith('第一句。')
    })
    expect(p.currentText).toBe('第一句。')
  })

  it('stop：代际 +1、清队列、中止在途合成，晚到合成结果不播', async () => {
    const p = new VoiceBroadcastPlayer()
    const onStart = vi.fn()
    p.setCallbacks({ onStart })

    // 第一个合成挂起（不 resolve），第二个合成正常
    const firstSynth = deferred<{ ok: boolean; url?: string; error?: string }>()
    const mockCalls: Array<() => Promise<{ ok: boolean; url?: string; error?: string }>> = [
      () => firstSynth.promise,
      async () => ({ ok: true, url: 'http://x/late' }),
    ]
    mockCallMimoTts.mockImplementation(() => mockCalls.shift()!())

    p.enqueueSegment('第一句。第二句。')

    // stop：清队列 + 中止在途
    p.stop()
    expect(p.queueLength).toBe(0)

    // 晚到结果 resolve → 代际校验丢弃，不播放
    firstSynth.resolve({ ok: true, url: 'http://x/first' })
    await new Promise((r) => setTimeout(r, 0))
    expect(onStart).not.toHaveBeenCalled()
    expect(p.currentText).toBeNull()
  })

  it('单句合成失败：标记 failed 跳过，不断链', async () => {
    const p = new VoiceBroadcastPlayer()
    const onStart = vi.fn()
    const onSynthError = vi.fn()
    p.setCallbacks({ onStart, onSynthError })

    mockCallMimoTts.mockImplementation(async () => ({ ok: false, error: '未配置 API Key' }))

    p.enqueueSegment('第一句。第二句。')

    await vi.waitFor(() => {
      expect(onSynthError).toHaveBeenCalled()
    })
    // 第一句失败，第二句也被预取失败 → 无 ready，不播放
    expect(onStart).not.toHaveBeenCalled()
    expect(p.readyCount).toBe(0)
  })

  it('队列空触发 onQueueDrained', async () => {
    const p = new VoiceBroadcastPlayer()
    const onQueueDrained = vi.fn()
    p.setCallbacks({ onQueueDrained })

    mockCallMimoTts.mockImplementation(async () => ({ ok: true, url: 'http://x' }))
    p.enqueueSegment('你好。')
    // 合成后 ready → 播放；无 onended 手动触发
    await vi.waitFor(() => {
      expect(p.readyCount).toBe(0) // 已进入播放
    })
    // 手动驱动 onended → done → 队列空 → onQueueDrained
    const audio = audioInstances[audioInstances.length - 1]
    audio.onended?.()
    await vi.waitFor(() => {
      expect(onQueueDrained).toHaveBeenCalled()
    })
  })

  it('播放结束 onended 后驱动下一句', async () => {
    const p = new VoiceBroadcastPlayer()
    const onStart = vi.fn()
    p.setCallbacks({ onStart })

    mockCallMimoTts.mockImplementation(async () => ({ ok: true, url: 'http://x' }))
    p.enqueueSegment('第一句。第二句。')

    // 等第一句开始播
    await vi.waitFor(() => {
      expect(onStart).toHaveBeenCalledWith('第一句。')
    })
    // 驱动第一句 ended → 播放第二句
    const audio1 = audioInstances[audioInstances.length - 1]
    audio1.onended?.()
    await vi.waitFor(() => {
      expect(onStart).toHaveBeenCalledWith('第二句。')
    })
  })

  it('base64 模式：预取深度为 1（同一时刻至多 1 个在途合成）', async () => {
    // 覆盖移动端实测：mimo-tts 单进程串行合成 + base64 载荷 ~200KB/句，
    // 并发预取会让后续句子在服务端排队累积突破单句超时。BASE64_PREFETCH_DEPTH=1。
    const p = new VoiceBroadcastPlayer()
    p.setOptions({ base64Mode: true })
    const onStart = vi.fn()
    p.setCallbacks({ onStart })

    // 第一个合成挂起；其余立即返回成功
    const firstSynth = deferred<{ ok: boolean; url?: string }>()
    const calls: Array<() => Promise<{ ok: boolean; url?: string }>> = [
      () => firstSynth.promise,
      async () => ({ ok: true, url: 'data:audio/wav;base64,AAAA' }),
    ]
    mockCallMimoTts.mockImplementation(() => calls.shift()!())

    p.enqueueSegment('第一句。第二句。')
    await vi.waitFor(() => {
      expect(mockCallMimoTts).toHaveBeenCalledTimes(1)
    })
    // 首句在途时不应预取第二句（深度 1）
    expect(mockCallMimoTts).toHaveBeenCalledTimes(1)

    // 释放首句 → 第二句才开始合成
    firstSynth.resolve({ ok: true, url: 'data:audio/wav;base64,BBBB' })
    await vi.waitFor(() => {
      expect(mockCallMimoTts).toHaveBeenCalledTimes(2)
    })
    // 首句 base64 data URL 直接播放
    await vi.waitFor(() => {
      expect(onStart).toHaveBeenCalledWith('第一句。')
    })
  })

  it('base64 模式：单句合成超时为 25s（BASE64_SYNTH_TIMEOUT），file 模式仍为 12s', async () => {
    vi.useFakeTimers()
    try {
      // 合成永不 settle → 只有定时器能触发超时兜底
      const hangPromise = () => new Promise<{ ok: boolean }>(() => { /* 永不 settle */ })

      // file 模式（默认）：12s 超时
      const pFile = new VoiceBroadcastPlayer()
      const errFile = vi.fn()
      pFile.setCallbacks({ onSynthError: errFile })
      mockCallMimoTts.mockImplementation(hangPromise)
      pFile.enqueueSegment('第一句。')
      vi.advanceTimersByTime(11000)
      expect(errFile).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1500)
      expect(errFile).toHaveBeenCalled() // 12s 超时触发

      // base64 模式：25s 超时
      const p64 = new VoiceBroadcastPlayer()
      p64.setOptions({ base64Mode: true })
      const err64 = vi.fn()
      p64.setCallbacks({ onSynthError: err64 })
      p64.enqueueSegment('第一句。')
      vi.advanceTimersByTime(24000)
      expect(err64).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2000)
      expect(err64).toHaveBeenCalled() // 25s 超时触发
    } finally {
      vi.useRealTimers()
    }
  })
})
