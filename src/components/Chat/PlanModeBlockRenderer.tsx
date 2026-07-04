/**
 * 计划模式块渲染器组件
 *
 * 用于 PlanMode 工具的交互界面
 * - 显示计划标题、步骤列表（扁平结构）
 * - 支持审批/拒绝操作
 * - 支持键盘导航
 */

import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { invoke } from '@/services/tauri';
import { createLogger } from '@/utils/logger';
import {
  Check,
  XCircle,
  Loader2,
  ThumbsDown,
  X,
  Clock,
  ClipboardList,
} from 'lucide-react';
import { useActiveSessionConversationId, useActiveSessionActions } from '@/stores/conversationStore/useActiveSession';
import { Button } from '../Common/Button';
import type { PlanModeBlock } from '@/types';

const log = createLogger('PlanModeBlock');

export interface PlanModeBlockRendererProps {
  block: PlanModeBlock;
}

// ========================================
// 类型定义
// ========================================

/** 扁平步骤项 - 支持后端返回的 step 格式 */
interface FlatPlanStep {
  /** 步骤状态 */
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  /** 步骤描述 */
  step?: string;
  /** 兼容旧格式：任务描述 */
  description?: string;
  /** 步骤 ID */
  taskId?: string;
}

// ========================================
// 状态配置
// ========================================

type PlanStatusAnimation = 'animate-spin' | undefined;

interface PlanStatusEntry {
  color: string;
  bg: string;
  labelKey: string;
  animation?: PlanStatusAnimation;
}

/** PlanMode 状态配置 */
export const PLAN_STATUS_CONFIG: PlanStatusEntry = {
  drafting: {
    color: 'text-violet-500',
    bg: 'bg-violet-500/10',
    labelKey: 'plan.statusDrafting',
    animation: 'animate-spin',
  },
  pending_approval: {
    color: 'text-yellow-500',
    bg: 'bg-yellow-500/10',
    labelKey: 'plan.statusPendingApproval',
  },
  approved: {
    color: 'text-green-500',
    bg: 'bg-green-500/10',
    labelKey: 'plan.statusApproved',
  },
  rejected: {
    color: 'text-red-500',
    bg: 'bg-red-500/10',
    labelKey: 'plan.statusRejected',
  },
  executing: {
    color: 'text-blue-500',
    bg: 'bg-blue-500/10',
    labelKey: 'plan.statusExecuting',
    animation: 'animate-spin',
  },
  completed: {
    color: 'text-success',
    bg: 'bg-success/10',
    labelKey: 'plan.statusCompleted',
  },
  canceled: {
    color: 'text-gray-500',
    bg: 'bg-gray-500/10',
    labelKey: 'plan.statusCanceled',
  },
};

// ========================================
// 子组件
// ========================================

