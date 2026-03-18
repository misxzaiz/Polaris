/**
 * 聊天导出服务 - 将对话导出为 Markdown 或 JSON 格式
 * 支持 ChatMessage 类型（内容块架构）
 */

import type { ChatMessage, AssistantChatMessage, UserChatMessage, ContentBlock } from '../types';
import { isTextBlock, isToolCallBlock, isSystemMessage } from '../types';

/**
 * 从内容块中提取文本内容
 */
function extractTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter(isTextBlock)
    .map(block => block.content)
    .join('');
}

/**
 * 从内容块中提取工具调用摘要
 */
function extractToolSummary(blocks: ContentBlock[]): { count: number; names: string[] } | undefined {
  const toolBlocks = blocks.filter(isToolCallBlock);
  if (toolBlocks.length === 0) return undefined;

  return {
    count: toolBlocks.length,
    names: Array.from(new Set(toolBlocks.map(block => block.name))),
  };
}

/**
 * 将 ChatMessage 转换为 Markdown 格式
 */
export function exportToMarkdown(
  messages: ChatMessage[],
  workspaceName?: string
): string {
  const date = new Date().toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  let md = '# Polaris 对话记录\n\n';
  md += `**时间**: ${date}\n`;

  if (workspaceName) {
    md += `**工作区**: ${workspaceName}\n`;
  }

  md += `**消息数**: ${messages.length}\n`;
  md += '\n---\n\n';

  for (const message of messages) {
    const time = new Date(message.timestamp).toLocaleString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });

    if (message.type === 'user') {
      const userMsg = message as UserChatMessage;
      md += `## 用户\n\n`;
      md += `<small>${time}</small>\n\n`;
      md += formatContent(userMsg.content);
      md += '\n\n---\n\n';
    } else if (message.type === 'assistant') {
      const assistantMsg = message as AssistantChatMessage;
      md += `## 助手\n\n`;
      md += `<small>${time}</small>\n\n`;

      // 从 blocks 中提取文本内容
      const textContent = extractTextFromBlocks(assistantMsg.blocks);
      md += formatContent(textContent);

      // 添加工具调用摘要（如果有）
      const toolSummary = extractToolSummary(assistantMsg.blocks);
      if (toolSummary && toolSummary.count > 0) {
        md += `\n\n*调用了 ${toolSummary.count} 个工具: ${toolSummary.names.join(', ')}*`;
      }

      md += '\n\n---\n\n';
    } else if (isSystemMessage(message)) {
      md += `## 系统\n\n`;
      md += `<small>${time}</small>\n\n`;
      md += `*${message.content}*\n\n`;
      md += '---\n\n';
    }
  }

  return md;
}

/**
 * 将 ChatMessage 转换为 JSON 格式
 */
export function exportToJson(
  messages: ChatMessage[],
  workspaceName?: string
): string {
  const data = {
    metadata: {
      date: new Date().toISOString(),
      workspace: workspaceName || null,
      messageCount: messages.length,
      exportedBy: 'Polaris',
    },
    messages: messages.map(m => ({
      type: m.type,
      content: m.type === 'assistant'
        ? extractTextFromBlocks((m as AssistantChatMessage).blocks)
        : (m as UserChatMessage).content,
      timestamp: m.timestamp,
      toolSummary: m.type === 'assistant'
        ? extractToolSummary((m as AssistantChatMessage).blocks)
        : undefined,
    })),
  };

  return JSON.stringify(data, null, 2);
}

/**
 * 格式化消息内容，处理代码块
 */
function formatContent(content: string): string {
  // 移除现有的代码块标记（如果有），重新处理
  const lines = content.split('\n');
  let result = '';
  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockContent: string[] = [];

  for (const line of lines) {
    // 检测是否是代码块开始
    const codeStartMatch = line.match(/^```(\w+)?/);
    if (codeStartMatch) {
      if (!inCodeBlock) {
        // 代码块开始
        inCodeBlock = true;
        codeBlockLang = codeStartMatch[1] || '';
        codeBlockContent = [];
      } else {
        // 代码块结束
        result += '```' + (codeBlockLang ? codeBlockLang : '') + '\n';
        result += codeBlockContent.join('\n');
        result += '\n```\n\n';
        inCodeBlock = false;
        codeBlockContent = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
    } else {
      result += line + '\n';
    }
  }

  // 处理未闭合的代码块
  if (inCodeBlock) {
    result += '```' + (codeBlockLang ? codeBlockLang : '') + '\n';
    result += codeBlockContent.join('\n');
    result += '\n```\n\n';
  }

  return result;
}

/**
 * 生成默认文件名
 */
export function generateFileName(format: 'md' | 'json' = 'md'): string {
  const now = new Date();
  const date = now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
  const time = String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0');

  return `对话记录-${date}-${time}.${format}`;
}
