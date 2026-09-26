/**
 * 可折叠块分组逻辑 + 渲染器
 */

import { memo, useState, useEffect, useMemo } from 'react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { ChevronRight, ChevronUp, FileText, Brain, Check, XCircle, Wrench, ListTodo } from 'lucide-react';
import type { ContentBlock, ThinkingBlock, ToolCallBlock } from '@/types';
import type { ProcessBlockCollapseMode } from '@/types';
import type { CollapsibleBlockGroup } from '../chatUtils/types';
import { TOOL_COLLAPSE_CONFIG } from '../chatUtils/constants';
import { isEmptyTextBlock } from '../chatUtils/helpers';
import { ToolCallBlockRenderer } from '../chatBlocks/ToolCallBlockRenderer';
import { ThinkingBlockRenderer } from '../chatBlocks/ThinkingBlockRenderer';
import { renderContentBlock } from '../chatBlocks';
import { extractEditDiff, extractWriteInfo, type DiffData } from '@/utils/diffExtractor';
import { extractToolKeyInfo } from '@/utils/toolConfig';
import { calculateDuration, formatDuration } from '@/utils/toolSummary';

/**
 * 块分类枚举。
 * - 'process'：过程块（结束后折叠入汇总条）
 * - 'result'：结果块（始终保留，优先展示）
 * - 'skip'：空文本等不渲染的块
 */
type BlockCategory = 'process' | 'result' | 'skip';

/**
 * 单一分类函数（替代多个独立 isXxxBlock，减少维护负担）。
 * 吸收审查意见：
 * - text 复用 isEmptyTextBlock 过滤空文本（"..." 等）
 * - plugin_card 仅 interaction + pending 态按过程块处理，其余保留为结果
 * - default 兜底 skip，未知类型不丢失（由上层兜底渲染）
 */
function categorizeBlock(block: ContentBlock): BlockCategory {
  switch (block.type) {
    case 'text':
      return isEmptyTextBlock(block) ? 'skip' : 'result';
    case 'artifact_preview':
      return 'result';
    case 'plugin_card':
      // interaction 模式 pending 态：等待用户回复，按过程块折叠
      return block.mode === 'interaction' && block.status === 'pending'
        ? 'process' : 'result';
    case 'thinking':
    case 'tool_call':
    case 'plan_mode':
    case 'agent_run':
    case 'permission_request':
    case 'question':
    case 'context_compact':
    case 'tool_group':
      return 'process';
    default:
      // 未知/新增块类型：归为 result 兜底渲染，避免内容丢失
      return 'result';
  }
}

/**
 * 提取过程块（与 categorizeBlock 的 process 分类一致）。
 * 供补充卡片（SessionSummaryCard）"运行过程" tab 复用，
 * 与 AutoModeRenderer 的折叠块集合保持同一语义。
 */
export function extractProcessBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.filter((b) => categorizeBlock(b) === 'process');
}

/** 变更文件信息（从工具调用块中提取） */
interface FileChange {
  /** 完整路径（用于打开编辑器 + 去重 key） */
  fullPath: string;
  /** 仅文件名（用于展示） */
  fileName: string;
  /** 目录路径（用于展示的次要信息） */
  dirPath: string;
  /** 变更类型 */
  changeType: 'modified' | 'created' | 'deleted';
  /** Edit 工具的 diff 数据（modified 时有） */
  diffData?: DiffData;
  /** Write 工具的新内容（created 时有） */
  newContent?: string;
}

/** 从完整路径中拆分文件名和目录 */
function splitFilePath(filePath: string): { fileName: string; dirPath: string } {
  const parts = filePath.split(/[/\\]/).filter(Boolean);
  const fileName = parts.pop() || filePath;
  const dirPath = parts.join('/') + (parts.length ? '/' : '');
  return { fileName, dirPath };
}

/**
 * 从工具调用块中提取变更文件列表。
 * - Edit 工具：diffData.filePath → modified（含 diff 数据）
 * - Write 工具：input.file_path/path → created（含新内容）
 * - apply_patch：patchData[] 多文件 → modified / deleted
 * 复用 diffExtractor，去重（同一文件多次修改只记一次，优先保留 diff 数据）。
 */
