/**
 * 增强版聊天消息列表组件 - 支持内容块架构
 *
 * 核心特性：
 * - Assistant 消息包含 blocks 数组
 * - 工具调用穿插在文本中间显示
 * - 支持流式更新内容块
 * - TodoWrite 专用渲染
 * - Grep 关键词高亮
 * - Bash ANSI 码清理
 * - Edit 工具优化显示
 */

import { useMemo, memo, useState, useCallback, useRef, useDeferredValue } from 'react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { clsx } from 'clsx';
import { invoke } from '@tauri-apps/api/core';
import type { ChatMessage, UserChatMessage, AssistantChatMessage, ContentBlock, TextBlock, ThinkingBlock, ToolCallBlock } from '../../types';
import { useEventChatStore, useGitStore, useWorkspaceStore, useTabStore } from '../../stores';
import { getToolConfig, extractToolKeyInfo } from '../../utils/toolConfig';
import { markdownCache } from '../../utils/cache';
import { useThrottle } from '../../hooks/useThrottle';
import {
  formatDuration,
  calculateDuration,
  generateOutputSummary,
  parseGrepMatches,
  stripAnsiCodes,
  escapeRegExp,
  type GrepMatch,
  type GrepOutputData
} from '../../utils/toolSummary';
import { Check, XCircle, Loader2, AlertTriangle, Play, ChevronDown, ChevronRight, Circle, FileSearch, FolderOpen, Code, FileDiff, RotateCcw, Copy, GitPullRequest, Brain } from 'lucide-react';
import { ChatNavigator } from './ChatNavigator';
import { groupConversationRounds } from '../../utils/conversationRounds';
import { splitMarkdownWithMermaid } from '../../utils/markdown';
import { MermaidDiagram } from './MermaidDiagram';
import { extractCodeBlocks, replaceCodeBlocksWithPlaceholders } from '../../utils/markdown-enhanced';
import { DiffViewer } from '../Diff/DiffViewer';
import { isEditTool } from '../../utils/diffExtractor';
import { Button } from '../Common/Button';
import { BilingualTextRenderer } from './BilingualTextRenderer';
import { MessageTranslateButton } from './MessageTranslateButton';
import { useMessageTranslationStore } from '../../stores/messageTranslationStore';
import { extractTranslatableParagraphsFromMarkdown } from '../../utils/translateUtils';
import { calculateRenderMode, type MessageRenderMode, DEFAULT_LAYER_CONFIG } from '../../utils/messageLayer';

/** Markdown 渲染器（使用缓存优化） */
function formatContent(content: string): string {
  return markdownCache.render(content);
}

/** 用户消息组件 */
const UserBubble = memo(function UserBubble({ message }: { message: UserChatMessage }) {
  return (
    <div className="flex justify-end my-2">
      <div className="max-w-[85%] px-4 py-3 rounded-2xl
                  bg-gradient-to-br from-primary to-primary-600
                  text-white shadow-glow">
        <div className="text-sm leading-relaxed whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    </div>
  );
});

/** 文本内容块组件（支持 Mermaid 渲染 + 代码高亮 + 双语翻译）
 *
 * 性能优化策略：
 * 1. 流式输出时使用节流（而非防抖），确保固定间隔渲染，提供更好的实时性
 * 2. 流式阶段显示简化版内容（纯文本），避免复杂 markdown 渲染
 * 3. 使用 useDeferredValue 降低渲染优先级，保持 UI 响应
 * 4. 流式结束后显示完整渲染结果
 * 5. 分层渲染：preview/archive 模式使用简化渲染
 */
const TextBlockRenderer = memo(function TextBlockRenderer({
  block,
  messageId,
  onTranslateAll,
  isStreaming = false,
  renderMode = 'full'
}: {
  block: TextBlock;
  messageId: string;
  onTranslateAll?: () => void;
  isStreaming?: boolean;
  renderMode?: MessageRenderMode;
}) {
  // 流式输出时使用节流（200ms 间隔），确保固定频率渲染
  // 节流比防抖更适合流式场景：用户能看到内容持续更新，而不是等待结束后才显示
  const throttledContent = useThrottle(block.content, isStreaming ? 200 : 0);

  // 使用 useDeferredValue 延迟渲染复杂内容，保持 UI 响应
  const deferredContent = useDeferredValue(throttledContent);

  // 流式阶段使用节流内容，非流式使用原始内容
  const contentToRender = isStreaming ? deferredContent : block.content;

  // 非流式阶段：完整渲染（useMemo 必须在条件判断之前调用，遵守 React Hooks 规则）
  const parts = useMemo(() => splitMarkdownWithMermaid(block.content), [block.content]);

  // 流式阶段：显示简化版内容（纯文本），避免复杂渲染
  // 性能关键：直接返回，不执行任何 markdown 解析或正则处理
  if (isStreaming) {
    return (
      <div className="prose prose-invert prose-sm max-w-none">
        <StreamingTextContent content={contentToRender} />
      </div>
    );
  }

  // 归档模式：仅显示摘要（截取前 200 字符）
  if (renderMode === 'archive') {
    const summaryContent = block.content.length > 200
      ? block.content.slice(0, 200) + '...'
      : block.content;
    return (
      <div className="prose prose-invert prose-sm max-w-none text-text-secondary">
        <span className="whitespace-pre-wrap">{summaryContent}</span>
      </div>
    );
  }

  // 预览模式：简化渲染（不渲染 Mermaid，不渲染复杂代码高亮）
  if (renderMode === 'preview') {
    return (
      <div className="prose prose-invert prose-sm max-w-none">
        <PreviewTextContent content={block.content} />
      </div>
    );
  }

  // 完整模式：完整渲染
  return (
    <div className="prose prose-invert prose-sm max-w-none">
      {parts.map((part, partIndex) => {
        if (part.type === 'text') {
          return <TextPartRenderer key={`text-${partIndex}`} content={part.content} messageId={messageId} onTranslateAll={onTranslateAll} />;
        } else {
          return (
            <MermaidDiagram
              key={`mermaid-${partIndex}`}
              code={part.content}
              id={part.id || `mermaid-${partIndex}`}
            />
          );
        }
      })}
    </div>
  );
});

