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

import { useMemo, memo, useState, useRef, useDeferredValue, useEffect, useCallback } from 'react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { clsx } from 'clsx';
import type { ChatMessage, UserChatMessage, AssistantChatMessage, ContentBlock, TextBlock, ThinkingBlock, ToolCallBlock } from '../../types';
import { useEventChatStore } from '../../stores';
import { useActiveSessionMessages, useActiveSessionStreaming } from '../../stores/conversationStore/useActiveSession';
import { getToolConfig, extractToolKeyInfo, getToolShortName } from '../../utils/toolConfig';
import { markdownCache } from '../../utils/cache';
import { useThrottle } from '../../hooks/useThrottle';
import {
  formatDuration,
  calculateDuration,
  generateCollapsedSummary,
  parseGrepMatches,
  stripAnsiCodes,
  escapeRegExp,
  type GrepMatch,
  type GrepOutputData
} from '../../utils/toolSummary';
import { Check, XCircle, Loader2, AlertTriangle, Play, ChevronDown, ChevronRight, ChevronUp, Circle, FileSearch, FolderOpen, Code, FileDiff, Brain, ListOrdered } from 'lucide-react';
import { ChatNavigator } from './ChatNavigator';
import { useMessageSearch, MessageSearchPanel } from './MessageSearchPanel';
import { QuestionBlockRenderer, SimplifiedQuestionRenderer } from './QuestionBlockRenderer';
import { PlanModeBlockRenderer, SimplifiedPlanModeRenderer } from './PlanModeBlockRenderer';
import { AgentRunBlockRenderer, SimplifiedAgentRunRenderer } from './AgentRunBlockRenderer';
import { PermissionRequestRenderer, SimplifiedPermissionRequestRenderer } from './PermissionRequestRenderer';
import { ContentBlockErrorBoundary } from './ContentBlockErrorBoundary';
import { groupConversationRounds } from '../../utils/conversationRounds';
import { splitMarkdownWithMermaid } from '../../utils/markdown';
import { MermaidDiagram } from './MermaidDiagram';
import { DiffViewer } from '../Diff/DiffViewer';
import { isEditTool } from '../../utils/diffExtractor';
import { calculateRenderMode, type MessageRenderMode, DEFAULT_LAYER_CONFIG } from '../../utils/messageLayer';

/** Markdown 渲染器（使用缓存优化） */
function formatContent(content: string): string {
  return markdownCache.render(content);
}

// ========================================
// 工具调用折叠配置
// ========================================

/** 工具调用折叠配置 */
const TOOL_COLLAPSE_CONFIG = {
  /** 折叠前最多显示的可折叠块数 */
  maxVisibleBlocks: 4,
  /** 触发折叠的最小块数（超过此值才折叠） */
  collapseThreshold: 5,
};

/** 可折叠块分组（支持 thinking + tool_call 混合） */
interface CollapsibleBlockGroup {
  /** 在 blocks 数组中的起始索引 */
  startIndex: number;
  /** 在 blocks 数组中的结束索引（包含） */
  endIndex: number;
  /** 连续的可折叠块 */
  blocks: (ThinkingBlock | ToolCallBlock)[];
}

// ========================================
// 思考内容步骤提取
// ========================================

/** 思考步骤提取结果 */
interface ThinkingStep {
  text: string;
  index: number;
}

/**
 * 从思考内容中提取关键步骤
 * 支持多种格式的步骤标记
 */
