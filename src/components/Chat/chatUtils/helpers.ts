/**
 * 聊天组件共享工具函数
 */

import type { AssistantChatMessage, ContentBlock, TextBlock, ToolCallBlock } from '@/types';
import type { TodoInputData } from './types';
import { markdownCache } from '@/utils/cache';

/** Markdown 渲染器（使用缓存优化） */
export function formatContent(content: string): string {
  return markdownCache.render(content);
}

/** 提取助手消息的纯文本内容 */
export function extractAssistantText(message: AssistantChatMessage): string {
  if (message.content) return message.content;
  if (message.blocks) {
    return message.blocks
      .filter((b): b is TextBlock => b.type === 'text')
      .map(b => b.content)
      .join('\n');
  }
  return '';
}

/**
 * 判断文本块是否为空白内容（不打断分组）
 * 空白内容：空字符串、只有空白字符、只有 "..." 或 ".."
 */
export function isEmptyTextBlock(block: ContentBlock): boolean {
  if (block.type !== 'text') return false;
  const content = (block as TextBlock).content?.trim();
  // 空内容、只有点号（如 "..."）、只有空白
  if (!content) return true;
  if (/^\.+$/.test(content)) return true;
  return false;
}

/**
 * 判断是否为 TodoWrite 工具
 */
export function isTodoWriteTool(block: ToolCallBlock): boolean {
  return block.name.toLowerCase() === 'todowrite';
}

/**
 * 判断是否为 Grep 工具
 */
export function isGrepTool(block: ToolCallBlock): boolean {
  return block.name.toLowerCase().includes('grep');
}

/**
 * 解析 TodoWrite 输入数据
 */
export function parseTodoInput(input: Record<string, unknown> | undefined): TodoInputData | null {
  if (!input) return null;
  const todos = input.todos as TodoInputData['todos'];
  if (!Array.isArray(todos)) return null;

  return {
    todos,
    total: todos.length,
    completed: todos.filter(t => t.status === 'completed').length,
    inProgress: todos.filter(t => t.status === 'in_progress').length,
    pending: todos.filter(t => t.status === 'pending').length,
  };
}
