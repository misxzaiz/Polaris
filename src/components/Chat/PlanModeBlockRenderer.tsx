/**
 * 计划模式块渲染器组件
 *
 * 用于 PlanMode 工具的交互界面
 * - 显示计划标题、阶段列表
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
  ChevronDown,
  ChevronRight,
  Circle,
  ThumbsUp,
  ThumbsDown,
  X,
  Clock,
  ListChecks,
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

/** PlanMode 状态配置 */
export const PLAN_STATUS_CONFIG = {
  drafting: {
    icon: Loader2,
    color: 'text-violet-500',
    bg: 'bg-violet-500/10',
    labelKey: 'plan.statusDrafting',
  },
  pending_approval: {
    icon: Clock,
    color: 'text-yellow-500',
    bg: 'bg-yellow-500/10',
    labelKey: 'plan.statusPendingApproval',
  },
  approved: {
    icon: ThumbsUp,
    color: 'text-green-500',
    bg: 'bg-green-500/10',
    labelKey: 'plan.statusApproved',
  },
  rejected: {
    icon: ThumbsDown,
    color: 'text-red-500',
    bg: 'bg-red-500/10',
    labelKey: 'plan.statusRejected',
  },
  executing: {
    icon: Loader2,
    color: 'text-blue-500 animate-spin',
    bg: 'bg-blue-500/10',
    labelKey: 'plan.statusExecuting',
  },
  completed: {
    icon: Check,
    color: 'text-success',
    bg: 'bg-success/10',
    labelKey: 'plan.statusCompleted',
  },
  canceled: {
    icon: X,
    color: 'text-gray-500',
    bg: 'bg-gray-500/10',
    labelKey: 'plan.statusCanceled',
  },
} as const;

/** PlanMode 任务状态配置 */
export const PLAN_TASK_STATUS_CONFIG = {
  pending: { icon: Circle, color: 'text-gray-400', bg: 'bg-gray-500/10' },
  in_progress: { icon: Loader2, color: 'text-violet-500', bg: 'bg-violet-500/10' },
  completed: { icon: Check, color: 'text-green-500', bg: 'bg-green-500/10' },
  failed: { icon: XCircle, color: 'text-red-500', bg: 'bg-red-500/10' },
  skipped: { icon: ChevronRight, color: 'text-gray-400', bg: 'bg-gray-500/10' },
} as const;

// ========================================
// 子组件
// ========================================

