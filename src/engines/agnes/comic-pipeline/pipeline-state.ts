/**
 * ComicPipeline — 管线状态机
 *
 * 管理漫画/漫剧生成的阶段流转和进度追踪。
 */

import type { PipelinePhase, PipelinePhaseInfo } from '@/ai-runtime'
import { PIPELINE_PHASES } from './types'

/** 管线状态 */
export interface PipelineState {
  /** 各阶段信息 */
  phases: Map<PipelinePhase, PipelinePhaseInfo>
  /** 全局进度 0-100 */
  overallProgress: number
  /** 当前活跃阶段 */
  activePhase: PipelinePhase | null
  /** 管线状态 */
  status: 'idle' | 'running' | 'completed' | 'failed' | 'aborted'
  /** 阶段产物 */
  artifacts: string[]
}

/**
 * 创建初始管线状态
 */
export function createInitialState(): PipelineState {
  const phases = new Map<PipelinePhase, PipelinePhaseInfo>()

  for (const phase of PIPELINE_PHASES) {
    phases.set(phase, {
      phase,
      status: 'pending',
      progress: 0,
    })
  }

  return {
    phases,
    overallProgress: 0,
    activePhase: null,
    status: 'idle',
    artifacts: [],
  }
}

/** 每个阶段的权重（影响全局进度计算） */
const PHASE_WEIGHTS: Record<PipelinePhase, number> = {
  script: 15,
  character: 20,
  storyboard: 30,
  animation: 25,
  finalize: 10,
}

/**
 * 计算全局进度
 */
export function calculateOverallProgress(phases: Map<PipelinePhase, PipelinePhaseInfo>): number {
  let total = 0
  let completedWeight = 0

  for (const [phase, info] of phases) {
    const weight = PHASE_WEIGHTS[phase]
    total += weight

    if (info.status === 'completed') {
      completedWeight += weight
    } else if (info.status === 'in_progress') {
      completedWeight += weight * (info.progress / 100)
    }
  }

  return total > 0 ? Math.round((completedWeight / total) * 100) : 0
}

/**
 * 阶段推进 — 标记阶段开始
 */
export function startPhase(
  state: PipelineState,
  phase: PipelinePhase,
  message?: string,
): PipelinePhaseInfo {
  const info = state.phases.get(phase)
  if (!info) throw new Error(`Unknown phase: ${phase}`)

  info.status = 'in_progress'
  info.progress = 0
  info.message = message
  state.activePhase = phase
  state.status = 'running'

  return { ...info }
}

/**
 * 阶段推进 — 更新阶段进度
 */
export function updatePhaseProgress(
  state: PipelineState,
  phase: PipelinePhase,
  progress: number,
  message?: string,
): PipelinePhaseInfo {
  const info = state.phases.get(phase)
  if (!info) throw new Error(`Unknown phase: ${phase}`)

  info.progress = Math.min(100, Math.max(0, progress))
  if (message) info.message = message
  state.overallProgress = calculateOverallProgress(state.phases)

  return { ...info }
}

/**
 * 阶段推进 — 标记阶段完成
 */
export function completePhase(
  state: PipelineState,
  phase: PipelinePhase,
  artifacts?: string[],
): PipelinePhaseInfo {
  const info = state.phases.get(phase)
  if (!info) throw new Error(`Unknown phase: ${phase}`)

  info.status = 'completed'
  info.progress = 100
  if (artifacts) {
    info.artifacts = artifacts
    state.artifacts.push(...artifacts)
  }
  state.overallProgress = calculateOverallProgress(state.phases)

  return { ...info }
}

/**
 * 阶段推进 — 标记阶段失败
 */
export function failPhase(
  state: PipelineState,
  phase: PipelinePhase,
  error: string,
): PipelinePhaseInfo {
  const info = state.phases.get(phase)
  if (!info) throw new Error(`Unknown phase: ${phase}`)

  info.status = 'failed'
  info.message = error
  state.status = 'failed'
  state.activePhase = null

  return { ...info }
}

/**
 * 完成整个管线
 */
export function completePipeline(state: PipelineState): void {
  state.status = 'completed'
  state.activePhase = null
  state.overallProgress = 100
}

/**
 * 中止管线
 */
export function abortPipeline(state: PipelineState): void {
  state.status = 'aborted'
  state.activePhase = null
}

/**
 * 获取下一个待执行的阶段
 */
export function getNextPendingPhase(state: PipelineState): PipelinePhase | null {
  for (const phase of PIPELINE_PHASES) {
    const info = state.phases.get(phase)
    if (info?.status === 'pending') {
      return phase
    }
  }
  return null
}
