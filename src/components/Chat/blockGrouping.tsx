/**
 * 可折叠块分组逻辑 + 渲染器
 */

import { memo, useState, useEffect } from 'react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { ChevronRight, ChevronUp } from 'lucide-react';
import type { ContentBlock, ThinkingBlock, ToolCallBlock } from '@/types';
import type { CollapsibleBlockGroup } from './chatUtils/types';
import { TOOL_COLLAPSE_CONFIG } from './chatUtils/constants';
import { isEmptyTextBlock } from './chatUtils/helpers';
import { ToolCallBlockRenderer } from './chatBlocks/ToolCallBlockRenderer';
import { ThinkingBlockRenderer } from './chatBlocks/ThinkingBlockRenderer';
import { renderContentBlock } from './chatBlocks';

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
              <ToolCallBlockRenderer block={block as ToolCallBlock} />
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

export function renderBlocksWithGrouping(
  blocks: ContentBlock[],
  isStreaming: boolean | undefined
): React.ReactNode[] {
  // 识别可折叠块分组
  const groups = identifyCollapsibleBlockGroups(blocks);

  // 如果没有分组，直接渲染
  if (groups.length === 0) {
    return blocks.map((block, index) => (
      <div key={`block-${index}`}>
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
            <div key={`block-${blockIndex}`}>
              <ThinkingBlockRenderer block={b as ThinkingBlock} isStreaming={isStreaming} />
            </div>
          );
        } else {
          result.push(
            <div key={`block-${blockIndex}`}>
              <ToolCallBlockRenderer block={b as ToolCallBlock} />
            </div>
          );
        }
        processedIndices.add(blockIndex);
      });
    } else {
      result.push(
        <div key={`block-${index}`}>
          {renderContentBlock(block, isStreaming)}
        </div>
      );
    }
  });

  return result;
}