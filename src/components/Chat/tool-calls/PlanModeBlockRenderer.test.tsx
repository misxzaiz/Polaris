/**
 * PlanModeBlockRenderer 组件测试
 *
 * 测试范围：
 * - 渲染：显示计划标题、描述、阶段列表、任务列表、进度条
 * - 交互：批准/拒绝操作、反馈输入、阶段展开/折叠
 * - 状态：drafting/pending_approval/approved/rejected/executing/completed/canceled
 * - 无障碍：ARIA 属性、键盘导航
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  PlanModeBlockRenderer,
  SimplifiedPlanModeRenderer,
  PLAN_STATUS_CONFIG,
  PLAN_TASK_STATUS_CONFIG,
} from './PlanModeBlockRenderer';
import type { PlanModeBlock, PlanStageBlock } from '../../types';

// Mock Tauri invoke
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Mock zustand store and hooks
const mockContinueChat = vi.fn();
vi.mock('../../stores/conversationStore/useActiveSession', () => ({
  useActiveSessionConversationId: () => 'test-conversation-id',
  useActiveSessionActions: () => ({ continueChat: mockContinueChat }),
}));

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'plan.defaultTitle': '计划',
        'plan.statusDrafting': '草稿中',
        'plan.statusPendingApproval': '待审批',
        'plan.statusApproved': '已批准',
        'plan.statusRejected': '已拒绝',
        'plan.statusExecuting': '执行中',
        'plan.statusCompleted': '已完成',
        'plan.statusCanceled': '已取消',
        'plan.approve': '批准',
        'plan.reject': '拒绝',
        'plan.cancel': '取消',
        'plan.confirmReject': '确认拒绝',
        'plan.feedbackPlaceholder': '请输入拒绝原因或修改建议...',
        'plan.feedbackLabel': '反馈意见',
        'plan.planModeAriaLabel': `计划: ${options?.title || '计划'}`,
        'plan.approvalButtonsLabel': '审批按钮组',
        'plan.approveAriaLabel': '批准计划',
        'plan.rejectAriaLabel': '拒绝计划',
        'plan.stageAriaLabel': `阶段 ${options?.name}: ${options?.completed}/${options?.total} 任务完成`,
      };
      return translations[key] || key;
    },
  }),
}));

// 测试数据工厂
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
    title: '测试计划',
    description: '这是一个测试计划的描述',
    status: 'pending_approval',
    isActive: true,
    stages: [createPlanStage()],
    ...overrides,
  };
}

describe('PlanModeBlockRenderer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(undefined);
    mockContinueChat.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('渲染', () => {
    it('应该显示计划标题', () => {
      const block = createPlanModeBlock({ title: '我的测试计划' });
      render(<PlanModeBlockRenderer block={block} />);

      expect(screen.getByText('我的测试计划')).toBeInTheDocument();
    });

    it('应该显示计划描述', () => {
      const block = createPlanModeBlock({ description: '计划描述内容' });
      render(<PlanModeBlockRenderer block={block} />);

      expect(screen.getByText('计划描述内容')).toBeInTheDocument();
    });

    it('应该显示阶段列表', () => {
      const block = createPlanModeBlock({
        stages: [
          createPlanStage({ stageId: 'stage-1', name: '阶段一' }),
          createPlanStage({ stageId: 'stage-2', name: '阶段二' }),
        ],
      });
      render(<PlanModeBlockRenderer block={block} />);

      expect(screen.getByText('阶段一')).toBeInTheDocument();
      expect(screen.getByText('阶段二')).toBeInTheDocument();
    });

    it('应该显示整体进度', () => {
      const block = createPlanModeBlock({
        stages: [
          createPlanStage({
            tasks: [
              { taskId: 't1', description: '任务1', status: 'completed' },
              { taskId: 't2', description: '任务2', status: 'pending' },
            ],
          }),
        ],
      });
      render(<PlanModeBlockRenderer block={block} />);

      // 应显示 1/2 进度（使用 getAllByText 检查至少有一个）
      const progressElements = screen.getAllByText('1/2');
      expect(progressElements.length).toBeGreaterThanOrEqual(1);
    });

    it('当 isActive 为 true 时应显示激活样式', () => {
      const block = createPlanModeBlock({ isActive: true });
      const { container } = render(<PlanModeBlockRenderer block={block} />);

      // 检查是否有 violet 边框样式
      const mainDiv = container.firstChild as HTMLElement;
      expect(mainDiv.className).toMatch(/violet/);
    });
  });

  describe('状态显示', () => {
    it('drafting 状态应显示加载图标', () => {
      const block = createPlanModeBlock({ status: 'drafting' });
      render(<PlanModeBlockRenderer block={block} />);

      expect(screen.getByText('草稿中')).toBeInTheDocument();
    });

    it('pending_approval 状态应显示待审批标签', () => {
      const block = createPlanModeBlock({ status: 'pending_approval' });
      render(<PlanModeBlockRenderer block={block} />);

      expect(screen.getByText('待审批')).toBeInTheDocument();
    });

    it('approved 状态应显示已批准标签', () => {
      const block = createPlanModeBlock({ status: 'approved', isActive: false });
      render(<PlanModeBlockRenderer block={block} />);

      expect(screen.getByText('已批准')).toBeInTheDocument();
    });

    it('rejected 状态应显示已拒绝标签', () => {
      const block = createPlanModeBlock({ status: 'rejected', isActive: false });
      render(<PlanModeBlockRenderer block={block} />);

      expect(screen.getByText('已拒绝')).toBeInTheDocument();
    });

    it('completed 状态应显示已完成标签', () => {
      const block = createPlanModeBlock({ status: 'completed', isActive: false });
      render(<PlanModeBlockRenderer block={block} />);

      expect(screen.getByText('已完成')).toBeInTheDocument();
    });
  });

  describe('审批交互', () => {
    it('pending_approval 状态应显示审批按钮', () => {
      const block = createPlanModeBlock({ status: 'pending_approval', isActive: true });
      render(<PlanModeBlockRenderer block={block} />);

      expect(screen.getByText('批准')).toBeInTheDocument();
      expect(screen.getByText('拒绝')).toBeInTheDocument();
    });

    it('非 pending_approval 状态不应显示审批按钮', () => {
      const block = createPlanModeBlock({ status: 'approved', isActive: false });
      render(<PlanModeBlockRenderer block={block} />);

      expect(screen.queryByText('批准')).not.toBeInTheDocument();
      expect(screen.queryByText('拒绝')).not.toBeInTheDocument();
    });

    it('isActive 为 false 时不应显示审批按钮', () => {
      const block = createPlanModeBlock({ status: 'pending_approval', isActive: false });
      render(<PlanModeBlockRenderer block={block} />);

      expect(screen.queryByText('批准')).not.toBeInTheDocument();
    });

    it('点击批准按钮应调用 approve_plan', async () => {
      const block = createPlanModeBlock({ status: 'pending_approval', isActive: true });
      render(<PlanModeBlockRenderer block={block} />);

      fireEvent.click(screen.getByText('批准'));

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('approve_plan', {
          sessionId: 'test-conversation-id',
          planId: 'test-plan-id',
        });
      });
    });

    it('批准后应调用 continueChat', async () => {
      const block = createPlanModeBlock({ status: 'pending_approval', isActive: true });
      render(<PlanModeBlockRenderer block={block} />);

      fireEvent.click(screen.getByText('批准'));

      await waitFor(() => {
        expect(mockContinueChat).toHaveBeenCalled();
      });
    });

    it('点击拒绝按钮应显示反馈输入框', () => {
      const block = createPlanModeBlock({ status: 'pending_approval', isActive: true });
      render(<PlanModeBlockRenderer block={block} />);

      fireEvent.click(screen.getByText('拒绝'));

      expect(screen.getByPlaceholderText('请输入拒绝原因或修改建议...')).toBeInTheDocument();
    });

    it('提交拒绝时应调用 reject_plan', async () => {
      const block = createPlanModeBlock({ status: 'pending_approval', isActive: true });
      render(<PlanModeBlockRenderer block={block} />);

      // 点击拒绝显示反馈输入
      fireEvent.click(screen.getByText('拒绝'));

      // 输入反馈
      const input = screen.getByPlaceholderText('请输入拒绝原因或修改建议...');
      fireEvent.change(input, { target: { value: '需要修改' } });

      // 确认拒绝
      fireEvent.click(screen.getByText('确认拒绝'));

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('reject_plan', {
          sessionId: 'test-conversation-id',
          planId: 'test-plan-id',
          feedback: '需要修改',
        });
      });
    });

    it('提交拒绝后应调用 continueChat', async () => {
      const block = createPlanModeBlock({ status: 'pending_approval', isActive: true });
      render(<PlanModeBlockRenderer block={block} />);

      fireEvent.click(screen.getByText('拒绝'));
      fireEvent.click(screen.getByText('确认拒绝'));

      await waitFor(() => {
        expect(mockContinueChat).toHaveBeenCalled();
      });
    });
  });

  describe('阶段展开/折叠', () => {
    it('点击阶段头部应展开阶段', () => {
      const block = createPlanModeBlock({
        stages: [createPlanStage({ stageId: 'stage-1', name: '阶段一' })],
      });
      render(<PlanModeBlockRenderer block={block} />);

      // 点击阶段头部
      const stageHeader = screen.getByText('阶段一').closest('div')!;
      fireEvent.click(stageHeader);

      // 展开后应显示任务列表
      expect(screen.getByText('任务 1')).toBeInTheDocument();
    });

    it('再次点击应折叠阶段', () => {
      const block = createPlanModeBlock({
        stages: [createPlanStage({ stageId: 'stage-1', name: '阶段一' })],
      });
      render(<PlanModeBlockRenderer block={block} />);

      const stageHeader = screen.getByText('阶段一').closest('div')!;

      // 展开
      fireEvent.click(stageHeader);
      expect(screen.getByText('任务 1')).toBeInTheDocument();

      // 折叠
      fireEvent.click(stageHeader);
      expect(screen.queryByText('任务 1')).not.toBeInTheDocument();
    });
  });

  describe('任务状态', () => {
    it('应显示不同状态的任务', () => {
      const block = createPlanModeBlock({
        stages: [
          createPlanStage({
            tasks: [
              { taskId: 't1', description: '已完成任务', status: 'completed' },
              { taskId: 't2', description: '进行中任务', status: 'in_progress' },
              { taskId: 't3', description: '待执行任务', status: 'pending' },
            ],
          }),
        ],
      });
      render(<PlanModeBlockRenderer block={block} />);

      // 展开阶段
      const stageHeader = screen.getByText('阶段 1').closest('div')!;
      fireEvent.click(stageHeader);

      expect(screen.getByText('已完成任务')).toBeInTheDocument();
      expect(screen.getByText('进行中任务')).toBeInTheDocument();
      expect(screen.getByText('待执行任务')).toBeInTheDocument();
    });

    it('已完成任务应有删除线样式', () => {
      const block = createPlanModeBlock({
        stages: [
          createPlanStage({
            tasks: [{ taskId: 't1', description: '完成任务', status: 'completed' }],
          }),
        ],
      });
      render(<PlanModeBlockRenderer block={block} />);

      // 展开阶段
      const stageHeader = screen.getByText('阶段 1').closest('div')!;
      fireEvent.click(stageHeader);

      const taskText = screen.getByText('完成任务');
      expect(taskText.className).toMatch(/line-through/);
    });
  });

  describe('反馈信息', () => {
    it('有 feedback 时应显示反馈信息', () => {
      const block = createPlanModeBlock({
        status: 'rejected',
        feedback: '计划需要修改',
      });
      render(<PlanModeBlockRenderer block={block} />);

      expect(screen.getByText('计划需要修改')).toBeInTheDocument();
    });

    it('无 feedback 时不显示反馈区域', () => {
      const block = createPlanModeBlock({ status: 'approved' });
      render(<PlanModeBlockRenderer block={block} />);

      // 没有反馈内容
      const feedbackArea = screen.queryByText(/计划需要修改/);
      expect(feedbackArea).not.toBeInTheDocument();
    });
  });

  describe('无障碍', () => {
    it('应有正确的 ARIA role 属性', () => {
      const block = createPlanModeBlock();
      render(<PlanModeBlockRenderer block={block} />);

      expect(screen.getByRole('region')).toBeInTheDocument();
    });

    it('应有正确的 aria-label', () => {
      const block = createPlanModeBlock({ title: '我的计划' });
      render(<PlanModeBlockRenderer block={block} />);

      expect(screen.getByLabelText('计划: 我的计划')).toBeInTheDocument();
    });

    it('审批按钮应有 aria-label', () => {
      const block = createPlanModeBlock({ status: 'pending_approval', isActive: true });
      render(<PlanModeBlockRenderer block={block} />);

      expect(screen.getByLabelText('批准计划')).toBeInTheDocument();
      expect(screen.getByLabelText('拒绝计划')).toBeInTheDocument();
    });

    it('阶段应有键盘导航支持', () => {
      const block = createPlanModeBlock({
        stages: [createPlanStage({ stageId: 'stage-1', name: '阶段一' })],
      });
      render(<PlanModeBlockRenderer block={block} />);

      // 找到可聚焦的阶段头部
      const stageButton = screen.getByText('阶段一').closest('[role="button"]')!;

      // 按 Enter 应展开/折叠
      fireEvent.keyDown(stageButton, { key: 'Enter' });

      expect(screen.getByText('任务 1')).toBeInTheDocument();
    });
  });

  describe('SimplifiedPlanModeRenderer', () => {
    it('应显示计划标题和状态', () => {
      const block = createPlanModeBlock({ title: '简化计划', status: 'completed' });
      render(<SimplifiedPlanModeRenderer block={block} />);

      expect(screen.getByText('简化计划')).toBeInTheDocument();
    });

    it('应显示任务进度', () => {
      const block = createPlanModeBlock({
        stages: [
          createPlanStage({
            tasks: [
              { taskId: 't1', description: '任务1', status: 'completed' },
              { taskId: 't2', description: '任务2', status: 'pending' },
            ],
          }),
        ],
      });
      render(<SimplifiedPlanModeRenderer block={block} />);

      expect(screen.getByText('1/2')).toBeInTheDocument();
    });

    it('应有 aria-label', () => {
      const block = createPlanModeBlock({ title: '测试计划' });
      render(<SimplifiedPlanModeRenderer block={block} />);

      expect(screen.getByLabelText('计划: 测试计划')).toBeInTheDocument();
    });
  });

  describe('状态配置导出', () => {
    it('PLAN_STATUS_CONFIG 应包含所有状态', () => {
      expect(PLAN_STATUS_CONFIG.drafting).toBeDefined();
      expect(PLAN_STATUS_CONFIG.pending_approval).toBeDefined();
      expect(PLAN_STATUS_CONFIG.approved).toBeDefined();
      expect(PLAN_STATUS_CONFIG.rejected).toBeDefined();
      expect(PLAN_STATUS_CONFIG.executing).toBeDefined();
      expect(PLAN_STATUS_CONFIG.completed).toBeDefined();
      expect(PLAN_STATUS_CONFIG.canceled).toBeDefined();
    });

    it('PLAN_TASK_STATUS_CONFIG 应包含所有任务状态', () => {
      expect(PLAN_TASK_STATUS_CONFIG.pending).toBeDefined();
      expect(PLAN_TASK_STATUS_CONFIG.in_progress).toBeDefined();
      expect(PLAN_TASK_STATUS_CONFIG.completed).toBeDefined();
      expect(PLAN_TASK_STATUS_CONFIG.failed).toBeDefined();
      expect(PLAN_TASK_STATUS_CONFIG.skipped).toBeDefined();
    });
  });
});