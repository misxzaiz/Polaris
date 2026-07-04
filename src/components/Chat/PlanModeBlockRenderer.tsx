/**
 * 计划模式块渲染器组件
 *
 * 用于 PlanMode 的交互界面，采用左侧彩条 + 扁平化阶段行设计。
 * - 显示计划标题、整体进度、阶段列表
 * - 支持阶段展开/折叠查看任务明细
 * - 支持审批/拒绝操作
 * - 支持键盘导航与无障碍
 *
 * 设计原则
 * ---------
 * 1. 去嵌套 —— 阶段不再是 `border rounded-lg` 包裹的卡片，改用分隔线 + 圆点表示层级
 * 2. 去紫 —— 用 indigo（介于蓝紫之间）替代 violet-500，与项目蓝调更协调
 * 3. 去冗余 —— 整体进度只保留一条；阶段用 `N/M 完成/进行中` 元信息替代独立进度条
 * 4. 小按钮 —— 审批按钮紧凑布局，不占满整宽
 */

import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { invoke } from '@/services/tauri';
import { createLogger } from '@/utils/logger';
import {
  Loader2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
} from 'lucide-react';
import { useActiveSessionConversationId, useActiveSessionActions } from '@/stores/conversationStore/useActiveSession';
import { Button } from '../Common/Button';
import type { PlanModeBlock, PlanStageBlock } from '@/types';

const log = createLogger('PlanModeBlock');

export interface PlanModeBlockRendererProps {
  block: PlanModeBlock;
}

// ========================================
// 状态配置
// ========================================

type PlanStatusAnimation = 'animate-spin' | undefined;

interface PlanStatusEntry {
  color: string;
  bg: string;
  labelKey: string;
  barColor: string;
  animation?: PlanStatusAnimation;
}

interface PlanTaskStatusEntry {
  color: string;
  dotColor: string;
  animation?: PlanStatusAnimation;
}

/** PlanMode 状态配置 */
export const PLAN_STATUS_CONFIG: Record<string, PlanStatusEntry> = {
  drafting: {
    color: 'text-yellow-500',
    bg: 'bg-yellow-500/10',
    labelKey: 'plan.statusDrafting',
    barColor: 'bg-yellow-500',
    animation: 'animate-spin',
  },
  pending_approval: {
    color: 'text-yellow-500',
    bg: 'bg-yellow-500/10',
    labelKey: 'plan.statusPendingApproval',
    barColor: 'bg-yellow-500',
  },
  approved: {
    color: 'text-primary',
    bg: 'bg-primary/10',
    labelKey: 'plan.statusApproved',
    barColor: 'bg-primary',
  },
  rejected: {
    color: 'text-red-500',
    bg: 'bg-red-500/10',
    labelKey: 'plan.statusRejected',
    barColor: 'bg-red-500',
  },
  executing: {
    color: 'text-primary',
    bg: 'bg-primary/10',
    labelKey: 'plan.statusExecuting',
    barColor: 'bg-primary',
    animation: 'animate-spin',
  },
  completed: {
    color: 'text-success',
    bg: 'bg-success/10',
    labelKey: 'plan.statusCompleted',
    barColor: 'bg-success',
  },
  canceled: {
    color: 'text-gray-500',
    bg: 'bg-gray-500/10',
    labelKey: 'plan.statusCanceled',
    barColor: 'bg-gray-500',
  },
};

/** 阶段/任务状态配置（仅视觉，不包裹） */
export const PLAN_TASK_STATUS_CONFIG: Record<string, PlanTaskStatusEntry> = {
  pending:     { color: 'text-text-muted', dotColor: 'bg-text-muted' },
  in_progress: { color: 'text-primary',    dotColor: 'bg-primary',    animation: 'animate-spin' },
  completed:   { color: 'text-success',    dotColor: 'bg-success' },
  failed:      { color: 'text-red-500',    dotColor: 'bg-red-500' },
  skipped:     { color: 'text-text-muted', dotColor: 'bg-gray-500' },
};

// ========================================
// 子组件
// ========================================

/** 阶段状态图标 —— 根据阶段 status 返回对应小元素 */
function StageStatusDot({ status }: { status: PlanStageBlock['status'] }) {
  switch (status) {
    case 'completed':
      return <span className="w-1.5 h-1.5 rounded-full bg-success block" />;
    case 'in_progress':
      return <span className="w-1.5 h-1.5 rounded-full bg-primary block animate-pulse" />;
    case 'failed':
      return <span className="w-1.5 h-1.5 rounded-full bg-red-500 block" />;
    default:
      return <span className="w-1.5 h-1.5 rounded-full bg-text-muted block" />;
  }
}