export function extractFileChanges(blocks: ContentBlock[]): FileChange[] {
  const seen = new Map<string, FileChange>();
  const add = (fullPath: string, changeType: FileChange['changeType'], data?: Partial<FileChange>) => {
    const { fileName, dirPath } = splitFilePath(fullPath);
    const existing = seen.get(fullPath);
    if (existing) {
      // 已存在：合并 diff/内容数据（保留已有，补充缺失）
      seen.set(fullPath, {
        ...existing,
        ...data,
        changeType,
        fileName: existing.fileName || fileName,
        dirPath: existing.dirPath || dirPath,
      });
      return;
    }
    seen.set(fullPath, {
      fullPath,
      fileName,
      dirPath,
      changeType,
      ...data,
    });
  };

  for (const b of blocks) {
    if (b.type !== 'tool_call' || b.status !== 'completed') continue;

    // apply_patch：多文件补丁（Claude Code 主要改文件工具）
    if (b.name === 'apply_patch' && b.patchData && b.patchData.length > 0) {
      for (const p of b.patchData) {
        if (!p.filePath) continue;
        add(p.filePath, p.type === 'delete' ? 'deleted' : 'modified');
      }
      continue;
    }

    const edit = extractEditDiff(b);
    if (edit?.filePath) {
      add(edit.filePath, 'modified', { diffData: edit });
      continue;
    }
    const write = extractWriteInfo(b);
    if (write?.filePath) {
      add(write.filePath, 'created', { newContent: write.newContent });
    }
  }
  return Array.from(seen.values());
}

/**
 * 可折叠块组组件 - thinking + tool_call 混合折叠
 */