/** 单个步骤项 - 紧凑扁平设计 */
const PlanStepItem = memo(function PlanStepItem({
  step,
  index,
  isLast,
}: {
  step: FlatPlanStep;
  index: number;
  isLast: boolean;
}) {
  const status = step.status;
  const text = step.step || step.description || '';
  const isCompleted = status === 'completed';
  const isInProgress = status === 'in_progress';
  const isFailed = status === 'failed';

  // 获取状态指示器 - 紧凑尺寸
  const getStatusIndicator = () => {
    if (isCompleted) {
      return (
        <div className="w-4 h-4 rounded-full bg-success/15 flex items-center justify-center shrink-0">
          <Check className="w-2.5 h-2.5 text-success" />
        </div>
      );
    }
    if (isInProgress) {
      return (
        <div className="w-4 h-4 rounded-full bg-violet-500/15 flex items-center justify-center shrink-0">
          <Loader2 className="w-2.5 h-2.5 text-violet-500 animate-spin" />
        </div>
      );
    }
    if (isFailed) {
      return (
        <div className="w-4 h-4 rounded-full bg-red-500/15 flex items-center justify-center shrink-0">
          <XCircle className="w-2.5 h-2.5 text-red-500" />
        </div>
      );
    }
    // pending
    return (
      <div className="w-4 h-4 rounded-full border-[1.5px] border-border-subtle flex items-center justify-center shrink-0">
        <span className="text-[8px] text-text-muted">{index + 1}</span>
      </div>
    );
  };

  return (
    <div className="flex items-start gap-2">
      {/* 状态指示器 + 竖线 */}
      <div className="flex flex-col items-center">
        {getStatusIndicator()}
        {!isLast && (
          <div className={clsx(
            'w-px flex-1 min-h-[14px] mt-0.5',
            isCompleted ? 'bg-success/30' : 'bg-border-subtle'
          )} />
        )}
      </div>

      {/* 步骤内容 */}
      <div className="flex-1 py-0.5 min-w-0">
        <span className={clsx(
          'text-[13px] leading-snug',
          isCompleted && 'text-text-muted line-through',
          isInProgress && 'text-text-primary',
          isFailed && 'text-red-400',
          !isCompleted && !isInProgress && !isFailed && 'text-text-secondary'
        )}>
          {text}
        </span>
      </div>
    </div>
  );
});

// ========================================
// 主组件
// ========================================

