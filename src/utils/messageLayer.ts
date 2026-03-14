/**
 * 消息分层渲染类型定义
 *
 * 将消息分为三个层级，优化渲染性能：
 * - Active Layer (活跃层): 最近几轮对话，完整渲染
 * - Preview Layer (预览层): 中间轮次，简化渲染
 * - Archive Layer (归档层): 较早轮次，仅显示摘要
 */

/**
 * 消息渲染模式
 */
export type MessageRenderMode = 'full' | 'preview' | 'archive';

/**
 * 分层渲染配置
 */
export interface MessageLayerConfig {
  /** 活跃层轮次数量（默认 5 轮） */
  activeRounds: number;
  /** 预览层轮次数量（默认 10 轮） */
  previewRounds: number;
}

/**
 * 默认配置
 */
export const DEFAULT_LAYER_CONFIG: MessageLayerConfig = {
  activeRounds: 5,
  previewRounds: 10,
};

/**
 * 根据消息位置计算渲染模式
 *
 * @param messageIndex 消息在列表中的索引（0 开始）
 * @param totalMessages 消息总数
 * @param config 分层配置
 * @returns 渲染模式
 */
export function calculateRenderMode(
  messageIndex: number,
  totalMessages: number,
  config: MessageLayerConfig = DEFAULT_LAYER_CONFIG
): MessageRenderMode {
  // 计算从末尾开始的轮次数
  // 每轮 = 1 个用户消息 + 1 个助手消息
  const messagesFromEnd = totalMessages - messageIndex;
  const roundsFromEnd = Math.floor(messagesFromEnd / 2);

  // 活跃层：最近 N 轮
  if (roundsFromEnd <= config.activeRounds) {
    return 'full';
  }

  // 预览层：中间 N 轮
  if (roundsFromEnd <= config.activeRounds + config.previewRounds) {
    return 'preview';
  }

  // 归档层：更早的消息
  return 'archive';
}

/**
 * 批量计算所有消息的渲染模式
 *
 * @param totalMessages 消息总数
 * @param config 分层配置
 * @returns 渲染模式数组
 */
export function calculateAllRenderModes(
  totalMessages: number,
  config: MessageLayerConfig = DEFAULT_LAYER_CONFIG
): MessageRenderMode[] {
  const modes: MessageRenderMode[] = [];

  for (let i = 0; i < totalMessages; i++) {
    modes.push(calculateRenderMode(i, totalMessages, config));
  }

  return modes;
}

/**
 * 获取活跃层的消息索引范围
 *
 * @param totalMessages 消息总数
 * @param config 分层配置
 * @returns [startIndex, endIndex]（包含）
 */
export function getActiveLayerRange(
  totalMessages: number,
  config: MessageLayerConfig = DEFAULT_LAYER_CONFIG
): [number, number] {
  const activeMessages = config.activeRounds * 2;
  const startIndex = Math.max(0, totalMessages - activeMessages);
  const endIndex = totalMessages - 1;

  return [startIndex, endIndex];
}

/**
 * 获取预览层的消息索引范围
 *
 * @param totalMessages 消息总数
 * @param config 分层配置
 * @returns [startIndex, endIndex]（包含），如果没有预览层返回 null
 */
export function getPreviewLayerRange(
  totalMessages: number,
  config: MessageLayerConfig = DEFAULT_LAYER_CONFIG
): [number, number] | null {
  const activeMessages = config.activeRounds * 2;
  const previewMessages = config.previewRounds * 2;
  const startIndex = Math.max(0, totalMessages - activeMessages - previewMessages);
  const endIndex = totalMessages - activeMessages - 1;

  if (startIndex > endIndex) {
    return null;
  }

  return [startIndex, endIndex];
}

/**
 * 获取归档层的消息数量
 */
export function getArchiveLayerCount(
  totalMessages: number,
  config: MessageLayerConfig = DEFAULT_LAYER_CONFIG
): number {
  const activeMessages = config.activeRounds * 2;
  const previewMessages = config.previewRounds * 2;
  const archiveCount = totalMessages - activeMessages - previewMessages;

  return Math.max(0, archiveCount);
}