/**
 * 预览模式文本渲染器 - 简化版，避免 Mermaid 和复杂代码高亮
 */
const PreviewTextContent = memo(function PreviewTextContent({ content }: { content: string }) {
  const formattedHTML = useMemo(() => formatContent(content), [content]);

  return (
    <div
      className="whitespace-pre-wrap break-words"
      dangerouslySetInnerHTML={{ __html: formattedHTML }}
    />
  );
});

/**
 * 流式文本内容渲染器 - 极简版，最大化性能
 * 
 * 优化策略：
 * 1. 单节点渲染：不按行分割，直接渲染整个文本
 * 2. 使用 CSS white-space: pre-wrap 保持换行格式
 * 3. 仅做最小化的代码块标识符高亮
 * 4. 避免所有不必要的 useMemo/map 操作
 * 
 * 性能关键（2026-03-09 更新）：
 * - 不使用正则表达式（正则在长文本上性能差）
 * - 使用 lastIndexOf 从末尾搜索代码块标记（O(n) 但从末尾开始，流式场景更高效）
 * - 限制处理范围：只处理最后 2000 字符中的代码块标记
 * - 避免对整个长文本进行多次遍历
 */
const StreamingTextContent = memo(function StreamingTextContent({ content }: { content: string }) {
  // 如果内容为空，渲染占位符
  if (!content) {
    return <span className="text-text-muted">...</span>;
  }

  // 性能优化：对于长文本，只处理最后 2000 字符
  // 因为流式输出中，代码块标记通常出现在最新内容中
  const SEARCH_WINDOW = 2000;
  const searchStart = Math.max(0, content.length - SEARCH_WINDOW);
  const searchRegion = content.slice(searchStart);
  
  // 快速检测：从末尾搜索代码块标记
  const lastCodeBlockInRegion = searchRegion.lastIndexOf('```');
  
  // 如果搜索区域内没有代码块标记，直接渲染纯文本（最快路径）
  if (lastCodeBlockInRegion === -1) {
    return (
      <span className="whitespace-pre-wrap break-words">
        {content}
      </span>
    );
  }

  // 将区域内的相对位置转换为全局位置
  const firstCodeBlock = searchStart + lastCodeBlockInRegion;

  // 构建渲染结果
  const parts: React.ReactNode[] = [];
  let keyIndex = 0;
  const MAX_PARTS = 10; // 减少最大片段数，避免创建过多节点

  // 添加代码块标记之前的所有文本（作为一个整体）
  if (firstCodeBlock > 0) {
    parts.push(
      <span key={`text-${keyIndex++}`}>
        {content.slice(0, firstCodeBlock)}
      </span>
    );
  }

  // 处理代码块标记
  let remaining = content.slice(firstCodeBlock);
  
  while (remaining.length > 0 && keyIndex < MAX_PARTS) {
    const idx = remaining.indexOf('```');
    
    if (idx === -1) {
      parts.push(
        <span key={`text-${keyIndex++}`}>
          {remaining}
        </span>
      );
      break;
    }

    // 添加代码块标记之前的普通文本
    if (idx > 0) {
      parts.push(
        <span key={`text-${keyIndex++}`}>
          {remaining.slice(0, idx)}
        </span>
      );
    }

    // 找到代码块标记的结束位置（到下一个换行或行尾）
    let endOfMarker = 3;
    const afterMarker = remaining.slice(idx + 3);
    
    // 查找语言标识符结束位置
    for (let i = 0; i < afterMarker.length && i < 30; i++) {
      const char = afterMarker[i];
      if (char === '\n' || char === '\r') {
        endOfMarker = 3 + i + 1;
        break;
      }
      if (!/[a-zA-Z0-9_+-]/.test(char)) {
        endOfMarker = 3 + i;
        break;
      }
      endOfMarker = 3 + i + 1;
    }

    // 添加代码块标记（带样式）
    const marker = remaining.slice(idx, idx + endOfMarker);
    parts.push(
      <span key={`code-${keyIndex++}`} className="text-text-muted font-mono text-xs">
        {marker}
      </span>
    );

    remaining = remaining.slice(idx + endOfMarker);
  }

  // 添加剩余内容
  if (remaining.length > 0) {
    parts.push(
      <span key={`text-remaining`}>
        {remaining}
      </span>
    );
  }

  return <span className="whitespace-pre-wrap break-words">{parts}</span>;
});

/**
 * 文本部分渲染器（支持代码高亮 + 双语翻译）
 */
const TextPartRenderer = memo(function TextPartRenderer({ 
  content,
  messageId,
  onTranslateAll
}: { 
  content: string;
  messageId: string;
  onTranslateAll?: () => void;
}) {
  const formattedHTML = useMemo(() => formatContent(content), [content]);

  const codeBlocks = useMemo(() => {
    const blocks = extractCodeBlocks(formattedHTML);
    return blocks;
  }, [formattedHTML]);

  const { processedHTML } = useMemo(() => {
    return replaceCodeBlocksWithPlaceholders(formattedHTML, codeBlocks);
  }, [formattedHTML, codeBlocks]);

  return (
    <BilingualTextRenderer
      messageId={messageId}
      content={content}
      processedHTML={processedHTML}
      codeBlocks={codeBlocks}
      onTranslateAll={onTranslateAll}
    />
  );
});

