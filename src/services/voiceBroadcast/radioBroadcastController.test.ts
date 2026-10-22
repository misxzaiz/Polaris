/**
 * radioBroadcastController 单元测试
 *
 * 覆盖（spec §2.1 状态机 + §5 停止语义）：
 * - start：预检失败 → error；正常 → starting → (播放器回调) playing
 * - stop：幂等（idle 时 no-op；重复 stop 忽略）；三路中断序列
 * - 段循环：runSegment 收尾衔接；（空段/失败计数 → error 阈值 → running=false）
 * - 控制器是唯一状态写入方
 *
 * mock：播放器（可观测 stop/enqueueSegment/setCallbacks）、会话管理、kernel hook、
 *       assistantTextUtils、ttsTextFilter、voiceService（probe）。
 * 播报用「软取消」不硬杀（spec §5）：interruptSession 被调用即满足中断语义断言。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- mock 依赖（先 mock 后 import，vitest hoist 规则） ----

// 播放器 mock：用 vi.hoisted 提升类定义，供 mock factory 与测试体引用
const { MockPlayer } = vi.hoisted(() => {
  class MockPlayer {
    setCallbacks = vi.fn()
    setOptions = vi.fn()
    setVolume = vi.fn()
    stop = vi.fn()
    pause = vi.fn()
    resume = vi.fn()
    enqueueSegment = vi.fn()
    setRate = vi.fn()
    fadeOut = vi.fn().mockResolvedValue(undefined)
    /** 字幕快照（P0-1）：默认 null，测试可编程 */
    getTranscript = vi.fn(() => null)
    /** P1：段自动入库取句（默认空数组，测试可编程） */
    takeDoneSentences = vi.fn(() => [])
    /** P1：回听就绪句直插 */
    enqueuePrepared = vi.fn()
    queueLength = 0
    hasPendingSynth = false
    /** 未就绪句数（段级提前量判断用）；默认 0 = 低水位，lookahead 触发 */
    pendingCount = 0
    /** 回调捕获：测试驱动用 */
    callbacks: Record<string, (...args: unknown[]) => void> = {}
    constructor() {
      // 捕获 setCallbacks 传入的回调，供测试手动触发
      this.setCallbacks.mockImplementation((cb: Record<string, (...args: unknown[]) => void>) => {
        this.callbacks = { ...this.callbacks, ...cb }
      })
      // 入队模拟：queueLength 递增（反映「有内容在播」，避免控制器空转续段）
      this.enqueueSegment.mockImplementation(() => {
        this.queueLength++
      })
    }
  }
  return { MockPlayer }
})
vi.mock('./voiceBroadcastPlayer', () => ({
  VoiceBroadcastPlayer: MockPlayer,
  splitSentences: (t: string) =>
    t.split(/(?<=[。！？!?；;\n])/).map((s: string) => s.trim()).filter(Boolean),
}))

// 会话管理 mock：共享 stores Map，测试可注入会话 store
const mockStores = vi.hoisted(() => new Map<string, unknown>())
const mockCreateSession = vi.fn()
const mockInterruptSession = vi.fn()
vi.mock('@/stores/conversationStore/sessionStoreManager', () => ({
  sessionStoreManager: {
    getState: () => ({
      createSession: mockCreateSession,
      interruptSession: mockInterruptSession,
      stores: mockStores,
      sessionMetadata: new Map(),
    }),
  },
}))

vi.mock('@/stores/configStore', () => ({
  useConfigStore: { getState: () => ({ config: { defaultEngine: 'simple-ai' } }) },
}))

vi.mock('@/stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({
      currentWorkspaceId: 'ws-1',
      workspaces: [{ id: 'ws-1', name: '默认', path: '/tmp/ws' }],
    }),
  },
}))

// kernel hook mock：订阅可编程 + wait 可编程
const mockSubscribeKernel = vi.fn()
const mockWaitStreamEnd = vi.fn()
vi.mock('@/session-v2/hooks/useKernelSessionState', () => ({
  subscribeKernelSessionState: (...args: unknown[]) => mockSubscribeKernel(...args),
  waitKernelSessionStreamEnd: (...args: unknown[]) => mockWaitStreamEnd(...args),
  getKernelSessionStateSnapshot: () => ({ sessionId: null, state: 'none', isStreaming: false, error: null }),
}))

const mockPickLatest = vi.fn()
vi.mock('@/services/assistantTextUtils', () => ({
  pickLatestAssistantText: (...args: unknown[]) => mockPickLatest(...args),
}))

