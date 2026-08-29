/**
 * 任务板渲染器 - TaskCreate/Update/List 聚合展示
 *
 * run 级单板：同一 run 内的 Task 工具调用合并为一个板，
 * store 层以 taskId 为键幂等合并（createConversationStore）。
 * 复用 TodoWrite 行组件与进度条，扩展 blocked/stopped 状态。
 *
 * 折叠态：单行进度条 + 统计；展开态：任务列表 + 依赖 + 更新次数。
 */

import { memo, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  Check,
  Loader2,
  Circle,
  AlertTriangle,
  Square,
  ArrowLeft,
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

function TaskItemRow({ item, items, index }: {
  item: TaskBoardItem;
  items: TaskBoardItem[];
  index: number;
}) {
  const { t } = useTranslation('chat');
  const statusConfig = TASK_STATUS_CONFIG[item.status] || TASK_STATUS_CONFIG.pending;
  const StatusIcon = STATUS_ICON[item.status] || Circle;
  const isRunning = item.status === 'in_progress';
  // 进行中用 activeForm，其余用 subject
  const label = isRunning && item.activeForm ? item.activeForm : item.subject;
  // 依赖项
  const blockedBy = item.blockedBy ?? [];

  return (
    <div className="flex items-start gap-2 p-2 rounded bg-background-surface hover:bg-background-hover transition-colors">
      <div className={clsx('p-1 rounded shrink-0', statusConfig.bg)}>
        <StatusIcon className={clsx('w-3.5 h-3.5', statusConfig.color, isRunning && 'animate-spin')} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text-primary truncate">{label || t('common.untitled', '无标题')}</div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className={clsx('text-xs', statusConfig.color)}>{t(statusConfig.labelKey)}</span>
          <span className="text-xs text-text-muted">#{index + 1}</span>
          {blockedBy.length > 0 && (
            <span className="flex items-center gap-0.5 text-xs text-text-muted">
              <ArrowLeft size={10} />
              {blockedBy.map(id => {
                // 找被依赖项的序号
                const depIdx = items.findIndex(it => it.id === id)
                return depIdx >= 0 ? `#${depIdx + 1}` : id.slice(0, 4)
              }).join(',')}
            </span>
          )}
          {(item.updateCount ?? 0) > 2 && (
            <span className="text-xs text-text-muted">{t('task.frequent', '频繁')}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export const TaskBoardRenderer = memo(function TaskBoardRenderer({ block }: { block: TaskBoardBlock }) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);

  const percent = block.total > 0 ? Math.round((block.completed / block.total) * 100) : 0;
  const runningItem = useMemo(
    () => block.items.find(i => i.status === 'in_progress'),
    [block.items]
  );

  return (
    <div className="my-2 rounded-lg border border-border-subtle/30 bg-surface/[0.3] overflow-hidden">
      {/* 头部 / 折叠态 */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-2 w-full px-3 py-2 hover:bg-surface/50 transition-colors"
      >
        <ListPlus size={15} className="text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          {/* 进度条 */}
          <div className="flex items-center gap-2">
            <div className="flex-1 bg-background-base rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-primary h-full transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="text-xs text-text-tertiary shrink-0">
              {block.completed}/{block.total} ({percent}%)
            </span>
          </div>
          {/* 统计 + 进行中项 */}
          <div className="flex items-center gap-2 mt-1 text-xs text-text-muted">
            <span>{t('task.taskBoard', '任务板')}</span>
            <span>· {block.total} {t('task.items', '项')}</span>
            {block.inProgress > 0 && (
              <span className="text-blue-500">{block.inProgress} {t('status.running')}</span>
            )}
            {block.blocked > 0 && (
              <span className="text-red-500 flex items-center gap-0.5">
                <AlertTriangle size={10} /> {block.blocked} {t('status.blocked')}
              </span>
            )}
            {runningItem && (
              <span className="text-text-secondary truncate">
                · {runningItem.activeForm || runningItem.subject}
              </span>
            )}
          </div>
        </div>
        {expanded ? <ChevronDown size={14} className="text-text-muted shrink-0" /> : <ChevronRight size={14} className="text-text-muted shrink-0" />}
      </button>

      {/* 展开态 */}
      {expanded && (
        <div className="px-3 pb-2 space-y-1 border-t border-border-subtle/20">
          {block.items.map((item, i) => (
            <TaskItemRow key={item.id} item={item} items={block.items} index={i} />
          ))}
        </div>
      )}
    </div>
  );
});