/**
 * 扁平化阶段行 —— 不再是 `border rounded-lg` 包裹的卡片，仅用圆点 + 分隔线表示层级。
 * 点击可展开任务列表（任务以左侧竖线连接，无独立卡片）。
 */
const PlanStageRow = memo(function PlanStageRow({
  stage,
  isExpanded = false,
  onToggle,
}: {
  stage: PlanStageBlock;
  isExpanded?: boolean;
  onToggle?: () => void;
}) {
  const { t } = useTranslation('chat');

  const totalTasks = stage.tasks.length;
  const completedTasks = stage.tasks.filter(task => task.status === 'completed').length;
  const isInProgress = stage.status === 'in_progress';

  // 键盘支持：Enter/Space 展开/折叠
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onToggle?.();
      }
    },
    [onToggle]
  );

  const metaText = totalTasks > 0
    ? `${completedTasks}/${totalTasks} ${isInProgress ? t('plan.stageInProgress') : t('plan.stageCompleted')}`
    : `${totalTasks} tasks`;

  return (
    <>
      {/* 阶段行 —— 无卡片外壳，仅用 padding + 分隔线 */}
      <div
        onClick={onToggle}
        onKeyDown={handleKeyDown}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-label={t('plan.stageAriaLabel', {
          name: stage.name,
          completed: completedTasks,
          total: totalTasks,
        })}
        className={clsx(
          'flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors',
          'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-1 focus:ring-offset-background-elevated',
          isExpanded && 'hover:bg-background-hover/50'
        )}
      >
        <StageStatusDot status={stage.status} />
        <span className="text-xs text-text-muted w-3 shrink-0 font-mono">{stage.stageId}</span>
        <span className={clsx(
          'text-sm font-medium flex-1 truncate',
          stage.status === 'completed' && 'text-text-secondary',
          isInProgress && 'text-text-primary',
          stage.status === 'failed' && 'text-red-400'
        )}>
          {stage.name}
        </span>
        {totalTasks > 0 && (
          <span className="text-xs text-text-tertiary shrink-0">{metaText}</span>
        )}
        {isExpanded
          ? <ChevronDown className="w-3.5 h-3.5 text-text-muted shrink-0" />
          : <ChevronRight className="w-3.5 h-3.5 text-text-muted shrink-0" />}
      </div>

      {/* 展开的任务列表 —— 无独立卡片，用左侧竖线连接 */}
      {isExpanded && stage.tasks.length > 0 && (
        <div className="px-3 pb-2 pt-0.5">
          <div className="ml-5 pl-3 border-l border-border-subtle space-y-1">
            {stage.tasks.map((task, idx) => {
              const config = PLAN_TASK_STATUS_CONFIG[task.status];
              const isDone = task.status === 'completed';
              return (
                <div key={task.taskId || idx} className="flex items-center gap-2">
                  <span className={clsx(
                    'w-1.5 h-1.5 rounded-full block shrink-0',
                    config.dotColor,
                    config.animation && 'animate-pulse'
                  )} />
                  <span className={clsx(
                    'text-xs flex-1',
                    isDone ? 'text-text-tertiary line-through' : 'text-text-secondary'
                  )}>
                    {task.description}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
});

// ========================================
// 主组件
// ========================================

export const PlanModeBlockRenderer = memo(function PlanModeBlockRenderer({
  block,
}: PlanModeBlockRendererProps) {
  const { t } = useTranslation('chat');
  const [expandedStages, setExpandedStages] = useState<Set<string>>(new Set());
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

  // 切换阶段展开状态
  const toggleStage = useCallback((stageId: string) => {
    setExpandedStages(prev => {
      const next = new Set(prev);
      if (next.has(stageId)) {
        next.delete(stageId);
      } else {
        next.add(stageId);
      }
      return next;
    });
  }, []);

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
      // 1. 调用后端命令批准计划，更新状态
      await invoke('approve_plan', {
        sessionId: conversationId,
        planId: block.id,
      });

      // 2. 构建审批结果 prompt 并发送给 CLI
      const approvalPrompt = buildApprovalPrompt(true);

      // 3. 调用 continueChat 将结果发送给 CLI
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
      // 1. 调用后端命令拒绝计划，更新状态
      await invoke('reject_plan', {
        sessionId: conversationId,
        planId: block.id,
        feedback: rejectFeedback || undefined,
      });

      // 2. 构建审批结果 prompt 并发送给 CLI
      const rejectionPrompt = buildApprovalPrompt(false, rejectFeedback || undefined);

      // 3. 调用 continueChat 将结果发送给 CLI
      if (conversationId) {
        await continueChat(rejectionPrompt);
      }

      // 4. 重置反馈输入
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

  // 计算整体进度
  const totalTasks = block.stages.reduce((sum, s) => sum + s.tasks.length, 0);
  const completedTasks = block.stages.reduce(
    (sum, s) => sum + s.tasks.filter(t => t.status === 'completed').length,
    0
  );
  const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={t('plan.planModeAriaLabel', { title: block.title || t('plan.defaultTitle') })}
      onKeyDown={handleKeyDown}
      className={clsx(
        'my-2 rounded-lg border overflow-hidden border-l-2 border-l-primary',
        block.isActive && block.status !== 'completed'
          ? 'bg-gradient-to-r from-primary/5 to-transparent border border-primary/20'
          : 'bg-background-elevated border-border',
        block.status === 'completed' && 'border-l-success'
      )}
    >
      {/* 头部 —— 单图标（标题内），无重复 ListChecks */}
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-sm font-medium text-text-primary flex-1 truncate">
          {block.title || t('plan.defaultTitle')}
        </span>
        <span className={clsx(
          'text-xs px-2 py-0.5 rounded-full shrink-0',
          statusConfig.bg, statusConfig.color
        )}>
          {t(statusConfig.labelKey)}
        </span>
      </div>

      {/* 描述 —— 与头部无分割线，用 margin 自然分隔 */}
      {block.description && (
        <div className="px-3 pb-2 text-xs text-text-secondary leading-relaxed">
          {block.description}
        </div>
      )}

      {/* 整体进度 —— 只在 executing/completed 且有任务时显示 */}
      {totalTasks > 0 && (block.status === 'executing' || block.status === 'completed') && (
        <div className="px-3 py-1.5 flex items-center gap-2">
          <div className="flex-1 bg-background-surface rounded-full h-1.5 overflow-hidden">
            <div
              className={clsx('h-full transition-all duration-300 rounded-full', statusConfig.barColor)}
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-xs text-text-tertiary shrink-0">{completedTasks}/{totalTasks}</span>
        </div>
      )}

      {/* 阶段列表 —— 扁平化，无滚动容器（由外层 chat 控制高度） */}
      <div className="border-t border-border-subtle">
        {block.stages.map(stage => (
          <PlanStageRow
            key={stage.stageId}
            stage={stage}
            isExpanded={expandedStages.has(stage.stageId)}
            onToggle={() => toggleStage(stage.stageId)}
          />
        ))}
      </div>

      {/* 反馈输入框 —— 紧凑布局，按钮不占满整宽 */}
      {isInteractive && showFeedbackInput && (
        <div className="px-3 py-2 border-t border-border-subtle">
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
            className="w-full px-3 py-1.5 rounded-md text-sm bg-background-surface border border-border
                       focus:border-primary focus:ring-2 focus:ring-primary/30 outline-none
                       placeholder:text-text-tertiary disabled:opacity-50"
          />
          <div className="flex items-center gap-2 mt-2 justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowFeedbackInput(false)}
              disabled={isSubmitting}
            >
              {t('plan.cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleReject}
              disabled={isSubmitting}
            >
              {isSubmitting && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
              {t('plan.confirmReject')}
            </Button>
          </div>
        </div>
      )}

      {/* 审批按钮 —— 紧凑布局，不占满整宽 */}
      {isInteractive && !showFeedbackInput && (
        <div
          role="group"
          aria-label={t('plan.approvalButtonsLabel')}
          className="flex items-center gap-2 px-3 py-2 border-t border-border-subtle justify-end"
        >
          <Button
            variant="primary"
            size="sm"
            onClick={handleApprove}
            disabled={isSubmitting}
            aria-label={t('plan.approveAriaLabel')}
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
          >
            {t('plan.reject')}
          </Button>
        </div>
      )}

      {/* 反馈信息 */}
      {block.feedback && (
        <div className="px-3 py-2 border-t border-border-subtle bg-danger-faint/50">
          <div className="text-xs text-red-400">{block.feedback}</div>
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

  const totalTasks = block.stages.reduce((sum, s) => sum + s.tasks.length, 0);
  const completedTasks = block.stages.reduce(
    (sum, s) => sum + s.tasks.filter(t => t.status === 'completed').length,
    0
  );

  return (
    <div
      className="my-1 flex items-center gap-2 text-xs text-text-tertiary"
      aria-label={t('plan.planModeAriaLabel', { title: block.title || t('plan.defaultTitle') })}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-primary block shrink-0" aria-hidden="true" />
      <ClipboardList className="w-3 h-3 text-primary shrink-0" aria-hidden="true" />
      <span className="truncate">{block.title || t('plan.defaultTitle')}</span>
      {totalTasks > 0 && (
        <span className="text-text-secondary">{completedTasks}/{totalTasks}</span>
      )}
    </div>
  );
});

export default PlanModeBlockRenderer;