/**
 * 状态图标配置
 */
const STATUS_CONFIG = {
  pending: { icon: Loader2, className: 'animate-spin text-yellow-500', labelKey: 'status.pending' },
  running: { icon: Play, className: 'text-blue-500 animate-pulse', labelKey: 'status.running' },
  completed: { icon: Check, className: 'text-green-500', labelKey: 'status.completed' },
  failed: { icon: XCircle, className: 'text-red-500', labelKey: 'status.failed' },
  partial: { icon: AlertTriangle, className: 'text-orange-500', labelKey: 'status.partial' },
} as const;

// ========================================
// Grep 输出渲染器
// ========================================

/**
 * 高亮文本组件 - 用于 Grep 结果
 */
function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;

  try {
    const regex = new RegExp(`(${escapeRegExp(query)})`, 'gi');
    const parts = text.split(regex);

    return (
      <>
        {parts.map((part, i) =>
          regex.test(part) ? (
            <mark key={i} className="bg-yellow-500/30 text-text-primary px-0.5 rounded font-medium">
              {part}
            </mark>
          ) : (
            <span key={i}>{part}</span>
          )
        )}
      </>
    );
  } catch {
    return <>{text}</>;
  }
}

/**
 * Grep 匹配项组件
 */
const GrepMatchItem = memo(function GrepMatchItem({
  match,
  query
}: {
  match: GrepMatch;
  query: string;
}) {
  return (
    <div className="flex items-start gap-2 py-1.5 px-2 rounded bg-background-surface hover:bg-background-hover transition-colors">
      {/* 文件名 */}
      {match.file && (
        <div className="text-xs text-primary font-mono shrink-0">
          {match.file.split('/').pop() || match.file}
        </div>
      )}
      {/* 行号 */}
      {match.line > 0 && (
        <div className="text-xs text-text-muted font-mono shrink-0 w-8">
          :{match.line}
        </div>
      )}
      {/* 内容 */}
      <div className="flex-1 text-xs text-text-secondary font-mono break-all">
        <HighlightedText text={match.content} query={query} />
      </div>
    </div>
  );
});

/**
 * Grep 输出渲染器
 */
const GrepOutputRenderer = memo(function GrepOutputRenderer({
  data
}: {
  data: GrepOutputData;
}) {
  const { t } = useTranslation('chat');
  
  return (
    <div className="space-y-2">
      {/* 匹配项列表 */}
      <div className="space-y-0.5">
        {data.matches.slice(0, 20).map((match, idx) => (
          <GrepMatchItem key={idx} match={match} query={data.query} />
        ))}
      </div>
      {/* 超过20个提示 */}
      {data.total > 20 && (
        <div className="text-xs text-text-tertiary text-center py-1">
          {t('tool.moreMatches', { count: data.total - 20 })}
        </div>
      )}
    </div>
  );
});

// ========================================
// TodoWrite 渲染器
// ========================================

/**
 * TodoWrite 相关类型定义
 */
interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

interface TodoInputData {
  todos: TodoItem[];
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
}

/**
 * 判断是否为 TodoWrite 工具
 */
function isTodoWriteTool(block: ToolCallBlock): boolean {
  return block.name.toLowerCase() === 'todowrite';
}

/**
 * 判断是否为 Grep 工具
 */
function isGrepTool(block: ToolCallBlock): boolean {
  return block.name.toLowerCase().includes('grep');
}

/**
 * 解析 TodoWrite 输入数据
 */
function parseTodoInput(input: Record<string, unknown> | undefined): TodoInputData | null {
  if (!input) return null;
  const todos = input.todos as TodoItem[];
  if (!Array.isArray(todos)) return null;

  return {
    todos,
    total: todos.length,
    completed: todos.filter(t => t.status === 'completed').length,
    inProgress: todos.filter(t => t.status === 'in_progress').length,
    pending: todos.filter(t => t.status === 'pending').length,
  };
}

/**
 * TodoWrite 任务状态配置
 */
const TODO_STATUS_CONFIG = {
  completed: { icon: Check, color: 'text-green-500', bg: 'bg-green-500/10', labelKey: 'status.completed' },
  in_progress: { icon: Loader2, color: 'text-violet-500', bg: 'bg-violet-500/10', labelKey: 'status.running' },
  pending: { icon: Circle, color: 'text-gray-400', bg: 'bg-gray-500/10', labelKey: 'status.pending' },
} as const;

/**
 * TodoWrite 任务项组件
 */
const TodoItem = memo(function TodoItem({
  todo,
  index
}: {
  todo: TodoItem;
  index: number;
}) {
  const { t } = useTranslation('chat');
  const statusConfig = TODO_STATUS_CONFIG[todo.status] || TODO_STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;

  return (
    <div className="flex items-start gap-2 p-2 rounded bg-background-surface hover:bg-background-hover transition-colors">
      <div className={clsx('p-1 rounded', statusConfig.bg)}>
        <StatusIcon className={clsx('w-3.5 h-3.5', statusConfig.color,
          todo.status === 'in_progress' && 'animate-spin'
        )} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text-primary">{todo.content}</div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className={clsx('text-xs', statusConfig.color)}>{t(statusConfig.labelKey)}</span>
          <span className="text-xs text-text-muted">#{index + 1}</span>
        </div>
      </div>
    </div>
  );
});

/**
 * TodoWrite 输入渲染器 - 展开状态
 */
