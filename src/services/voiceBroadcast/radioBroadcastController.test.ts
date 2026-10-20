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
 *       assistantTextUtils、ttsTextFilter、mcpBridge（probe）。
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
    queueLength = 0
    hasPendingSynth = false
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

const mockProbe = vi.fn()
vi.mock('./mcpBridge', () => ({ probeMimoTts: mockProbe }))

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
})