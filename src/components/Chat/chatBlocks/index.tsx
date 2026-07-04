/**
 * 内容块渲染器 - 统一路由
 * 每个块都有错误边界保护
 */

import React from 'react';
import type { ContentBlock } from '@/types';
import { ContentBlockErrorBoundary } from '../ContentBlockErrorBoundary';
import { AskQuestionCard } from '../AskQuestionCard';
import { PlanModeBlockRenderer } from '../PlanModeBlockRenderer';
import { AgentRunBlockRenderer } from '../AgentRunBlockRenderer';
import { PermissionRequestRenderer } from '../PermissionRequestRenderer';
import { TextBlockRenderer } from './TextBlockRenderer';
import { ThinkingBlockRenderer } from './ThinkingBlockRenderer';
import { ToolCallBlockRenderer } from './ToolCallBlockRenderer';
import { ArtifactPreviewRenderer } from './ArtifactPreviewRenderer';
import { MediaPreviewRenderer } from './MediaPreviewRenderer';

export function renderContentBlock(
  block: ContentBlock,
  isStreaming?: boolean
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
        <TextBlockRenderer block={block} isStreaming={isStreaming} />,
        `text-${block.content.slice(0, 20)}`
      );
    case 'thinking':
      return wrapWithErrorBoundary(
        <ThinkingBlockRenderer block={block} isStreaming={isStreaming} />,
        `thinking-${block.content.slice(0, 20)}`
      );
    case 'tool_call':
      return wrapWithErrorBoundary(
        <ToolCallBlockRenderer block={block} />,
        block.id
      );
    case 'artifact_preview':
      return wrapWithErrorBoundary(
        <ArtifactPreviewRenderer block={block} />,
        block.previewId
      );
    case 'media_preview':
      return wrapWithErrorBoundary(
        <MediaPreviewRenderer block={block} />,
        `media-${block.mediaType}-${block.url?.slice(0, 20) || block.videoId || 'unknown'}`
      );
    case 'question':
      return wrapWithErrorBoundary(
        <AskQuestionCard block={block} />,
        block.id
      );
    case 'plan_mode':
      return wrapWithErrorBoundary(
        <PlanModeBlockRenderer block={block} />,
        block.id
      );
    case 'agent_run':
      return wrapWithErrorBoundary(
        <AgentRunBlockRenderer block={block} />,
        block.id
      );
    case 'permission_request':
      return wrapWithErrorBoundary(
        <PermissionRequestRenderer block={block} />,
        block.id
      );
    default:
      return null;
  }
}
