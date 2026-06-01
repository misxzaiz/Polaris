/**
 * ComicStudio Store — 漫画/漫剧工作室状态管理
 *
 * 管理管线执行状态、UI 模式（面板/全屏）、当前视图切换。
 */

import { create } from 'zustand'
import type {
  PipelinePhase,
  PipelinePhaseInfo,
} from '@/ai-runtime'
import type {
  ComicPipelineConfig,
  ComicScript,
  CharacterDesign,
  StoryboardPanel,
  AnimationClip,
  PipelineArtifact,
} from '@/engines/agnes/comic-pipeline'

/** ComicStudio 视图模式 */
export type ComicStudioView = 'script' | 'characters' | 'storyboard' | 'animation' | 'output'

/** ComicStudio 显示模式 */
export type ComicStudioDisplayMode = 'panel' | 'fullscreen'

/** ComicStudio 状态接口 */
interface ComicStudioState {
  // ---- UI 状态 ----
  /** 显示模式 */
  displayMode: ComicStudioDisplayMode
  /** 当前活跃视图 */
  activeView: ComicStudioView
  /** 是否显示配置面板 */
  showConfig: boolean
  /** 侧边栏宽度 */
  sidebarWidth: number

  // ---- 管线状态 ----
  /** 是否正在运行 */
  isRunning: boolean
  /** 管线阶段列表 */
  phases: PipelinePhaseInfo[]
  /** 当前活跃阶段 */
  activePhase: PipelinePhase | null
  /** 全局进度 */
  overallProgress: number
  /** 管线状态 */
  pipelineStatus: 'idle' | 'running' | 'completed' | 'failed' | 'aborted'
  /** 最后一次错误消息（引擎不可用等场景） */
  lastError: string | null

  // ---- 管线配置 ----
  config: ComicPipelineConfig

  // ---- 产物 ----
  script: ComicScript | null
  characterDesigns: CharacterDesign[]
  storyboards: StoryboardPanel[]
  animationClips: AnimationClip[]
  artifacts: PipelineArtifact[]

  // ---- 输入 ----
  storyIdea: string
  sessionId: string | null
  taskId: string | null

  // ---- 操作 ----
  /** 切换显示模式 */
  toggleDisplayMode: () => void
  setDisplayMode: (mode: ComicStudioDisplayMode) => void
  /** 切换活跃视图 */
  setActiveView: (view: ComicStudioView) => void
  /** 切换配置面板 */
  toggleConfig: () => void
  setSidebarWidth: (width: number) => void

  /** 设置故事想法 */
  setStoryIdea: (idea: string) => void
  /** 更新管线配置 */
  updateConfig: (partial: Partial<ComicPipelineConfig>) => void

  /** 开始管线 */
  startPipeline: (sessionId: string, taskId: string) => void
  /** 更新阶段状态 */
  updatePhase: (phase: PipelinePhaseInfo) => void
  /** 更新全局进度 */
  updateProgress: (progress: number, currentPhase: PipelinePhase, message: string) => void
  /** 完成管线 */
  completePipeline: (artifacts: PipelineArtifact[]) => void
  /** 管线失败 */
  failPipeline: (error: string, failedPhase: PipelinePhase) => void
  /** 中止管线 */
  abortPipeline: () => void

  /** 添加角色设计 */
  addCharacterDesign: (design: CharacterDesign) => void
  /** 添加分镜 */
  addStoryboard: (panel: StoryboardPanel) => void
  /** 添加动画片段 */
  addAnimationClip: (clip: AnimationClip) => void
  /** 设置剧本 */
  setScript: (script: ComicScript) => void

  /** 重置状态 */
  reset: () => void
}

const defaultConfig: ComicPipelineConfig = {
  comicStyle: 'japanese_manga',
  pageLayout: 'manga_flow',
  panelsPerPage: 4,
  outputFormat: 'both',
  includeAnimation: true,
  animationDuration: 3,
}

