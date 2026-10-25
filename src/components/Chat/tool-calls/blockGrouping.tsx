/**
 * 可折叠块分组逻辑 + 渲染器
 *
 * 分组规则（plans/tool-block-collapse-behavior-fix.md 定稿）：
 * - 连续 thinking + tool_call 归为一个折叠组；仅非空 text 块打断分组。
 * - 面板类块（plugin_card/question/form/artifact_preview 等）不打断分组：
 *   面板前后被「穿透」的过程块合并为一组，面板自身原序渲染在组外侧
 *   （自然浮到其前面折叠条下方），避免面板穿插产生多条折叠条。
 * - 流式期间组默认展开；结束后自动折叠为一条汇总条（零可见块）。
 */

import { memo, useState, useEffect } from 'react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { ChevronRight, ChevronUp, Layers } from 'lucide-react';
import type { ContentBlock, ThinkingBlock, ToolCallBlock } from '@/types';
import type { CollapsibleBlockGroup } from '../chatUtils/types';
import { isEmptyTextBlock } from '../chatUtils/helpers';
import { ToolCallBlockRenderer } from '../chatBlocks/ToolCallBlockRenderer';
import { ThinkingBlockRenderer } from '../chatBlocks/ThinkingBlockRenderer';
import { renderContentBlock } from '../chatBlocks';

/**
 * 可折叠块组组件 - thinking + tool_call 混合，全折叠式。
 * 折叠态：一条汇总条（图标 + 计数 pills + 块数，零可见块）；
 * 展开态：全部块用原渲染器 + 底部收起条。
 */
const CollapsibleBlockGroupRenderer = memo(function CollapsibleBlockGroupRenderer({
  blocks,
  isStreaming,
}: {
  blocks: (ThinkingBlock | ToolCallBlock)[];
  isStreaming?: boolean;
}) {
  const { t } = useTranslation('chat');

  // 流式期间默认展开显示过程，结束后自动折叠
  const [isExpanded, setIsExpanded] = useState(() => isStreaming ?? false);

  // 流式结束时自动折叠
  useEffect(() => {
    if (!isStreaming && isExpanded) {
      setIsExpanded(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isExpanded check prevents infinite loop
  }, [isStreaming]);

  const thinkingCount = blocks.filter(b => b.type === 'thinking').length;
  const toolCount = blocks.length - thinkingCount;

  // 平铺渲染（流式期间与结束后展开态共用同构形态）
  const renderBlocks = () =>
    blocks.map((block, index) =>
      block.type === 'thinking' ? (
        <ThinkingBlockRenderer key={`thinking-${index}`} block={block} isStreaming={isStreaming} />
      ) : (
        <ToolCallBlockRenderer key={`tool-${index}`} block={block as ToolCallBlock} isStreaming={isStreaming} />
      )
    );

  // 流式期间：不渲染汇总条包装，过程块直接平铺（避免"组壳套卡片"的双层视觉）；
  // 汇总条仅在流式结束后出现。
  if (isStreaming) {
    return <>{renderBlocks()}</>;
  }

  return (
    <div className="my-1">
      {/* 汇总条（折叠态唯一可见元素；展开态作为头部，点击收起） */}
      <button
        type="button"
        className={clsx(
          'flex items-center gap-2 w-full px-3 min-h-[38px] text-left',
          'rounded-lg border border-border bg-background-elevated',
          'transition-colors hover:bg-background-hover hover:border-primary/40',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary'
        )}
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
      >
        <Layers className="w-3.5 h-3.5 text-text-muted shrink-0" />
        <span className="text-xs font-medium text-text-secondary shrink-0">
          {t('summary.collapsedLabel')}
        </span>
        {thinkingCount > 0 && (
          <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-purple-400/10 text-purple-400 shrink-0">
            {t('summary.chipThinking', { count: thinkingCount })}
          </span>
        )}
        {toolCount > 0 && (
          <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-400/10 text-blue-400 shrink-0">
            {t('summary.chipTool', { count: toolCount })}
          </span>
        )}
        <span className="ml-auto text-[10px] text-text-muted tabular-nums shrink-0">
          {t('summary.toolbarBlockCount', { count: blocks.length })}
        </span>
        <ChevronRight className={clsx('w-3.5 h-3.5 text-text-muted shrink-0 transition-transform', isExpanded && 'rotate-90')} />
      </button>

      {/* 展开态：回到平铺（无容器壳，块卡自带间距），尾部轻量收起 */}
      {isExpanded && (
        <>
          {renderBlocks()}
          <button
            type="button"
            className="flex items-center justify-center gap-1 py-1 mx-auto text-xs text-text-muted hover:text-primary transition-colors"
            onClick={() => setIsExpanded(false)}
          >
            <ChevronUp className="w-3 h-3" />
            {t('tool.collapse')}
          </button>
        </>
      )}
    </div>
  );
});

/**
 * 识别相邻的可折叠块分组（thinking + tool_call）。
 * 打断规则：仅非空文本块打断；空文本与面板类块不打断也不进组，
 * 因此组内 indices 可跨越面板块（非连续）。
 */
export function identifyCollapsibleBlockGroups(blocks: ContentBlock[]): CollapsibleBlockGroup[] {
  const groups: CollapsibleBlockGroup[] = [];
  let currentBlocks: (ThinkingBlock | ToolCallBlock)[] = [];
  let currentIndices: number[] = [];
  let groupStartIndex = 0;

  const flush = () => {
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
  };

  blocks.forEach((block, index) => {
    if (block.type === 'tool_call' || block.type === 'thinking') {
      if (currentBlocks.length === 0) {
        groupStartIndex = index;
      }
      currentBlocks.push(block as ThinkingBlock | ToolCallBlock);
      currentIndices.push(index);
    } else if (block.type === 'text' && !isEmptyTextBlock(block)) {
      // 非空文本：打断分组（文本自身平铺显示，不被吞）
      flush();
    }
    // 其余块（空文本 / 面板类）：不打断分组，继续累积
  });

  flush();
  return groups;
}

export function renderBlocksWithGrouping(
  blocks: ContentBlock[],
  isStreaming: boolean | undefined,
): React.ReactNode[] {
  const groups = identifyCollapsibleBlockGroups(blocks);

  // 没有过程块：全部原序渲染
  if (groups.length === 0) {
    return blocks.map((block, index) => (
      <div key={`block-${index}`} data-block-index={index}>
        {renderContentBlock(block, isStreaming)}
      </div>
    ));
  }

  // 组映射：块索引 → 所属组（组可跨面板块，indices 不要求连续）
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
    if (group) {
      // 组首块位置渲染折叠组；任何 ≥1 块的组都渲染为汇总条（无阈值门槛）
      result.push(
        <CollapsibleBlockGroupRenderer
          key={`group-${group.startIndex}`}
          blocks={group.blocks}
          isStreaming={isStreaming}
        />
      );
      group.indices.forEach((idx: number) => processedIndices.add(idx));
    } else {
      // 非过程块（文本 / 面板类）原序渲染
      result.push(
        <div key={`block-${index}`} data-block-index={index}>
          {renderContentBlock(block, isStreaming)}
        </div>
      );
    }
  });

  return result;
}