function extractThinkingSteps(content: string): ThinkingStep[] {
  if (!content || content.length < 50) return [];

  const lines = content.split('\n');
  const steps: ThinkingStep[] = [];
  let stepIndex = 0;

  // 步骤匹配模式
  const patterns = [
    // 数字编号: 1. xxx, 1) xxx, 1、xxx
    /^(\d+)[\.\)、]\s*(.+)$/,
    // 中文步骤词: 首先, 其次, 然后, 最后
    /^(首先|其次|然后|接着|最后)[：:\s]+(.+)$/,
    // 步骤标记: 第一步, 第二步, etc.
    /^(第[一二三四五六七八九十]+步)[：:\s]*(.*)$/,
    // 英文步骤: First, Second, Then, Finally
    /^(First|Second|Third|Then|Next|Finally)[,:]\s*(.+)$/i,
    // 破折号列表: - xxx, • xxx
    /^[-•]\s*(.+)$/,
    // 星号列表: * xxx
    /^\*\s*(.+)$/,
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 5) continue;

    for (const pattern of patterns) {
      const match = trimmed.match(pattern);
      if (match) {
        // 数字编号模式
        if (match[1] && /^\d+$/.test(match[1])) {
          const num = parseInt(match[1], 10);
          // 只提取前10个步骤，避免提取代码行号
          if (num <= 10 && num > 0) {
            steps.push({
              text: match[2].trim(),
              index: stepIndex++
            });
          }
        } else if (match[2]) {
          // 其他模式
          steps.push({
            text: match[2].trim(),
            index: stepIndex++
          });
        } else if (match[1] && !/^\d+$/.test(match[1])) {
          // 破折号/星号列表
          steps.push({
            text: match[1].trim(),
            index: stepIndex++
          });
        }
        break;
      }
    }

    // 最多提取8个步骤
    if (steps.length >= 8) break;
  }

  return steps;
}

