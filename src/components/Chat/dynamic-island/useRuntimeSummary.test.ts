/**
 * useRuntimeSummary 派生函数测试
 *
 * 覆盖 plan_mode 执行态 / 完成态 / 失败态卡片派生：
 * - executing / drafting → 运行中卡（含进度、任务清单、轮播段）
 * - completed → 已完成卡（折叠组）
 * - stage 失败 → 失败卡
 * - pending_approval → 不进运行卡（由 urgent 层处理）
 */

import { describe, it, expect } from 'vitest';
import { deriveRuntimeSummary } from './useRuntimeSummary';
import type { PlanModeBlock, PlanStageBlock } from '@/types';

function createPlanStage(overrides?: Partial<PlanStageBlock>): PlanStageBlock {
  return {
    stageId: 'stage-1',
    name: '阶段 1',
    status: 'pending',
    tasks: [
      { taskId: 'task-1', description: '任务 1', status: 'pending' },
      { taskId: 'task-2', description: '任务 2', status: 'pending' },
    ],
    ...overrides,
  };
}

function createPlanModeBlock(overrides?: Partial<PlanModeBlock>): PlanModeBlock {
  return {
    id: 'test-plan-id',
    type: 'plan_mode',
    sessionId: 'session-1',
    title: '测试计划',
    description: '这是一个测试计划的描述',
    status: 'pending_approval',
    stages: [createPlanStage()],
    ...overrides,
  };
}

const NOW = 1_700_000_000_000;

describe('deriveRuntimeSummary - plan_mode 执行态', () => {
  it('executing 状态派生运行中卡（含进度、任务清单、轮播段）', () => {
    const pm = createPlanModeBlock({
      status: 'executing',
      stages: [
        createPlanStage({
          status: 'in_progress',
          tasks: [
            { taskId: 'task-1', description: '任务 1', status: 'completed' },
            { taskId: 'task-2', description: '任务 2', status: 'in_progress' },
            { taskId: 'task-3', description: '任务 3', status: 'pending' },
          ],
        }),
      ],
    });

    const s = deriveRuntimeSummary([pm], null, NOW);

    expect(s.hasRunning).toBe(true);
    expect(s.runningCount).toBe(1);
    const card = s.cards.find(c => c.kind === 'plan');
    expect(card).toBeDefined();
    expect(card!.running).toBe(true);
    expect(card!.failed).toBe(false);
    expect(card!.summary).toBe('测试计划');
    expect(card!.meta).toBe('1/3 · 执行中');
    expect(card!.percent).toBe(33);
    expect(card!.detail).toBe('任务 2');
    expect(card!.items).toEqual([
      { id: 'task-1', label: '任务 1', status: 'done' },
      { id: 'task-2', label: '任务 2', status: 'active' },
      { id: 'task-3', label: '任务 3', status: 'pending' },
    ]);
    // 轮播段
    expect(s.slides.length).toBe(1);
    expect(s.slides[0]).toMatchObject({
      kind: 'plan',
      label: '计划',
      value: '任务 2 · 1/3',
      barPercent: 33,
    });
  });

  it('drafting 状态同样派生运行中卡', () => {
    const pm = createPlanModeBlock({ status: 'drafting' });
    const s = deriveRuntimeSummary([pm], null, NOW);
    expect(s.runningCount).toBe(1);
    expect(s.cards[0].running).toBe(true);
    expect(s.cards[0].failed).toBe(false);
  });

  it('无 tasks 的扁平 stage 按 stage 本身计数', () => {
    const pm = createPlanModeBlock({
      status: 'executing',
      stages: [
        { stageId: 's1', name: '第一步', status: 'completed', tasks: [] },
        { stageId: 's2', name: '第二步', status: 'in_progress', tasks: [] },
        { stageId: 's3', name: '第三步', status: 'pending', tasks: [] },
      ],
    });
    const s = deriveRuntimeSummary([pm], null, NOW);
    const card = s.cards.find(c => c.kind === 'plan')!;
    expect(card.meta).toBe('1/3 · 执行中');
    expect(card.percent).toBe(33);
    expect(card.items).toEqual([
      { id: 's1', label: '第一步', status: 'done' },
      { id: 's2', label: '第二步', status: 'active' },
      { id: 's3', label: '第三步', status: 'pending' },
    ]);
  });
});

describe('deriveRuntimeSummary - plan_mode 完成/失败态', () => {
  it('completed 状态派生已完成卡（不进运行/失败，折叠组）', () => {
    const pm = createPlanModeBlock({
      status: 'completed',
      stages: [
        createPlanStage({
          status: 'completed',
          tasks: [
            { taskId: 'task-1', description: '任务 1', status: 'completed' },
            { taskId: 'task-2', description: '任务 2', status: 'completed' },
          ],
        }),
      ],
    });
    const s = deriveRuntimeSummary([pm], null, NOW);
    expect(s.hasRunning).toBe(false);
    expect(s.hasFailed).toBe(false);
    expect(s.doneCount).toBe(1);
    const card = s.cards.find(c => c.kind === 'plan')!;
    expect(card.running).toBe(false);
    expect(card.failed).toBe(false);
    expect(card.meta).toBe('2/2');
    expect(card.percent).toBe(100);
  });

  it('executing 但 stage 失败 → 失败卡', () => {
    const pm = createPlanModeBlock({
      status: 'executing',
      stages: [
        createPlanStage({
          status: 'in_progress',
          tasks: [
            { taskId: 'task-1', description: '任务 1', status: 'failed' },
            { taskId: 'task-2', description: '任务 2', status: 'pending' },
          ],
        }),
      ],
    });
    const s = deriveRuntimeSummary([pm], null, NOW);
    expect(s.hasFailed).toBe(true);
    expect(s.hasRunning).toBe(false);
    const card = s.cards.find(c => c.kind === 'plan')!;
    expect(card.failed).toBe(true);
    expect(card.running).toBe(false);
    expect(card.meta).toBe('0/2 · 失败');
    expect(s.slides.length).toBe(0);
  });

  it('pending_approval 不进运行卡（由 urgent 层处理）', () => {
    const pm = createPlanModeBlock({ status: 'pending_approval' });
    const s = deriveRuntimeSummary([pm], null, NOW);
    expect(s.hasRunning).toBe(false);
    expect(s.hasFailed).toBe(false);
    expect(s.cards.filter(c => c.kind === 'plan').length).toBe(0);
    // urgent 派生：待审批计划出现
    expect(s.urgent.length).toBe(1);
    expect(s.urgent[0].kind).toBe('plan');
  });
});
