/**
 * 工具状态辅助工具
 *
 * 统一管理工具状态的图标、颜色等配置
 * 避免在多个组件中重复定义相同的逻辑
 */

import {
  IconPending, IconRunning, IconCompleted, IconFailed, IconPartial
} from '@/components/Common/Icons';
import type { ToolStatus } from '@/types';

/**
 * 工具状态配置
 *
 * 包含每种状态对应的：
 * - icon: 图标组件
 * - color: 文本颜色类名
 * - bgClass: 背景样式类名
 */
export const TOOL_STATUS_CONFIG = {
  pending: {
    icon: IconPending,
    color: 'text-text-muted',
    bgClass: 'bg-background-surface border-border'
  },
  running: {
    icon: IconRunning,
    color: 'text-warning animate-pulse',
    bgClass: 'bg-warning-faint border-warning/30'
  },
  completed: {
    icon: IconCompleted,
    color: 'text-success',
    bgClass: 'bg-success-faint border-success/30'
  },
  failed: {
    icon: IconFailed,
    color: 'text-error',
    bgClass: 'bg-error-faint border-error/30'
  },
  partial: {
    icon: IconPartial,
    color: 'text-warning',
    bgClass: 'bg-warning-faint border-warning/30'
  }
} as const;

/**
 * 获取状态图标组件
 *
 * @param status - 工具状态
 * @returns 对应的图标组件
 *
 * @example
 * const StatusIcon = getToolStatusIcon('running');
 * return <StatusIcon size={14} />;
 */
export function getToolStatusIcon(status: ToolStatus) {
  return TOOL_STATUS_CONFIG[status]?.icon;
}

/**
 * 获取状态颜色类名
 *
 * @param status - 工具状态
 * @returns Tailwind CSS 类名字符串
 *
 * @example
 * <div className={getToolStatusColor('running')}>
 *   运行中...
 * </div>
 */
export function getToolStatusColor(status: ToolStatus): string {
  return TOOL_STATUS_CONFIG[status]?.color || 'text-text-muted';
}

/**
 * 获取状态背景样式类名
 *
 * @param status - 工具状态
 * @returns Tailwind CSS 类名字符串
 *
 * @example
 * <div className={clsx(
 *   "px-3 py-2 rounded-lg border",
 *   getToolStatusBgClass('running')
 * )}>
 *   内容
 * </div>
 */
export function getToolStatusBgClass(status: ToolStatus): string {
  return TOOL_STATUS_CONFIG[status]?.bgClass || 'bg-background-surface border-border';
}