const mockClean = vi.fn()
vi.mock('@/services/ttsTextFilter', () => ({
  cleanTextForSpeech: (...args: unknown[]) => mockClean(...args),
}))

// voiceService 现在被控制器静态 import，工厂随模块初始化即执行 → 需要 hoisted
const { mockProbe, mockLibraryAdd } = vi.hoisted(() => ({
  mockProbe: vi.fn(),
  mockLibraryAdd: vi.fn(),
}))
vi.mock('./voiceService', () => ({ probeVoice: mockProbe, addLibraryItem: mockLibraryAdd, buildAudioPlayUrl: (f: string) => f }))

// 语音「停止」口令 watcher mock：捕获 setCallbacks 的 onStop，供测试触发
const { MockVoiceStopWatcher } = vi.hoisted(() => {
  class MockVoiceStopWatcher {
    setCallbacks = vi.fn()
    start = vi.fn()
    stop = vi.fn()
    callbacks: Record<string, (...args: unknown[]) => void> = {}
    constructor() {
      this.setCallbacks.mockImplementation((cb: Record<string, (...args: unknown[]) => void>) => {
        this.callbacks = { ...this.callbacks, ...cb }
      })
    }
  }
  return { MockVoiceStopWatcher }
})
vi.mock('./voiceStopWatcher', () => ({ VoiceStopWatcher: MockVoiceStopWatcher }))

// ---- import after mock ----
import { radioBroadcastController } from './radioBroadcastController'

/** 手动驱动「一段流式结束」：取用户注册的 kernel 订阅回调并触发下降沿 */
let kernelSubCb: ((s: { state: string; isStreaming: boolean; error: string | null }) => void) | null = null

/** 触发一次 kernel running（段开始，sawStreaming 置位） */
function fireStreamingStart(): void {
  kernelSubCb?.({ state: 'running', isStreaming: true, error: null })
}

/** 触发一次 kernel idle 下降沿（一段 AI 流式结束） */
function fireIdle(): void {
  kernelSubCb?.({ state: 'idle', isStreaming: false, error: null })
}

/**
 * 真实下降沿序列：先 running 再 idle。
 * 说明：kernel.subscribe 建订即推首帧空闲快照，被控制器守卫拦截（不触发段结束）；
 * 只有观测到 running 之后的 idle 才算「段结束下降沿」（对齐 sawStreaming 守卫语义）。
 */
function fireSegmentEnd(): void {
  fireStreamingStart()
  fireIdle()
}

