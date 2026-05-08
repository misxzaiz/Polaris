import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendLongGoalSupplement,
  bindLongGoalSession,
  completeLongGoal,
  createLongGoal,
  finishLongGoalSession,
  listLongGoals,
  pauseLongGoal,
  prepareLongGoalExecution,
  prepareLongGoalMaintenance,
  prepareLongGoalPlanning,
  readLongGoal,
  recordLongGoalStep,
  resumeLongGoal,
} from './longGoalService'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('./transport', () => ({
  invoke: invokeMock,
}))

describe('longGoalService', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('calls the backend create command', async () => {
    invokeMock.mockResolvedValueOnce({ config: { id: 'goal-1' } })

    await expect(createLongGoal({
      title: 'Goal',
      goal: 'Build long goal executor',
      workspacePath: 'D:\\space\\base\\Polaris',
      engineId: 'codex',
      interval: '30m',
    })).resolves.toEqual({ config: { id: 'goal-1' } })

    expect(invokeMock).toHaveBeenCalledWith('long_goal_create', {
      title: 'Goal',
      goal: 'Build long goal executor',
      workspacePath: 'D:\\space\\base\\Polaris',
      engineId: 'codex',
      interval: '30m',
    })
  })

  it('calls read and state transition commands', async () => {
    invokeMock.mockResolvedValue({ config: { id: 'goal-1' } })

    await listLongGoals('D:\\workspace')
    await readLongGoal('D:\\workspace', 'goal-1')
    await bindLongGoalSession({
      workspacePath: 'D:\\workspace',
      goalId: 'goal-1',
      sessionId: 'session-1',
      phase: 'planning',
    })
    await finishLongGoalSession({
      workspacePath: 'D:\\workspace',
      goalId: 'goal-1',
      sessionId: 'session-1',
      summary: 'Planning completed',
      result: 'success',
    })
    await pauseLongGoal('D:\\workspace', 'goal-1')
    await resumeLongGoal('D:\\workspace', 'goal-1')
    await prepareLongGoalPlanning('D:\\workspace', 'goal-1')
    await prepareLongGoalExecution('D:\\workspace', 'goal-1')
    await prepareLongGoalMaintenance('D:\\workspace', 'goal-1')

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'long_goal_list', {
      workspacePath: 'D:\\workspace',
    })
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'long_goal_read', {
      workspacePath: 'D:\\workspace',
      goalId: 'goal-1',
    })
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'long_goal_bind_session', {
      workspacePath: 'D:\\workspace',
      goalId: 'goal-1',
      sessionId: 'session-1',
      phase: 'planning',
    })
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'long_goal_finish_session', {
      workspacePath: 'D:\\workspace',
      goalId: 'goal-1',
      sessionId: 'session-1',
      summary: 'Planning completed',
      result: 'success',
    })
    expect(invokeMock).toHaveBeenNthCalledWith(5, 'long_goal_pause', {
      workspacePath: 'D:\\workspace',
      goalId: 'goal-1',
    })
    expect(invokeMock).toHaveBeenNthCalledWith(6, 'long_goal_resume', {
      workspacePath: 'D:\\workspace',
      goalId: 'goal-1',
    })
    expect(invokeMock).toHaveBeenNthCalledWith(7, 'long_goal_prepare_planning', {
      workspacePath: 'D:\\workspace',
      goalId: 'goal-1',
    })
    expect(invokeMock).toHaveBeenNthCalledWith(8, 'long_goal_prepare_execution', {
      workspacePath: 'D:\\workspace',
      goalId: 'goal-1',
    })
    expect(invokeMock).toHaveBeenNthCalledWith(9, 'long_goal_prepare_maintenance', {
      workspacePath: 'D:\\workspace',
      goalId: 'goal-1',
    })
  })

  it('calls write-oriented commands', async () => {
    invokeMock.mockResolvedValue({ config: { id: 'goal-1' } })

    await appendLongGoalSupplement({
      workspacePath: 'D:\\workspace',
      goalId: 'goal-1',
      content: 'Please prioritize tests',
      priority: 'high',
    })
    await recordLongGoalStep({
      workspacePath: 'D:\\workspace',
      goalId: 'goal-1',
      stepId: 'step-1',
      summary: 'Implemented document service',
      changedFiles: ['src-tauri/src/services/long_goal_service.rs'],
      testsRun: ['cargo test --lib long_goal_service --no-run'],
      commitSha: 'abc123',
      result: 'success',
      nextStep: 'Build UI',
    })
    await completeLongGoal({
      workspacePath: 'D:\\workspace',
      goalId: 'goal-1',
      completionSummary: 'Goal completed',
      remainingRisks: ['Needs review'],
      reviewSuggestions: ['Run full app'],
    })

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'long_goal_append_supplement', {
      workspacePath: 'D:\\workspace',
      goalId: 'goal-1',
      content: 'Please prioritize tests',
      priority: 'high',
    })
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'long_goal_record_step', {
      workspacePath: 'D:\\workspace',
      goalId: 'goal-1',
      stepId: 'step-1',
      summary: 'Implemented document service',
      changedFiles: ['src-tauri/src/services/long_goal_service.rs'],
      testsRun: ['cargo test --lib long_goal_service --no-run'],
      commitSha: 'abc123',
      result: 'success',
      nextStep: 'Build UI',
    })
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'long_goal_complete', {
      workspacePath: 'D:\\workspace',
      goalId: 'goal-1',
      completionSummary: 'Goal completed',
      remainingRisks: ['Needs review'],
      reviewSuggestions: ['Run full app'],
    })
  })
})
