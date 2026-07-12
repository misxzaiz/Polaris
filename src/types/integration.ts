/**
 * 集成模块类型定义
 */

import type { IntegrationDisplayMode } from './config';

/** 平台类型 */
export type Platform = 'qqbot' | 'feishu' | 'wechat' | 'telegram';

/** 实例 ID */
export type InstanceId = string;

/** QQ Bot 实例配置（用于实例管理，与 config.ts 中的 QQBotInstanceConfig 对应） */
export interface QQBotInstanceConfigData {
  /** 实例 ID */
  id: InstanceId;
  /** 显示名称 */
  name: string;
  /** 是否启用 */
  enabled: boolean;
  /** 应用 ID */
  appId: string;
  /** 应用密钥 */
  clientSecret: string;
  /** 是否沙箱环境 */
  sandbox: boolean;
  /** 消息显示模式 */
  displayMode: IntegrationDisplayMode;
  /** 启动时自动连接 */
  autoConnect: boolean;
  /** 创建时间 (ISO 8601) */
  createdAt?: string;
  /** 最后活跃时间 (ISO 8601) */
  lastActive?: string;
}

/** Feishu 实例配置 */
export interface FeishuInstanceConfigData {
  /** 实例 ID */
  id: InstanceId;
  /** 显示名称 */
  name: string;
  /** 是否启用 */
  enabled: boolean;
  /** 应用 ID (App ID) */
  appId: string;
  /** 应用密钥 (App Secret) */
  appSecret: string;
  /** 事件验证 Token */
  verificationToken: string;
  /** 事件加密 Key */
  encryptKey: string;
  /** 消息显示模式 */
  displayMode: IntegrationDisplayMode;
  /** 启动时自动连接 */
  autoConnect: boolean;
  /** 创建时间 (ISO 8601) */
  createdAt?: string;
  /** 最后活跃时间 (ISO 8601) */
  lastActive?: string;
}

/** 实例配置枚举 */
export interface InstanceConfig {
  type: 'qqbot' | 'feishu';
  enabled: boolean;
  appId: string;
  /** QQ Bot: clientSecret */
  clientSecret: string;
  /** QQ Bot: sandbox */
  sandbox: boolean;
  /** Feishu: appSecret */
  appSecret: string;
  /** Feishu: verificationToken */
  verificationToken: string;
  /** Feishu: encryptKey */
  encryptKey: string;
  displayMode: IntegrationDisplayMode;
  autoConnect: boolean;
  /** 默认工作目录 */
  workDir?: string;
}

/** 平台实例 */
export interface PlatformInstance {
  /** 实例 ID */
  id: InstanceId;
  /** 显示名称 */
  name: string;
  /** 平台类型 */
  platform: Platform;
  /** 实例配置 */
  config: InstanceConfig;
  /** 创建时间 */
  createdAt: string;
  /** 最后活跃时间 */
  lastActive?: string;
  /** 是否启用 */
  enabled: boolean;
}

/** 消息内容类型 */
export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  url: string;
  fileName?: string;
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
  fileName?: string;
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
  platformMessageId?: string;
  raw?: unknown;
}

/** 发送目标 */
export type SendTarget =
  | { type: 'conversation'; conversationId: string }
  | { type: 'channel'; channelId: string }
  | { type: 'user'; userId: string }
  | { type: 'webhook'; url: string };

/** 连接状态（细化状态机） */
export type ConnectionState =
  | 'disconnected' // 未连接
  | 'connecting' // 连接中（正在建立 WebSocket）
  | 'authenticating' // 鉴权中（WebSocket 已建立，等待 READY）
  | 'ready' // 已就绪（收到 READY，可以收发消息）
  | 'failed' // 连接失败
  | 'reconnecting'; // 重连中

/** 连接状态显示文本 */
export const ConnectionStateLabels: Record<ConnectionState, string> = {
  disconnected: '未连接',
  connecting: '连接中...',
  authenticating: '鉴权中...',
  ready: '已就绪',
  failed: '连接失败',
  reconnecting: '重连中...',
};

/** 连接状态颜色 */
export const ConnectionStateColors: Record<ConnectionState, string> = {
  disconnected: 'text-text-tertiary',
  connecting: 'text-warning',
  authenticating: 'text-warning',
  ready: 'text-success',
  failed: 'text-danger',
  reconnecting: 'text-warning',
};

/** 集成状态 */
export interface IntegrationStatus {
  platform: Platform;
  connected: boolean;
  connectionState: ConnectionState;
  error?: string;
  errorDetail?: string;
  lastActivity?: number;
  stats: IntegrationStats;
  retryCount: number;
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
export type { QQBotConfig, FeishuConfig, IntegrationDisplayMode } from './config';

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