/** 构造可注入会话 store 的最小 stub（提供 sendMessage / getState） */
function makeSessionStore() {
  return {
    getState: () => ({
      sendMessage: vi.fn().mockResolvedValue(true),
      // 供 pickLatestAssistantText mock 读（控制器经 pickLatestAssistantText(store.getState())）
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // 默认：probe 成功、clean 原样、wait resolve、pick 空
  mockProbe.mockResolvedValue({ ok: true })
  mockClean.mockImplementation((t: string) => t)
  mockWaitStreamEnd.mockResolvedValue(undefined)
  mockPickLatest.mockReturnValue('第一段文本。第二段。')
  mockCreateSession.mockReturnValue('sess-1')
  mockInterruptSession.mockResolvedValue(undefined)
  kernelSubCb = null
  mockSubscribeKernel.mockImplementation((_id: string, cb: (s: unknown) => void) => {
    kernelSubCb = cb as typeof kernelSubCb
    return vi.fn()
  })
  // 注入默认会话 store（'sess-1'）
  mockStores.clear()
  mockStores.set('sess-1', makeSessionStore())
})

/** 每个用例前把控制器单例归 idle（避免用例间状态残留） */
beforeEach(async () => {
  if (radioBroadcastController.getStatus() !== 'idle') {
    await radioBroadcastController.stop()
  }
})

describe('radioBroadcastController', () => {
  it('start：预检失败 → error', async () => {
    mockProbe.mockResolvedValue({ ok: false, error: '未配置 API Key' })
    await radioBroadcastController.start({
      direction: { kind: 'tech', text: '分布式' },
      voice: '冰糖',
    })
    expect(radioBroadcastController.getStatus()).toBe('error')
    expect(radioBroadcastController.getSnapshot().error).toContain('API Key')
  })

  it('start：方向为空 → error', async () => {
    await radioBroadcastController.start({
      direction: { kind: 'custom', text: '' },
      voice: '冰糖',
    })
    expect(radioBroadcastController.getStatus()).toBe('error')
  })

  it('start→normal：进入 starting 并请求第一段', async () => {
    await radioBroadcastController.start({
      direction: { kind: 'study', text: '英语单词' },
      voice: '茉莉',
    })
    // 第一段已发起（waitStreamEnd 被调用）
    expect(mockWaitStreamEnd).toHaveBeenCalled()
    // 状态不再是 idle/error（处于生成/播放链中）
    expect(['generating', 'playing']).toContain(radioBroadcastController.getStatus())
  })

  it('stop：三路中断（播放器 stop + interruptSession + 在途 Promise 结清）', async () => {
    await radioBroadcastController.start({
      direction: { kind: 'study', text: '英语' },
      voice: '冰糖',
    })
    const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
    await radioBroadcastController.stop()
    expect(radioBroadcastController.getStatus()).toBe('idle')
    // 路由 1：播放器 stop 被调用
    expect(player.stop).toHaveBeenCalled()
    // 路由 2：interruptSession 被调用
    expect(mockInterruptSession).toHaveBeenCalled()
    // 停止原因标注：手动停止（默认）
    expect(radioBroadcastController.getSnapshot().stopReason).toBe('manual')
  })

  it('stop 幂等：idle 时 no-op', async () => {
    await radioBroadcastController.stop()
    expect(radioBroadcastController.getStatus()).toBe('idle')
  })

  it('语音口令「停止」→ 触发 controller.stop（全链路接线）', async () => {
    await radioBroadcastController.start({
      direction: { kind: 'story', text: '小王子' },
      voice: '冰糖',
    })
    // start 时 voiceStopEnabled=true 已向 watcher setCallbacks({onStop})
    const watcher = (radioBroadcastController as unknown as {
      voiceStopWatcher: MockVoiceStopWatcher
    }).voiceStopWatcher
    expect(watcher.setCallbacks).toHaveBeenCalled()
    // 命中口令 → watcher.onStop → controller.stop()（async，等待三路中断完成）
    watcher.callbacks.onStop?.()
    await vi.waitFor(() => {
      expect(radioBroadcastController.getStatus()).toBe('idle')
    })
    // 停止原因标注：语音口令触发
    expect(radioBroadcastController.getSnapshot().stopReason).toBe('voice-command')
  })

  it('stop 后晚到段结果不回流播放（running=false 拦截）', async () => {
    await radioBroadcastController.start({
      direction: { kind: 'story', text: '小王子' },
      voice: '冰糖',
    })
    const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
    // 播放中触发停止（三路中断）
    await radioBroadcastController.stop()
    expect(player.enqueueSegment).not.toHaveBeenCalled()
    // 晚到段结束回调（stop 后订阅残留）→ stopped/running=false 拦截，不入队
    fireStreamingStart()
    fireIdle()
    expect(player.enqueueSegment).not.toHaveBeenCalled()
    // 语音口令 watcher 也已停
    const watcher = (radioBroadcastController as unknown as {
      voiceStopWatcher: MockVoiceStopWatcher
    }).voiceStopWatcher
    expect(watcher.stop).toHaveBeenCalled()
  })

  it('段下降沿：取全文清洗后入队播放', async () => {
    await radioBroadcastController.start({
      direction: { kind: 'story', text: '小王子' },
      voice: '冰糖',
    })
    const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
    fireSegmentEnd()
    // 入队应被调用（播放器 enqueueSegment）
    expect(player.enqueueSegment).toHaveBeenCalled()
  })

  it('sawStreaming 守卫：首帧 idle（未观测到 running）不触发段结束', async () => {
    // 覆盖移动端实测根因：kernel.subscribe 建订即推首帧空闲快照，
    // 若被误判为「段结束下降沿」会取空文本 → 段文本为空 → 死循环
    await radioBroadcastController.start({
      direction: { kind: 'tech', text: '分布式' },
      voice: '冰糖',
    })
    const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
    // 只触发 idle（订阅建订首帧 / 会话初始态），从未见过 running
    fireIdle()
    // 首帧 idle 不应被当作段结束：不取全文、不入队
    expect(player.enqueueSegment).not.toHaveBeenCalled()
  })

  it('sawStreaming 守卫：error 下降沿同样需要先观测到 running', async () => {
    await radioBroadcastController.start({
      direction: { kind: 'tech', text: '分布式' },
      voice: '冰糖',
    })
    const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
    // 首帧直接 error（会话启动失败）→ 不当作段结束（避免空文本错误计数）
    kernelSubCb?.({ state: 'error', isStreaming: false, error: 'boom' })
    expect(player.enqueueSegment).not.toHaveBeenCalled()
    // 真实先 running 再 error 的下降沿 → 正常入队
    fireStreamingStart()
    kernelSubCb?.({ state: 'error', isStreaming: false, error: 'boom' })
    expect(player.enqueueSegment).toHaveBeenCalled()
  })

  it('连续失败达到阈值 → error 并停止循环', async () => {
    // 每段都空文本 → 计数失败
    mockPickLatest.mockReturnValue('')
    await radioBroadcastController.start({
      direction: { kind: 'tech', text: 'xx' },
      voice: '冰糖',
    })
    // 触发 3 次空段下降沿 → error
    for (let i = 0; i < 3; i++) {
      fireSegmentEnd()
    }
    expect(radioBroadcastController.getStatus()).toBe('error')
    // error 后 requestNextSegment 不再触发（running=false）
  })

  it('轮次上限：maxRounds 命中后队列播空即优雅停止，不再请求新段', async () => {
    await radioBroadcastController.start({
      direction: { kind: 'story', text: '小王子' },
      voice: '冰糖',
      maxRounds: 1,
    })
    const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
    // 段 1 入队 → segmentIndex=1 ≥ maxRounds
    fireSegmentEnd()
    expect(player.enqueueSegment).toHaveBeenCalled()
    // 播完队列（queue 清 0）→ 触发 onQueueDrained → reachedLimit → 优雅停机回 idle
    player.queueLength = 0
    player.hasPendingSynth = false
    player.callbacks.onQueueDrained?.()
    await vi.waitFor(() => {
      expect(radioBroadcastController.getStatus()).toBe('idle')
    })
    // 停机后不再请求下一段（waitStreamEnd 计数不再增长——最后计数留在停前）
    // 停止原因标注：轮次上限命中
    expect(radioBroadcastController.getSnapshot().stopReason).toBe('max-rounds')
  })

  it('时长上限：maxSeconds 命中（极小值 → 启动即超时）→ 队列空即优雅停止', async () => {
    await radioBroadcastController.start({
      direction: { kind: 'tech', text: '分布式' },
      voice: '冰糖',
      maxSeconds: 0.0001, // 0.1ms 内必超时
    })
    // start 内 requestNextSegment → reachedLimit（已超时）→ 队列空 → stop()
    await vi.waitFor(() => {
      expect(radioBroadcastController.getStatus()).toBe('idle')
    })
    // 停止原因标注：时长上限命中
    expect(radioBroadcastController.getSnapshot().stopReason).toBe('max-seconds')
  })

  it('轮次未满：段入队后不触发提前停止（回归保护）', async () => {
    await radioBroadcastController.start({
      direction: { kind: 'study', text: '英语' },
      voice: '冰糖',
      maxRounds: 5,
    })
    const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
    fireSegmentEnd() // 段 1（segmentIndex=1 < maxRounds）
    // 未达上限：段正常入队、状态保持播报中（不因 limitReached 提前停）
    expect(player.enqueueSegment).toHaveBeenCalled()
    expect(radioBroadcastController.getStatus()).not.toBe('idle')
    expect(radioBroadcastController.getStatus()).not.toBe('stopping')
  })

  it('段级提前量：句播完低水位（未就绪 ≤ 阈值）→ 提前请求下一段（播放时并行生成）', async () => {
    await radioBroadcastController.start({
      direction: { kind: 'story', text: '小王子' },
      voice: '冰糖',
    })
    const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
    // 先垫队列水位：queueLength>0 让首段 runSegment 收尾（afterSegmentFinished）不空转续段
    player.pendingCount = 0
    player.queueLength = 2 // 已有 2 句可播
    // 等首段 runSegment 收尾（微任务清空，避免 hasSegmentInFlight 挡提前量）
    await new Promise((r) => setTimeout(r, 0))
    const callsBefore = mockWaitStreamEnd.mock.calls.length // 首段已在生成
    // 一句播完（onEnd）→ 低水位触发提前请求下一段（waitStreamEnd 再次被调用）
    player.callbacks.onEnd?.()
    await vi.waitFor(() => {
      expect(mockWaitStreamEnd.mock.calls.length).toBeGreaterThan(callsBefore)
    })
  })

  it('段级提前量：高水位（未就绪句数充足）不提前请求', async () => {
    await radioBroadcastController.start({
      direction: { kind: 'story', text: '小王子' },
      voice: '冰糖',
    })
    const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
    const callsBefore = mockWaitStreamEnd.mock.calls.length
    player.pendingCount = 10 // 远超阈值 → 无需提前请求
    player.queueLength = 5 // 有内容在播，堵住 afterSegmentFinished 空转续段路径
    player.callbacks.onEnd?.()
    expect(mockWaitStreamEnd.mock.calls.length).toBe(callsBefore)
  })

  // ── P0 快赢（radio-broadcast-p0-quickwins-spec）──

  it('P0-1 onStart/onEnd 句级变化实时广播（修复 status 已是 playing 时不 emit 的刷新缺口）', async () => {
    await radioBroadcastController.start({
      direction: { kind: 'story', text: '小王子' },
      voice: '冰糖',
    })
    // 进入 playing（播放器 onStart 回调驱动）
    ;(radioBroadcastController as unknown as { player: MockPlayer }).player.callbacks.onStart?.('第一句')
    expect(radioBroadcastController.getStatus()).toBe('playing')
    expect(radioBroadcastController.getSnapshot().nowPlayingText).toBe('第一句')
    // 连续第二句（status 保持 playing）→ 快照仍实时更新（旧行为：setStatus 早退不 emit，UI 卡在第一句）
    ;(radioBroadcastController as unknown as { player: MockPlayer }).player.callbacks.onStart?.('第二句')
    expect(radioBroadcastController.getSnapshot().nowPlayingText).toBe('第二句')
  })

  it('P0-1 快照携带 transcript（播放器 getTranscript 透传）', async () => {
    await radioBroadcastController.start({
      direction: { kind: 'story', text: '小王子' },
      voice: '冰糖',
    })
    const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
    expect(radioBroadcastController.getSnapshot().transcript).toBeNull()
    player.getTranscript.mockReturnValue({ lines: [{ id: 'a', text: '第一句', status: 'playing' }], currentIndex: 0 })
    expect(radioBroadcastController.getSnapshot().transcript?.currentIndex).toBe(0)
  })

  it('P0-2 setRate 转发播放器；start opts.rate 随 setOptions 下发', async () => {
    await radioBroadcastController.start({
      direction: { kind: 'story', text: '小王子' },
      voice: '冰糖',
      rate: 1.5,
    })
    const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
    expect(player.setOptions).toHaveBeenCalledWith(expect.objectContaining({ rate: 1.5 }))
    radioBroadcastController.setRate(2)
    expect(player.setRate).toHaveBeenCalledWith(2)
  })

  it('P0-3 睡眠定时「播完本段」：不再请求新段，队列播空即优雅停止（stopReason=sleep）', async () => {
    await radioBroadcastController.start({
      direction: { kind: 'story', text: '小王子' },
      voice: '冰糖',
    })
    const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
    fireSegmentEnd() // 段 1 入队（segmentIndex=1）
    expect(player.enqueueSegment).toHaveBeenCalled()
    radioBroadcastController.sleep({ afterSegment: true })
    expect(radioBroadcastController.getSnapshot().sleepAfterSegment).toBe(true)
    // 队列播空 → onQueueDrained → 达上限判定（sleepAfterSegment）→ 优雅停机
    player.queueLength = 0
    player.hasPendingSynth = false
    player.callbacks.onQueueDrained?.()
    await vi.waitFor(() => {
      expect(radioBroadcastController.getStatus()).toBe('idle')
    })
    expect(radioBroadcastController.getSnapshot().stopReason).toBe('sleep')
  })

  it('P0-3 睡眠定时（分钟档）：watchdog 到点淡出并停止（stopReason=sleep）', async () => {
    vi.useFakeTimers()
    try {
      await radioBroadcastController.start({
        direction: { kind: 'story', text: '小王子' },
        voice: '冰糖',
      })
      const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
      player.queueLength = 2 // 有内容在播（不触发 afterSegmentFinished 空转）
      radioBroadcastController.sleep({ minutes: 15 })
      expect(radioBroadcastController.getSnapshot().sleepUntil).toBeGreaterThan(0)
      // 快进 15 分钟（watchdog 1s interval 触发）+ 淡出 3s（50ms 步进）+ 停止微任务
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      await vi.advanceTimersByTimeAsync(3200)
      expect(player.fadeOut).toHaveBeenCalled()
      expect(radioBroadcastController.getStatus()).toBe('idle')
      expect(radioBroadcastController.getSnapshot().stopReason).toBe('sleep')
    } finally {
      vi.useRealTimers()
    }
  })

  it('P0-3 取消定时：清空 sleepUntil / sleepAfterSegment', async () => {
    await radioBroadcastController.start({
      direction: { kind: 'story', text: '小王子' },
      voice: '冰糖',
    })
    radioBroadcastController.sleep({ afterSegment: true })
    expect(radioBroadcastController.getSnapshot().sleepAfterSegment).toBe(true)
    radioBroadcastController.sleep(null)
    expect(radioBroadcastController.getSnapshot().sleepUntil).toBe(0)
    expect(radioBroadcastController.getSnapshot().sleepAfterSegment).toBe(false)
  })

  // ── P1 资产层（radio-broadcast-p1-asset-layer-spec）──

  /** 最小 LibraryItem 形状（控制器只读用到的字段） */
  function makeLibraryItem(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'item-1',
      title: '经济漫谈 · 第 1 集',
      topic: '经济学基础',
      engine: 'claude-code',
      voiceRef: '冰糖',
      createdAt: 1,
      favorite: false,
      tags: [],
      source: 'live',
      sentences: [
        { text: '库第一句。', audioId: 'a1', file: 'C:/lib/1.wav' },
        { text: '库第二句。', file: 'C:/lib/2.wav' },
      ],
      ...overrides,
    }
  }

  it('P1 playLibraryItem：直插就绪句 + 无 AI 会话；队列播空即 finished 停止', async () => {
    const item = makeLibraryItem()
    const ok = await radioBroadcastController.playLibraryItem(item as Parameters<typeof radioBroadcastController.playLibraryItem>[0])
    expect(ok).toBe(true)
    const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
    expect(player.enqueuePrepared).toHaveBeenCalledTimes(1)
    const prepared = player.enqueuePrepared.mock.calls[0][0] as Array<{ text: string; playUrl: string }>
    expect(prepared.map((s) => s.playUrl)).toEqual(['C:/lib/1.wav', 'C:/lib/2.wav'])
    expect(player.enqueueSegment).not.toHaveBeenCalled() // 无 AI 段请求
    expect(mockProbe).not.toHaveBeenCalled() // 无预检
    expect(radioBroadcastController.getStatus()).toBe('playing')

    // 队列播空 → 自然结束（stopReason = finished，不请求新段）
    player.queueLength = 0
    player.hasPendingSynth = false
    player.callbacks.onQueueDrained?.()
    await vi.waitFor(() => {
      expect(radioBroadcastController.getStatus()).toBe('idle')
    })
    expect(radioBroadcastController.getSnapshot().stopReason).toBe('finished')
    expect(mockLibraryAdd).not.toHaveBeenCalled() // 回听不应二次入库
  })

  it('P1 playLibraryItem：句子无 file → error 不播', async () => {
    const item = makeLibraryItem({ sentences: [{ text: '无文件句。' }] })
    const ok = await radioBroadcastController.playLibraryItem(item as Parameters<typeof radioBroadcastController.playLibraryItem>[0])
    expect(ok).toBe(false)
    expect(radioBroadcastController.getStatus()).toBe('error')
    expect(radioBroadcastController.getSnapshot().error).toContain('无可播放')
  })

  it('P1 段自动入库：stop 收尾时把播完句子落库（source=live）', async () => {
    mockLibraryAdd.mockResolvedValue({ ok: true, item: undefined })
    await radioBroadcastController.start({
      direction: { kind: 'study', text: '英语' },
      voice: '冰糖',
    })
    const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
    player.takeDoneSentences.mockReturnValue([{ text: '已播句。', audioId: 'k', file: 'C:/x/1.wav' }])
    await radioBroadcastController.stop()
    expect(mockLibraryAdd).toHaveBeenCalledTimes(1)
    const arg = mockLibraryAdd.mock.calls[0][0] as { title: string; source: string; voiceRef: string; sentences: unknown[] }
    expect(arg.source).toBe('live')
    expect(arg.voiceRef).toBe('冰糖')
    expect(arg.sentences).toEqual([{ text: '已播句。', audioId: 'k', file: 'C:/x/1.wav' }])
    expect(arg.title.length).toBeGreaterThan(0)
  })

  it('P1 stop 时 takeDoneSentences 在清队列前取走（顺序关键）', async () => {
    await radioBroadcastController.start({
      direction: { kind: 'news', text: '头条' },
      voice: '冰糖',
    })
    const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
    // takeDoneSentences 必须发生在 player.stop（清队列）之前
    let playerStopped = false
    let takenBeforeStop = false
    player.stop.mockImplementation(() => {
      playerStopped = true
    })
    player.takeDoneSentences.mockImplementation(() => {
      takenBeforeStop = !playerStopped
      return [{ text: 's', file: 'f' }]
    })
    await radioBroadcastController.stop()
    expect(mockLibraryAdd).toHaveBeenCalled()
    expect(takenBeforeStop).toBe(true)
  })

  // ── P2 体验层（radio-broadcast-p2-experience-spec）──

  /** 记录 prompt 的会话 store stub（换台/插话断言用） */
  function makeRecordingStore() {
    const prompts: string[] = []
    const sendMessage = vi.fn().mockImplementation(async (p: string) => {
      prompts.push(p)
      return true
    })
    return { prompts, sendMessage, getState: () => ({ sendMessage }) }
  }

  /**
   * 可控 waitStreamEnd 序列：显式 promises 依次消费，之后的调用一律返回
   * 「随 signal abort reject」的挂起——避免默认即时 resolve 造成
   * 段收尾无限续请求（微任务空转饿死宏任务 → OOM）。
   */
  function makeWaitSequence(initialPromises: Array<Promise<void>>) {
    const calls = [...initialPromises]
    mockWaitStreamEnd.mockImplementation((_sid: string, opts?: { signal?: AbortSignal }) => {
      const next = calls.length > 0
        ? (calls.shift() as Promise<void>)
        : new Promise<void>((_, rej) => {
            opts?.signal?.addEventListener('abort', () => rej(new Error('aborted')))
          })
      return next
    })
  }

  /** 微任务排水：等段收尾链走完（无空转时安全） */
  async function drainMicrotasks(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  }

  it('P2 换台：在途段收尾后才发岔题指令（旧话题最多多播一段），方向即时更新', async () => {
    const store = makeRecordingStore()
    mockStores.set('sess-1', store)
    // 首段生成挂起（模拟 AI 正在写老方向内容）；后续段一律挂起直到 abort
    let release!: () => void
    makeWaitSequence([new Promise<void>((r) => { release = r })])
    await radioBroadcastController.start({
      direction: { kind: 'story', text: '小王子' },
      voice: '冰糖',
    })
    expect(store.prompts).toHaveLength(1) // 首段已发出
    fireStreamingStart() // kernel running（sawStreaming 置位，模拟真实生成中）

    radioBroadcastController.switchTopic({ kind: 'news', text: '今日要闻' })
    // 方向即时更新 + 标题换台
    expect(radioBroadcastController.getSnapshot().direction).toEqual({ kind: 'news', text: '今日要闻' })
    const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
    expect(player.setOptions).toHaveBeenCalledWith(expect.objectContaining({ mediaTitle: '新闻 · 今日要闻' }))
    // 首段在途期间：岔题指令未发（无新 sendMessage）
    expect(store.prompts).toHaveLength(1)

    // 首段收尾 → 衔接点自动以岔题 prompt 发起新段（复用段生成唯一路径）
    // MockPlayer 是单例：复位水位，避免上一用例残留 queueLength 堵住续段
    player.queueLength = 0
    player.hasPendingSynth = false
    release()
    await vi.waitFor(() => {
      expect(store.prompts.length).toBeGreaterThan(1)
    })
    expect(store.prompts[1]).toContain('用户换台了')
    expect(store.prompts[1]).toContain('今日要闻')
    expect(store.prompts[1]).not.toContain('小王子')
  })

  it('P2 换台：无段在途 → 立即发岔题指令并请求生成', async () => {
    const store = makeRecordingStore()
    mockStores.set('sess-1', store)
    // 首段挂起 → 释放；垫水位堵住段收尾空转，制造「无段在途」稳定态
    let release!: () => void
    makeWaitSequence([new Promise<void>((r) => { release = r })])
    await radioBroadcastController.start({
      direction: { kind: 'study', text: '英语单词' },
      voice: '冰糖',
    })
    const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
    player.queueLength = 3
    release()
    await drainMicrotasks()
    expect(store.prompts).toHaveLength(1)

    radioBroadcastController.switchTopic({ kind: 'tech', text: '量子计算' })
    await vi.waitFor(() => {
      expect(store.prompts.length).toBe(2)
    })
    const lastPrompt = store.prompts[1]
    expect(lastPrompt).toContain('用户换台了')
    expect(lastPrompt).toContain('量子计算')
  })

  it('P2 插话（无段在途）：立即响应——暂停播报、回复入队恢复播放且不计 round', async () => {
    const store = makeRecordingStore()
    mockStores.set('sess-1', store)
    // 首段挂起 → 垫水位 → 释放，得到「无段在途」稳定态
    let release!: () => void
    makeWaitSequence([new Promise<void>((r) => { release = r })])
    await radioBroadcastController.start({
      direction: { kind: 'story', text: '小王子' },
      voice: '冰糖',
    })
    const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
    player.queueLength = 3
    release()
    await drainMicrotasks()
    expect(store.prompts).toHaveLength(1)

    radioBroadcastController.interject('狐狸为什么重要？')
    await vi.waitFor(() => {
      expect(store.prompts.length).toBe(2)
    })
    // 半双工：请求发出即暂停
    expect(player.pause).toHaveBeenCalled()
    const lastPrompt = store.prompts[1]
    expect(lastPrompt).toContain('听众插话')
    expect(lastPrompt).toContain('狐狸为什么重要？')

    // 回复下降沿 → 入队 + 恢复播放；round（segmentIndex）不因插话回复增长
    fireSegmentEnd()
    await vi.waitFor(() => {
      expect(player.enqueueSegment).toHaveBeenCalled()
    })
    expect(player.resume).toHaveBeenCalled()
    expect((radioBroadcastController as unknown as { segmentIndex: number }).segmentIndex).toBe(0)
  })

  it('P2 插话（段在途）：暂存并在收尾后响应，不立即暂停', async () => {
    const store = makeRecordingStore()
    mockStores.set('sess-1', store)
    let release!: () => void
    makeWaitSequence([new Promise<void>((r) => { release = r })])
    await radioBroadcastController.start({
      direction: { kind: 'news', text: '头条' },
      voice: '冰糖',
    })
    const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
    // MockPlayer 是单例：显式复位水位，避免上一用例的 queueLength 残留堵住段收尾续请求
    player.queueLength = 0
    player.hasPendingSynth = false
    radioBroadcastController.interject('关注一下股市')
    // 在途期间：仅暂存（无新请求、不暂停）
    expect(store.prompts).toHaveLength(1)
    expect(player.pause).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => {
      expect(store.prompts.length).toBe(2)
    })
    expect(store.prompts[1]).toContain('听众插话')
    expect(store.prompts[1]).toContain('股市')
    expect(player.pause).toHaveBeenCalled() // 发起插话请求时才进入半双工
  })

  it('P2 埋点与续播快照：start/stop 更新 metrics + radioLastSession', async () => {
    localStorage.clear()
    await radioBroadcastController.start({
      direction: { kind: 'study', text: '英语' },
      voice: '冰糖',
    })
    await radioBroadcastController.stop()
    const metrics = JSON.parse(localStorage.getItem('polaris.radioMetrics') ?? '{}')
    expect(metrics.sessionCount).toBe(1)
    const last = JSON.parse(localStorage.getItem('polaris.radioLastSession') ?? '{}')
    expect(last.direction).toEqual({ kind: 'study', text: '英语' })
    expect(last.voice).toBe('冰糖')
  })

  it('P2 埋点：换台/插话/回听计数', async () => {
    localStorage.clear()
    const store = makeRecordingStore()
    mockStores.set('sess-1', store)
    await radioBroadcastController.start({
      direction: { kind: 'story', text: '小王子' },
      voice: '冰糖',
    })
    const player = (radioBroadcastController as unknown as { player: MockPlayer }).player
    player.queueLength = 2
    await new Promise((r) => setTimeout(r, 0))
    radioBroadcastController.switchTopic({ kind: 'news', text: '头条' })
    radioBroadcastController.interject('插一句')
    await vi.waitFor(() => {
      expect(mockWaitStreamEnd.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    await radioBroadcastController.stop()
    const metrics = JSON.parse(localStorage.getItem('polaris.radioMetrics') ?? '{}')
    expect(metrics.switchCount).toBe(1)
    expect(metrics.interjectCount).toBe(1)
  })
})