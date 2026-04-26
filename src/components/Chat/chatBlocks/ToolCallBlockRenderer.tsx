/**
 * 工具调用块渲染器 - 优化版本
 */

import { memo, useState, useMemo, useCallback } from 'react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Check, XCircle, ChevronDown, ChevronRight, Code, FileDiff, Copy } from 'lucide-react';
import type { ToolCallBlock } from '../../../types';
import { getToolConfig, extractToolKeyInfo, getToolShortName } from '../../../utils/toolConfig';
import { extractFullFilePath, extractFullCommand } from '../../../utils/toolInputExtractor';
import { copyToClipboard } from '../../../utils/clipboard';
import { useFileEditorStore } from '../../../stores/fileEditorStore';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import {
  formatDuration,
  calculateDuration,
  generateCollapsedSummary,
  stripAnsiCodes,
  parseGrepMatches,
} from '../../../utils/toolSummary';
import { DiffViewer } from '../../Diff/DiffViewer';
import { isEditTool } from '../../../utils/diffExtractor';
import { STATUS_CONFIG } from '../chatUtils/constants';
import { isTodoWriteTool, isGrepTool, parseTodoInput } from '../chatUtils/helpers';
import { GrepOutputRenderer } from './GrepOutputRenderer';
import { TodoWriteInputRenderer } from './TodoWriteRenderer';