const CollapsibleBlockGroupRenderer = memo(function CollapsibleBlockGroupRenderer({
  blocks,
  maxVisible,
  isStreaming,
}: {
  blocks: (ThinkingBlock | ToolCallBlock)[];
  maxVisible: number;
  isStreaming?: boolean;
}) {
  const { t } = useTranslation('chat');

  // 流式期间默认展开，结束后自动折叠
  const [isExpanded, setIsExpanded] = useState(() => isStreaming ?? false);

  // 流式结束时自动折叠
  useEffect(() => {
    if (!isStreaming && isExpanded) {
      setIsExpanded(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isExpanded check prevents infinite loop
  }, [isStreaming]);

  const hiddenCount = blocks.length - maxVisible;
  const visibleBlocks = isExpanded ? blocks : blocks.slice(0, maxVisible);

  // 统计 thinking 和 tool_call 数量
  const thinkingCount = blocks.filter(b => b.type === 'thinking').length;
  const toolCount = blocks.filter(b => b.type === 'tool_call').length;

  return (
    <div className="collapsible-block-group">
      {visibleBlocks.map((block, index) => {
        if (block.type === 'thinking') {
          return (
            <div key={`thinking-${index}`}>
              <ThinkingBlockRenderer block={block} isStreaming={isStreaming} />
            </div>
          );
        } else {
          return (
            <div key={`tool-${index}`}>
              <ToolCallBlockRenderer block={block as ToolCallBlock} isStreaming={isStreaming} />
            </div>
          );
        }
      })}

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


/**
 * 过程块段落折叠列表（v3 段落折叠式）
 *
 * 按类型分组为独立可折叠段落，每段有：
 * - 头部行：图标 + 标题 + 一行摘要 + 计数 + 折叠箭头
 * - 展开内容：精炼卡片（tool_call 一行式，thinking 预览+展开）
 *
 * 导出供 SessionSummaryCard 段落复用。
 * bare 模式：无外层边框（嵌入卡片内部，由卡片提供边框）。
 */
export const ProcessBlockGroupedList = memo(function ProcessBlockGroupedList({
  processBlocks,
  bare = false,
}: {
  processBlocks: ContentBlock[];
  bare?: boolean;
}) {
  const { t } = useTranslation('chat');

  // 按类型分组（保持出现顺序）
  const groups = useMemo(() => {
    const map = new Map<string, ContentBlock[]>();
    const order: string[] = [];
    for (const b of processBlocks) {
      const key = getBlockGroupKey(b);
      if (!map.has(key)) { map.set(key, []); order.push(key); }
      map.get(key)!.push(b);
    }
    return order.map(k => ({ key: k, label: getBlockGroupLabel(k, t), blocks: map.get(k)! }));
  }, [processBlocks, t]);

  return (
    <div className={clsx('flex flex-col', !bare && 'border border-border rounded-md overflow-hidden')}>
      {groups.map(group => (
        <ProcessSection key={group.key} groupKey={group.key} label={group.label} blocks={group.blocks} />
      ))}
    </div>
  );
});

/** 单个过程段落（可折叠） */
const ProcessSection = memo(function ProcessSection({
  groupKey, label, blocks,
}: {
  groupKey: string;
  label: string;
  blocks: ContentBlock[];
}) {
  const [open, setOpen] = useState(false);

  // 一行摘要：取第一个块的关键信息
  const summary = useMemo(() => deriveSectionSummary(blocks), [blocks]);

  return (
    <div className="border-b border-border last:border-b-0">
      {/* 段落头部 */}
      <button
        className={clsx(
          'flex items-center gap-2 w-full px-3 py-2 text-left',
          'transition-colors hover:bg-background-hover min-h-[44px]'
        )}
        onClick={() => setOpen(o => !o)}
      >
        {getGroupIcon(groupKey)}
        <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider flex-shrink-0">
          {label}
        </span>
        <span className="text-[11px] text-text-tertiary flex-1 min-w-0 truncate">{summary}</span>
        <span className="text-[10px] text-text-muted flex-shrink-0">{blocks.length}</span>
        <ChevronRight className={clsx('w-3 h-3 text-text-muted flex-shrink-0 transition-transform', open && 'rotate-90')} />
      </button>

      {/* 段落展开内容：精炼卡片列表 */}
      {open && (
        <div className="max-h-[50vh] overflow-y-auto">
          {blocks.map((block, idx) => (
            <ProcessBlockItem key={idx} block={block} />
          ))}
        </div>
      )}
    </div>
  );
});

/** 过程块精炼渲染（替代 renderContentBlock 全展开） */
const ProcessBlockItem = memo(function ProcessBlockItem({
  block,
}: {
  block: ContentBlock;
}) {
  // thinking：复用 ThinkingBlockRenderer（自带折叠+预览）
  if (block.type === 'thinking') {
    return (
      <div className="px-2 py-1">
        <ThinkingBlockRenderer block={block as ThinkingBlock} />
      </div>
    );
  }
  // tool_call：一行式精炼卡片
  if (block.type === 'tool_call') {
    return <ToolCallLite block={block as ToolCallBlock} />;
  }
  // 其余类型：回退到完整渲染器（plan_mode / agent_run 等有专用渲染器）
  return (
    <div className="border-b border-border last:border-b-0">
      {renderContentBlock(block, false)}
    </div>
  );
});

/** tool_call 精炼一行卡片 */
const ToolCallLite = memo(function ToolCallLite({ block }: { block: ToolCallBlock }) {
  const [open, setOpen] = useState(false);
  const info = useMemo(() => {
    try { return extractToolKeyInfo(block.name, block.input); } catch { return ''; }
  }, [block.name, block.input]);
  const duration = useMemo(() => {
    if (block.startedAt && block.completedAt) {
      const ms = calculateDuration(block.startedAt, block.completedAt);
      return ms != null ? formatDuration(ms) : '';
    }
    return '';
  }, [block.startedAt, block.completedAt]);
  const ok = block.status === 'completed';
  const failed = block.status === 'failed';

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-background-hover transition-colors min-h-[44px]"
        onClick={() => setOpen(o => !o)}
      >
        <Wrench className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
        <span className="text-xs font-medium text-text-secondary flex-shrink-0">{block.name}</span>
        {info && <span className="text-[11px] text-text-muted flex-1 min-w-0 truncate font-mono">{info}</span>}
        {ok && <span className="text-[10px] text-green-400 flex-shrink-0"><Check className="w-3 h-3" /></span>}
        {failed && <span className="text-[10px] text-red-400 flex-shrink-0"><XCircle className="w-3 h-3" /></span>}
        {duration && <span className="text-[10px] text-text-muted flex-shrink-0">{duration}</span>}
        <ChevronRight className={clsx('w-3 h-3 text-text-muted flex-shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="px-3 py-2 bg-background-base border-t border-border max-h-[180px] overflow-y-auto">
          <ToolCallBlockRenderer block={block} />
        </div>
      )}
    </div>
  );
});

/** 段落一行摘要 */
function deriveSectionSummary(blocks: ContentBlock[]): string {
  if (blocks.length === 0) return '';
  const names = blocks.map(b => {
    if (b.type === 'tool_call') return b.name;
    if (b.type === 'thinking') return 'thinking';
    return b.type;
  });
  // 去重统计
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
  const parts = [...counts.entries()].map(([n, c]) => c > 1 ? `${n} ×${c}` : n);
  return parts.join(' · ');
}

/** 获取块的分组 key */
function getBlockGroupKey(block: ContentBlock): string {
  switch (block.type) {
    case 'thinking': return 'thinking';
    case 'tool_call': return 'tools';
    case 'plan_mode': return 'plan';
    case 'permission_request': return 'permission';
    case 'agent_run': return 'agent';
    case 'question': return 'question';
    case 'context_compact': return 'compact';
    case 'tool_group': return 'tools';
    case 'text': return 'text';
    default: return 'other';
  }
}

/** 获取分组显示标签 */
function getBlockGroupLabel(key: string, t: (key: string) => string): string {
  switch (key) {
    case 'thinking': return t('summary.sectionThinking');
    case 'tools': return t('summary.sectionTools');
    case 'plan': return t('summary.sectionPlan');
    case 'permission': return 'Permission';
    case 'agent': return 'Agent';
    case 'question': return 'Question';
    case 'compact': return 'Compact';
    case 'text': return 'Text';
    default: return 'Other';
  }
}

/** 获取分组图标 */
function getGroupIcon(key: string): React.ReactNode {
  const className = 'w-3.5 h-3.5';
  switch (key) {
    case 'thinking':
      return <Brain className={clsx(className, 'text-purple-400')} />;
    case 'tools':
      return <Wrench className={clsx(className, 'text-blue-400')} />;
    case 'plan':
      return <ListTodo className={clsx(className, 'text-yellow-400')} />;
    case 'permission':
      return <FileText className={clsx(className, 'text-orange-400')} />;
    case 'agent':
      return <FileText className={clsx(className, 'text-cyan-400')} />;
    default:
      return <FileText className={clsx(className, 'text-text-muted')} />;
  }
}

/**
 * 识别连续的可折叠块分组（thinking + tool_call）
 * 空文本块（空内容或只有"..."）不打断分组
 */
export function identifyCollapsibleBlockGroups(blocks: ContentBlock[]): CollapsibleBlockGroup[] {
  const groups: CollapsibleBlockGroup[] = [];
  let currentBlocks: (ThinkingBlock | ToolCallBlock)[] = [];
  let currentIndices: number[] = [];
  let groupStartIndex = 0;

  blocks.forEach((block, index) => {
    if (block.type === 'tool_call' || block.type === 'thinking') {
      if (currentBlocks.length === 0) {
        groupStartIndex = index;
      }
      currentBlocks.push(block as ThinkingBlock | ToolCallBlock);
      currentIndices.push(index);
    } else if (!isEmptyTextBlock(block)) {
      if (currentBlocks.length > 0) {
        groups.push({
          startIndex: groupStartIndex,
          endIndex: currentIndices[currentIndices.length - 1],
          blocks: currentBlocks,
          indices: [...currentIndices],
        });
        currentBlocks = [];
        currentIndices = [];
      }
    }
    // 空白块不打断分组（继续累积）
  });

  // 处理末尾的组
  if (currentBlocks.length > 0) {
    groups.push({
      startIndex: groupStartIndex,
      endIndex: currentIndices[currentIndices.length - 1],
      blocks: currentBlocks,
      indices: [...currentIndices],
    });
  }

  return groups;
}

/**
 * Auto 模式渲染器：折叠态只显示结果块 + 汇总条，展开态恢复全部原始顺序。
 * 包裹为组件以便管理展开/折叠状态。
 */
const AutoModeRenderer = memo(function AutoModeRenderer({
  blocks,
}: {
  blocks: ContentBlock[];
}) {
  // 定位最后一个非空 text 块（最终结果）
  let lastTextIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === 'text' && !isEmptyTextBlock(blocks[i])) {
      lastTextIdx = i;
      break;
    }
  }

  const resultBlocks: ContentBlock[] = [];
  const foldedBlocks: ContentBlock[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const category = categorizeBlock(block);

    if (category === 'process') {
      foldedBlocks.push(block);
    } else if (category === 'result') {
      // text：仅保留最后一个作为最终结果，中间 text 折叠
      if (block.type === 'text') {
        if (i === lastTextIdx) {
          resultBlocks.push(block);
        } else {
          foldedBlocks.push(block);
        }
      } else {
        // artifact_preview / plugin_card：不再于消息正文直出，
        // 统一由补充卡片（SessionSummaryCard）"预览" tab 承载，避免双份。
        foldedBlocks.push(block);
      }
    }
    // skip（空文本）→ 不渲染也不折叠
  }

  const children: React.ReactNode[] = [];

  // 结果块（最终文本）始终可见
  resultBlocks.forEach((block, index) => {
    children.push(
      <div key={`result-${index}`}>{renderContentBlock(block, false)}</div>
    );
  });

  // 折叠块不再于消息内渲染"运行过程已折叠"汇总条：
  // 统一由 AssistantBubble 后的补充卡片（SessionSummaryCard）承载
  // （含运行过程 / 变更文件 / 预览 三 tab），避免双份冗余。
  return <>{children}</>;
});

export function renderBlocksWithGrouping(
  blocks: ContentBlock[],
  isStreaming: boolean | undefined,
  collapseMode?: ProcessBlockCollapseMode,
): React.ReactNode[] {
  const mode = collapseMode ?? 'auto';

  // ===== 新行为：auto 模式 + 非流式 → 折叠汇总 =====
  if (!isStreaming && mode === 'auto') {
    return [<AutoModeRenderer key="auto" blocks={blocks} />];
  }

  // ===== 原有逻辑不变（legacy 模式 / 流式期间）=====
  // 识别可折叠块分组
  const groups = identifyCollapsibleBlockGroups(blocks);

  // 如果没有分组，直接渲染
  if (groups.length === 0) {
    return blocks.map((block, index) => (
      <div key={`block-${index}`} data-block-index={index}>
        {renderContentBlock(block, isStreaming)}
      </div>
    ));
  }

  // 构建分组映射
  const groupMap = new Map<number, CollapsibleBlockGroup>();
  groups.forEach(group => {
    group.indices.forEach(idx => {
      groupMap.set(idx, group);
    });
  });

  const result: React.ReactNode[] = [];
  const processedIndices = new Set<number>();

  blocks.forEach((block, index) => {
    if (processedIndices.has(index)) return;

    const group = groupMap.get(index);

    if (group && group.blocks.length > TOOL_COLLAPSE_CONFIG.collapseThreshold) {
      result.push(
        <CollapsibleBlockGroupRenderer
          key={`group-${group.startIndex}`}
          blocks={group.blocks}
          maxVisible={TOOL_COLLAPSE_CONFIG.maxVisibleBlocks}
          isStreaming={isStreaming}
        />
      );
      group.indices.forEach((idx: number) => processedIndices.add(idx));
    } else if (group) {
      group.blocks.forEach((b: ThinkingBlock | ToolCallBlock, i: number) => {
        const blockIndex = group.indices[i];
        if (b.type === 'thinking') {
          result.push(
            <div key={`block-${blockIndex}`} data-block-index={blockIndex}>
              <ThinkingBlockRenderer block={b as ThinkingBlock} isStreaming={isStreaming} />
            </div>
          );
        } else {
          result.push(
            <div key={`block-${blockIndex}`} data-block-index={blockIndex}>
              <ToolCallBlockRenderer block={b as ToolCallBlock} isStreaming={isStreaming} />
            </div>
          );
        }
        processedIndices.add(blockIndex);
      });
    } else {
      result.push(
        <div key={`block-${index}`} data-block-index={index}>
          {renderContentBlock(block, isStreaming)}
        </div>
      );
    }
  });

  return result;
}