/**
 * 内容块渲染器 - 统一路由
 * 每个块都有错误边界保护
 */

import React from 'react';
import type { ContentBlock } from '@/types';
import { ContentBlockErrorBoundary } from '../common/ContentBlockErrorBoundary';
import { AskQuestionCard } from '../tool-calls/AskQuestionCard';
import { PlanModeBlockRenderer } from '../tool-calls/PlanModeBlockRenderer';
import { AgentRunBlockRenderer } from '../tool-calls/AgentRunBlockRenderer';
import { TaskBoardRenderer } from './TaskBoardRenderer';
import { PermissionRequestRenderer } from '../tool-calls/PermissionRequestRenderer';
import { TextBlockRenderer } from './TextBlockRenderer';
import { ThinkingBlockRenderer } from './ThinkingBlockRenderer';
import { ToolCallBlockRenderer } from './ToolCallBlockRenderer';
import { ArtifactPreviewRenderer } from './ArtifactPreviewRenderer';
import { PluginCardHost } from './PluginCardHost';
import { ContextCompactRenderer } from './ContextCompactRenderer';
import { DispatchTaskCard } from '../dispatch/DispatchTaskCard';
import { AssaultResultCard } from '../tool-calls/AssaultResultCard';
import { WorkflowCard } from '../tool-calls/WorkflowCard';
import { parseWorkflowResult } from '../tool-calls/workflowParsers';

/** dispatch_task 工具块渲染为专属派发卡片（实时状态/动态/操作） */
const DISPATCH_TOOL_NAME = 'mcp__polaris-dispatch__dispatch_task';
/** workflow 工具块(SDK 内置多 agent 编排)。按 name 小写规范化匹配,同时命中
 * 'workflow' 与 'Workflow'。解析器注册表(parseWorkflowResult)自协商三路分发:
 * 攻坚格式→AssaultResultCard,通用 workflow→WorkflowCard,全失败→降级工具块。 */
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
      // spec 协议输出（已移除）
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
      if (block.name.toLowerCase() === WORKFLOW_TOOL_NAME) {
        // 解析器注册表自协商:攻坚格式→AssaultResultCard,通用 workflow→WorkflowCard,
        // 全失败→降级通用工具块。避免误捕获 deep-research / code-review 等非攻坚 workflow。
        const parsed = parseWorkflowResult(block.output);
        if (parsed.kind === 'assault') {
          return wrapWithErrorBoundary(
            <AssaultResultCard block={block} />,
            block.id
          );
        }
        if (parsed.kind === 'generic') {
          return wrapWithErrorBoundary(
            <WorkflowCard block={block} data={parsed.data} />,
            block.id
          );
        }
        // kind === 'none':降级通用工具块
      }
      return wrapWithErrorBoundary(
        <ToolCallBlockRenderer block={block} isStreaming={isStreaming} />,
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
    case 'task_board':
      return wrapWithErrorBoundary(
        <TaskBoardRenderer block={block} />,
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
