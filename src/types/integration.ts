/**
 * 集成模块类型定义
 */

/** 平台类型 */
export type Platform = 'qqbot' | 'wechat' | 'telegram';

/** 消息内容类型 */
export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  url: string;
  localPath?: string;
}

export interface FileContent {
  type: 'file';
  name: string;
  url: string;
  size: number;
}

export interface AudioContent {
  type: 'audio';
  url: string;
  transcript?: string;
}

export interface MixedContent {
  type: 'mixed';
  items: MessageContent[];
}

export type MessageContent = TextContent | ImageContent | FileContent | AudioContent | MixedContent;

/** 集成消息 */
export interface IntegrationMessage {
  id: string;
  platform: Platform;
  conversationId: string;
  senderId: string;
  senderName: string;
  content: MessageContent;
  timestamp: number;
  raw?: unknown;
}

/** 发送目标 */
export type SendTarget =
  | { type: 'conversation'; conversationId: string }
  | { type: 'channel'; channelId: string }
  | { type: 'user'; userId: string }
  | { type: 'webhook'; url: string };

/** 集成状态 */
export interface IntegrationStatus {
  platform: Platform;
  connected: boolean;
  error?: string;
  lastActivity?: number;
  stats: IntegrationStats;
}

/** 统计信息 */
export interface IntegrationStats {
  messagesReceived: number;
  messagesSent: number;
  errors: number;
}

/** 会话信息 */
export interface IntegrationSession {
  conversationId: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

// 从 config.ts 重新导出配置类型
export type { QQBotConfig, IntegrationDisplayMode } from './config';

/** 判断消息内容是否为文本 */
export function isTextContent(content: MessageContent): content is TextContent {
  return content.type === 'text';
}

/** 获取消息文本 */
export function getMessageText(content: MessageContent): string {
  if (content.type === 'text') {
    return content.text;
  }
  if (content.type === 'mixed') {
    return content.items
      .filter(isTextContent)
      .map((item) => item.text)
      .join(' ');
  }
  return '';
}
