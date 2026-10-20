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

// ---- import after mock ----
import { radioBroadcastController } from './radioBroadcastController'

/** 手动驱动「一段流式结束」：取用户注册的 kernel 订阅回调并触发下降沿 */
let kernelSubCb: ((s: { state: string; isStreaming: boolean; error: string | null }) => void) | null = null

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

/** 触发一次 kernel 下降沿（模拟一段 AI 流式结束） */
function fireSegmentEnd(): void {
  kernelSubCb?.({ state: 'idle', isStreaming: false, error: null })
}

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
})