const initialState = {
  displayMode: 'panel' as ComicStudioDisplayMode,
  activeView: 'script' as ComicStudioView,
  showConfig: true,
  sidebarWidth: 280,
  isRunning: false,
  phases: [] as PipelinePhaseInfo[],
  activePhase: null as PipelinePhase | null,
  overallProgress: 0,
  pipelineStatus: 'idle' as const,
  lastError: null as string | null,
  config: { ...defaultConfig },
  script: null,
  characterDesigns: [] as CharacterDesign[],
  storyboards: [] as StoryboardPanel[],
  animationClips: [] as AnimationClip[],
  artifacts: [] as PipelineArtifact[],
  storyIdea: '',
  sessionId: null as string | null,
  taskId: null as string | null,
}

export const useComicStudioStore = create<ComicStudioState>((set, get) => ({
  ...initialState,

  toggleDisplayMode: () => {
    const current = get().displayMode
    set({ displayMode: current === 'panel' ? 'fullscreen' : 'panel' })
  },
  setDisplayMode: (mode) => set({ displayMode: mode }),
  setActiveView: (view) => set({ activeView: view }),
  toggleConfig: () => set((s) => ({ showConfig: !s.showConfig })),
  setSidebarWidth: (width) => set({ sidebarWidth: Math.max(220, Math.min(400, width)) }),
  setStoryIdea: (idea) => set({ storyIdea: idea }),
  updateConfig: (partial) => set((s) => ({ config: { ...s.config, ...partial } })),

  startPipeline: (sessionId, taskId) => set({
    isRunning: true,
    pipelineStatus: 'running',
    overallProgress: 0,
    sessionId,
    taskId,
    script: null,
    characterDesigns: [],
    storyboards: [],
    animationClips: [],
    artifacts: [],
  }),

  updatePhase: (phase) => set((s) => {
    const idx = s.phases.findIndex(p => p.phase === phase.phase)
    const newPhases = [...s.phases]
    if (idx >= 0) {
      newPhases[idx] = phase
    } else {
      newPhases.push(phase)
    }
    return {
      phases: newPhases,
      activePhase: phase.status === 'in_progress' ? phase.phase : s.activePhase,
    }
  }),

  updateProgress: (progress, currentPhase, _message) => set({
    overallProgress: progress,
    activePhase: currentPhase,
  }),

  completePipeline: (artifacts) => set({
    isRunning: false,
    pipelineStatus: 'completed',
    overallProgress: 100,
    activePhase: null,
    artifacts,
    activeView: 'output',
  }),

  failPipeline: (error, failedPhase) => set((s) => {
    // 如果 phases 为空（引擎尚未启动即失败），构造一个失败阶段用于显示
    if (s.phases.length === 0) {
      return {
        isRunning: false,
        pipelineStatus: 'failed' as const,
        activePhase: null,
        lastError: error,
        phases: [{
          phase: failedPhase,
          status: 'failed' as const,
          progress: 0,
          message: error,
        }],
      }
    }
    return {
      isRunning: false,
      pipelineStatus: 'failed' as const,
      activePhase: null,
      lastError: error,
      phases: s.phases.map(p =>
        p.phase === failedPhase ? { ...p, status: 'failed' as const, message: error } : p
      ),
    }
  }),

  abortPipeline: () => set({
    isRunning: false,
    pipelineStatus: 'aborted',
    activePhase: null,
  }),

  addCharacterDesign: (design) => set((s) => ({
    characterDesigns: [...s.characterDesigns, design],
  })),
  addStoryboard: (panel) => set((s) => ({
    storyboards: [...s.storyboards, panel],
  })),
  addAnimationClip: (clip) => set((s) => ({
    animationClips: [...s.animationClips, clip],
  })),
  setScript: (script) => set({ script }),

  reset: () => set({ ...initialState, config: { ...defaultConfig } }),
}))
