import { invoke } from './transport'

export type LongGoalStatus =
  | 'planning'
  | 'active'
  | 'running'
  | 'paused'
  | 'maintenance'
  | 'blocked'
  | 'completed'
  | 'failed'

export type LongGoalPhase = 'planning' | 'execution' | 'maintenance' | 'review'

export interface LongGoalConfig {
  id: string
  title: string
  goal: string
  status: LongGoalStatus
  phase: LongGoalPhase
  workspacePath: string
  engineId: string
  triggerMode: string
  interval: string
  retryCount: number
  maxRetries: number
  retryBackoff: string
  autoPauseOnComplete: boolean
  allowCodeChanges: boolean
  allowGitCommit: boolean
  currentStepId?: string
  currentSessionId?: string
  lastSessionId?: string
  nextRunAt?: number
  lastFailureAt?: number
  revision: number
  createdAt: number
  updatedAt: number
}

export interface CreateLongGoalParams {
  title: string
  goal: string
  workspacePath: string
  engineId: string
  interval?: string
  maxRetries?: number
  retryBackoff?: string
  autoPauseOnComplete?: boolean
  allowCodeChanges?: boolean
  allowGitCommit?: boolean
}

export interface LongGoalDocuments {
  protocol: string
  plan: string
  progress: string
  queue: string
  supplement: string
  lastSessionSummary?: string
}

export interface LongGoalState {
  config: LongGoalConfig
  documents: LongGoalDocuments
  goalPath: string
}

export interface AppendLongGoalSupplementParams {
  workspacePath: string
  goalId: string
  content: string
  priority?: string
}

export interface BindLongGoalSessionParams {
  workspacePath: string
  goalId: string
  sessionId: string
  phase: LongGoalPhase
}

export interface FinishLongGoalSessionParams {
  workspacePath: string
  goalId: string
  sessionId: string
  summary: string
  result?: string
  nextStep?: string
  goalStatus?: LongGoalStatus
  retryFailure?: boolean
}

export interface RecordLongGoalStepParams {
  workspacePath: string
  goalId: string
  stepId: string
  summary: string
  changedFiles?: string[]
  testsRun?: string[]
  commitSha?: string
  result?: string
  nextStep?: string
  goalStatus?: LongGoalStatus
  retryFailure?: boolean
}

export interface CompleteLongGoalParams {
  workspacePath: string
  goalId: string
  completionSummary: string
  remainingRisks?: string[]
  reviewSuggestions?: string[]
}

export async function createLongGoal(params: CreateLongGoalParams): Promise<LongGoalState> {
  return invoke<LongGoalState>('long_goal_create', { params })
}

export async function listLongGoals(workspacePath: string): Promise<LongGoalState[]> {
  return invoke<LongGoalState[]>('long_goal_list', { workspacePath })
}

export async function readLongGoal(workspacePath: string, goalId: string): Promise<LongGoalState> {
  return invoke<LongGoalState>('long_goal_read', { workspacePath, goalId })
}

export async function appendLongGoalSupplement(
  params: AppendLongGoalSupplementParams
): Promise<LongGoalState> {
  return invoke<LongGoalState>('long_goal_append_supplement', { params })
}

export async function bindLongGoalSession(
  params: BindLongGoalSessionParams
): Promise<LongGoalState> {
  return invoke<LongGoalState>('long_goal_bind_session', { params })
}

export async function finishLongGoalSession(
  params: FinishLongGoalSessionParams
): Promise<LongGoalState> {
  return invoke<LongGoalState>('long_goal_finish_session', { params })
}

export async function pauseLongGoal(workspacePath: string, goalId: string): Promise<LongGoalState> {
  return invoke<LongGoalState>('long_goal_pause', { workspacePath, goalId })
}

export async function resumeLongGoal(workspacePath: string, goalId: string): Promise<LongGoalState> {
  return invoke<LongGoalState>('long_goal_resume', { workspacePath, goalId })
}

export async function prepareLongGoalPlanning(
  workspacePath: string,
  goalId: string
): Promise<string> {
  return invoke<string>('long_goal_prepare_planning', { workspacePath, goalId })
}

export async function prepareLongGoalExecution(
  workspacePath: string,
  goalId: string
): Promise<string> {
  return invoke<string>('long_goal_prepare_execution', { workspacePath, goalId })
}

export async function recordLongGoalStep(params: RecordLongGoalStepParams): Promise<LongGoalState> {
  return invoke<LongGoalState>('long_goal_record_step', { params })
}

export async function completeLongGoal(params: CompleteLongGoalParams): Promise<LongGoalState> {
  return invoke<LongGoalState>('long_goal_complete', { params })
}

export async function prepareLongGoalMaintenance(
  workspacePath: string,
  goalId: string
): Promise<string> {
  return invoke<string>('long_goal_prepare_maintenance', { workspacePath, goalId })
}
