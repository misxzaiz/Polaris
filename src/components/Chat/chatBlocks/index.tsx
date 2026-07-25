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
import { PluginCardHost } from './PluginCardHost';
import { ContextCompactRenderer } from './ContextCompactRenderer';
import { DispatchTaskCard } from '../DispatchTaskCard';
import { AssaultResultCard } from '../AssaultResultCard';

/** dispatch_task 工具块渲染为专属派发卡片（实时状态/动态/操作） */
const DISPATCH_TOOL_NAME = 'mcp__polaris-dispatch__dispatch_task';
/** workflow 工具块(SDK 内置多 agent 编排)渲染为攻坚结果卡片(完成态时间线) */
const WORKFLOW_TOOL_NAME = 'workflow';

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
      if (block.name === DISPATCH_TOOL_NAME) {
        return wrapWithErrorBoundary(
          <DispatchTaskCard block={block} />,
          block.id
        );
      }
      if (block.name === WORKFLOW_TOOL_NAME) {
        return wrapWithErrorBoundary(
          <AssaultResultCard block={block} />,
          block.id
        );
      }
      return wrapWithErrorBoundary(
        <ToolCallBlockRenderer block={block} />,
        block.id
      );
    case 'artifact_preview':
      return wrapWithErrorBoundary(
        <ArtifactPreviewRenderer block={block} />,
        block.previewId
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
    case 'plugin_card':
      return wrapWithErrorBoundary(
        <PluginCardHost block={block} />,
        block.id
      );
    case 'context_compact':
      return wrapWithErrorBoundary(
        <ContextCompactRenderer block={block} />,
        block.id
      );
    default:
      return null;
  }
}
