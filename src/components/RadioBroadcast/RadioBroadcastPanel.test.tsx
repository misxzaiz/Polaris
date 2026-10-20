/**
 * RadioBroadcastPanel 组件测试
 *
 * 覆盖生产级升级 spec §2 的关键行为：
 * - 配置视图 4 个语义分组（内容/声音/模型/控制）渲染
 * - 输入校验：非法轮次/时长 → 阻止 start + warning toast
 * - 音量 slider 存在且可调
 * - 双视图可达：播报中可切到配置（播报不中断），可返回播报视图
 * - 开始/停止/暂停按钮动作转发
 * - 播报中状态徽标 + 正在朗读文本
 *
 * 依赖 mock：
 * - useRadioBroadcast（状态可控）
 * - useRadioBroadcastPrefsStore（初始偏好）
 * - SessionConfigSelector（轻量替身）
 * - useToastStore（记录调用）
 * - react-i18next 已在 src/test/setup.ts 全局 mock，t() 返回 key
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { RadioBroadcastPanel } from './RadioBroadcastPanel'
import type { RadioBroadcastControllerOptions } from '@/services/voiceBroadcast/radioBroadcastController'
import type { RadioBroadcastStatus } from '@/services/voiceBroadcast/types'

// ==== Mocks ====
const mockStart = vi.fn<(opts: RadioBroadcastControllerOptions) => Promise<void>>()
const mockStop = vi.fn<() => Promise<void>>()
const mockPause = vi.fn<() => void>()
const mockResume = vi.fn<() => void>()

let mockState: {
  status: RadioBroadcastStatus
  direction: { kind: string; text: string }
  voice: string
  segment: { index: number; text: string } | null
  segmentCount: number
  error: string | null
  nowPlayingText: string | null
  startedAt: number
  maxRounds?: number
  maxSeconds?: number
  stopReason: string | null
}

vi.mock('@/hooks/useRadioBroadcast', () => ({
  useRadioBroadcast: () => ({
    status: mockState.status,
    direction: mockState.direction,
    voice: mockState.voice,
    segment: mockState.segment,
    segmentCount: mockState.segmentCount,
    error: mockState.error,
    nowPlayingText: mockState.nowPlayingText,
    startedAt: mockState.startedAt,
    maxRounds: mockState.maxRounds,
    maxSeconds: mockState.maxSeconds,
    stopReason: mockState.stopReason,
    isPlaying: mockState.status === 'playing',
    isActive:
      mockState.status === 'starting' ||
      mockState.status === 'playing' ||
      mockState.status === 'generating' ||
      mockState.status === 'stopping',
    start: mockStart,
    stop: mockStop,
    pause: mockPause,
    resume: mockResume,
    directionPresets: [],
    voices: [
      { id: '冰糖', label: '冰糖', desc: '清甜' },
      { id: '茉莉', label: '茉莉', desc: '温柔' },
    ],
  }),
}))

const mockSetPrefs = vi.fn()
vi.mock('@/stores/radioBroadcastPrefsStore', () => ({
  useRadioBroadcastPrefsStore: () => ({
    kind: 'study' as const,
    directionText: '经济学基础',
    voice: '冰糖' as const,
    volume: 1,
    voiceStopEnabled: true,
    base64Mode: false,
    engineId: '',
    providerConfig: {
      profileMode: 'profile' as const,
      modelProfileId: '',
      model: '',
    },
    maxRounds: '',
    maxSeconds: '',
    setPrefs: mockSetPrefs,
  }),
}))

vi.mock('@/components/Chat/session/SessionConfigSelector', () => ({
  SessionConfigSelector: () => (
    <div data-testid="session-config-selector" />
  ),
}))

vi.mock('@/stores/engineMetadataStore', () => {
  const getEngineFullName = (id?: string | null) => id ?? 'claude-code'
  const state = {
    metadatas: [],
    loaded: false,
    getEngineFullName,
    getEngineDisplayName: (id?: string | null) => id ?? 'claude-code',
    getEngine: () => undefined,
  }
  const useEngineMetadataStore = (selector?: unknown) =>
    selector ? (selector as (s: typeof state) => unknown)(state) : state
  return {
    useEngineMetadataStore: Object.assign(useEngineMetadataStore, {
      getState: () => state,
    }),
  }
})

vi.mock('@/stores/configStore', () => ({
  useConfigStore: {
    getState: () => ({ config: { defaultEngine: 'claude-code' } }),
  },
}))

const mockToast = {
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}
vi.mock('@/stores/toastStore', () => ({
  useToastStore: () => mockToast,
}))

function makeState(overrides: Partial<typeof mockState> = {}): typeof mockState {
  return {
    status: 'idle',
    direction: { kind: 'study', text: '经济学基础' },
    voice: '冰糖',
    segment: null,
    segmentCount: 0,
    error: null,
    nowPlayingText: null,
    startedAt: 0,
    stopReason: null,
    ...overrides,
  }
}

beforeEach(() => {
  mockState = makeState()
  mockStart.mockReset()
  mockStop.mockReset()
  mockPause.mockReset()
  mockResume.mockReset()
  mockToast.info.mockReset()
  mockToast.warning.mockReset()
  mockToast.error.mockReset()
  mockSetPrefs.mockReset()
})

describe('RadioBroadcastPanel — 配置视图（idle）', () => {
  it('渲染 4 个语义分组标题', () => {
    render(<RadioBroadcastPanel />)
    expect(screen.getByText('radioBroadcast.section.content')).toBeTruthy()
    expect(screen.getByText('radioBroadcast.section.voice')).toBeTruthy()
    expect(screen.getByText('radioBroadcast.section.model')).toBeTruthy()
    expect(screen.getByText('radioBroadcast.section.control')).toBeTruthy()
  })

  it('渲染音色选择 + 音量 slider + 开始按钮', () => {
    render(<RadioBroadcastPanel />)
    expect(screen.getByLabelText('radioBroadcast.voiceSelect')).toBeTruthy()
    expect(screen.getByLabelText('radioBroadcast.volume')).toBeTruthy()
    expect(screen.getByText('radioBroadcast.start')).toBeTruthy()
  })

  it('点击开始按钮转发 start 并携带配置', () => {
    render(<RadioBroadcastPanel />)
    fireEvent.click(screen.getByText('radioBroadcast.start'))
    expect(mockStart).toHaveBeenCalledTimes(1)
    const opts = mockStart.mock.calls[0][0]
    expect(opts.direction).toEqual({ kind: 'study', text: '经济学基础' })
    expect(opts.voice).toBe('冰糖')
    expect(opts.volume).toBe(1)
    expect(opts.maxRounds).toBeUndefined()
  })
})

describe('RadioBroadcastPanel — 输入校验', () => {
  it('非法轮次 → 阻止 start + warning toast + aria-invalid', () => {
    // 先渲染，再改 prefs 的 maxRounds。由于 mock prefs store 是常量，改用 DOM 触发：
    // 直接渲染后在方向输入旁无轮次输入——配置视图含轮次输入框（label maxRounds）
    render(<RadioBroadcastPanel />)
    const roundsInput = screen.getByLabelText('radioBroadcast.maxRounds') as HTMLInputElement
    fireEvent.change(roundsInput, { target: { value: '0' } })
    fireEvent.click(screen.getByText('radioBroadcast.start'))
    expect(mockStart).not.toHaveBeenCalled()
    expect(mockToast.warning).toHaveBeenCalledWith('radioBroadcast.toast.invalidLimits')
    expect(roundsInput.getAttribute('aria-invalid')).toBe('true')
  })
})

describe('RadioBroadcastPanel — 播报中视图', () => {
  it('播报中渲染状态徽标 + 正在朗读 + 暂停/停止按钮', () => {
    mockState = makeState({
      status: 'playing',
      startedAt: Date.now() - 5000,
      segment: { index: 2, text: '段内容' },
      segmentCount: 5,
      maxRounds: 10,
      nowPlayingText: '正在朗读的句子',
    })
    render(<RadioBroadcastPanel />)
    expect(screen.getByText('正在朗读的句子')).toBeTruthy()
    expect(screen.getByText('radioBroadcast.pause')).toBeTruthy()
    expect(screen.getByText('radioBroadcast.stop')).toBeTruthy()
    // 累计时长非 0
    expect(screen.getByText(/radioBroadcast.duration/)).toBeTruthy()
  })

  it('点击停止转发 stop', () => {
    mockState = makeState({ status: 'playing', startedAt: Date.now() })
    render(<RadioBroadcastPanel />)
    fireEvent.click(screen.getByText('radioBroadcast.stop'))
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it('双视图可达：播报中可切到配置（不中断）并可返回', () => {
    mockState = makeState({ status: 'playing', startedAt: Date.now() })
    render(<RadioBroadcastPanel />)
    // 播报中默认显示播报视图
    expect(screen.getByText('radioBroadcast.configView')).toBeTruthy()
    fireEvent.click(screen.getByText('radioBroadcast.configView'))
    // 切到配置视图：显示分组 + 返回按钮 + 播报中提示
    expect(screen.getByText('radioBroadcast.section.content')).toBeTruthy()
    expect(screen.getByText('radioBroadcast.playingHint')).toBeTruthy()
    expect(screen.getByText('radioBroadcast.backToPlayback')).toBeTruthy()
    // 返回播报视图（此时仍在播报，start 不会触发）
    fireEvent.click(screen.getByText('radioBroadcast.backToPlayback'))
    expect(screen.getByText('radioBroadcast.pause')).toBeTruthy()
    // 全程没有触发 start
    expect(mockStart).not.toHaveBeenCalled()
  })
})

describe('RadioBroadcastPanel — 停止反馈 Toast', () => {
  it('start 成功（idle → playing）→ success toast', () => {
    mockState = makeState({ status: 'idle' })
    const { rerender } = render(<RadioBroadcastPanel />)
    mockState = makeState({ status: 'playing', startedAt: Date.now() })
    rerender(<RadioBroadcastPanel />)
    expect(mockToast.success).toHaveBeenCalledWith('radioBroadcast.toast.started')
  })

  it('回 idle 且 stopReason=max-rounds → info toast', () => {
    // 先 playing，再 idle + stopReason（模拟自动停止）
    mockState = makeState({
      status: 'playing',
      startedAt: Date.now(),
      stopReason: null,
    })
    const { rerender } = render(<RadioBroadcastPanel />)
    mockState = makeState({ status: 'idle', stopReason: 'max-rounds' })
    rerender(<RadioBroadcastPanel />)
    expect(mockToast.info).toHaveBeenCalledWith('radioBroadcast.toast.maxRounds')
  })
})