const TodoWriteInputRenderer = memo(function TodoWriteInputRenderer({
  data
}: {
  data: TodoInputData;
}) {
  const percent = data.total > 0 ? Math.round((data.completed / data.total) * 100) : 0;

  return (
    <div className="space-y-3">
      {/* 进度条 */}
      <div className="flex items-center gap-3">
        <div className="flex-1 bg-background-base rounded-full h-2 overflow-hidden">
          <div
            className="bg-violet-500 h-full transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="text-xs text-text-tertiary">
          {data.completed}/{data.total} ({percent}%)
        </span>
      </div>

      {/* 任务列表 */}
      <div className="space-y-1">
        {data.todos.map((todo, index) => (
          <TodoItem key={index} todo={todo} index={index} />
        ))}
      </div>
    </div>
  );
});

/**
 * TodoWrite 任务状态图标（用于折叠状态）
 */
function getTodoStatusIcon(status: TodoItem['status']): React.ReactElement {
  const config = TODO_STATUS_CONFIG[status];
  const Icon = config.icon;
  return (
    <Icon className={clsx('w-3 h-3', config.color,
      status === 'in_progress' && 'animate-spin'
    )} />
  );
}

// ========================================
// 思考过程块渲染器
// ========================================

/** 思考过程块组件 - 可折叠展示 */
const ThinkingBlockRenderer = memo(function ThinkingBlockRenderer({ block }: { block: ThinkingBlock }) {
  const [isCollapsed, setIsCollapsed] = useState(block.collapsed ?? true);

  return (
    <div className="my-2 rounded-lg border border-border-subtle bg-surface-elevated overflow-hidden">
      {/* 头部 - 可点击折叠 */}
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-hover transition-colors"
      >
        <Brain className="w-4 h-4 text-primary" />
        <span className="text-sm font-medium text-text-secondary">思考过程</span>
        {isCollapsed ? (
          <ChevronRight className="w-4 h-4 text-text-muted ml-auto" />
        ) : (
          <ChevronDown className="w-4 h-4 text-text-muted ml-auto" />
        )}
      </button>

      {/* 内容 - 折叠时隐藏 */}
      {!isCollapsed && (
        <div className="px-3 py-2 border-t border-border-subtle">
          <div className="text-sm text-text-secondary whitespace-pre-wrap leading-relaxed">
            {block.content}
          </div>
        </div>
      )}
    </div>
  );
});

// ========================================
// 工具调用块渲染器
// ========================================

