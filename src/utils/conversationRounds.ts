/**
 * 对话轮次分组工具
 *
 * 将用户消息和助手回复配对分组，用于消息导航
 */

import type { ChatMessage, UserChatMessage, AssistantChatMessage } from '../types';
import { isTextBlock, isToolCallBlock } from '../types';

/** 对话轮次摘要 */
export interface ConversationRound {
  /** 轮次索引（从 0 开始） */
  roundIndex: number;
  /** 用户消息 */
  userMessage: UserChatMessage;
  /** 助手回复（可能尚未回复） */
  assistantMessage?: AssistantChatMessage;
  /** 用户消息摘要 */
  userSummary: string;
  /** 助手回复摘要 */
  assistantSummary: string;
  /** 是否包含工具调用 */
  hasTools: boolean;
  /** 格式化时间 */
  timestamp: string;
  /** 消息在数组中的索引 */
  messageIndices: number[];
}

/** 从消息内容中提取纯文本摘要 */
function extractSummary(content: string, maxLength = 40): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength - 1) + '…';
}

/** 从助手消息的 blocks 中提取摘要 */
function extractAssistantSummary(message: AssistantChatMessage): string {
  if (message.content) {
    return extractSummary(message.content);
  }

  if (message.blocks && message.blocks.length > 0) {
    // 查找第一个文本块
    const textBlock = message.blocks.find(isTextBlock);
    if (textBlock) {
      return extractSummary(textBlock.content);
    }
    // 如果没有文本块，使用工具名称
    const toolBlock = message.blocks.find(isToolCallBlock);
    if (toolBlock) {
      return `使用工具: ${toolBlock.name}`;
    }
  }

  return '[空回复]';
}

/** 格式化时间戳 */
function formatTimestamp(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/** 检查助手消息是否包含工具调用 */
function hasToolCalls(message: AssistantChatMessage): boolean {
  if (!message.blocks) return false;
  return message.blocks.some(block => block.type === 'tool_call');
}

/**
 * 将消息列表分组为对话轮次
 *
 * 分组规则：
 * - 每个用户消息开始一个新轮次
 * - 用户消息后的助手消息属于同一轮次
 * - 连续的助手消息合并到同一个轮次
 * - 系统消息被忽略
 */
export function groupConversationRounds(messages: ChatMessage[]): ConversationRound[] {
  const rounds: ConversationRound[] = [];
  let currentRound: Partial<ConversationRound> | null = null;
  let roundIndex = 0;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    switch (message.type) {
      case 'user': {
        // 如果有待处理的轮次，先完成它
        if (currentRound && currentRound.userMessage) {
          rounds.push(currentRound as ConversationRound);
          roundIndex++;
        }

        // 开始新轮次
        const userMsg = message as UserChatMessage;
        currentRound = {
          roundIndex,
          userMessage: userMsg,
          userSummary: extractSummary(userMsg.content),
          assistantSummary: '',
          hasTools: false,
          timestamp: formatTimestamp(userMsg.timestamp),
          messageIndices: [i],
        };
        break;
      }

      case 'assistant': {
        if (currentRound) {
          const assistantMsg = message as AssistantChatMessage;

          // 如果已经有助手消息，合并摘要
          if (currentRound.assistantMessage) {
            currentRound.assistantSummary = extractAssistantSummary(assistantMsg);
          } else {
            currentRound.assistantMessage = assistantMsg;
            currentRound.assistantSummary = extractAssistantSummary(assistantMsg);
          }

          // 更新工具调用标记
          if (!currentRound.hasTools && hasToolCalls(assistantMsg)) {
            currentRound.hasTools = true;
          }

          currentRound.messageIndices?.push(i);
        }
        break;
      }

      case 'system':
        // 系统消息不参与分组，但记录索引
        if (currentRound) {
          currentRound.messageIndices?.push(i);
        }
        break;
    }
  }

  // 添加最后一个轮次
  if (currentRound && currentRound.userMessage) {
    rounds.push(currentRound as ConversationRound);
  }

  return rounds;
}