/** 用户消息组件 - 简化版 */
const UserBubble = memo(function UserBubble({
  message,
}: {
  message: UserChatMessage;
}) {
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

/** 文本内容块组件（支持 Mermaid 渲染 + 代码高亮）
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
  isStreaming = false,
  renderMode = 'full'
}: {
  block: TextBlock;
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
          return <TextPartRenderer key={`text-${partIndex}`} content={part.content} />;
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
      className="break-words"
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
  // 如果内容为空，不渲染任何内容（避免与底部流式光标重复显示）
  if (!content) {
    return null;
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
 * 文本部分渲染器（支持代码高亮）
 */
const TextPartRenderer = memo(function TextPartRenderer({
  content
}: {
  content: string;
}) {
  const formattedHTML = useMemo(() => formatContent(content), [content]);

  return (
    <div
      className="break-words"
      dangerouslySetInnerHTML={{ __html: formattedHTML }}
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

// ========================================
// 思考过程块渲染器
// ========================================

/** 思考过程块组件 - 增强版可折叠展示 */
const ThinkingBlockRenderer = memo(function ThinkingBlockRenderer({
  block,
  isStreaming = false
}: {
  block: ThinkingBlock;
  isStreaming?: boolean;
}) {
  // 流式期间展开显示思考内容，结束后折叠
  const [isCollapsed, setIsCollapsed] = useState(() => {
    // 如果有明确的 collapsed 属性，使用它
    if (block.collapsed !== undefined) return block.collapsed;
    // 流式时展开，结束后折叠
    return !isStreaming;
  });

  // 流式结束时自动折叠
  useEffect(() => {
    if (!isStreaming) {
      setIsCollapsed(true);
    }
  }, [isStreaming]);

  // 计算字数统计
  const charCount = block.content.length;

  // 提取思考步骤
  const steps = useMemo(() => extractThinkingSteps(block.content), [block.content]);

  // 生成预览文本（折叠时显示前80字或步骤摘要）
  const previewText = useMemo(() => {
    if (steps.length >= 2) {
      // 有步骤时显示步骤数量和第一个步骤
      return `${steps.length} 个步骤: ${steps[0].text.slice(0, 40)}${steps[0].text.length > 40 ? '...' : ''}`;
    }
    // 无步骤时显示前80字
    return block.content.length > 80
      ? block.content.slice(0, 80) + '...'
      : block.content;
  }, [block.content, steps]);

  return (
    <div className="my-2 rounded-lg border border-primary/20 bg-gradient-to-r from-primary/5 to-transparent overflow-hidden">
      {/* 头部 - 可点击折叠 */}
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-primary/5 transition-colors"
      >
        <Brain className="w-4 h-4 text-primary shrink-0" />
        <span className="text-sm font-medium text-primary">思考过程</span>

        {/* 字数统计 */}
        <span className="text-xs text-text-tertiary ml-2">
          {charCount > 1000 ? `${(charCount / 1000).toFixed(1)}k` : charCount} 字
        </span>

        {/* 步骤数量徽章 */}
        {steps.length >= 2 && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/10 text-primary text-xs">
            <ListOrdered className="w-3 h-3" />
            {steps.length} 步骤
          </span>
        )}

        {/* 流式指示器 */}
        {isStreaming && (
          <span className="flex items-center gap-1 ml-2">
            <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
            <span className="text-xs text-primary">思考中...</span>
          </span>
        )}

        {/* 展开/折叠图标 */}
        <span className="ml-auto flex items-center gap-1">
          {isCollapsed ? (
            <ChevronRight className="w-4 h-4 text-text-muted" />
          ) : (
            <ChevronDown className="w-4 h-4 text-text-muted" />
          )}
        </span>
      </button>

      {/* 折叠时显示预览 */}
      {isCollapsed && previewText && (
        <div className="px-3 py-1.5 border-t border-primary/10 bg-background-surface/50">
          <p className="text-xs text-text-tertiary italic truncate">
            {previewText}
          </p>
        </div>
      )}

      {/* 展开时显示完整内容 */}
      {!isCollapsed && (
        <div className="px-3 py-2 border-t border-primary/10 bg-background-surface/30">
          {/*/!* 步骤摘要区域 *!/*/}
          {/*{steps.length >= 2 && (*/}
          {/*  <div className="mb-3 pb-3 border-b border-primary/10">*/}
          {/*    <div className="flex items-center gap-1.5 mb-2">*/}
          {/*      <ListOrdered className="w-3.5 h-3.5 text-primary" />*/}
          {/*      <span className="text-xs font-medium text-primary">思考步骤</span>*/}
          {/*    </div>*/}
          {/*    <div className="space-y-1">*/}
          {/*      {steps.map((step, idx) => (*/}
          {/*        <div key={idx} className="flex items-start gap-2 text-xs">*/}
          {/*          <span className="shrink-0 w-4 h-4 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[10px] font-medium">*/}
          {/*            {idx + 1}*/}
          {/*          </span>*/}
          {/*          <span className="text-text-secondary line-clamp-1">*/}
          {/*            {step.text.length > 60 ? step.text.slice(0, 60) + '...' : step.text}*/}
          {/*          </span>*/}
          {/*        </div>*/}
          {/*      ))}*/}
          {/*    </div>*/}
          {/*  </div>*/}
          {/*)}*/}

          {/* 完整思考内容 */}
          <div className="text-sm text-text-secondary whitespace-pre-wrap leading-relaxed">
            {block.content}
          </div>
          {/* 流式光标 */}
          {isStreaming && (
            <span className="inline-flex ml-1">
              <span className="flex gap-0.5 items-end h-4">
                <span className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
            </span>
          )}
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
  // 始终默认折叠（流式时也不展开，避免界面跳动）
  const [isExpanded, setIsExpanded] = useState(false);
  const [showFullOutput, setShowFullOutput] = useState(false);
  const [showToolDetails, setShowToolDetails] = useState(false);

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

  // 生成折叠状态的简化摘要（用于单行显示）
  const collapsedSummary = useMemo(() => {
    if (block.status === 'completed' || block.status === 'failed') {
      return generateCollapsedSummary(block.name, block.input, block.output, block.status);
    }
    return null;
  }, [block.name, block.input, block.output, block.status]);

  // 获取工具缩写
  const toolShortName = useMemo(() => getToolShortName(block.name), [block.name]);

  // 格式化输入参数（非 TodoWrite 工具使用）
  const formatInput = (input: Record<string, unknown>): string => {
    const entries = Object.entries(input);
    if (entries.length === 0) return '';
    return entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  };

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
        'my-1.5 rounded-lg overflow-hidden w-full transition-all duration-200',
        'border border-border bg-background-elevated',
        statusAnimationClass,
        block.status === 'failed' && 'border-error/30 bg-error-faint/50'
      )}
    >
      {/* 统一头部 - 折叠和展开共用 */}
      <div
        className={clsx(
          'flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-background-hover transition-colors',
          'border-l-2',
          toolConfig.borderColor
        )}
        onClick={() => canExpand && setIsExpanded(!isExpanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            canExpand && setIsExpanded(!isExpanded);
          }
        }}
        tabIndex={canExpand ? 0 : -1}
        role="button"
        aria-expanded={isExpanded}
      >
        {/* 工具缩写图标 - 始终使用字母缩写 */}
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

        {/* 耗时 */}
        {duration && (
          <span className="text-[10px] text-text-muted px-1.5 py-0.5 bg-background-secondary rounded shrink-0">
            {duration}
          </span>
        )}

        {/* 输出摘要 */}
        {collapsedSummary && collapsedSummary.summary && (
          <span className={clsx(
            'text-[10px] px-1.5 py-0.5 rounded shrink-0',
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

        {/* 状态图标 */}
        <StatusIcon className={clsx('w-3.5 h-3.5 shrink-0', statusConfig.className)} />

        {/* 展开/收起箭头 */}
        {canExpand && (
          <ChevronDown
            className={clsx(
              'w-3 h-3 text-text-muted shrink-0 transition-transform duration-200',
              isExpanded && 'rotate-180'
            )}
          />
        )}
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

/** 内容块渲染器 - 每个块都有错误边界保护 */
function renderContentBlock(
  block: ContentBlock,
  isStreaming?: boolean,
  renderMode: MessageRenderMode = 'full'
): React.ReactNode {
  // 创建带有错误边界的内容块包装器
  const wrapWithErrorBoundary = (content: React.ReactNode, blockId?: string) => (
    <ContentBlockErrorBoundary key={blockId || `block-${block.type}`} blockType={block.type} blockId={blockId}>
      {content}
    </ContentBlockErrorBoundary>
  );

  switch (block.type) {
    case 'text':
      return wrapWithErrorBoundary(
        <TextBlockRenderer block={block} isStreaming={isStreaming} renderMode={renderMode} />,
        `text-${block.content.slice(0, 20)}`
      );
    case 'thinking':
      // 归档模式下不渲染思考块
      if (renderMode === 'archive') return null;
      return wrapWithErrorBoundary(
        <ThinkingBlockRenderer block={block} isStreaming={isStreaming} />,
        `thinking-${block.content.slice(0, 20)}`
      );
    case 'tool_call':
      // 归档模式下使用简化工具渲染
      if (renderMode === 'archive') {
        return wrapWithErrorBoundary(
          <SimplifiedToolCallRenderer block={block} />,
          block.id
        );
      }
      return wrapWithErrorBoundary(
        <ToolCallBlockRenderer block={block} />,
        block.id
      );
    case 'question':
      // 归档模式下使用简化问题渲染
      if (renderMode === 'archive') {
        return wrapWithErrorBoundary(
          <SimplifiedQuestionRenderer block={block} />,
          block.id
        );
      }
      return wrapWithErrorBoundary(
        <QuestionBlockRenderer block={block} />,
        block.id
      );
    case 'plan_mode':
      // 归档模式下使用简化计划渲染
      if (renderMode === 'archive') {
        return wrapWithErrorBoundary(
          <SimplifiedPlanModeRenderer block={block} />,
          block.id
        );
      }
      return wrapWithErrorBoundary(
        <PlanModeBlockRenderer block={block} />,
        block.id
      );
    case 'agent_run':
      // 归档模式下使用简化 Agent 渲染
      if (renderMode === 'archive') {
        return wrapWithErrorBoundary(
          <SimplifiedAgentRunRenderer block={block} />,
          block.id
        );
      }
      return wrapWithErrorBoundary(
        <AgentRunBlockRenderer block={block} />,
        block.id
      );
    case 'permission_request':
      // 归档模式下使用简化权限请求渲染
      if (renderMode === 'archive') {
        return wrapWithErrorBoundary(
          <SimplifiedPermissionRequestRenderer block={block} />,
          block.id
        );
      }
      return wrapWithErrorBoundary(
        <PermissionRequestRenderer block={block} />,
        block.id
      );
    default:
      return null;
  }
}

/**
 * 简化版工具调用渲染器 - 用于归档层
 */
const SimplifiedToolCallRenderer = memo(function SimplifiedToolCallRenderer({ block }: { block: ToolCallBlock }) {
  const { t } = useTranslation('chat');
  const toolConfig = getToolConfig(block.name);
  const ToolIcon = toolConfig.icon;

  const statusText = block.status === 'completed' ? t('status.completed') :
                     block.status === 'failed' ? t('status.failed') :
                     t('status.running');

  return (
    <div
      className="my-1 flex items-center gap-2 text-xs text-text-tertiary"
      aria-label={`${toolConfig.label}: ${statusText}`}
    >
      <ToolIcon className={clsx('w-3 h-3', toolConfig.color)} aria-hidden="true" />
      <span>{toolConfig.label}</span>
      {block.status === 'completed' ? (
        <Check className="w-3 h-3 text-success" aria-hidden="true" />
      ) : block.status === 'failed' ? (
        <XCircle className="w-3 h-3 text-error" aria-hidden="true" />
      ) : null}
    </div>
  );
});

/** 助手消息组件 - 使用内容块架构 */
const AssistantBubble = memo(function AssistantBubble({
  message,
  renderMode = 'full',
}: {
  message: AssistantChatMessage;
  renderMode?: MessageRenderMode;
}) {
  const hasBlocks = message.blocks && message.blocks.length > 0;

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
        </div>

        {/* 渲染内容块（支持工具和思考块折叠聚合） */}
        {hasBlocks ? (
          <div className="space-y-1">
            {renderBlocksWithGrouping(message.blocks, message.isStreaming, renderMode)}
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

// ========================================
// 可折叠块分组识别
// ========================================

/**
 * 识别连续的可折叠块分组（thinking + tool_call）
 * 文本块等其他类型会打断分组
 */
function identifyCollapsibleBlockGroups(blocks: ContentBlock[]): CollapsibleBlockGroup[] {
  const groups: CollapsibleBlockGroup[] = [];
  let currentBlocks: (ThinkingBlock | ToolCallBlock)[] = [];
  let groupStartIndex = 0;

  blocks.forEach((block, index) => {
    // thinking 和 tool_call 都参与折叠
    if (block.type === 'tool_call' || block.type === 'thinking') {
      if (currentBlocks.length === 0) {
        groupStartIndex = index;
      }
      currentBlocks.push(block as ThinkingBlock | ToolCallBlock);
    } else {
      // 其他块类型，保存之前的组
      if (currentBlocks.length > 0) {
        groups.push({
          startIndex: groupStartIndex,
          endIndex: groupStartIndex + currentBlocks.length - 1,
          blocks: currentBlocks,
        });
        currentBlocks = [];
      }
    }
  });

  // 处理末尾的组
  if (currentBlocks.length > 0) {
    groups.push({
      startIndex: groupStartIndex,
      endIndex: groupStartIndex + currentBlocks.length - 1,
      blocks: currentBlocks,
    });
  }

  return groups;
}

// ========================================
// 思考块工具样式渲染器
// ========================================

/** 思考块简化渲染器（使用工具调用样式） */
const ThinkingAsToolRenderer = memo(function ThinkingAsToolRenderer({
  block,
  isStreaming = false,
}: {
  block: ThinkingBlock;
  isStreaming?: boolean;
}) {
  const { t } = useTranslation('chat');
  const [isExpanded, setIsExpanded] = useState(false);

  // 计算字数统计
  const charCount = block.content.length;

  // 生成预览文本（折叠时显示前50字）
  const previewText = useMemo(() => {
    return block.content.length > 50
      ? block.content.slice(0, 50) + '...'
      : block.content;
  }, [block.content]);

  // 状态配置
  const statusIcon = isStreaming ? Loader2 : Check;
  const statusClass = isStreaming ? 'animate-spin text-primary' : 'text-success';
  const StatusIcon = statusIcon;

  return (
    <div className="my-1.5 rounded-lg overflow-hidden w-full transition-all duration-200 border border-border bg-background-elevated">
      {/* 头部 - 类似工具调用样式 */}
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-background-hover transition-colors border-l-2 border-primary/30"
        onClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsExpanded(!isExpanded);
          }
        }}
        tabIndex={0}
        role="button"
        aria-expanded={isExpanded}
      >
        {/* 图标 */}
        <div className="w-5 h-5 rounded text-[10px] font-semibold flex items-center justify-center shrink-0 bg-primary/10 text-primary">
          <Brain className="w-3.5 h-3.5" />
        </div>

        {/* 名称 */}
        <span className="text-xs font-medium text-text-secondary shrink-0">
          {t('thinking.title') || '思考'}
        </span>

        {/* 字数统计 */}
        <span className="text-xs text-text-tertiary truncate flex-1 min-w-0">
          {charCount > 1000 ? `${(charCount / 1000).toFixed(1)}k` : charCount} 字
        </span>

        {/* 流式指示器 */}
        {isStreaming && (
          <span className="text-xs text-primary">思考中...</span>
        )}

        {/* 状态图标 */}
        <StatusIcon className={clsx('w-3.5 h-3.5 shrink-0', statusClass)} />

        {/* 展开/收起箭头 */}
        <ChevronDown
          className={clsx(
            'w-3 h-3 text-text-muted shrink-0 transition-transform duration-200',
            isExpanded && 'rotate-180'
          )}
        />
      </div>

      {/* 展开时显示内容 */}
      {isExpanded && (
        <div className="px-3 py-2 border-t border-border bg-background-subtle">
          <div className="text-sm text-text-secondary whitespace-pre-wrap leading-relaxed">
            {block.content}
          </div>
          {isStreaming && (
            <span className="inline-flex ml-1 mt-1">
              <span className="flex gap-0.5 items-end h-4">
                <span className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
            </span>
          )}
        </div>
      )}

      {/* 折叠时显示预览 */}
      {!isExpanded && previewText && (
        <div className="px-3 py-1.5 border-t border-border bg-background-surface/50">
          <p className="text-xs text-text-tertiary italic truncate">
            {previewText}
          </p>
        </div>
      )}
    </div>
  );
});

// ========================================
// 可折叠块组组件
// ========================================

/** 可折叠块组组件 - thinking + tool_call 混合折叠 */
const CollapsibleBlockGroupRenderer = memo(function CollapsibleBlockGroupRenderer({
  blocks,
  maxVisible,
  isStreaming,
  renderMode: _renderMode,
}: {
  blocks: (ThinkingBlock | ToolCallBlock)[];
  maxVisible: number;
  isStreaming?: boolean;
  renderMode: MessageRenderMode;
}) {
  // _renderMode 保留用于未来扩展（如 archive 模式下简化渲染）
  const { t } = useTranslation('chat');
  const [isExpanded, setIsExpanded] = useState(false);

  const hiddenCount = blocks.length - maxVisible;
  const visibleBlocks = isExpanded ? blocks : blocks.slice(0, maxVisible);

  // 统计 thinking 和 tool_call 数量
  const thinkingCount = blocks.filter(b => b.type === 'thinking').length;
  const toolCount = blocks.filter(b => b.type === 'tool_call').length;

  return (
    <div className="collapsible-block-group">
      {/* 渲染可见的块 */}
      {visibleBlocks.map((block, index) => {
        if (block.type === 'thinking') {
          return (
            <div key={`thinking-${index}`}>
              <ThinkingAsToolRenderer block={block} isStreaming={isStreaming} />
            </div>
          );
        } else {
          return (
            <div key={`tool-${index}`}>
              <ToolCallBlockRenderer block={block as ToolCallBlock} />
            </div>
          );
        }
      })}

      {/* 折叠/展开指示器 */}
      {hiddenCount > 0 && (
        <div
          className={clsx(
            'flex items-center gap-1.5 px-3 py-2 my-1',
            'bg-background-surface border border-dashed border-border rounded-md',
            'cursor-pointer text-xs text-text-secondary',
            'hover:bg-background-hover hover:border-primary hover:text-primary',
            'transition-all duration-150',
            'focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background-base'
          )}
          onClick={() => setIsExpanded(!isExpanded)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setIsExpanded(!isExpanded);
            }
          }}
          aria-expanded={isExpanded}
        >
          {isExpanded ? (
            <>
              <ChevronUp className="w-3.5 h-3.5" />
              <span>{t('tool.collapse')}</span>
            </>
          ) : (
            <>
              <ChevronRight className="w-3.5 h-3.5" />
              <span>
                {thinkingCount > 0 && toolCount > 0
                  ? t('tool.moreMixed', { count: hiddenCount })
                  : thinkingCount > 0
                    ? t('tool.moreThinking', { count: hiddenCount })
                    : t('tool.moreTools', { count: hiddenCount })}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
});

// ========================================
// 分组渲染函数
// ========================================

/**
 * 渲染内容块数组（支持思考块和工具块折叠聚合）
 */
function renderBlocksWithGrouping(
  blocks: ContentBlock[],
  isStreaming: boolean | undefined,
  renderMode: MessageRenderMode
): React.ReactNode[] {
  // 识别可折叠块分组
  const groups = identifyCollapsibleBlockGroups(blocks);

  // 如果没有分组，直接渲染
  if (groups.length === 0) {
    return blocks.map((block, index) => (
      <div key={`block-${index}`}>
        {renderContentBlock(block, isStreaming, renderMode)}
      </div>
    ));
  }

  // 构建分组映射：block index -> CollapsibleBlockGroup
  const groupMap = new Map<number, CollapsibleBlockGroup>();
  groups.forEach(group => {
    for (let i = 0; i < group.blocks.length; i++) {
      groupMap.set(group.startIndex + i, group);
    }
  });

  const result: React.ReactNode[] = [];
  const processedIndices = new Set<number>();

  blocks.forEach((block, index) => {
    if (processedIndices.has(index)) return;

    const group = groupMap.get(index);

    if (group && group.blocks.length > TOOL_COLLAPSE_CONFIG.collapseThreshold) {
      // 需要折叠的组
      result.push(
        <CollapsibleBlockGroupRenderer
          key={`group-${group.startIndex}`}
          blocks={group.blocks}
          maxVisible={TOOL_COLLAPSE_CONFIG.maxVisibleBlocks}
          isStreaming={isStreaming}
          renderMode={renderMode}
        />
      );
      // 标记组内所有块已处理
      group.blocks.forEach((_, i) => processedIndices.add(group.startIndex + i));
    } else if (group) {
      // 不需要折叠的组，逐个渲染（thinking 使用工具样式）
      group.blocks.forEach((block, i) => {
        if (block.type === 'thinking') {
          result.push(
            <div key={`block-${group.startIndex + i}`}>
              <ThinkingAsToolRenderer block={block} isStreaming={isStreaming} />
            </div>
          );
        } else {
          result.push(
            <div key={`block-${group.startIndex + i}`}>
              <ToolCallBlockRenderer block={block as ToolCallBlock} />
            </div>
          );
        }
        processedIndices.add(group.startIndex + i);
      });
    } else {
      // 非可折叠块（text, question 等）
      result.push(
        <div key={`block-${index}`}>
          {renderContentBlock(block, isStreaming, renderMode)}
        </div>
      );
    }
  });

  return result;
}

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
  const { messages, archivedMessages, currentMessage } = useActiveSessionMessages();
  const isStreaming = useActiveSessionStreaming();
  const { loadMoreArchivedMessages } = useEventChatStore();

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

  // 消息搜索功能
  const {
    searchQuery,
    setSearchQuery,
    isSearchVisible,
    openSearch,
    closeSearch,
    currentMatchIndex,
    totalMatches,
    currentMatchMessageId,
    goToPrevious,
    goToNext,
  } = useMessageSearch(displayMessages);

  // 搜索结果跳转
  useEffect(() => {
    if (currentMatchMessageId && virtuosoRef.current) {
      const index = displayMessages.findIndex(m => m.id === currentMatchMessageId);
      if (index >= 0) {
        virtuosoRef.current.scrollToIndex({
          index,
          align: 'center',
          behavior: 'smooth',
        });
      }
    }
  }, [currentMatchMessageId, displayMessages]);

  // 键盘快捷键：Ctrl+F / Cmd+F 打开搜索
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        openSearch();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openSearch]);

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

        {/* 消息搜索面板 */}
        {isSearchVisible && (
          <MessageSearchPanel
            visible={isSearchVisible}
            onClose={closeSearch}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            currentMatchIndex={currentMatchIndex}
            totalMatches={totalMatches}
            onPrevious={goToPrevious}
            onNext={goToNext}
          />
        )}

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
