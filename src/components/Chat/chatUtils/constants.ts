/**
 * 聊天组件共享常量配置
 */

import { Check, XCircle, Loader2, AlertTriangle, Circle } from 'lucide-react';

/** 工具调用折叠配置 */
export const TOOL_COLLAPSE_CONFIG = {
  /** 折叠前最多显示的可折叠块数 */
  maxVisibleBlocks: 4,
  /** 触发折叠的最小块数（超过此值才折叠） */
  collapseThreshold: 5,
} as const;

/** Virtuoso 视口扩展常量（避免每次渲染创建新对象） */
export const VIEWPORT_EXTENSION = { top: 100, bottom: 150 };

/** Virtuoso 底部间距 */
export const FOOTER_SPACER_STYLE = { height: '120px' } as const;

/**
 * 状态图标配置
 */
export const STATUS_CONFIG = {
  pending: { icon: Loader2, className: 'animate-spin text-yellow-500', labelKey: 'status.pending' },
  running: { icon: Loader2, className: 'animate-spin text-blue-500', labelKey: 'status.running' },
  completed: { icon: Check, className: 'text-green-500', labelKey: 'status.completed' },
  failed: { icon: XCircle, className: 'text-red-500', labelKey: 'status.failed' },
  partial: { icon: AlertTriangle, className: 'text-orange-500', labelKey: 'status.partial' },
} as const;

/**
 * TodoWrite 任务状态配置
 */
export const TODO_STATUS_CONFIG = {
  completed: { icon: Check, color: 'text-green-500', bg: 'bg-green-500/10', labelKey: 'status.completed' },
  in_progress: { icon: Loader2, color: 'text-violet-500', bg: 'bg-violet-500/10', labelKey: 'status.running' },
  pending: { icon: Circle, color: 'text-gray-400', bg: 'bg-gray-500/10', labelKey: 'status.pending' },
} as const;
