/**
 * 任务板渲染器 - TaskCreate/Update/List 聚合展示
 *
 * run 级单板：同一 run 内的 Task 工具调用合并为一个板，
 * store 层以 taskId 为键幂等合并（createConversationStore）。
 *
 * 高信息密度设计：折叠态单行（进度条+数字+当前项），展开态紧凑行列表。
 */

import { memo, useState } from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Loader2,
  Circle,
  AlertTriangle,
  Square,
  ChevronDown,
  ChevronRight,
  ListPlus,
} from 'lucide-react';
import type { TaskBoardBlock, TaskBoardItem } from '@/types';
import { TASK_STATUS_CONFIG } from '../chatUtils/constants';

const STATUS_ICON = {
  completed: Check,
  in_progress: Loader2,
  pending: Circle,
  blocked: AlertTriangle,
  stopped: Square,
} as const;

/** 状态点：小色块，不包背景容器，省空间 */
function StatusDot({ status }: { status: TaskBoardItem['status'] }) {
  const Icon = STATUS_ICON[status] || Circle;
  const cfg = TASK_STATUS_CONFIG[status] || TASK_STATUS_CONFIG.pending;
  return (
    <Icon className={clsx('w-3 h-3 shrink-0', cfg.color, status === 'in_progress' && 'animate-spin')} />
  );
}

function TaskItemRow({ item, index }: { item: TaskBoardItem; index: number }) {
  const isRunning = item.status === 'in_progress';
  const label = isRunning && item.activeForm ? item.activeForm : item.subject;

  return (
    <div className="flex items-center gap-2 px-2 py-1 rounded hover:bg-background-hover/60 transition-colors">
      <StatusDot status={item.status} />
      <span className={clsx(
        'text-xs flex-1 min-w-0 truncate',
        item.status === 'completed' ? 'text-text-muted line-through' : 'text-text-secondary',
      )}>
        {label || '无标题'}
      </span>
      <span className="text-[10px] text-text-muted shrink-0 font-mono">#{index + 1}</span>
    </div>
  );
}

export const TaskBoardRenderer = memo(function TaskBoardRenderer({ block }: { block: TaskBoardBlock }) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);

  const percent = block.total > 0 ? Math.round((block.completed / block.total) * 100) : 0;
  const runningItem = block.items.find(i => i.status === 'in_progress');

  return (
    <div className="my-1.5 rounded-md border border-border-subtle/40 bg-surface/40 overflow-hidden">
      {/* 头部 / 折叠态：高密度单/双行 */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-2 w-full px-2.5 py-1.5 hover:bg-surface/60 transition-colors"
      >
        <ListPlus size={13} className="text-primary shrink-0" />
        {/* 进度条 + 数字 */}
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="w-16 bg-background-base rounded-full h-1 overflow-hidden">
            <div
              className="bg-primary h-full transition-all duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="text-[11px] text-text-tertiary tabular-nums font-mono">
            {block.completed}/{block.total}
          </span>
        </div>
        {/* 进行中项（截断） */}
        {runningItem ? (
          <span className="text-[11px] text-text-secondary truncate flex-1 text-left">
            {runningItem.activeForm || runningItem.subject}
          </span>
        ) : percent === 100 ? (
          <span className="text-[11px] text-success truncate flex-1 text-left">{t('task.allDone', '全部完成')}</span>
        ) : (
          <span className="text-[11px] text-text-muted truncate flex-1 text-left">{t('task.taskBoard', '任务板')}</span>
        )}
        {/* 状态计数标签 */}
        <div className="flex items-center gap-1 shrink-0">
          {block.inProgress > 0 && (
            <span className="text-[10px] text-primary">{block.inProgress}运行</span>
          )}
          {block.blocked > 0 && (
            <span className="text-[10px] text-danger flex items-center gap-0.5">
              <AlertTriangle size={9} />{block.blocked}
            </span>
          )}
        </div>
        {expanded
          ? <ChevronDown size={12} className="text-text-muted shrink-0" />
          : <ChevronRight size={12} className="text-text-muted shrink-0" />}
      </button>

      {/* 展开态：紧凑行列表 */}
      {expanded && (
        <div className="px-1.5 pb-1.5 pt-0.5 border-t border-border-subtle/30 space-y-0.5">
          {block.items.map((item, i) => (
            <TaskItemRow key={item.id} item={item} index={i} />
          ))}
        </div>
      )}
    </div>
  );
});
