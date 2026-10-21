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
  playbackRate: number
  src: string
}
const audioInstances: AudioInstance[] = []
const MockAudio = vi.fn(function MockAudio(this: AudioInstance, src: string) {
  this.src = src
  this.volume = 1
  this.playbackRate = 1
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

  it('单句合成失败：先重试一次，仍失败才标记 failed 跳过不断链', async () => {
    const p = new VoiceBroadcastPlayer()
    const onStart = vi.fn()
    const onSynthError = vi.fn()
    p.setCallbacks({ onStart, onSynthError })

    mockCallMimoTts.mockImplementation(async () => ({ ok: false, error: '未配置 API Key' }))

    p.enqueueSegment('第一句。第二句。')

    // 首次失败 → 自动重试一次（共 2 次合成调用）→ 仍失败才 onSynthError
    await vi.waitFor(() => {
      expect(onSynthError).toHaveBeenCalledTimes(2) // 两句各重试后各失败
    })
    // 每句各 2 次合成（首败 + 重试）
    expect(mockCallMimoTts).toHaveBeenCalledTimes(4)
    // 全部失败 → 无 ready，不播放
    expect(onStart).not.toHaveBeenCalled()
    expect(p.readyCount).toBe(0)
  })

  it('单句合成偶发失败：重试成功则不丢句，正常播放', async () => {
    const p = new VoiceBroadcastPlayer()
    const onStart = vi.fn()
    const onSynthError = vi.fn()
    p.setCallbacks({ onStart, onSynthError })

    // 第一次调用失败，第二次（重试）成功
    let call = 0
    mockCallMimoTts.mockImplementation(async () => {
      call++
      return call % 2 === 1 ? { ok: false, error: '偶发 5xx' } : { ok: true, url: 'http://x/ok' }
    })

    p.enqueueSegment('第一句。')

    // 重试成功后这句话正常播放，onSynthError 不被触发
    await vi.waitFor(() => {
      expect(onStart).toHaveBeenCalledWith('第一句。')
    })
    expect(mockCallMimoTts).toHaveBeenCalledTimes(2)
    expect(onSynthError).not.toHaveBeenCalled()
    expect(p.currentText).toBe('第一句。')
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

  it('base64 模式：单句合成超时为 25s（BASE64_SYNTH_TIMEOUT），file 模式仍为 12s（含重试）', async () => {
    vi.useFakeTimers()
    try {
      // 合成永不 settle → 只有定时器能触发超时兜底
      const hangPromise = () => new Promise<{ ok: boolean }>(() => { /* 永不 settle */ })

      // file 模式（默认）：12s 超时。合成失败先重试一次，故 onSynthError 需两个超时周期（12s + 12s）
      const pFile = new VoiceBroadcastPlayer()
      const errFile = vi.fn()
      pFile.setCallbacks({ onSynthError: errFile })
      mockCallMimoTts.mockImplementation(hangPromise)
      pFile.enqueueSegment('第一句。')
      vi.advanceTimersByTime(12000)
      expect(errFile).not.toHaveBeenCalled() // 首次超时 → 触发重试，不报错
      vi.advanceTimersByTime(12000)
      expect(errFile).toHaveBeenCalled() // 重试再超时 → 最终失败（24s 累计）
      expect(mockCallMimoTts).toHaveBeenCalledTimes(2) // 首试 + 重试各一次

      // base64 模式：25s 超时
      const p64 = new VoiceBroadcastPlayer()
      p64.setOptions({ base64Mode: true })
      const err64 = vi.fn()
      p64.setCallbacks({ onSynthError: err64 })
      p64.enqueueSegment('第一句。')
      vi.advanceTimersByTime(25000)
      expect(err64).not.toHaveBeenCalled() // 首次超时 → 重试
      vi.advanceTimersByTime(25000)
      expect(err64).toHaveBeenCalled() // 重试再超时（50s 累计）
    } finally {
      vi.useRealTimers()
    }
  })

  // ── P0 快赢（radio-broadcast-p0-quickwins-spec）──

  it('P0-5 缓存命中：同参数句二次入队不再调合成 API，直接就绪播放', async () => {
    const p = new VoiceBroadcastPlayer()
    const onStart = vi.fn()
    p.setCallbacks({ onStart })
    mockCallMimoTts.mockImplementation(async () => ({ ok: true, url: 'http://x/same' }))

    // 第一遍：真实合成 → 播 → 播完
    p.enqueueSegment('第一句。')
    await vi.waitFor(() => {
      expect(onStart).toHaveBeenCalledWith('第一句。')
    })
    audioInstances[audioInstances.length - 1].onended?.()
    // 第二遍：同句同参数 → 缓存命中，callMimoTts 不再被调
    p.enqueueSegment('第一句。')
    await vi.waitFor(() => {
      expect(onStart).toHaveBeenCalledTimes(2)
    })
    expect(mockCallMimoTts).toHaveBeenCalledTimes(1)
  })

  it('P0-5 缓存区分参数：不同音色/输出模式不串缓存', async () => {
    const p = new VoiceBroadcastPlayer()
    p.setCallbacks({ onStart: vi.fn() })
    mockCallMimoTts.mockImplementation(async () => ({ ok: true, url: 'http://x/v' }))
    p.enqueueSegment('第一句。')
    await vi.waitFor(() => {
      expect(p.currentText).toBe('第一句。')
    })
    // 换音色 → key 不同 → 仍需真实合成
    p.setOptions({ voice: '茉莉' })
    p.enqueueSegment('第一句。')
    await vi.waitFor(() => {
      expect(mockCallMimoTts).toHaveBeenCalledTimes(2)
    })
  })

  it('P0-2 setRate：新句继承倍速，播报中调整即时生效', async () => {
    const p = new VoiceBroadcastPlayer()
    p.setCallbacks({ onStart: vi.fn() })
    mockCallMimoTts.mockImplementation(async () => ({ ok: true, url: 'http://x' }))

    p.setOptions({ rate: 1.5 })
    p.enqueueSegment('第一句。第二句。')
    await vi.waitFor(() => {
      expect(p.currentText).toBe('第一句。')
    })
    expect(audioInstances[audioInstances.length - 1].playbackRate).toBe(1.5)
    // 播报中调整 → 当前音频即时生效
    p.setRate(2)
    expect(audioInstances[audioInstances.length - 1].playbackRate).toBe(2)
  })

  it('P0-1 getTranscript：队列即文稿（含状态与当前索引），stop 后为 null', async () => {
    // 合成挂起 → 两句一 ready 一 pending，状态可断言
    const p = new VoiceBroadcastPlayer()
    const firstSynth = deferred<{ ok: boolean; url?: string }>()
    const calls: Array<() => Promise<{ ok: boolean; url?: string }>> = [
      async () => ({ ok: true, url: 'http://x/1' }),
      () => firstSynth.promise,
    ]
    // 第一句立即就绪并播放；第二句挂起（保持 pending）
    mockCallMimoTts.mockImplementation(() => calls.shift()!())
    p.enqueueSegment('第一句。第二句。')
    await vi.waitFor(() => {
      expect(p.currentText).toBe('第一句。')
    })

    const t1 = p.getTranscript()
    expect(t1).not.toBeNull()
    expect(t1!.lines.map((l) => l.text)).toEqual(['第一句。', '第二句。'])
    expect(t1!.currentIndex).toBe(0)
    expect(t1!.lines[0].status).toBe('playing')
    // 预取深度 2：第二句虽未就绪但已进入合成（挂起中）
    expect(t1!.lines[1].status).toBe('synthesizing')

    // stop 清队列 → 文稿消失（播完即弃语义）
    p.stop()
    expect(p.getTranscript()).toBeNull()
  })

  it('P0-3 fadeOut：线性降音量后暂停当前音频；期间被停则放弃', async () => {
    const p = new VoiceBroadcastPlayer()
    p.setCallbacks({ onStart: vi.fn() })
    mockCallMimoTts.mockImplementation(async () => ({ ok: true, url: 'http://x' }))
    p.enqueueSegment('第一句。')
    await vi.waitFor(() => {
      expect(p.currentText).toBe('第一句。')
    })
    const audio = audioInstances[audioInstances.length - 1]
    await p.fadeOut(60)
    expect(audio.volume).toBeLessThan(1)
    expect(audio.volume).toBeGreaterThanOrEqual(0)
    expect(audio.pause).toHaveBeenCalled()
  })
})