/** 工具调用块组件 - 优化版本 */
const ToolCallBlockRenderer = memo(function ToolCallBlockRenderer({ block }: { block: ToolCallBlock }) {
  const { t } = useTranslation('chat');
  const [isExpanded, setIsExpanded] = useState(false);
  const [showFullOutput, setShowFullOutput] = useState(false);
  const [showToolDetails, setShowToolDetails] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);

  // 获取 Store
  const gitStore = useGitStore();
  const workspaceStore = useWorkspaceStore();
  const tabStore = useTabStore();

  // 获取工具配置
  const toolConfig = useMemo(() => getToolConfig(block.name), [block.name]);

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

  // 生成输出摘要
  const outputSummary = useMemo(() => {
    if (block.status === 'completed' && block.output) {
      return generateOutputSummary(block.name, block.output, block.status, block.input);
    }
    return null;
  }, [block.name, block.output, block.status, block.input]);

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
  }, [block.name, block.status, block.output, block.error]);

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

  // 判断输出是否需要展开功能（修复：基于实际长度而非 outputSummary）
  const outputNeedsExpand = (block.output?.length ?? 0) > 1000;

  // 格式化输入参数（非 TodoWrite 工具使用）
  const formatInput = (input: Record<string, unknown>): string => {
    const entries = Object.entries(input);
    if (entries.length === 0) return '';
    return entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  };

  // 工具图标组件
  const ToolIcon = toolConfig.icon;

  // 是否可展开（有输入参数或有输出）
  const hasInput = block.input && Object.keys(block.input).length > 0;
  const hasOutput = block.output && block.output.length > 0;
  const hasError = block.status === 'failed' && block.error;
  const canExpand = hasInput || hasOutput || hasError;

  // 是否显示 Diff 按钮（Edit 工具且有 Diff 数据）
  const showDiffButton = useMemo(() => {
    const isEdit = isEditTool(block.name);
    const isCompleted = block.status === 'completed';
    const hasDiff = !!block.diffData;

    return isEdit && isCompleted && hasDiff;
  }, [block.name, block.status, block.diffData]);

  // 撤销操作处理 - 多级撤销策略
  const handleUndo = useCallback(async () => {
    if (!block.diffData) return;

    const workspace = workspaceStore.getCurrentWorkspace();
    if (!workspace || !workspace.path) {
      console.error('[ToolCallBlock] 无法获取当前工作区');
      return;
    }

    setIsUndoing(true);
    try {
      // Level 1: 使用 fullOldContent（精确撤销）
      if (block.diffData.fullOldContent && block.diffData.fullOldContent.length > 0) {
        await invoke('write_file_absolute', {
          path: block.diffData.filePath,
          content: block.diffData.fullOldContent
        });

        await gitStore.refreshStatus(workspace.path);

        console.log('[ToolCallBlock] 撤销成功（Level 1: fullOldContent）', {
          filePath: block.diffData.filePath,
          contentLength: block.diffData.fullOldContent.length,
        });
        return;
      }

      // Level 2: 使用 Git discard（降级方案）
      console.warn('[ToolCallBlock] 使用降级方案：Git discard');

      // 将绝对路径转换为相对路径
      let relativePath = block.diffData.filePath;
      if (relativePath.startsWith(workspace.path)) {
        relativePath = relativePath.substring(workspace.path.length);
        if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
          relativePath = relativePath.substring(1);
        }
        relativePath = relativePath.replace(/\\/g, '/');
      }

      await gitStore.discardChanges(workspace.path, relativePath);

      console.log('[ToolCallBlock] 撤销成功（Level 2: Git discard）', {
        filePath: block.diffData.filePath,
        relativePath,
      });
    } catch (err) {
      console.error('[ToolCallBlock] 撤销失败:', err);

      // 显示用户友好的错误提示
      if (err instanceof Error) {
        const errorMsg = err.message || '未知错误';
        console.error(`[ToolCallBlock] 错误详情: ${errorMsg}`);
      }
    } finally {
      setIsUndoing(false);
    }
  }, [block.diffData, gitStore, workspaceStore]);

  // 复制文件路径
  const handleCopyPath = useCallback(() => {
    if (!block.diffData) return;
    navigator.clipboard.writeText(block.diffData.filePath);
  }, [block.diffData]);

  // 在 Git 面板查看
  const handleOpenInGitPanel = useCallback(async () => {
    if (!block.diffData) return;

    const workspace = workspaceStore.getCurrentWorkspace();
    if (!workspace || !workspace.path) return;

    // 将绝对路径转换为相对路径
    let relativePath = block.diffData.filePath;
    if (relativePath.startsWith(workspace.path)) {
      relativePath = relativePath.substring(workspace.path.length);
      if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
        relativePath = relativePath.substring(1);
      }
      relativePath = relativePath.replace(/\\/g, '/');
    }

    try {
      const diff = await gitStore.getWorktreeFileDiff(
        workspace.path,
        relativePath
      );
      tabStore.openDiffTab(diff);
    } catch (err) {
      console.error('[ToolCallBlock] 打开 Diff 失败:', err);
    }
  }, [block.diffData, gitStore, workspaceStore, tabStore]);

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

  return (
    <div
      className={clsx(
        'my-2 rounded-lg overflow-hidden w-full transition-all duration-200',
        'border border-border',
        'bg-background-surface',
        statusAnimationClass
      )}
    >
      {/* 工具调用头部 - 左侧色条 */}
      <div
        className={clsx(
          'flex items-center gap-3 px-3 py-2',
          canExpand ? 'cursor-pointer hover:bg-background-hover' : 'cursor-default',
          'border-l-4',
          toolConfig.borderColor
        )}
        onClick={() => canExpand && setIsExpanded(!isExpanded)}
      >
        {/* 工具类型图标 */}
        <div className={clsx('p-1.5 rounded-md', toolConfig.bgColor)}>
          <ToolIcon className={clsx('w-4 h-4', toolConfig.color)} />
        </div>

        {/* 操作描述 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-text-secondary">
              {block.status === 'running' ? t('tool.running') : t('tool.completed')}{toolConfig.label}
            </span>
            {keyInfo && (
              <span className={clsx('font-medium truncate', toolConfig.color)}>
                {keyInfo}
              </span>
            )}
          </div>
          {/* 输出摘要（折叠时显示） */}
          {!isExpanded && outputSummary && (
            <div className="text-xs text-text-tertiary mt-0.5 flex items-center gap-1">
              {isGrepTool(block) && grepData ? (
                <>
                  <FileSearch className="w-3 h-3 shrink-0" />
                  <span>{outputSummary.summary}</span>
                </>
              ) : (
                <span>{outputSummary.summary}</span>
              )}
              {(outputSummary.expandable || outputNeedsExpand) && (
                <ChevronRight className="w-3 h-3 shrink-0" />
              )}
            </div>
          )}
          {/* TodoWrite 任务预览（折叠时显示前2个任务） */}
          {!isExpanded && todoData && todoData.total > 0 && (
            <div className="mt-1.5 space-y-0.5">
              {todoData.todos.slice(0, 2).map((todo, idx) => (
                <div key={idx} className="text-xs text-text-tertiary flex items-center gap-1.5">
                  {getTodoStatusIcon(todo.status)}
                  <span className="truncate">{todo.content}</span>
                </div>
              ))}
              {todoData.total > 2 && (
                <div className="text-xs text-text-muted">
                  {t('tool.moreTasks', { count: todoData.total - 2 })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 状态与耗时 */}
        <div className="flex items-center gap-2 shrink-0">
          {duration && (
            <span className="text-xs text-text-tertiary">{duration}</span>
          )}
          <StatusIcon className={clsx('w-4 h-4', statusConfig.className)} />
        </div>

        {/* 展开/收起图标 */}
        {canExpand && (
          <ChevronDown
            className={clsx(
              'w-4 h-4 text-text-muted transition-transform shrink-0',
              isExpanded && 'rotate-180'
            )}
          />
        )}
      </div>

      {/* 可展开的详情 */}
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

          {/* Edit 工具：操作按钮组 */}
          {showDiffButton && block.diffData && (
            <div className="mb-3 flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                variant="danger"
                onClick={handleUndo}
                disabled={isUndoing}
              >
                {isUndoing ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin mr-1" />
                    {t('tool.undoing')}
                  </>
                ) : (
                  <>
                    <RotateCcw className="w-3 h-3 mr-1" />
                    {t('tool.undo')}
                  </>
                )}
              </Button>

              <Button
                size="sm"
                variant="ghost"
                onClick={handleCopyPath}
              >
                <Copy className="w-3 h-3 mr-1" />
                {t('tool.copyPath')}
              </Button>

              <Button
                size="sm"
                variant="secondary"
                onClick={handleOpenInGitPanel}
              >
                <GitPullRequest className="w-3 h-3 mr-1" />
                {t('tool.viewInGitPanel')}
              </Button>
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
                {outputNeedsExpand && !useCustomRenderer && (
                  <button
                    onClick={() => setShowFullOutput(!showFullOutput)}
                    className="ml-auto text-primary hover:text-primary-hover text-xs"
                  >
                    {showFullOutput ? t('tool.collapse') : t('tool.expandAll')}
                  </button>
                )}
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

/** 内容块渲染器 */
function renderContentBlock(
  block: ContentBlock,
  messageId: string,
  onTranslateAll?: () => void,
  isStreaming?: boolean,
  renderMode: MessageRenderMode = 'full'
): React.ReactNode {
  switch (block.type) {
    case 'text':
      return <TextBlockRenderer key={`text-${block.content.slice(0, 20)}`} block={block} messageId={messageId} onTranslateAll={onTranslateAll} isStreaming={isStreaming} renderMode={renderMode} />;
    case 'thinking':
      // 归档模式下不渲染思考块
      if (renderMode === 'archive') return null;
      return <ThinkingBlockRenderer key={`thinking-${block.content.slice(0, 20)}`} block={block} />;
    case 'tool_call':
      // 归档模式下使用简化工具渲染
      if (renderMode === 'archive') {
        return <SimplifiedToolCallRenderer key={block.id} block={block} />;
      }
      return <ToolCallBlockRenderer key={block.id} block={block} />;
    default:
      return null;
  }
}

/**
 * 简化版工具调用渲染器 - 用于归档层
 */
const SimplifiedToolCallRenderer = memo(function SimplifiedToolCallRenderer({ block }: { block: ToolCallBlock }) {
  const toolConfig = getToolConfig(block.name);
  const ToolIcon = toolConfig.icon;

  return (
    <div className="my-1 flex items-center gap-2 text-xs text-text-tertiary">
      <ToolIcon className={clsx('w-3 h-3', toolConfig.color)} />
      <span>{toolConfig.label}</span>
      {block.status === 'completed' ? (
        <Check className="w-3 h-3 text-success" />
      ) : block.status === 'failed' ? (
        <XCircle className="w-3 h-3 text-error" />
      ) : null}
    </div>
  );
});

/** 助手消息组件 - 使用内容块架构 */
const AssistantBubble = memo(function AssistantBubble({
  message,
  renderMode = 'full'
}: {
  message: AssistantChatMessage;
  renderMode?: MessageRenderMode;
}) {
  const hasBlocks = message.blocks && message.blocks.length > 0;
  const translateMessage = useMessageTranslationStore((state) => state.translateMessage);

  const handleTranslateAll = useCallback(() => {
    const translatableContent: Array<{ originalText: string; tagName: string }> = [];
    for (const block of message.blocks || []) {
      if (block.type === 'text') {
        const paragraphs = extractTranslatableParagraphsFromMarkdown(block.content);
        translatableContent.push(...paragraphs);
      }
    }
    if (translatableContent.length > 0) {
      translateMessage(message.id, translatableContent);
    }
  }, [message.id, message.blocks, translateMessage]);

  return (
    <div className="flex gap-3 my-2">
      {/* Avatar */}
      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary to-primary-600
                      flex items-center justify-center shadow-glow shrink-0">
        <span className="text-sm font-bold text-white">P</span>
      </div>

      {/* 内容 */}
      <div className="flex-1 space-y-1 min-w-0">
        {/* 头部信息 */}
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-text-primary">Claude</span>
          <span className="text-xs text-text-tertiary">
            {new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
          </span>
          {/* 消息级翻译按钮 - 归档模式不显示 */}
          {renderMode === 'full' && (
            <MessageTranslateButton
              messageId={message.id}
              blocks={message.blocks || []}
              isStreaming={message.isStreaming}
            />
          )}
        </div>

        {/* 渲染内容块 */}
        {hasBlocks ? (
          <div className="space-y-1">
            {message.blocks.map((block, index) => (
              <div key={index}>
                {renderContentBlock(block, message.id, handleTranslateAll, message.isStreaming, renderMode)}
              </div>
            ))}
          </div>
        ) : message.content ? (
          // 兼容旧格式（content 字符串）
          <div
            className="prose prose-invert prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: formatContent(message.content) }}
          />
        ) : null}

        {/* 流式光标 */}
        {message.isStreaming && (
          <span className="inline-flex ml-1">
            <span className="flex gap-0.5 items-end h-4">
              <span className="w-1 h-1 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1 h-1 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1 h-1 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
          </span>
        )}
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  // 优化重渲染：使用浅比较代替深度序列化
  // 比较关键属性：id、isStreaming、blocks 数量、最后一个块的内容长度
  const prevBlocks = prevProps.message.blocks;
  const nextBlocks = nextProps.message.blocks;

  // 基础属性比较
  if (prevProps.message.id !== nextProps.message.id) return false;
  if (prevProps.message.isStreaming !== nextProps.message.isStreaming) return false;

  // blocks 数量不同，需要更新
  if (prevBlocks.length !== nextBlocks.length) return false;

  // 对于流式消息，检查最后一个文本块的内容长度
  // 这比 JSON.stringify 快得多，且能捕获大部分更新
  if (nextProps.message.isStreaming && prevBlocks.length > 0) {
    const lastPrev = prevBlocks[prevBlocks.length - 1];
    const lastNext = nextBlocks[nextBlocks.length - 1];

    if (lastPrev.type === 'text' && lastNext.type === 'text') {
      // 内容长度变化需要更新
      if (lastPrev.content.length !== lastNext.content.length) return false;
    } else if (lastPrev.type !== lastNext.type) {
      return false;
    }

    // 检查工具调用块的状态变化
    for (let i = 0; i < prevBlocks.length; i++) {
      const pb = prevBlocks[i];
      const nb = nextBlocks[i];
      if (pb.type !== nb.type) return false;
      if (pb.type === 'tool_call' && nb.type === 'tool_call') {
        if (pb.status !== nb.status) return false;
        if (pb.output !== nb.output) return false;
      }
    }
  }

  // 非流式消息，认为没有变化
  return true;
});

/** 系统消息组件 */
const SystemBubble = memo(function SystemBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-center my-2">
      <p className="text-sm text-text-muted italic">{content}</p>
    </div>
  );
});

/** 消息渲染器 */
function renderChatMessage(message: ChatMessage, renderMode: MessageRenderMode = 'full'): React.ReactNode {
  switch (message.type) {
    case 'user':
      return <UserBubble key={message.id} message={message} />;
    case 'assistant':
      return <AssistantBubble key={message.id} message={message} renderMode={renderMode} />;
    case 'system':
      return <SystemBubble key={message.id} content={(message as any).content} />;
    default:
      return null;
  }
}

/** 空状态组件 */
const EmptyState = memo(function EmptyState() {
  const { t } = useTranslation('chat');
  
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-4">
      {/* Logo 图标 */}
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-primary-600 flex items-center justify-center shadow-glow mb-6 hover:shadow-glow-lg transition-all">
        <span className="text-3xl font-bold text-white">P</span>
      </div>

      {/* 标题 */}
      <h1 className="text-2xl font-semibold text-text-primary mb-2">
        {t('welcome.title')}
      </h1>

      {/* 描述 */}
      <p className="text-text-secondary mb-8 max-w-md">
        {t('welcome.description')}
      </p>

      {/* 功能列表 */}
      <div className="grid grid-cols-3 gap-4 max-w-lg">
        <div className="flex flex-col items-center gap-2 p-4 rounded-xl bg-background-surface border border-border shadow-soft hover:shadow-medium hover:border-border-strong transition-all">
          <div className="w-8 h-8 rounded-lg bg-success-faint flex items-center justify-center">
            <FolderOpen className="w-4 h-4 text-success" />
          </div>
          <span className="text-xs text-text-tertiary">{t('welcome.featureFileManage')}</span>
        </div>
        <div className="flex flex-col items-center gap-2 p-4 rounded-xl bg-background-surface border border-border shadow-soft hover:shadow-medium hover:border-border-strong transition-all">
          <div className="w-8 h-8 rounded-lg bg-warning-faint flex items-center justify-center">
            <Code className="w-4 h-4 text-warning" />
          </div>
          <span className="text-xs text-text-tertiary">{t('welcome.featureCodeEdit')}</span>
        </div>
        <div className="flex flex-col items-center gap-2 p-4 rounded-xl bg-background-surface border border-border shadow-soft hover:shadow-medium hover:border-border-strong transition-all">
          <div className="w-8 h-8 rounded-lg bg-primary-faint flex items-center justify-center">
            <FileSearch className="w-4 h-4 text-primary" />
          </div>
          <span className="text-xs text-text-tertiary">{t('welcome.featureSmartAnalysis')}</span>
        </div>
      </div>

      {/* 提示 */}
      <p className="text-text-tertiary text-sm mt-8">
        {t('welcome.hint')}
      </p>
    </div>
  );
});

/**
 * 增强版聊天消息列表组件
 *
 * 使用内容块架构渲染消息，工具调用穿插在文本中间
 *
 * 性能优化：
 * - 流式阶段直接从 currentMessage 读取内容，不更新 messages 数组
 * - 避免 50ms 一次的整个消息列表重渲染
 */
export function EnhancedChatMessages() {
  const { messages, archivedMessages, loadMoreArchivedMessages, currentMessage, isStreaming } = useEventChatStore();

  // 性能优化：流式阶段合并 currentMessage 到消息列表
  // 这样就不需要频繁更新 messages 数组，避免整个列表重渲染
  // 使用 ref 缓存消息对象，避免每次 currentMessage 变化都创建新引用
  const prevDisplayMessagesRef = useRef<ChatMessage[]>([]);
  // 存储 lastContentRef 用于快速比较内容是否变化
  const lastContentRef = useRef<{ id: string; contentLen: number; blockCount: number } | null>(null);
  
  const displayMessages = useMemo(() => {
    if (!currentMessage || !isStreaming) {
      prevDisplayMessagesRef.current = messages;
      lastContentRef.current = null;
      return messages;
    }

    // 快速检查：如果 currentMessage 内容长度与上次相同，直接返回缓存
    const lastBlock = currentMessage.blocks[currentMessage.blocks.length - 1];
    const currentContentLen = lastBlock?.type === 'text' ? (lastBlock as any).content?.length || 0 : 0;
    const currentBlockCount = currentMessage.blocks.length;
    
    if (
      lastContentRef.current?.id === currentMessage.id &&
      lastContentRef.current?.contentLen === currentContentLen &&
      lastContentRef.current?.blockCount === currentBlockCount
    ) {
      // 内容长度相同，直接返回缓存（避免创建新数组）
      return prevDisplayMessagesRef.current;
    }

    // 更新缓存标记
    lastContentRef.current = { id: currentMessage.id, contentLen: currentContentLen, blockCount: currentBlockCount };

    // 检查 currentMessage 是否已在 messages 中
    const existingIndex = messages.findIndex(m => m.id === currentMessage.id);
    
    if (existingIndex >= 0) {
      // 内容变化，创建新的消息数组，但复用不变的消息对象
      const updated: ChatMessage[] = [
        ...messages.slice(0, existingIndex),
        {
          ...messages[existingIndex],
          blocks: currentMessage.blocks,
          isStreaming: true,
        } as AssistantChatMessage,
        ...messages.slice(existingIndex + 1),
      ];
      prevDisplayMessagesRef.current = updated;
      return updated;
    } else {
      // 添加到末尾
      const newMessages: ChatMessage[] = [...messages, {
        id: currentMessage.id,
        type: 'assistant' as const,
        blocks: currentMessage.blocks,
        timestamp: new Date().toISOString(),
        isStreaming: true,
      }];
      prevDisplayMessagesRef.current = newMessages;
      return newMessages;
    }
  }, [messages, currentMessage, isStreaming]);

  const isEmpty = displayMessages.length === 0;
  const hasArchive = archivedMessages.length > 0;

  // Virtuoso 引用，用于滚动控制
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // 智能自动滚动：用户在底部附近时自动滚动，离开底部时禁用
  const [autoScroll, setAutoScroll] = useState(true);

  // 当前可见的对话轮次索引
  const [currentRoundIndex, setCurrentRoundIndex] = useState(0);

  // 对话轮次分组（使用 displayMessages 包含流式消息）
  const conversationRounds = useMemo(() => {
    return groupConversationRounds(displayMessages);
  }, [displayMessages]);

  // 检测用户是否在底部附近（基于像素距离）
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    setAutoScroll(atBottom);
  }, []);

  // 监听可见范围变化，更新当前轮次索引
  const handleRangeChange = useCallback((range: { startIndex: number; endIndex: number }) => {
    const { startIndex, endIndex } = range;
    // 使用可见区域中心来找到最相关的轮次
    const centerIndex = Math.floor((startIndex + endIndex) / 2);

    // 找到包含中心索引的轮次
    const round = conversationRounds.findIndex(r =>
      r.messageIndices.some(idx => idx >= startIndex && idx <= endIndex) &&
      r.messageIndices.some(idx => idx > centerIndex)
    );

    // 如果没找到更合适的，使用第一个包含范围内消息的轮次
    const fallbackRound = conversationRounds.findIndex(r =>
      r.messageIndices.some(idx => idx >= startIndex && idx <= endIndex)
    );

    const targetRound = round >= 0 ? round : fallbackRound;
    if (targetRound >= 0) {
      setCurrentRoundIndex(targetRound);
    }
  }, [conversationRounds]);

  // 滚动到指定轮次
  const scrollToRound = useCallback((roundIndex: number) => {
    const round = conversationRounds[roundIndex];
    if (!round || !virtuosoRef.current) return;

    // 优先跳转到 AI 回复，如果没有则跳转到用户消息
    const targetIndex = round.assistantMessage
      ? round.messageIndices[1]  // AI 回复索引
      : round.messageIndices[0]; // 用户消息索引

    virtuosoRef.current.scrollToIndex({
      index: targetIndex,
      align: 'start',
      behavior: 'smooth',
    });

    setAutoScroll(false); // 禁用自动滚动
  }, [conversationRounds]);

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    if (!virtuosoRef.current) return;

    // 使用 scrollTo 替代 scrollToIndex，确保滚动到容器的物理底部
    virtuosoRef.current.scrollTo({
      top: Number.MAX_SAFE_INTEGER,
      behavior: 'smooth',
    });

    setAutoScroll(true); // 启用自动滚动
  }, []);

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* 归档消息提示 - 分批加载 */}
      {hasArchive && (
        <div className="flex justify-center py-2 bg-background-surface border-b border-border">
          <button
            onClick={() => loadMoreArchivedMessages(20)}
            className="text-xs text-primary hover:text-primary-hover transition-colors flex items-center gap-2 px-3 py-1.5 rounded-full hover:bg-primary-faint"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
            加载更早的消息 ({archivedMessages.length} 条)
          </button>
        </div>
      )}

      {/* 消息列表 */}
      <div className="flex-1 min-h-0 relative">
        <div className="h-full">
          {isEmpty ? (
            <EmptyState />
          ) : (
            <Virtuoso
              ref={virtuosoRef}
              style={{ height: '100%' }}
              data={displayMessages}
              itemContent={(index, item) => {
                // 计算当前消息的渲染模式
                const renderMode = calculateRenderMode(index, displayMessages.length, DEFAULT_LAYER_CONFIG);
                return renderChatMessage(item, renderMode);
              }}
              components={{
                EmptyPlaceholder: () => null,
                Header: hasArchive ? (() => (
                  <div className="flex justify-center py-3">
                    <button
                      onClick={() => loadMoreArchivedMessages(20)}
                      className="text-xs text-text-tertiary hover:text-primary transition-colors flex items-center gap-1"
                    >
                      <ChevronDown className="w-3 h-3" />
                      加载更早 20 条消息
                    </button>
                  </div>
                )) : undefined,
                Footer: () => <div style={{ height: '120px' }} />,
              }}
              followOutput={autoScroll ? (isStreaming ? true : 'smooth') : false}
              atBottomStateChange={handleAtBottomStateChange}
              atBottomThreshold={150}
              rangeChanged={handleRangeChange}
              increaseViewportBy={{ top: 100, bottom: 300 }}
              initialTopMostItemIndex={displayMessages.length - 1}
            />
          )}
        </div>

        {/* 聊天导航器 */}
        {!isEmpty && (
          <ChatNavigator
            rounds={conversationRounds}
            currentRoundIndex={currentRoundIndex}
            onScrollToBottom={scrollToBottom}
            onScrollToRound={scrollToRound}
          />
        )}
      </div>
    </div>
  );
}