export const PlanModeBlockRenderer = memo(function PlanModeBlockRenderer({
  block,
}: PlanModeBlockRendererProps) {
  const { t } = useTranslation('chat');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [rejectFeedback, setRejectFeedback] = useState('');
  const [showFeedbackInput, setShowFeedbackInput] = useState(false);

  // 无障碍支持
  const containerRef = useRef<HTMLDivElement>(null);
  const feedbackInputRef = useRef<HTMLInputElement>(null);

  const conversationId = useActiveSessionConversationId();
  const { continueChat } = useActiveSessionActions();

  const statusConfig = PLAN_STATUS_CONFIG[block.status];

  // 是否可交互
  const isInteractive = block.status === 'pending_approval' && block.isActive;

  // 键盘导航支持
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showFeedbackInput) {
          setShowFeedbackInput(false);
          setRejectFeedback('');
          e.preventDefault();
        }
      }
    },
    [showFeedbackInput]
  );

  // 焦点管理：反馈输入框显示时自动聚焦
  useEffect(() => {
    if (showFeedbackInput && feedbackInputRef.current) {
      feedbackInputRef.current.focus();
    }
  }, [showFeedbackInput]);

  // 构建审批结果 prompt 格式
  const buildApprovalPrompt = useCallback(
    (approved: boolean, feedback?: string): string => {
      const planTitle = block.title || t('plan.defaultTitle');
      const action = approved ? '批准' : '拒绝';
      const parts: string[] = [`[计划审批] 用户${action}了计划: "${planTitle}"`];

      if (!approved && feedback) {
        parts.push(`反馈意见: ${feedback}`);
      }

      return parts.join('\n');
    },
    [block.title, t]
  );

  // 批准计划
  const handleApprove = useCallback(async () => {
    if (!isInteractive || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await invoke('approve_plan', {
        sessionId: conversationId,
        planId: block.id,
      });

      const approvalPrompt = buildApprovalPrompt(true);

      if (conversationId) {
        await continueChat(approvalPrompt);
      }
    } catch (error) {
      log.error('批准计划失败:', error instanceof Error ? error : new Error(String(error)));
    } finally {
      setIsSubmitting(false);
    }
  }, [isInteractive, isSubmitting, conversationId, block.id, buildApprovalPrompt, continueChat]);

  // 拒绝计划
  const handleReject = useCallback(async () => {
    if (!isInteractive || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await invoke('reject_plan', {
        sessionId: conversationId,
        planId: block.id,
        feedback: rejectFeedback || undefined,
      });

      const rejectionPrompt = buildApprovalPrompt(false, rejectFeedback || undefined);

      if (conversationId) {
        await continueChat(rejectionPrompt);
      }

      setRejectFeedback('');
      setShowFeedbackInput(false);
    } catch (error) {
      log.error('拒绝计划失败:', error instanceof Error ? error : new Error(String(error)));
    } finally {
      setIsSubmitting(false);
    }
  }, [
    isInteractive,
    isSubmitting,
    conversationId,
    block.id,
    rejectFeedback,
    buildApprovalPrompt,
    continueChat,
  ]);

  // 从 stages 中提取扁平步骤列表
  // 支持两种格式：
  // 1. stages[].tasks[] 嵌套格式
  // 2. 直接使用 stages 作为扁平步骤
  const steps: FlatPlanStep[] = [];
  let totalTasks = 0;
  let completedTasks = 0;

  block.stages.forEach(stage => {
    if (stage.tasks && stage.tasks.length > 0) {
      // 嵌套格式：每个 stage 包含 tasks
      stage.tasks.forEach(task => {
        steps.push({
          status: task.status,
          step: task.description,
          taskId: task.taskId,
        });
        totalTasks++;
        if (task.status === 'completed') completedTasks++;
      });
    } else {
      // 扁平格式：stage 本身就是一个步骤
      steps.push({
        status: stage.status as FlatPlanStep['status'],
        step: stage.name,
        taskId: stage.stageId,
      });
      totalTasks++;
      if (stage.status === 'completed') completedTasks++;
    }
  });

  const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  // 获取状态指示点
  const getStatusDot = () => {
    if (block.status === 'completed') {
      return <div className="w-2 h-2 rounded-full bg-success shrink-0" />;
    }
    if (block.status === 'executing' || block.status === 'drafting') {
      return <div className="w-2 h-2 rounded-full bg-violet-500 animate-pulse shrink-0" />;
    }
    if (block.status === 'pending_approval') {
      return <div className="w-2 h-2 rounded-full bg-yellow-500 shrink-0" />;
    }
    if (block.status === 'rejected') {
      return <div className="w-2 h-2 rounded-full bg-red-500 shrink-0" />;
    }
    return <div className="w-2 h-2 rounded-full bg-text-muted shrink-0" />;
  };

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={t('plan.planModeAriaLabel', { title: block.title || t('plan.defaultTitle') })}
      onKeyDown={handleKeyDown}
      className="my-1.5 rounded-lg border border-border-subtle bg-background-elevated overflow-hidden"
    >
      {/* 头部 - 高密度设计 */}
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        {getStatusDot()}
        <span className="text-[13px] font-medium text-text-primary flex-1 truncate">
          {block.title || t('plan.defaultTitle')}
        </span>
        <span className={clsx(
          'text-[10px] px-1.5 py-px rounded',
          statusConfig.bg,
          statusConfig.color
        )}>
          {t(statusConfig.labelKey)}
        </span>
      </div>

      {/* 进度条 - 内联在头部下方 */}
      {totalTasks > 0 && (
        <div className="flex items-center gap-2 px-2.5 pb-1.5">
          <div className="flex-1 h-1 bg-background-tertiary rounded-full overflow-hidden">
            <div
              className="h-full bg-violet-500 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-[10px] text-text-muted whitespace-nowrap">
            {completedTasks}/{totalTasks}
          </span>
        </div>
      )}

      {/* 分隔线 */}
      <div className="h-px bg-border-subtle mx-2.5" />

      {/* 步骤列表 - 高密度渲染 */}
      <div className="max-h-[200px] overflow-y-auto px-2.5 py-1.5">
        {steps.map((step, idx) => (
          <PlanStepItem
            key={step.taskId || idx}
            step={step}
            index={idx}
            isLast={idx === steps.length - 1}
          />
        ))}
        {steps.length === 0 && (
          <div className="py-2 text-center text-[11px] text-text-muted">
            暂无步骤
          </div>
        )}
      </div>

      {/* 分隔线 */}
      <div className="h-px bg-border-subtle mx-2.5" />

      {/* 反馈输入框 - 高密度设计 */}
      {isInteractive && showFeedbackInput && (
        <div className="px-2.5 py-1.5">
          <label className="sr-only" htmlFor="plan-feedback-input">
            {t('plan.feedbackLabel')}
          </label>
          <input
            id="plan-feedback-input"
            ref={feedbackInputRef}
            type="text"
            value={rejectFeedback}
            onChange={e => setRejectFeedback(e.target.value)}
            placeholder={t('plan.feedbackPlaceholder')}
            aria-label={t('plan.feedbackLabel')}
            disabled={isSubmitting}
            className="w-full px-2 py-1 rounded text-[12px] bg-background-base border border-border
                       focus:border-violet-500 focus:ring-1 focus:ring-violet-500/50 outline-none
                       placeholder:text-text-muted disabled:opacity-50 transition-colors"
          />
          <div className="flex items-center gap-1.5 mt-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowFeedbackInput(false)}
              disabled={isSubmitting}
              className="flex-1 h-6 text-[11px]"
            >
              {t('plan.cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleReject}
              disabled={isSubmitting}
              className="flex-1 h-6 text-[11px]"
            >
              {isSubmitting && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
              {t('plan.confirmReject')}
            </Button>
          </div>
        </div>
      )}

      {/* 审批按钮 - 高密度设计 */}
      {isInteractive && !showFeedbackInput && (
        <div
          role="group"
          aria-label={t('plan.approvalButtonsLabel')}
          className="flex items-center gap-1.5 px-2.5 py-1.5"
        >
          <Button
            variant="primary"
            size="sm"
            onClick={handleApprove}
            disabled={isSubmitting}
            aria-label={t('plan.approveAriaLabel')}
            className="flex-1 h-6 text-[11px]"
          >
            {isSubmitting && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
            {t('plan.approve')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => setShowFeedbackInput(true)}
            disabled={isSubmitting}
            aria-label={t('plan.rejectAriaLabel')}
            className="flex-1 h-6 text-[11px]"
          >
            {t('plan.reject')}
          </Button>
        </div>
      )}

      {/* 反馈信息 - 高密度设计 */}
      {block.feedback && (
        <div className="px-2.5 py-1 border-t border-border-subtle bg-red-500/5">
          <div className="text-[11px] text-red-400">{block.feedback}</div>
        </div>
      )}
    </div>
  );
});

// ========================================
// 简化版渲染器
// ========================================

/** 简化版计划渲染器 - 用于归档层 */
export const SimplifiedPlanModeRenderer = memo(function SimplifiedPlanModeRenderer({
  block,
}: {
  block: PlanModeBlock;
}) {
  const { t } = useTranslation('chat');
  const statusConfig = PLAN_STATUS_CONFIG[block.status];

  // 计算进度
  let totalTasks = 0;
  let completedTasks = 0;

  block.stages.forEach(stage => {
    if (stage.tasks && stage.tasks.length > 0) {
      totalTasks += stage.tasks.length;
      completedTasks += stage.tasks.filter(t => t.status === 'completed').length;
    } else {
      totalTasks++;
      if (stage.status === 'completed') completedTasks++;
    }
  });

  return (
    <div
      className="my-1 flex items-center gap-2 text-xs text-text-tertiary"
      aria-label={t('plan.planModeAriaLabel', { title: block.title || t('plan.defaultTitle') })}
    >
      <ClipboardList className="w-3 h-3 text-violet-500" aria-hidden="true" />
      <span className="truncate">{block.title || t('plan.defaultTitle')}</span>
      {totalTasks > 0 && (
        <span className="text-text-secondary">{completedTasks}/{totalTasks}</span>
      )}
    </div>
  );
});

export default PlanModeBlockRenderer;
