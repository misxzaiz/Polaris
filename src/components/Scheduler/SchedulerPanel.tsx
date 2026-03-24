/**
 * 定时任务管理面板
 */

import { useEffect, useState } from 'react';
import { useSchedulerStore, useToastStore, useEventChatStore } from '../../stores';
import type { TaskLog, CreateTaskParams, LockStatus } from '../../types/scheduler';
import { ConfirmDialog } from '../Common/ConfirmDialog';
import { DropdownMenu } from '../Common/DropdownMenu';
import type { DropdownMenuItem } from '../Common/DropdownMenu';
import type { ScheduledTask } from '../../types/scheduler';
import { TriggerTypeLabels } from '../../types/scheduler';
import * as tauri from '../../services/tauri';
import type { ProtocolFileType, TaskExportItem } from '../../services/tauri';
import { TaskEditor } from './TaskEditor';
import { useContainerSize } from '../../hooks';
import { createLogger } from '../../utils/logger';

const log = createLogger('SchedulerPanel');

/** 格式化时间戳 */
function formatTime(timestamp: number | undefined): string {
  if (!timestamp) return '--';
  return new Date(timestamp * 1000).toLocaleString('zh-CN');
}

/** 格式化相对时间 */
function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return '--';
  const now = Date.now() / 1000;
  const diff = timestamp - now;

  if (diff < 0) return '已过期';
  if (diff < 60) return `${Math.floor(diff)} 秒后`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟后`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时后`;
  return `${Math.floor(diff / 86400)} 天后`;
}