export const ToolCallBlockRenderer = memo(function ToolCallBlockRenderer({ block }: { block: ToolCallBlock }) {
  const { t } = useTranslation('chat');
  // 始终默认折叠（流式时也不展开，避免界面跳动）
  const [isExpanded, setIsExpanded] = useState(false);
  const [showFullOutput, setShowFullOutput] = useState(false);
  const [showToolDetails, setShowToolDetails] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);

  // 获取工具配置
  const toolConfig = useMemo(() => getToolConfig(block.name), [block.name]);

  // 文件路径点击打开编辑器
  const openFile = useFileEditorStore((s) => s.openFile);
  const currentWorkspace = useWorkspaceStore((s) => {
    const { workspaces, currentWorkspaceId } = s;
    return workspaces.find(w => w.id === currentWorkspaceId) || null;
  });
  const fullFilePath = useMemo(() => extractFullFilePath(block.input), [block.input]);

  const handleFilePathClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!fullFilePath) return;
    const isAbsolute = fullFilePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(fullFilePath);
    const absolutePath = isAbsolute
      ? fullFilePath
      : currentWorkspace
        ? (currentWorkspace.path.replace(/[\\/]+$/, '') + '/' + fullFilePath.replace(/^[\\/]+/, ''))
        : fullFilePath;
    const fileName = fullFilePath.split(/[/\\]/).pop() || fullFilePath;
    openFile(absolutePath, fileName);
  }, [fullFilePath, currentWorkspace, openFile]);

  // 状态图标
  const statusConfig = STATUS_CONFIG[block.status] || STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;

  // 计算耗时
  const duration = useMemo(() => {
    if (block.duration) return formatDuration(block.duration);
    const calculated = calculateDuration(block.startedAt, block.completedAt);
    return calculated ? formatDuration(calculated) : '';
  }, [block.duration, block.startedAt, block.completedAt]);

  // 提取关键信息
  const keyInfo = useMemo(() => extractToolKeyInfo(block.name, block.input), [block.name, block.input]);

  // Edit 工具的简化输出提示
  const editOutputSummary = useMemo(() => {
    if (!isEditTool(block.name) || block.status !== 'completed') {
      return null;
    }

    if (block.output) {
      const output = block.output.toLowerCase();
      // 成功
      if (output.includes('has been updated') ||
          output.includes('successfully edited') ||
          output.includes('edited successfully')) {
        return {
          type: 'success',
          text: t('tool.fileUpdated')
        };
      }
      // 失败
      if (output.includes('failed') ||
          output.includes('error') ||
          output.includes('could not')) {
        return {
          type: 'error',
          text: t('tool.fileUpdateFailed')
        };
      }
    }

    return null;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable i18n function
  }, [block.output, block.name, block.status]);

  // 解析 TodoWrite 数据
  const todoData = useMemo(() => {
    if (isTodoWriteTool(block)) {
      return parseTodoInput(block.input);
    }
    return null;
  }, [block]);

  // 解析 Grep 数据
  const grepData = useMemo(() => {
    if (isGrepTool(block) && block.output) {
      return parseGrepMatches(block.output, block.input);
    }
    return null;
  }, [block]);

  // 判断输出是否需要展开功能
  const outputNeedsExpand = (block.output?.length ?? 0) > 1000;

  // 生成折叠状态的简化摘要（用于单行显示）
  const collapsedSummary = useMemo(() => {
    if (block.status === 'completed' || block.status === 'failed') {
      return generateCollapsedSummary(block.name, block.input, block.output, block.status);
    }
    return null;
  }, [block.name, block.input, block.output, block.status]);

  // 获取工具缩写
  const toolShortName = useMemo(() => getToolShortName(block.name), [block.name]);

  // 格式化输入参数
  const formatInput = (input: Record<string, unknown>): string => {
    const entries = Object.entries(input);
    if (entries.length === 0) return '';
    return entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  };

  // 是否可展开
  const hasInput = block.input && Object.keys(block.input).length > 0;
  const hasOutput = block.output && block.output.length > 0;
  const hasError = block.status === 'failed' && block.error;
  const canExpand = hasInput || hasOutput || hasError;

  // 是否显示 Diff 按钮
  const showDiffButton = useMemo(() => {
    const isEdit = isEditTool(block.name);
    const isCompleted = block.status === 'completed';
    const hasDiff = !!block.diffData;

    return isEdit && isCompleted && hasDiff;
  }, [block.name, block.status, block.diffData]);

  // 是否使用专用输出渲染器
  const useCustomRenderer = grepData !== null;

  // 状态动画类
  const statusAnimationClass = useMemo(() => {
    switch (block.status) {
      case 'pending':
        return 'animate-pulse border-dashed';
      case 'running':
        return 'animate-pulse';
      case 'completed':
        return '';
      case 'failed':
        return 'animate-shake-once';
      case 'partial':
        return '';
      default:
        return '';
    }
  }, [block.status]);

  // Bash 工具需要清理 ANSI 码
  const displayOutput = useMemo(() => {
    if (!block.output) return '';
    const normalizedToolName = block.name.toLowerCase();
    if (
      normalizedToolName.includes('bash') ||
      normalizedToolName.includes('command') ||
      normalizedToolName.includes('execute')
    ) {
      return stripAnsiCodes(block.output);
    }
    return block.output;
  }, [block.name, block.output]);

  // 是否为 Bash/Command 类工具
  const isBashTool = useMemo(() => {
    const n = block.name.toLowerCase();
    return n.includes('bash') || n.includes('command') || n.includes('execute');
  }, [block.name]);

  // 提取完整命令（用于复制，不截断）
  const fullCommand = useMemo(() => extractFullCommand(block.input), [block.input]);

  // 复制命令回调
  const handleCopyCommand = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!fullCommand) return;
    await copyToClipboard(fullCommand);
    setCopiedCommand(true);
    setTimeout(() => setCopiedCommand(false), 2000);
  }, [fullCommand]);

  // 复制输出回调（始终复制完整输出）
  const handleCopyOutput = useCallback(async () => {
    const text = block.output ? stripAnsiCodes(block.output) : '';
    if (!text) return;
    await copyToClipboard(text);
    setCopiedOutput(true);
    setTimeout(() => setCopiedOutput(false), 2000);
  }, [block.output]);

  return (
    <div
      className={clsx(
        'my-1.5 rounded-lg overflow-hidden w-full transition-all duration-200',
        'border border-border bg-background-elevated',
        statusAnimationClass,
        block.status === 'failed' && 'border-error/30 bg-error-faint/50'
      )}
    >
      {/* 统一头部 - 折叠和展开共用 */}
      <div
        className={clsx(
          'group flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-background-hover transition-colors',
          'border-l-2',
          toolConfig.borderColor
        )}
        onClick={() => canExpand && setIsExpanded(!isExpanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (canExpand) {
              setIsExpanded(!isExpanded);
            }
          }
        }}
        tabIndex={canExpand ? 0 : -1}
        role="button"
        aria-expanded={isExpanded}
      >
        {/* 工具缩写图标 */}
        <div
          className={clsx(
            'w-5 h-5 rounded text-[10px] font-semibold flex items-center justify-center shrink-0',
            toolConfig.bgColor,
            toolConfig.color
          )}
        >
          {toolShortName}
        </div>

        {/* 工具名称 */}
        <span className="text-xs font-medium text-text-secondary shrink-0">
          {toolConfig.label}
        </span>

        {/* 关键参数 */}
        {keyInfo && (
          <span className={clsx('text-xs truncate flex-1 min-w-0', toolConfig.color)}>
            {keyInfo}
          </span>
        )}

        {/* 右侧信息区 */}
        <div className="flex items-center gap-1.5 ml-auto shrink-0">
          {duration && (
            <span className="text-[10px] text-text-muted px-1.5 py-0.5 bg-background-secondary rounded">
              {duration}
            </span>
          )}

          {collapsedSummary && collapsedSummary.summary && (
            <span className={clsx(
              'text-[10px] px-1.5 py-0.5 rounded',
              collapsedSummary.summaryType === 'lines' && 'text-sky-500 bg-sky-500/10',
              collapsedSummary.summaryType === 'files' && 'text-primary bg-primary/10',
              collapsedSummary.summaryType === 'matches' && 'text-cyan-500 bg-cyan-500/10',
              collapsedSummary.summaryType === 'diff' && 'text-warning bg-warning/10',
              collapsedSummary.summaryType === 'status' && (block.status === 'completed' ? 'text-success bg-success/10' : 'text-error bg-error/10'),
              collapsedSummary.summaryType === 'size' && 'text-sky-500 bg-sky-500/10',
              collapsedSummary.summaryType === 'count' && 'text-primary bg-primary/10',
              collapsedSummary.summaryType === 'plain' && 'text-text-tertiary bg-background-secondary'
            )}>
              {collapsedSummary.summary}
            </span>
          )}

          <StatusIcon className={clsx('w-3.5 h-3.5', statusConfig.className)} />

          {canExpand && (
            <ChevronDown
              className={clsx(
                'w-3 h-3 text-text-muted transition-transform duration-200',
                isExpanded && 'rotate-180'
              )}
            />
          )}
        </div>
      </div>

      {/* 展开时显示详情区域 */}
      {isExpanded && (
        <div className="px-4 py-3 bg-background-subtle border-t border-border">
          {/* 工具名称和时间 */}
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-text-muted font-mono">{block.name}</span>
            <div className="text-xs text-text-tertiary flex gap-3">
              <span>{t('tool.startTime', { time: new Date(block.startedAt).toLocaleTimeString('zh-CN') })}</span>
              {block.completedAt && (
                <span>{t('tool.endTime', { time: new Date(block.completedAt).toLocaleTimeString('zh-CN') })}</span>
              )}
            </div>
          </div>

          {/* 文件路径：点击打开编辑器 */}
          {fullFilePath && (
            <div className="mb-3">
              <button
                type="button"
                className="text-xs text-primary hover:underline cursor-pointer flex items-center gap-1"
                onClick={handleFilePathClick}
                title={fullFilePath}
              >
                <Code className="w-3 h-3 shrink-0" />
                <span className="truncate">{fullFilePath}</span>
              </button>
            </div>
          )}

          {/* Edit 工具：直接显示 Diff */}
          {showDiffButton && block.diffData && (
            <div className="mb-3">
              <div className="text-xs text-text-muted mb-2 flex items-center gap-1.5">
                <FileDiff className="w-3 h-3" />
                {t('tool.fileDiff')}
              </div>
              <DiffViewer
                oldContent={block.diffData.oldContent}
                newContent={block.diffData.newContent}
                changeType="modified"
                showStatusHint={false}
                maxHeight="300px"
              />
            </div>
          )}

          {/* 非Edit工具或无Diff：显示输入参数 */}
          {!showDiffButton && hasInput && (
            <div className="mb-3">
              <div className="text-xs text-text-muted mb-1.5 flex items-center gap-1.5">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
                {todoData ? t('tool.taskList') : t('tool.inputParams')}
                {isBashTool && fullCommand && (
                  <button
                    onClick={handleCopyCommand}
                    className={clsx(
                      'ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors',
                      copiedCommand
                        ? 'text-success bg-success/10'
                        : 'text-primary hover:text-primary-hover'
                    )}
                  >
                    {copiedCommand ? (
                      <>
                        <Check className="w-3 h-3" />
                        {t('tool.copied')}
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        {t('tool.copyCommand')}
                      </>
                    )}
                  </button>
                )}
              </div>
              {todoData ? (
                <TodoWriteInputRenderer data={todoData} />
              ) : (
                <pre className="text-xs text-text-secondary bg-background-surface rounded p-2.5 max-w-full overflow-x-auto font-mono">
                  {formatInput(block.input)}
                </pre>
              )}
            </div>
          )}

          {/* Edit 工具：简化输出提示 */}
          {editOutputSummary && (
            <div className="mb-3">
              <div className={clsx(
                'text-xs flex items-center gap-1.5',
                editOutputSummary.type === 'success' ? 'text-success' : 'text-error'
              )}>
                {editOutputSummary.type === 'success' ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <XCircle className="w-3.5 h-3.5" />
                )}
                {editOutputSummary.text}
              </div>
            </div>
          )}

          {/* 非Edit工具：完整输出结果 */}
          {!isEditTool(block.name) && hasOutput && (
            <div className="mb-3">
              <div className="text-xs text-text-muted mb-1.5 flex items-center gap-1.5">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {t('tool.outputResult')}
                <div className="ml-auto flex items-center gap-1.5">
                  {displayOutput && (
                    <button
                      onClick={handleCopyOutput}
                      className={clsx(
                        'flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors',
                        copiedOutput
                          ? 'text-success bg-success/10'
                          : 'text-primary hover:text-primary-hover'
                      )}
                    >
                      {copiedOutput ? (
                        <>
                          <Check className="w-3 h-3" />
                          {t('tool.copied')}
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          {t('tool.copyOutput')}
                        </>
                      )}
                    </button>
                  )}
                  {outputNeedsExpand && !useCustomRenderer && (
                    <button
                      onClick={() => setShowFullOutput(!showFullOutput)}
                      className="text-primary hover:text-primary-hover text-xs"
                    >
                      {showFullOutput ? t('tool.collapse') : t('tool.expandAll')}
                    </button>
                  )}
                </div>
              </div>
              {useCustomRenderer && grepData ? (
                <GrepOutputRenderer data={grepData} />
              ) : (
                <pre className={clsx(
                  'text-xs text-text-secondary bg-background-surface rounded p-2.5 overflow-x-auto font-mono',
                  showFullOutput ? 'max-h-96 overflow-y-auto' : 'max-h-48 overflow-y-auto'
                )}>
                  {showFullOutput
                    ? displayOutput
                    : (displayOutput.length > 1000
                      ? displayOutput.slice(0, 1000) + '\n... (' + t('tool.outputTruncated') + ')'
                      : displayOutput)}
                </pre>
              )}
            </div>
          )}

          {/* Edit 工具：工具详情折叠区域 */}
          {isEditTool(block.name) && (hasInput || hasOutput) && (
            <div className="mb-3">
              <div
                onClick={() => setShowToolDetails(!showToolDetails)}
                className="text-xs text-text-tertiary hover:text-text-primary cursor-pointer flex items-center gap-1 select-none"
              >
                <ChevronRight
                  className={clsx(
                    'w-3 h-3 transition-transform',
                    showToolDetails && 'rotate-90'
                  )}
                />
                {t('tool.toolDetails')}
              </div>
              {showToolDetails && (
                <div className="mt-2 space-y-2">
                  {hasInput && (
                    <div>
                      <div className="text-xs text-text-muted mb-1">{t('tool.inputParams')}</div>
                      <pre className="text-xs text-text-secondary bg-background-surface rounded p-2.5 overflow-x-auto font-mono">
                        {formatInput(block.input)}
                      </pre>
                    </div>
                  )}
                  {hasOutput && (
                    <div>
                      <div className="text-xs text-text-muted mb-1">{t('tool.outputResult')}</div>
                      <pre className="text-xs text-text-secondary bg-background-surface rounded p-2.5 overflow-x-auto font-mono max-h-48 overflow-y-auto">
                        {displayOutput}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 错误信息 */}
          {hasError && (
            <div className="mb-3">
              <div className="text-xs text-error mb-1.5 flex items-center gap-1.5">
                <XCircle className="w-3 h-3" />
                {t('tool.errorInfo')}
              </div>
              <pre className="text-xs text-error bg-error-faint rounded p-2.5 overflow-x-auto font-mono">
                {block.error}
              </pre>
            </div>
          )}

          {/* 状态标签 */}
          <div className="flex items-center gap-2">
            <span className={clsx(
              'text-xs px-2 py-0.5 rounded-full',
              toolConfig.bgColor,
              toolConfig.color
            )}>
              {t(statusConfig.labelKey)}
            </span>
            {duration && (
              <span className="text-xs text-text-tertiary">
                {t('tool.duration', { duration })}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