/** 计划阶段组件 */
const PlanStageRenderer = memo(function PlanStageRenderer({
  stage,
  isExpanded = false,
  onToggle,
}: {
  stage: PlanStageBlock;
  isExpanded?: boolean;
  onToggle?: () => void;
}) {
  const { t } = useTranslation('chat');
  const statusConfig = PLAN_TASK_STATUS_CONFIG[stage.status];
  const StatusIcon = statusConfig.icon;

  // 计算阶段进度
  const totalTasks = stage.tasks.length;
  const completedTasks = stage.tasks.filter(task => task.status === 'completed').length;
  const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

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

  return (
    <div className="border border-border-subtle rounded-lg overflow-hidden">
      {/* 阶段头部 */}
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
          'flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-background-hover transition-colors',
          'focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-1',
          stage.status === 'in_progress' && 'bg-violet-500/5'
        )}
      >
        <div className={clsx('p-1 rounded', statusConfig.bg)}>
          <StatusIcon
            className={clsx(
              'w-3.5 h-3.5',
              statusConfig.color,
              stage.status === 'in_progress' && 'animate-spin'
            )}
          />
        </div>
        <span className="text-sm font-medium text-text-primary flex-1 truncate">
          {stage.name}
        </span>
        {totalTasks > 0 && (
          <span className="text-xs text-text-tertiary">
            {completedTasks}/{totalTasks}
          </span>
        )}
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-text-muted" />
        ) : (
          <ChevronRight className="w-4 h-4 text-text-muted" />
        )}
      </div>

      {/* 阶段内容 */}
      {isExpanded && stage.tasks.length > 0 && (
        <div className="px-3 py-2 border-t border-border-subtle bg-background-subtle/30">
          {/* 进度条 */}
          {totalTasks > 0 && (
            <div className="mb-2">
              <div className="flex items-center gap-2 mb-1">
                <div className="flex-1 bg-background-base rounded-full h-1.5 overflow-hidden">
                  <div
                    className="bg-violet-500 h-full transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <span className="text-xs text-text-tertiary">{progress}%</span>
              </div>
            </div>
          )}

          {/* 任务列表 */}
          <div className="space-y-1">
            {stage.tasks.map((task, idx) => {
              const taskConfig = PLAN_TASK_STATUS_CONFIG[task.status];
              const TaskIcon = taskConfig.icon;
              return (
                <div
                  key={task.taskId || idx}
                  className="flex items-start gap-2 p-1.5 rounded bg-background-surface/50"
                >
                  <TaskIcon
                    className={clsx(
                      'w-3.5 h-3.5 mt-0.5 shrink-0',
                      taskConfig.color,
                      task.status === 'in_progress' && 'animate-spin'
                    )}
                  />
                  <span
                    className={clsx(
                      'text-xs flex-1',
                      task.status === 'completed'
                        ? 'text-text-tertiary line-through'
                        : 'text-text-secondary'
                    )}
                  >
                    {task.description}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
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
  const StatusIcon = statusConfig.icon;

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
        'my-2 rounded-lg border overflow-hidden',
        block.isActive
          ? 'bg-violet-500/5 border-violet-500/30'
          : 'bg-background-surface border-border'
      )}
    >
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-inherit bg-inherit/50">
        <div className={clsx('p-1.5 rounded', statusConfig.bg)}>
          <StatusIcon
            className={clsx(
              'w-4 h-4',
              statusConfig.color,
              block.status === 'drafting' && 'animate-spin'
            )}
          />
        </div>
        <ListChecks className="w-4 h-4 text-violet-500" />
        <span className="text-sm font-medium text-text-primary">
          {block.title || t('plan.defaultTitle')}
        </span>
        <span className={clsx('ml-auto text-xs px-2 py-0.5 rounded-full', statusConfig.bg, statusConfig.color)}>
          {t(statusConfig.labelKey)}
        </span>
      </div>

      {/* 描述 */}
      {block.description && (
        <div className="px-3 py-2 text-xs text-text-secondary border-b border-inherit bg-inherit/30">
          {block.description}
        </div>
      )}

      {/* 整体进度 */}
      {totalTasks > 0 && (
        <div className="px-3 py-2 border-b border-inherit">
          <div className="flex items-center gap-2">
            <div className="flex-1 bg-background-base rounded-full h-2 overflow-hidden">
              <div
                className="bg-violet-500 h-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-xs text-text-tertiary">{completedTasks}/{totalTasks}</span>
          </div>
        </div>
      )}

      {/* 阶段列表 - 可滚动 */}
      <div className="max-h-[300px] overflow-y-auto p-3 space-y-2">
        {block.stages.map(stage => (
          <PlanStageRenderer
            key={stage.stageId}
            stage={stage}
            isExpanded={expandedStages.has(stage.stageId)}
            onToggle={() => toggleStage(stage.stageId)}
          />
        ))}
      </div>

      {/* 反馈输入框 */}
      {isInteractive && showFeedbackInput && (
        <div className="px-3 py-2 border-t border-inherit bg-inherit/30">
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
            className="w-full px-3 py-2 rounded-md text-sm bg-bg-secondary border border-border
                       focus:border-violet-500 focus:ring-2 focus:ring-violet-500 outline-none
                       placeholder:text-text-tertiary disabled:opacity-50"
          />
          <div className="flex items-center gap-2 mt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowFeedbackInput(false)}
              disabled={isSubmitting}
              className="flex-1"
            >
              {t('plan.cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleReject}
              disabled={isSubmitting}
              className="flex-1"
            >
              {isSubmitting ? (
                <Loader2 className="w-3 h-3 animate-spin mr-1" />
              ) : (
                <ThumbsDown className="w-3 h-3 mr-1" />
              )}
              {t('plan.confirmReject')}
            </Button>
          </div>
        </div>
      )}

      {/* 审批按钮 */}
      {isInteractive && !showFeedbackInput && (
        <div
          role="group"
          aria-label={t('plan.approvalButtonsLabel')}
          className="flex items-center gap-2 px-3 py-2 border-t border-inherit bg-inherit/30"
        >
          <Button
            variant="primary"
            size="sm"
            onClick={handleApprove}
            disabled={isSubmitting}
            aria-label={t('plan.approveAriaLabel')}
            className="flex-1"
          >
            {isSubmitting ? (
              <Loader2 className="w-3 h-3 animate-spin mr-1" />
            ) : (
              <ThumbsUp className="w-3 h-3 mr-1" />
            )}
            {t('plan.approve')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => setShowFeedbackInput(true)}
            disabled={isSubmitting}
            aria-label={t('plan.rejectAriaLabel')}
            className="flex-1"
          >
            <ThumbsDown className="w-3 h-3 mr-1" />
            {t('plan.reject')}
          </Button>
        </div>
      )}

      {/* 反馈信息 */}
      {block.feedback && (
        <div className="px-3 py-2 border-t border-inherit bg-red-500/5">
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
  const statusConfig = PLAN_STATUS_CONFIG[block.status];
  const StatusIcon = statusConfig.icon;

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
      <StatusIcon className={clsx('w-3 h-3', statusConfig.color)} aria-hidden="true" />
      <ClipboardList className="w-3 h-3 text-violet-500" aria-hidden="true" />
      <span className="truncate">{block.title || t('plan.defaultTitle')}</span>
      {totalTasks > 0 && (
        <span className="text-text-secondary">{completedTasks}/{totalTasks}</span>
      )}
    </div>
  );
});

export default PlanModeBlockRenderer;