/** 状态徽章 */
function StatusBadge({ status }: { status?: 'running' | 'success' | 'failed' }) {
  if (!status) return <span className="text-gray-400">未执行</span>;

  const styles = {
    running: 'bg-blue-500/20 text-blue-400',
    success: 'bg-green-500/20 text-green-400',
    failed: 'bg-red-500/20 text-red-400',
  };

  const labels = {
    running: '执行中',
    success: '成功',
    failed: '失败',
  };

  return (
    <span className={`px-2 py-0.5 rounded text-xs ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

/** 任务卡片 */
function TaskCard({
  task,
  onEdit,
  onCopy,
  onDelete,
  onToggle,
  onRun,
  onSubscribe,
  onCancelSubscription,
  onUnsubscribe,
  onViewDocs,
  onResetSession,
  isSubscribing,
  isSubscribed,
  showGroupTag,
  selectionMode,
  isSelected,
  onSelect,
  isCompact,
}: {
  task: ScheduledTask;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onRun: () => void;
  onSubscribe: () => void;
  onCancelSubscription?: () => void;
  onUnsubscribe?: () => void;
  onViewDocs?: () => void;
  onResetSession?: () => void;
  isSubscribing?: boolean;
  /** 是否已订阅（有 subscribedContextId） */
  isSubscribed?: boolean;
  /** 是否显示分组标签（当任务列表有多个分组时显示） */
  showGroupTag?: boolean;
  /** 是否处于选择模式 */
  selectionMode?: boolean;
  /** 是否被选中 */
  isSelected?: boolean;
  /** 选择回调 */
  onSelect?: () => void;
  /** 是否紧凑模式 */
  isCompact?: boolean;
}) {
  // 构建操作菜单项
  const actionMenuItems: DropdownMenuItem[] = [];

  // 有任务路径时添加文档菜单项
  if (task.taskPath && onViewDocs) {
    actionMenuItems.push({ key: 'docs', label: '文档', onClick: onViewDocs });
  }

  // 有会话 ID 时添加重置会话菜单项
  if (task.conversationSessionId && onResetSession) {
    actionMenuItems.push({ key: 'reset_session', label: '重置会话', onClick: onResetSession });
  }

  // 通用操作菜单项
  actionMenuItems.push(
    { key: 'run', label: '执行', onClick: onRun },
    { key: 'toggle', label: task.enabled ? '禁用' : '启用', onClick: onToggle },
    { key: 'edit', label: '编辑', onClick: onEdit },
    { key: 'copy', label: '复制', onClick: onCopy },
    { key: 'delete', label: '删除', variant: 'danger', onClick: onDelete }
  );

  // 紧凑模式：使用下拉菜单
  if (isCompact) {
    return (
      <div className={`bg-[#1a1a2e] rounded-lg p-3 border ${isSelected ? 'border-blue-500' : 'border-[#2a2a4a]'}`}>
        <div className="flex items-start justify-between gap-2">
          {/* 选择模式下显示复选框 */}
          {selectionMode && (
            <div className="flex items-center mt-1">
              <input
                type="checkbox"
                checked={isSelected}
                onChange={onSelect}
                className="w-5 h-5 rounded border-gray-500 bg-[#12122a] text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer"
              />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`w-2 h-2 rounded-full shrink-0 ${task.enabled ? 'bg-green-500' : 'bg-gray-500'}`} />
              <h3 className="text-white font-medium truncate">{task.name}</h3>
              {/* 分组标签 */}
              {showGroupTag && task.group && (
                <span className="px-2 py-0.5 rounded text-xs bg-orange-500/20 text-orange-400">
                  {task.group}
                </span>
              )}
            </div>
            <div className="mt-1 text-xs text-gray-400 flex items-center gap-2 flex-wrap">
              <StatusBadge status={task.lastRunStatus} />
              {task.enabled && task.nextRunAt && (
                <span>{formatRelativeTime(task.nextRunAt)}</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {/* 订阅状态或按钮 - 紧凑模式 */}
            {isSubscribing ? (
              <button
                onClick={onCancelSubscription}
                className="p-1.5 bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
                title="停止"
              >
                ⏹
              </button>
            ) : isSubscribed ? (
              <span className="px-2 py-1 text-xs bg-cyan-600/30 text-cyan-400 rounded">🔔</span>
            ) : (
              <button
                onClick={onSubscribe}
                className="p-1.5 bg-cyan-600/20 text-cyan-400 hover:bg-cyan-600/30 rounded transition-colors"
                title="订阅执行"
              >
                👁
              </button>
            )}
            {/* 执行按钮 */}
            <button
              onClick={onRun}
              className="p-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
              title="执行"
            >
              ▶
            </button>
            {/* 更多操作下拉菜单 */}
            <DropdownMenu
              trigger={
                <button className="p-1.5 bg-gray-600/20 text-gray-300 hover:bg-gray-600/30 rounded transition-colors">
                  ⋯
                </button>
              }
              items={actionMenuItems}
              align="right"
            />
          </div>
        </div>
      </div>
    );
  }

  // 正常模式
  return (
    <div className={`bg-[#1a1a2e] rounded-lg p-4 border ${isSelected ? 'border-blue-500' : 'border-[#2a2a4a]'}`}>
      <div className="flex items-start justify-between">
        {/* 选择模式下显示复选框 */}
        {selectionMode && (
          <div className="flex items-center mr-3 mt-1">
            <input
              type="checkbox"
              checked={isSelected}
              onChange={onSelect}
              className="w-5 h-5 rounded border-gray-500 bg-[#12122a] text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer"
            />
          </div>
        )}
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${task.enabled ? 'bg-green-500' : 'bg-gray-500'}`} />
            <h3 className="text-white font-medium">{task.name}</h3>
            {/* 分组标签 */}
            {showGroupTag && task.group && (
              <span className="px-2 py-0.5 rounded text-xs bg-orange-500/20 text-orange-400">
                {task.group}
              </span>
            )}
          </div>

          <div className="mt-2 text-sm text-gray-400 space-y-1">
            <p>
              <span className="text-gray-500">触发: </span>
              {TriggerTypeLabels[task.triggerType]} - {task.triggerValue}
            </p>
            <p>
              <span className="text-gray-500">引擎: </span>
              {task.engineId}
            </p>
            <div className="flex items-center gap-4">
              <span>
                <span className="text-gray-500">状态: </span>
                <StatusBadge status={task.lastRunStatus} />
              </span>
              {task.enabled && task.nextRunAt && (
                <span>
                  <span className="text-gray-500">下次: </span>
                  {formatRelativeTime(task.nextRunAt)}
                </span>
              )}
              {/* 执行轮次显示 */}
              {task.maxRuns !== undefined && task.maxRuns !== null && (
                <span>
                  <span className="text-gray-500">轮次: </span>
                  <span className={task.currentRuns >= task.maxRuns ? 'text-yellow-400' : 'text-gray-300'}>
                    {task.currentRuns}/{task.maxRuns}
                  </span>
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* 有任务路径时显示查看文档按钮 */}
          {task.taskPath && onViewDocs && (
            <button
              onClick={onViewDocs}
              className="px-3 py-1 text-sm bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 rounded transition-colors"
              title="查看任务文档"
            >
              文档
            </button>
          )}
          {/* 订阅执行按钮 - 在 AI 对话窗口实时显示执行过程 */}
          {isSubscribing ? (
            // 正在订阅执行中 - 显示停止按钮
            <button
              onClick={onCancelSubscription}
              className="px-3 py-1 text-sm bg-red-600 hover:bg-red-700 text-white rounded transition-colors flex items-center gap-1"
              title="取消订阅并中断任务"
            >
              ⏹ 停止
            </button>
          ) : isSubscribed ? (
            // 已订阅等待触发 - 显示订阅状态和取消订阅按钮
            <div className="flex items-center gap-1">
              <span className="px-2 py-1 text-xs bg-cyan-600/30 text-cyan-400 rounded flex items-center gap-1">
                🔔 已订阅
              </span>
              <button
                onClick={onUnsubscribe}
                className="px-2 py-1 text-xs bg-gray-600/20 text-gray-400 hover:bg-gray-600/30 rounded transition-colors"
                title="取消订阅"
              >
                取消
              </button>
            </div>
          ) : (
            // 未订阅 - 显示订阅按钮
            <button
              onClick={onSubscribe}
              className="px-3 py-1 text-sm bg-cyan-600/20 text-cyan-400 hover:bg-cyan-600/30 rounded transition-colors flex items-center gap-1"
              title="订阅执行 - 在 AI 对话窗口查看执行过程"
            >
              👁 订阅
            </button>
          )}
          <button
            onClick={onRun}
            className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
            title="立即执行（后台）"
          >
            执行
          </button>
          <button
            onClick={onToggle}
            className={`px-3 py-1 text-sm rounded transition-colors ${
              task.enabled
                ? 'bg-yellow-600/20 text-yellow-400 hover:bg-yellow-600/30'
                : 'bg-green-600/20 text-green-400 hover:bg-green-600/30'
            }`}
          >
            {task.enabled ? '禁用' : '启用'}
          </button>
          <button
            onClick={onEdit}
            className="px-3 py-1 text-sm bg-gray-600/20 text-gray-300 hover:bg-gray-600/30 rounded transition-colors"
          >
            编辑
          </button>
          <button
            onClick={onCopy}
            className="px-3 py-1 text-sm bg-teal-600/20 text-teal-400 hover:bg-teal-600/30 rounded transition-colors"
            title="复制任务"
          >
            复制
          </button>
          <button
            onClick={onDelete}
            className="px-3 py-1 text-sm bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded transition-colors"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

/** 可折叠的内容块 */
function CollapsibleContent({
  label,
  content,
  maxHeight = 100,
  className = 'text-gray-300',
}: {
  label: string;
  content: string;
  maxHeight?: number;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const needsExpand = content.length > 200 || content.split('\n').length > 5;

  return (
    <div>
      <div
        className="flex items-center justify-between text-sm text-gray-400 mb-1 cursor-pointer hover:text-gray-300"
        onClick={() => needsExpand && setExpanded(!expanded)}
      >
        <span>{label}</span>
        {needsExpand && (
          <span className="text-xs text-blue-400">
            {expanded ? '收起' : '展开全部'}
          </span>
        )}
      </div>
      <pre
        className={`text-xs ${className} bg-[#12122a] p-2 rounded overflow-x-auto whitespace-pre-wrap transition-all ${!expanded && needsExpand ? `max-h-[${maxHeight}px] overflow-hidden relative` : ''}`}
        style={!expanded && needsExpand ? { maxHeight: `${maxHeight}px`, overflow: 'hidden' } : {}}
      >
        {content}
        {!expanded && needsExpand && (
          <span className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-[#12122a] to-transparent pointer-events-none" />
        )}
      </pre>
    </div>
  );
}

/** 日志列表 */
function LogList({
  logs,
  tasks,
  pagination,
  filter,
  onFilterChange,
  onPageChange,
}: {
  logs: TaskLog[];
  tasks: ScheduledTask[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  filter: LogFilterState;
  onFilterChange: (filter: LogFilterState) => void;
  onPageChange: (page: number) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // 获取任务选项用于筛选下拉
  const taskOptions = tasks.map((t) => ({ id: t.id, name: t.name }));

  return (
    <div className="space-y-3">
      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-2 p-3 bg-[#1a1a2e] border border-[#2a2a4a] rounded">
        {/* 搜索框 */}
        <input
          type="text"
          placeholder="搜索任务名称..."
          value={filter.search}
          onChange={(e) => onFilterChange({ ...filter, search: e.target.value })}
          className="px-3 py-1.5 text-sm bg-[#12122a] border border-[#2a2a4a] rounded text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 w-48"
        />
        {/* 任务筛选 */}
        <select
          value={filter.taskId}
          onChange={(e) => onFilterChange({ ...filter, taskId: e.target.value })}
          className="px-2 py-1.5 text-sm bg-[#12122a] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
        >
          <option value="">全部任务</option>
          {taskOptions.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        {/* 状态筛选 */}
        <select
          value={filter.status}
          onChange={(e) => onFilterChange({ ...filter, status: e.target.value as LogFilterState['status'] })}
          className="px-2 py-1.5 text-sm bg-[#12122a] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
        >
          <option value="all">全部状态</option>
          <option value="running">执行中</option>
          <option value="success">成功</option>
          <option value="failed">失败</option>
        </select>
        {/* 清除筛选 */}
        <button
          onClick={() => onFilterChange(defaultLogFilter)}
          className="px-3 py-1.5 text-sm bg-gray-600/20 text-gray-400 hover:bg-gray-600/30 rounded transition-colors"
        >
          清除筛选
        </button>
      </div>

      {/* 日志列表 */}
      {logs.length === 0 ? (
        <div className="text-center text-gray-500 py-8">
          暂无执行日志
        </div>
      ) : (
        <div className="space-y-2">
          {logs.map((log) => (
            <div key={log.id} className="bg-[#1a1a2e] rounded-lg p-3 border border-[#2a2a4a]">
              <div
                className="flex items-center justify-between cursor-pointer"
                onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
              >
                <div className="flex items-center gap-3">
                  <StatusBadge status={log.status} />
                  <span className="text-white">{log.taskName}</span>
                </div>
                <div className="text-sm text-gray-400">
                  {formatTime(log.startedAt)}
                  {/* 使用 durationMs 显示耗时 */}
                  {log.durationMs != null && log.durationMs > 0 ? (
                    <span className="ml-2">
                      耗时 {log.durationMs < 1000 ? `${log.durationMs}ms` : `${(log.durationMs / 1000).toFixed(1)}s`}
                    </span>
                  ) : log.finishedAt && log.startedAt ? (
                    <span className="ml-2">
                      耗时 {log.finishedAt - log.startedAt}s
                    </span>
                  ) : null}
                </div>
              </div>

              {expandedId === log.id && (
                <div className="mt-3 pt-3 border-t border-[#2a2a4a] space-y-3">
                  {/* 显示增强字段：Session ID、工具调用次数 */}
                  <div className="flex flex-wrap gap-4 text-xs text-gray-500">
                    {log.sessionId && (
                      <span>
                        Session: <code className="text-blue-400 bg-[#12122a] px-1 rounded">{log.sessionId.slice(0, 8)}...</code>
                      </span>
                    )}
                    {log.toolCallCount != null && log.toolCallCount > 0 && (
                      <span className="text-yellow-400">
                        工具调用: {log.toolCallCount} 次
                      </span>
                    )}
                  </div>

                  {/* 提示词 - 默认折叠 */}
                  <CollapsibleContent
                    label="提示词"
                    content={log.prompt}
                    maxHeight={60}
                    className="text-gray-300"
                  />

                  {/* 显示思考过程摘要 */}
                  {log.thinkingSummary && (
                    <CollapsibleContent
                      label="思考过程"
                      content={log.thinkingSummary}
                      maxHeight={80}
                      className="text-purple-400"
                    />
                  )}

                  {log.output && (
                    <CollapsibleContent
                      label="输出"
                      content={log.output}
                      maxHeight={120}
                      className="text-green-400"
                    />
                  )}

                  {log.error && (
                    <CollapsibleContent
                      label="错误"
                      content={log.error}
                      maxHeight={80}
                      className="text-red-400"
                    />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 分页控制 */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded">
          <div className="text-sm text-gray-400">
            共 {pagination.total} 条日志，第 {pagination.page}/{pagination.totalPages} 页
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onPageChange(pagination.page - 1)}
              disabled={pagination.page <= 1}
              className="px-3 py-1 text-sm bg-[#2a2a4a] text-white rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[#3a3a5a] transition-colors"
            >
              上一页
            </button>
            {/* 页码 */}
            <div className="flex items-center gap-1">
              {Array.from({ length: Math.min(5, pagination.totalPages) }, (_, i) => {
                let pageNum: number;
                if (pagination.totalPages <= 5) {
                  pageNum = i + 1;
                } else if (pagination.page <= 3) {
                  pageNum = i + 1;
                } else if (pagination.page >= pagination.totalPages - 2) {
                  pageNum = pagination.totalPages - 4 + i;
                } else {
                  pageNum = pagination.page - 2 + i;
                }
                return (
                  <button
                    key={pageNum}
                    onClick={() => onPageChange(pageNum)}
                    className={`w-8 h-8 text-sm rounded ${
                      pageNum === pagination.page
                        ? 'bg-blue-500 text-white'
                        : 'bg-[#2a2a4a] text-gray-400 hover:bg-[#3a3a5a]'
                    }`}
                  >
                    {pageNum}
                  </button>
                );
              })}
            </div>
            <button
              onClick={() => onPageChange(pagination.page + 1)}
              disabled={pagination.page >= pagination.totalPages}
              className="px-3 py-1 text-sm bg-[#2a2a4a] text-white rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[#3a3a5a] transition-colors"
            >
              下一页
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 日志设置组件 */
function LogSettings({
  stats,
  config,
  onConfigChange,
  onCleanup,
  cleaning,
}: {
  stats?: {
    totalLogs: number;
    totalTasks: number;
    totalSizeBytes: number;
    lastCleanupAt?: number;
  };
  config: {
    retentionDays: number;
    maxLogsPerTask: number;
    autoCleanupEnabled: boolean;
    autoCleanupIntervalHours: number;
  };
  onConfigChange: (config: {
    retentionDays: number;
    maxLogsPerTask: number;
    autoCleanupEnabled: boolean;
    autoCleanupIntervalHours: number;
  }) => void;
  onCleanup: () => void;
  cleaning: boolean;
}) {
  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const formatTime = (timestamp: number | undefined): string => {
    if (!timestamp) return '从未';
    return new Date(timestamp * 1000).toLocaleString('zh-CN');
  };

  return (
    <div className="space-y-4">
      {/* 日志统计 */}
      <div className="bg-[#1a1a2e] rounded-lg p-4 border border-[#2a2a4a]">
        <h3 className="text-white font-medium mb-3">日志统计</h3>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-gray-400">总日志数：</span>
            <span className="text-white ml-2">{stats?.totalLogs ?? 0}</span>
          </div>
          <div>
            <span className="text-gray-400">有日志的任务：</span>
            <span className="text-white ml-2">{stats?.totalTasks ?? 0}</span>
          </div>
          <div>
            <span className="text-gray-400">存储大小：</span>
            <span className="text-white ml-2">{formatBytes(stats?.totalSizeBytes ?? 0)}</span>
          </div>
          <div>
            <span className="text-gray-400">上次清理：</span>
            <span className="text-white ml-2">{formatTime(stats?.lastCleanupAt)}</span>
          </div>
        </div>
      </div>

      {/* 保留配置 */}
      <div className="bg-[#1a1a2e] rounded-lg p-4 border border-[#2a2a4a]">
        <h3 className="text-white font-medium mb-3">保留策略</h3>
        <div className="space-y-4">
          {/* 保留天数 */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-gray-300 text-sm">保留天数</label>
              <p className="text-xs text-gray-500">超过此天数的日志将被自动清理（0 表示不限）</p>
            </div>
            <select
              value={config.retentionDays}
              onChange={(e) => onConfigChange({ ...config, retentionDays: parseInt(e.target.value) })}
              className="px-3 py-1.5 text-sm bg-[#12122a] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
            >
              <option value={0}>不限</option>
              <option value={7}>7 天</option>
              <option value={14}>14 天</option>
              <option value={30}>30 天</option>
              <option value={60}>60 天</option>
              <option value={90}>90 天</option>
            </select>
          </div>

          {/* 每任务最大日志数 */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-gray-300 text-sm">每任务最大日志数</label>
              <p className="text-xs text-gray-500">每个任务最多保留的日志条数（0 表示不限）</p>
            </div>
            <select
              value={config.maxLogsPerTask}
              onChange={(e) => onConfigChange({ ...config, maxLogsPerTask: parseInt(e.target.value) })}
              className="px-3 py-1.5 text-sm bg-[#12122a] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
            >
              <option value={0}>不限</option>
              <option value={10}>10 条</option>
              <option value={20}>20 条</option>
              <option value={50}>50 条</option>
              <option value={100}>100 条</option>
              <option value={200}>200 条</option>
            </select>
          </div>
        </div>
      </div>

      {/* 自动清理 */}
      <div className="bg-[#1a1a2e] rounded-lg p-4 border border-[#2a2a4a]">
        <h3 className="text-white font-medium mb-3">自动清理</h3>
        <div className="space-y-4">
          {/* 启用自动清理 */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-gray-300 text-sm">启用自动清理</label>
              <p className="text-xs text-gray-500">定时检查并清理过期日志</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={config.autoCleanupEnabled}
                onChange={(e) => onConfigChange({ ...config, autoCleanupEnabled: e.target.checked })}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>

          {/* 清理间隔 */}
          {config.autoCleanupEnabled && (
            <div className="flex items-center justify-between">
              <div>
                <label className="text-gray-300 text-sm">清理间隔</label>
                <p className="text-xs text-gray-500">自动检查清理的时间间隔</p>
              </div>
              <select
                value={config.autoCleanupIntervalHours}
                onChange={(e) => onConfigChange({ ...config, autoCleanupIntervalHours: parseInt(e.target.value) })}
                className="px-3 py-1.5 text-sm bg-[#12122a] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
              >
                <option value={1}>每小时</option>
                <option value={6}>每 6 小时</option>
                <option value={12}>每 12 小时</option>
                <option value={24}>每天</option>
                <option value={72}>每 3 天</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {/* 手动清理 */}
      <div className="bg-[#1a1a2e] rounded-lg p-4 border border-[#2a2a4a]">
        <h3 className="text-white font-medium mb-3">手动清理</h3>
        <p className="text-sm text-gray-400 mb-3">
          立即清理所有超过保留天数的日志。此操作不可撤销。
        </p>
        <button
          onClick={onCleanup}
          disabled={cleaning}
          className="px-4 py-2 bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {cleaning ? '清理中...' : '立即清理过期日志'}
        </button>
      </div>
    </div>
  );
}

/** 分组折叠组件 */
function TaskGroup({
  name,
  tasks,
  defaultExpanded = true,
  children,
}: {
  name: string;
  tasks: ScheduledTask[];
  defaultExpanded?: boolean;
  children: (task: ScheduledTask) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className="mb-4">
      {/* 分组标题 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 bg-[#1a1a2e] rounded-t border border-[#2a2a4a] hover:bg-[#22224a] transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className={`transform transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
          <span className="text-white font-medium">{name}</span>
          <span className="text-xs px-2 py-0.5 bg-[#2a2a4a] text-gray-400 rounded-full">
            {tasks.length}
          </span>
        </div>
        <span className="text-xs text-gray-500">
          {expanded ? '点击收起' : '点击展开'}
        </span>
      </button>

      {/* 任务列表 */}
      {expanded && (
        <div className="space-y-2 p-2 bg-[#16162a] border-x border-b border-[#2a2a4a] rounded-b">
          {tasks.map((task) => children(task))}
        </div>
      )}
    </div>
  );
}

/** 任务筛选状态 */
interface TaskFilter {
  search: string;
  enabled: 'all' | 'enabled' | 'disabled';
  engineId: string;
  triggerType: 'all' | 'once' | 'cron' | 'interval';
  lastRunStatus: 'all' | 'running' | 'success' | 'failed' | 'none';
  group: string;
}

const defaultFilter: TaskFilter = {
  search: '',
  enabled: 'all',
  engineId: 'all',
  triggerType: 'all',
  lastRunStatus: 'all',
  group: 'all',
};

/** 筛选任务 */
function filterTasks(tasks: ScheduledTask[], filter: TaskFilter): ScheduledTask[] {
  return tasks.filter((task) => {
    // 搜索任务名称
    if (filter.search && !task.name.toLowerCase().includes(filter.search.toLowerCase())) {
      return false;
    }
    // 启用状态
    if (filter.enabled === 'enabled' && !task.enabled) return false;
    if (filter.enabled === 'disabled' && task.enabled) return false;
    // 引擎
    if (filter.engineId !== 'all' && task.engineId !== filter.engineId) return false;
    // 触发类型
    if (filter.triggerType !== 'all' && task.triggerType !== filter.triggerType) return false;
    // 执行状态
    if (filter.lastRunStatus !== 'all') {
      if (filter.lastRunStatus === 'none') {
        if (task.lastRunStatus) return false;
      } else {
        if (task.lastRunStatus !== filter.lastRunStatus) return false;
      }
    }
    // 分组
    if (filter.group !== 'all' && (task.group || '默认') !== filter.group) return false;
    return true;
  });
}

/** 任务排序字段 */
type TaskSortBy = 'name' | 'createdAt' | 'nextRunAt' | 'lastRunStatus' | 'enabled';

/** 排序方向 */
type SortOrder = 'asc' | 'desc';

/** 任务排序状态 */
interface TaskSortState {
  sortBy: TaskSortBy;
  sortOrder: SortOrder;
}

const defaultSortState: TaskSortState = {
  sortBy: 'createdAt',
  sortOrder: 'desc',
};

/** 排序任务 */
function sortTasks(tasks: ScheduledTask[], sortState: TaskSortState): ScheduledTask[] {
  const { sortBy, sortOrder } = sortState;
  const multiplier = sortOrder === 'asc' ? 1 : -1;

  return [...tasks].sort((a, b) => {
    switch (sortBy) {
      case 'name':
        return a.name.localeCompare(b.name) * multiplier;
      case 'createdAt': {
        const aTime = a.createdAt || 0;
        const bTime = b.createdAt || 0;
        return (aTime - bTime) * multiplier;
      }
      case 'nextRunAt': {
        const aNext = a.nextRunAt || 0;
        const bNext = b.nextRunAt || 0;
        return (aNext - bNext) * multiplier;
      }
      case 'lastRunStatus': {
        const statusOrder = { running: 0, success: 1, failed: 2, undefined: 3 };
        const aStatus = statusOrder[a.lastRunStatus as keyof typeof statusOrder] ?? 3;
        const bStatus = statusOrder[b.lastRunStatus as keyof typeof statusOrder] ?? 3;
        return (aStatus - bStatus) * multiplier;
      }
      case 'enabled': {
        const aEnabled = a.enabled ? 0 : 1;
        const bEnabled = b.enabled ? 0 : 1;
        return (aEnabled - bEnabled) * multiplier;
      }
      default:
        return 0;
    }
  });
}

/** 日志筛选状态 */
interface LogFilterState {
  search: string;
  status: 'all' | 'running' | 'success' | 'failed';
  taskId: string;
}

const defaultLogFilter: LogFilterState = {
  search: '',
  status: 'all',
  taskId: '',
};

/** 主面板 */
export function SchedulerPanel() {
  const { tasks, logs, logPagination, loading, subscribingTaskId, loadTasks, loadLogs, loadLogsPaginated, createTask, updateTask, deleteTask, toggleTask, runTask, runTaskWithSubscription, clearSubscription, subscribeTask, unsubscribeTask, initSchedulerEventListener } =
    useSchedulerStore();
  const toast = useToastStore();

  // 响应式布局检测
  const [containerRef, containerSize] = useContainerSize({ compactThreshold: 500, wideThreshold: 800 });
  const isCompact = containerSize.isCompact;

  const [showEditor, setShowEditor] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | undefined>();
  const [copyingTask, setCopyingTask] = useState<ScheduledTask | undefined>();
  const [activeTab, setActiveTab] = useState<'tasks' | 'logs' | 'settings'>('tasks');
  const [viewingTask, setViewingTask] = useState<ScheduledTask | undefined>();
  const [filter, setFilter] = useState<TaskFilter>(defaultFilter);
  const [logFilter, setLogFilter] = useState<LogFilterState>(defaultLogFilter);
  const [logPage, setLogPage] = useState(1);
  // 排序状态
  const [sortState, setSortState] = useState<TaskSortState>(defaultSortState);
  // 批量选择状态
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  // 筛选栏折叠状态
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  // 日志设置状态
  const [logStats, setLogStats] = useState<{
    totalLogs: number;
    totalTasks: number;
    totalSizeBytes: number;
    lastCleanupAt?: number;
  } | undefined>();
  const [logRetentionConfig, setLogRetentionConfig] = useState<{
    retentionDays: number;
    maxLogsPerTask: number;
    autoCleanupEnabled: boolean;
    autoCleanupIntervalHours: number;
  }>({
    retentionDays: 30,
    maxLogsPerTask: 100,
    autoCleanupEnabled: true,
    autoCleanupIntervalHours: 24,
  });
  const [cleaning, setCleaning] = useState(false);
  // 调度器状态
  const [lockStatus, setLockStatus] = useState<LockStatus | null>(null);
  const [schedulerOperating, setSchedulerOperating] = useState(false);
  // 确认对话框状态
  const [confirmDialog, setConfirmDialog] = useState<{
    show: boolean;
    title?: string;
    message: string;
    type?: 'danger' | 'warning' | 'info';
    onConfirm: () => void;
  } | null>(null);

  // 从任务列表提取引擎和分组选项
  const engineOptions = [...new Set(tasks.map((t) => t.engineId))].sort();
  const groupOptions = [...new Set(tasks.map((t) => t.group || '默认'))].sort((a, b) => {
    if (a === '默认') return 1;
    if (b === '默认') return -1;
    return a.localeCompare(b);
  });

  // 应用筛选
  const filteredTasks = filterTasks(tasks, filter);

  // 按分组整理筛选后的任务，并排序
  const groupedTasks = filteredTasks.reduce((acc, task) => {
    const groupKey = task.group || '默认';
    if (!acc[groupKey]) {
      acc[groupKey] = [];
    }
    acc[groupKey].push(task);
    return acc;
  }, {} as Record<string, ScheduledTask[]>);

  // 对每个分组内的任务进行排序
  Object.keys(groupedTasks).forEach((groupKey) => {
    groupedTasks[groupKey] = sortTasks(groupedTasks[groupKey], sortState);
  });

  // 获取排序后的分组名
  const groupNames = Object.keys(groupedTasks).sort((a, b) => {
    // "默认" 组放在最后
    if (a === '默认') return 1;
    if (b === '默认') return -1;
    return a.localeCompare(b);
  });

  // 初始化事件监听
  useEffect(() => {
    // 通过参数注入方式获取当前会话 ID，避免 schedulerStore 直接依赖 eventChatStore
    const cleanup = initSchedulerEventListener(() => useEventChatStore.getState().conversationId);
    return () => {
      cleanup();
    };
  }, [initSchedulerEventListener]);

  useEffect(() => {
    loadTasks();
    loadLockStatus();
  }, [loadTasks]);

  /** 加载调度器锁状态 */
  const loadLockStatus = async () => {
    try {
      const status = await tauri.schedulerGetLockStatus();
      setLockStatus(status);
    } catch (e) {
      log.error('获取锁状态失败', e instanceof Error ? e : new Error(String(e)));
    }
  };

  /** 启动调度器 */
  const handleStartScheduler = async () => {
    setSchedulerOperating(true);
    try {
      const result = await tauri.schedulerStart();
      toast.success(result);
      await loadLockStatus();
    } catch (e) {
      toast.error('启动失败', e instanceof Error ? e.message : '其他实例占用任务');
    } finally {
      setSchedulerOperating(false);
    }
  };

  /** 停止调度器 */
  const handleStopScheduler = () => {
    setConfirmDialog({
      show: true,
      title: '停止调度器',
      message: '确定要停止调度器吗？\n定时任务将不再自动执行。',
      type: 'warning',
      onConfirm: async () => {
        setConfirmDialog(null);
        setSchedulerOperating(true);
        try {
          const result = await tauri.schedulerStop();
          toast.success(result);
          await loadLockStatus();
        } catch (e) {
          toast.error('停止失败', e instanceof Error ? e.message : '未知错误');
        } finally {
          setSchedulerOperating(false);
        }
      }
    });
  };

  // 切换到日志标签页时加载分页日志
  useEffect(() => {
    if (activeTab === 'logs') {
      loadLogsPaginated(logFilter.taskId || undefined, logPage, 20);
    }
  }, [activeTab, logPage, logFilter.taskId, loadLogsPaginated]);

  // 切换到设置标签页时加载日志统计和配置
  useEffect(() => {
    if (activeTab === 'settings') {
      loadLogSettings();
    }
  }, [activeTab]);

  /** 加载日志统计和配置 */
  const loadLogSettings = async () => {
    try {
      const [stats, config] = await Promise.all([
        tauri.schedulerGetLogStats(),
        tauri.schedulerGetLogRetentionConfig(),
      ]);
      setLogStats(stats);
      setLogRetentionConfig(config);
    } catch (e) {
      console.error('加载日志设置失败:', e);
    }
  };

  /** 处理配置更改 */
  const handleConfigChange = async (newConfig: typeof logRetentionConfig) => {
    setLogRetentionConfig(newConfig);
    try {
      await tauri.schedulerUpdateLogRetentionConfig(newConfig);
      toast.success('配置已保存', '日志保留策略已更新');
    } catch (e) {
      toast.error('保存失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  /** 处理手动清理 */
  const handleCleanup = async () => {
    setConfirmDialog({
      show: true,
      title: '确认清理',
      message: '确定要清理过期日志吗？此操作不可撤销。',
      type: 'warning',
      onConfirm: async () => {
        setConfirmDialog(null);
        setCleaning(true);
        try {
          const count = await tauri.schedulerCleanupLogs();
          toast.success('清理完成', `已清理 ${count} 条过期日志`);
          // 刷新统计
          loadLogSettings();
        } catch (e) {
          toast.error('清理失败', e instanceof Error ? e.message : '未知错误');
        } finally {
          setCleaning(false);
        }
      }
    });
  };

  // 前端筛选日志（搜索和状态）
  const filteredLogs = logs.filter((log) => {
    // 搜索筛选
    if (logFilter.search && !log.taskName.toLowerCase().includes(logFilter.search.toLowerCase())) {
      return false;
    }
    // 状态筛选
    if (logFilter.status !== 'all' && log.status !== logFilter.status) {
      return false;
    }
    return true;
  });

  /** 处理立即执行任务（后台执行） */
  const handleRunTask = async (task: ScheduledTask) => {
    try {
      await runTask(task.id);
      // 任务在后台执行，这里只是提交成功
      toast.info('任务已提交', `任务 ${task.name} 已在后台开始执行`);
      // 刷新任务列表和日志
      loadTasks();
      if (activeTab === 'logs') {
        loadLogsPaginated(logFilter.taskId || undefined, logPage, 20);
      }
    } catch (e) {
      toast.error('提交失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  /** 取消订阅（中断正在执行的任务） */
  const handleCancelSubscription = async () => {
    // 通过 eventChatStore 的 interruptChat 来中断
    try {
      await useEventChatStore.getState().interruptChat();
      toast.info('已中断', '任务执行已被中断');
    } catch (e) {
      console.error('中断任务失败:', e);
    }
    clearSubscription();
  };

  /** 订阅并立即执行任务（在 AI 对话窗口实时显示） */
  const handleSubscribeAndRun = async (task: ScheduledTask) => {
    // 防抖：如果已有任务在执行，不允许再次点击
    if (subscribingTaskId) {
      toast.warning('请等待', '已有任务在执行中，请等待完成后再试');
      return;
    }

    try {
      // 获取当前会话 ID 作为上下文 ID
      const conversationId = useEventChatStore.getState().conversationId;
      
      // 先持久化订阅状态
      if (conversationId) {
        await subscribeTask(task.id, conversationId);
      }
      
      await runTaskWithSubscription(task.id, task.name, conversationId || undefined);
      toast.info('订阅执行', `任务「${task.name}」正在执行，请在 AI 对话窗口查看实时进度`);
      // 刷新任务列表和日志
      loadTasks();
      if (activeTab === 'logs') {
        loadLogsPaginated(logFilter.taskId || undefined, logPage, 20);
      }
    } catch (e) {
      toast.error('执行失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  /** 取消任务订阅 */
  const handleUnsubscribe = async (task: ScheduledTask) => {
    try {
      await unsubscribeTask(task.id);
      toast.info('已取消订阅', `任务「${task.name}」已取消订阅`);
      loadTasks();
    } catch (e) {
      toast.error('取消订阅失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  /** 切换任务选择状态 */
  const handleToggleSelect = (taskId: string) => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  /** 全选/取消全选筛选后的任务 */
  const handleSelectAll = () => {
    if (selectedTaskIds.size === filteredTasks.length) {
      // 已全选，取消全选
      setSelectedTaskIds(new Set());
    } else {
      // 全选
      setSelectedTaskIds(new Set(filteredTasks.map((t) => t.id)));
    }
  };

  /** 退出选择模式 */
  const handleExitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedTaskIds(new Set());
  };

  /** 批量启用任务 */
  const handleBatchEnable = async () => {
    const selectedTasks = tasks.filter((t) => selectedTaskIds.has(t.id) && !t.enabled);
    if (selectedTasks.length === 0) {
      toast.warning('提示', '没有可启用的任务');
      return;
    }
    try {
      for (const task of selectedTasks) {
        await toggleTask(task.id, true);
        await runTask(task.id);
      }
      toast.success('批量启用成功', `已启用并启动 ${selectedTasks.length} 个任务`);
      loadTasks();
      loadLogs(50);
    } catch (e) {
      toast.error('批量启用失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  /** 批量禁用任务 */
  const handleBatchDisable = async () => {
    const selectedTasks = tasks.filter((t) => selectedTaskIds.has(t.id) && t.enabled);
    if (selectedTasks.length === 0) {
      toast.warning('提示', '没有可禁用的任务');
      return;
    }
    try {
      for (const task of selectedTasks) {
        await toggleTask(task.id, false);
      }
      toast.success('批量禁用成功', `已禁用 ${selectedTasks.length} 个任务`);
      loadTasks();
    } catch (e) {
      toast.error('批量禁用失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  /** 批量删除任务 */
  const handleBatchDelete = async () => {
    const selectedTasks = tasks.filter((t) => selectedTaskIds.has(t.id));
    if (selectedTasks.length === 0) {
      toast.warning('提示', '请先选择要删除的任务');
      return;
    }
    setConfirmDialog({
      show: true,
      title: '确认批量删除',
      message: `确定要删除选中的 ${selectedTasks.length} 个任务吗？此操作不可恢复。`,
      type: 'danger',
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          for (const task of selectedTasks) {
            await deleteTask(task.id);
          }
          toast.success('批量删除成功', `已删除 ${selectedTasks.length} 个任务`);
          setSelectedTaskIds(new Set());
          loadTasks();
        } catch (e) {
          toast.error('批量删除失败', e instanceof Error ? e.message : '未知错误');
        }
      }
    });
  };

  const handleToggleTask = async (task: ScheduledTask) => {
    try {
      await toggleTask(task.id, !task.enabled);

      if (task.enabled) {
        toast.success(`任务「${task.name}」已禁用`);
        return;
      }

      await runTask(task.id);
      toast.success(`任务「${task.name}」已启用并开始执行`);
      loadLogs(50);
    } catch (e) {
      toast.error(task.enabled ? '禁用失败' : '启用失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  const handleCreate = async (params: CreateTaskParams) => {
    try {
      await createTask(params);
      toast.success('创建成功');
      setShowEditor(false);
    } catch (e) {
      toast.error('创建失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  /** 处理复制任务 */
  const handleCopy = (task: ScheduledTask) => {
    // 清除编辑状态，设置复制状态
    setEditingTask(undefined);
    // 复制任务，清除运行时状态字段
    setCopyingTask({
      ...task,
      name: `${task.name}（副本）`,
      // 清除运行时状态
      conversationSessionId: undefined,
      subscribedContextId: undefined,
      retryCount: 0,
      currentRuns: 0,
      lastRunStatus: undefined,
      lastRunAt: undefined,
      nextRunAt: undefined,
    });
    setShowEditor(true);
  };

  /** 处理复制任务保存 */
  const handleCopySave = async (params: CreateTaskParams) => {
    try {
      await createTask(params);
      toast.success('复制成功');
      setShowEditor(false);
      setCopyingTask(undefined);
    } catch (e) {
      toast.error('复制失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  const handleUpdate = async (params: CreateTaskParams) => {
    if (!editingTask) return;
    try {
      await updateTask({
        ...editingTask,
        ...params,
      });
      toast.success('更新成功');
      setShowEditor(false);
      setEditingTask(undefined);
    } catch (e) {
      toast.error('更新失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  const handleDelete = async (id: string) => {
    setConfirmDialog({
      show: true,
      title: '确认删除',
      message: '确定要删除这个任务吗？此操作不可恢复。',
      type: 'danger',
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await deleteTask(id);
          toast.success('删除成功');
        } catch (e) {
          toast.error('删除失败', e instanceof Error ? e.message : '未知错误');
        }
      }
    });
  };

  /** 重置任务会话 */
  const handleResetSession = async (id: string) => {
    setConfirmDialog({
      show: true,
      title: '重置会话',
      message: '确定要重置此任务的会话吗？下次执行将使用新会话，当前会话上下文将无法恢复。',
      type: 'warning',
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await tauri.schedulerResetTaskSession(id);
          await loadTasks(); // 刷新任务列表
          toast.success('会话已重置');
        } catch (e) {
          toast.error('重置失败', e instanceof Error ? e.message : '未知错误');
        }
      }
    });
  };

  /** 将任务转换为导出格式 */
  const taskToExportItem = (task: ScheduledTask): TaskExportItem => ({
    name: task.name,
    enabled: task.enabled,
    triggerType: task.triggerType,
    triggerValue: task.triggerValue,
    engineId: task.engineId,
    prompt: task.prompt,
    workDir: task.workDir,
    group: task.group,
    maxRuns: task.maxRuns,
    reuseSession: task.reuseSession,
    continueImmediately: task.continueImmediately,
    maxContinuousRuns: task.maxContinuousRuns,
    runInTerminal: task.runInTerminal,
    templateId: task.templateId,
    templateParamValues: task.templateParamValues,
    maxRetries: task.maxRetries,
    retryInterval: task.retryInterval,
    notifyOnComplete: task.notifyOnComplete ?? true,
  });

  /** 处理导出任务 */
  const handleExportTasks = async () => {
    // 确定要导出的任务
    const tasksToExport = selectionMode && selectedTaskIds.size > 0
      ? filteredTasks.filter(t => selectedTaskIds.has(t.id))
      : filteredTasks;

    if (tasksToExport.length === 0) {
      toast.warning('无可导出任务', '请选择要导出的任务');
      return;
    }

    try {
      const exportItems = tasksToExport.map(taskToExportItem);
      const success = await tauri.schedulerExportTasks(exportItems);
      if (success) {
        toast.success('导出成功', `已导出 ${tasksToExport.length} 个任务`);
      }
    } catch (e) {
      toast.error('导出失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  /** 处理导入任务 */
  const handleImportTasks = async () => {
    try {
      const importItems = await tauri.schedulerImportTasks();
      if (importItems.length === 0) {
        return; // 用户取消
      }

      let successCount = 0;
      let failCount = 0;

      for (const item of importItems) {
        try {
          const params: CreateTaskParams = {
            name: item.name,
            enabled: item.enabled,
            triggerType: item.triggerType as 'once' | 'cron' | 'interval',
            triggerValue: item.triggerValue,
            engineId: item.engineId,
            prompt: item.prompt,
            workDir: item.workDir,
            group: item.group,
            maxRuns: item.maxRuns,
            reuseSession: item.reuseSession,
            continueImmediately: item.continueImmediately,
            maxContinuousRuns: item.maxContinuousRuns,
            runInTerminal: item.runInTerminal,
            templateId: item.templateId,
            templateParamValues: item.templateParamValues,
            maxRetries: item.maxRetries,
            retryInterval: item.retryInterval,
            notifyOnComplete: item.notifyOnComplete,
          };
          await createTask(params);
          successCount++;
        } catch {
          failCount++;
        }
      }

      if (successCount > 0) {
        toast.success('导入完成', `成功导入 ${successCount} 个任务${failCount > 0 ? `，失败 ${failCount} 个` : ''}`);
        loadTasks();
      } else {
        toast.error('导入失败', '所有任务导入失败');
      }
    } catch (e) {
      toast.error('导入失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  return (
    <div ref={containerRef} className="h-full flex flex-col bg-[#12122a]">
      {/* 头部 */}
      <div className="p-4 border-b border-[#2a2a4a] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-medium text-white flex items-center gap-2">
            定时任务
          </h1>
          {/* 调度器状态指示器 */}
          {lockStatus && (
            <span className={`px-2 py-0.5 rounded text-xs flex items-center gap-1 ${
              lockStatus.isHolder
                ? 'bg-green-500/20 text-green-400'
                : 'bg-red-500/20 text-red-400'
            }`}>
              <span className={`w-2 h-2 rounded-full ${lockStatus.isHolder ? 'bg-green-500' : 'bg-red-500'}`} />
              {lockStatus.isHolder ? '调度中' : '已停止'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* 调度器控制按钮 */}
          {lockStatus && (
            lockStatus.isHolder ? (
              <button
                onClick={handleStopScheduler}
                disabled={schedulerOperating}
                className="px-3 py-1.5 text-sm bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="停止调度器"
              >
                {isCompact ? '⏹' : '停止调度'}
              </button>
            ) : (
              <button
                onClick={handleStartScheduler}
                disabled={schedulerOperating}
                className="px-3 py-1.5 text-sm bg-green-600/20 text-green-400 hover:bg-green-600/30 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="启动调度器"
              >
                {isCompact ? '▶' : '启动调度'}
              </button>
            )
          )}
          <button
            onClick={handleImportTasks}
            className="px-3 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded transition-colors text-sm"
          >
            {isCompact ? '↓' : '导入'}
          </button>
          <button
            onClick={() => {
              setEditingTask(undefined);
              setShowEditor(true);
            }}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
          >
            + 新建
          </button>
        </div>
      </div>

      {/* 标签页 */}
      <div className="border-b border-[#2a2a4a]">
        <div className="flex">
          <button
            onClick={() => setActiveTab('tasks')}
            className={`px-4 py-2 text-sm transition-colors ${
              activeTab === 'tasks'
                ? 'text-blue-400 border-b-2 border-blue-400'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            任务列表 ({tasks.length})
          </button>
          <button
            onClick={() => setActiveTab('logs')}
            className={`px-4 py-2 text-sm transition-colors ${
              activeTab === 'logs'
                ? 'text-blue-400 border-b-2 border-blue-400'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            执行日志 ({logs.length})
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`px-4 py-2 text-sm transition-colors ${
              activeTab === 'settings'
                ? 'text-blue-400 border-b-2 border-blue-400'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            设置
          </button>
        </div>
      </div>

      {/* 筛选栏 - 仅在任务列表标签页显示 */}
      {activeTab === 'tasks' && (
        <div className="p-3 border-b border-[#2a2a4a] bg-[#1a1a2e]">
          <div className="flex flex-wrap items-center gap-2">
            {/* 搜索框 */}
            <input
              type="text"
              placeholder="搜索..."
              value={filter.search}
              onChange={(e) => setFilter({ ...filter, search: e.target.value })}
              className={`px-3 py-1.5 text-sm bg-[#12122a] border border-[#2a2a4a] rounded text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 ${isCompact ? 'w-24' : 'w-48'}`}
            />
            {/* 状态筛选 - 核心筛选，始终显示 */}
            <select
              value={filter.enabled}
              onChange={(e) => setFilter({ ...filter, enabled: e.target.value as TaskFilter['enabled'] })}
              className="px-2 py-1.5 text-sm bg-[#12122a] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
            >
              <option value="all">全部状态</option>
              <option value="enabled">已启用</option>
              <option value="disabled">已禁用</option>
            </select>

            {/* 紧凑模式：更多筛选按钮 */}
            {isCompact && (
              <button
                onClick={() => setShowMoreFilters(!showMoreFilters)}
                className={`px-2 py-1.5 text-sm rounded transition-colors ${
                  showMoreFilters
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-600/20 text-gray-400 hover:bg-gray-600/30'
                }`}
              >
                {showMoreFilters ? '收起' : '更多'}
              </button>
            )}

            {/* 正常模式或紧凑模式下展开时显示所有筛选 */}
            {(!isCompact || showMoreFilters) && (
              <>
                {/* 引擎筛选 */}
                <select
                  value={filter.engineId}
                  onChange={(e) => setFilter({ ...filter, engineId: e.target.value })}
                  className="px-2 py-1.5 text-sm bg-[#12122a] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="all">全部引擎</option>
                  {engineOptions.map((engine) => (
                    <option key={engine} value={engine}>{engine}</option>
                  ))}
                </select>
                {/* 触发类型筛选 */}
                <select
                  value={filter.triggerType}
                  onChange={(e) => setFilter({ ...filter, triggerType: e.target.value as TaskFilter['triggerType'] })}
                  className="px-2 py-1.5 text-sm bg-[#12122a] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="all">全部触发</option>
                  <option value="once">一次性</option>
                  <option value="cron">Cron</option>
                  <option value="interval">间隔</option>
                </select>
                {/* 执行状态筛选 */}
                <select
                  value={filter.lastRunStatus}
                  onChange={(e) => setFilter({ ...filter, lastRunStatus: e.target.value as TaskFilter['lastRunStatus'] })}
                  className="px-2 py-1.5 text-sm bg-[#12122a] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="all">全部执行状态</option>
                  <option value="running">执行中</option>
                  <option value="success">成功</option>
                  <option value="failed">失败</option>
                  <option value="none">未执行</option>
                </select>
                {/* 分组筛选 */}
                <select
                  value={filter.group}
                  onChange={(e) => setFilter({ ...filter, group: e.target.value })}
                  className="px-2 py-1.5 text-sm bg-[#12122a] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="all">全部分组</option>
                  {groupOptions.map((group) => (
                    <option key={group} value={group}>{group}</option>
                  ))}
                </select>
                {/* 排序 */}
                <select
                  value={`${sortState.sortBy}-${sortState.sortOrder}`}
                  onChange={(e) => {
                    const [sortBy, sortOrder] = e.target.value.split('-') as [TaskSortBy, SortOrder];
                    setSortState({ sortBy, sortOrder });
                  }}
                  className="px-2 py-1.5 text-sm bg-[#12122a] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="createdAt-desc">创建时间 ↓</option>
                  <option value="createdAt-asc">创建时间 ↑</option>
                  <option value="name-asc">名称 A-Z</option>
                  <option value="name-desc">名称 Z-A</option>
                  <option value="nextRunAt-asc">下次执行 ↑</option>
                  <option value="nextRunAt-desc">下次执行 ↓</option>
                  <option value="lastRunStatus-asc">执行状态 ↑</option>
                  <option value="lastRunStatus-desc">执行状态 ↓</option>
                  <option value="enabled-asc">启用状态 ↑</option>
                  <option value="enabled-desc">启用状态 ↓</option>
                </select>
              </>
            )}

            {/* 清除筛选 */}
            <button
              onClick={() => setFilter(defaultFilter)}
              className="px-3 py-1.5 text-sm bg-gray-600/20 text-gray-400 hover:bg-gray-600/30 rounded transition-colors"
            >
              {isCompact ? '重置' : '清除筛选'}
            </button>
            {/* 筛选结果数量 */}
            {filteredTasks.length !== tasks.length && (
              <span className="text-xs text-gray-500 ml-2">
                {filteredTasks.length}/{tasks.length}
              </span>
            )}
            {/* 选择模式切换按钮 */}
            <button
              onClick={() => {
                if (selectionMode) {
                  handleExitSelectionMode();
                } else {
                  setSelectionMode(true);
                }
              }}
              className={`px-3 py-1.5 text-sm rounded transition-colors ${
                selectionMode
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-gray-600/20 text-gray-400 hover:bg-gray-600/30'
              }`}
            >
              {selectionMode ? '退出' : isCompact ? '多选' : '批量选择'}
            </button>
            {/* 导出按钮 */}
            {!isCompact && (
              <button
                onClick={handleExportTasks}
                className="px-3 py-1.5 text-sm bg-gray-600/20 text-gray-400 hover:bg-gray-600/30 rounded transition-colors"
              >
                导出
              </button>
            )}
          </div>
        </div>
      )}

      {/* 内容 */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="text-center text-gray-500 py-8">加载中...</div>
        ) : activeTab === 'tasks' ? (
          tasks.length === 0 ? (
            <div className="text-center text-gray-500 py-8">
              暂无定时任务，点击右上角按钮创建
            </div>
          ) : (
            <div className="space-y-2">
              {/* 按分组显示任务 */}
              {groupNames.map((groupName) => (
                <TaskGroup
                  key={groupName}
                  name={groupName}
                  tasks={groupedTasks[groupName]}
                >
                  {(task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      showGroupTag={groupNames.length > 1}
                      isCompact={isCompact}
                      onEdit={() => {
                        setCopyingTask(undefined);
                        setEditingTask(task);
                        setShowEditor(true);
                      }}
                      onCopy={() => handleCopy(task)}
                      onDelete={() => handleDelete(task.id)}
                      onToggle={() => handleToggleTask(task)}
                      onRun={() => handleRunTask(task)}
                      onSubscribe={() => handleSubscribeAndRun(task)}
                      onCancelSubscription={handleCancelSubscription}
                      onUnsubscribe={() => handleUnsubscribe(task)}
                      onViewDocs={() => setViewingTask(task)}
                      onResetSession={() => handleResetSession(task.id)}
                      isSubscribing={subscribingTaskId === task.id}
                      isSubscribed={!!task.subscribedContextId}
                      selectionMode={selectionMode}
                      isSelected={selectedTaskIds.has(task.id)}
                      onSelect={() => handleToggleSelect(task.id)}
                    />
                  )}
                </TaskGroup>
              ))}
            </div>
          )
        ) : activeTab === 'logs' ? (
          <LogList
            logs={filteredLogs}
            tasks={tasks}
            pagination={logPagination}
            filter={logFilter}
            onFilterChange={(newFilter) => {
              setLogFilter(newFilter);
              setLogPage(1); // 筛选变化时重置页码
            }}
            onPageChange={setLogPage}
          />
        ) : activeTab === 'settings' ? (
          <LogSettings
            stats={logStats}
            config={logRetentionConfig}
            onConfigChange={handleConfigChange}
            onCleanup={handleCleanup}
            cleaning={cleaning}
          />
        ) : null}
      </div>

      {/* 批量操作工具栏 */}
      {selectionMode && activeTab === 'tasks' && (
        <div className="p-3 border-t border-[#2a2a4a] bg-[#1a1a2e] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-400">
              {isCompact ? `${selectedTaskIds.size}/${filteredTasks.length}` : `已选择 ${selectedTaskIds.size}/${filteredTasks.length} 个任务`}
            </span>
            <button
              onClick={handleSelectAll}
              className="px-2 py-1 text-sm bg-gray-600/20 text-gray-300 hover:bg-gray-600/30 rounded transition-colors"
            >
              {selectedTaskIds.size === filteredTasks.length ? '取消' : '全选'}
            </button>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleBatchEnable}
              disabled={selectedTaskIds.size === 0}
              className={`px-2 py-1 text-sm bg-green-600/20 text-green-400 hover:bg-green-600/30 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${isCompact ? 'text-xs' : ''}`}
            >
              {isCompact ? '启用' : '批量启用'}
            </button>
            <button
              onClick={handleBatchDisable}
              disabled={selectedTaskIds.size === 0}
              className={`px-2 py-1 text-sm bg-yellow-600/20 text-yellow-400 hover:bg-yellow-600/30 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${isCompact ? 'text-xs' : ''}`}
            >
              {isCompact ? '禁用' : '批量禁用'}
            </button>
            <button
              onClick={handleBatchDelete}
              disabled={selectedTaskIds.size === 0}
              className={`px-2 py-1 text-sm bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${isCompact ? 'text-xs' : ''}`}
            >
              {isCompact ? '删除' : '批量删除'}
            </button>
          </div>
        </div>
      )}

      {/* 编辑弹窗 */}
      {showEditor && (
        <TaskEditor
          task={editingTask || copyingTask}
          onSave={editingTask ? handleUpdate : (copyingTask ? handleCopySave : handleCreate)}
          title={editingTask ? '编辑任务' : (copyingTask ? '复制任务' : '新建任务')}
          onClose={() => {
            setShowEditor(false);
            setEditingTask(undefined);
            setCopyingTask(undefined);
          }}
        />
      )}

      {/* 协议文档查看器 */}
      {viewingTask && (
        <ProtocolDocViewer
          task={viewingTask}
          onClose={() => setViewingTask(undefined)}
        />
      )}

      {/* 确认对话框 */}
      {confirmDialog?.show && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          type={confirmDialog.type}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </div>
  );
}

/** 协议文档查看器 */
function ProtocolDocViewer({
  task,
  onClose,
}: {
  task: ScheduledTask;
  onClose: () => void;
}) {
  const toast = useToastStore();
  const [activeDoc, setActiveDoc] = useState<'task' | 'supplement' | 'memory' | 'memory_tasks' | 'memory_runs'>('task');
  const [content, setContent] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState('');
  const [loading, setLoading] = useState(true);

  const fileType: ProtocolFileType = activeDoc === 'memory' ? 'memory_index' : activeDoc;
  const docPath =
    activeDoc === 'memory'
      ? 'memory/index.md'
      : activeDoc === 'memory_tasks'
        ? 'memory/tasks.md'
        : activeDoc === 'memory_runs'
          ? 'memory/runs.md'
          : `${activeDoc}.md`;

  // 读取文档内容
  useEffect(() => {
    if (!task.workDir || !task.taskPath) return;

    setLoading(true);

    tauri.schedulerReadProtocolFile(task.workDir, task.taskPath, fileType)
      .then((data) => {
        setContent(data);
        setEditedContent(data);
      })
      .catch((e) => {
        toast.error('读取文档失败', e instanceof Error ? e.message : '未知错误');
      })
      .finally(() => setLoading(false));
  }, [task, activeDoc, toast]);

  const handleSave = async () => {
    if (!task.workDir || !task.taskPath) return;

    try {
      await tauri.schedulerWriteProtocolFile(task.workDir, task.taskPath, fileType, editedContent);
      setContent(editedContent);
      setIsEditing(false);
      toast.success('保存成功');
    } catch (e) {
      toast.error('保存失败', e instanceof Error ? e.message : '未知错误');
    }
  };

  const docTabs = [
    { id: 'task' as const, label: '协议文档' },
    { id: 'supplement' as const, label: '用户补充' },
    { id: 'memory' as const, label: '记忆索引' },
    { id: 'memory_tasks' as const, label: '任务队列' },
    { id: 'memory_runs' as const, label: '执行记录' },
  ];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[#16162a] rounded-lg w-[800px] h-[80vh] flex flex-col border border-[#2a2a4a]">
        {/* 头部 */}
        <div className="p-4 border-b border-[#2a2a4a] flex items-center justify-between">
          <h2 className="text-lg font-medium text-white">
            {task.name} - 文档管理
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            ✕
          </button>
        </div>

        {/* 文档标签页 */}
        <div className="border-b border-[#2a2a4a]">
          <div className="flex">
            {docTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  setActiveDoc(tab.id);
                  setIsEditing(false);
                }}
                className={`px-4 py-2 text-sm transition-colors ${
                  activeDoc === tab.id
                    ? 'text-purple-400 border-b-2 border-purple-400'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-hidden p-4">
          {loading ? (
            <div className="text-center text-gray-500 py-8">加载中...</div>
          ) : isEditing ? (
            <textarea
              value={editedContent}
              onChange={(e) => setEditedContent(e.target.value)}
              className="w-full h-full p-3 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-purple-500 resize-none font-mono text-sm"
            />
          ) : (
            <pre className="w-full h-full p-3 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-gray-300 overflow-auto text-sm whitespace-pre-wrap">
              {content || '(空文档)'}
            </pre>
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="p-4 border-t border-[#2a2a4a] flex justify-between items-center">
          <div className="text-xs text-gray-500">
            路径: {task.taskPath}/{docPath}
          </div>
          <div className="flex gap-2">
            {isEditing ? (
              <>
                <button
                  onClick={() => setIsEditing(false)}
                  className="px-4 py-2 bg-gray-600/20 text-gray-300 hover:bg-gray-600/30 rounded transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleSave}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded transition-colors"
                >
                  保存
                </button>
              </>
            ) : (
              <button
                onClick={() => {
                  setEditedContent(content);
                  setIsEditing(true);
                }}
                className="px-4 py-2 bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 rounded transition-colors"
              >
                编辑
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SchedulerPanel;
