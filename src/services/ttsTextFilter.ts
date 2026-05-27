/**
 * TTS 文本过滤工具
 *
 * 从助手消息中提取可朗读的文本，过滤代码块、工具调用等内容
 */

import type { AssistantChatMessage } from '@/types/chat';
import { isTextBlock } from '@/types/chat';

/**
 * 从助手消息中提取可朗读的文本
 * 只提取 TextBlock，过滤所有其他类型
 */
export function extractSpeakableText(message: AssistantChatMessage): string {
  const textBlocks: string[] = [];

  for (const block of message.blocks) {
    // 只提取文本块
    if (isTextBlock(block)) {
      textBlocks.push(block.content);
    }
    // 其他类型全部忽略：
    // - ThinkingBlock: 内部思考过程
    // - ToolCallBlock: 工具调用信息
    // - QuestionBlock: 交互问题
    // - PlanModeBlock: 计划模式
    // - AgentRunBlock: Agent 运行状态
    // - ToolGroupBlock: 工具组
    // - PermissionRequestBlock: 权限请求
  }

  return textBlocks.join('\n');
}

/**
 * 清理文本中的 Markdown 格式
 * 移除代码块、链接语法等，只保留纯文本
 */
export function cleanTextForSpeech(text: string): string {
  return text
    // 移除代码块 ```...```
    .replace(/```[\s\S]*?```/g, '')
    // 移除行内代码 `...`
    .replace(/`[^`]+`/g, '')
    // 移除链接但保留文本 [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // 移除图片 ![alt](url)
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    // 移除标题标记 # ## ### 等
    .replace(/^#{1,6}\s+/gm, '')
    // 移除粗体/斜体标记 **text** _text_ __text__
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
    .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')
    // 移除删除线 ~~text~~
    .replace(/~~[^~]+~~/g, '')
    // 移除引用标记 >
    .replace(/^>\s*/gm, '')
    // 移除列表标记 - * 1.
    .replace(/^[-*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    // 移除水平线 --- *** ___
    .replace(/^[-*_]{3,}$/gm, '')
    // 移除 HTML 标签
    .replace(/<[^>]+>/g, '')
    // 合并多个空白字符
    .replace(/\n{2,}/g, '\n')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 检查文本是否应该朗读
 * 过短或只包含特殊字符的文本跳过
 */
export function shouldSpeakText(text: string): boolean {
  const cleaned = cleanTextForSpeech(text);
  // 至少 2 个字符才朗读
  return cleaned.length >= 2;
}

/**
 * 获取朗读文本的预览（用于调试）
 */
export function getSpeakablePreview(message: AssistantChatMessage, maxLength = 100): string {
  const rawText = extractSpeakableText(message);
  const cleanText = cleanTextForSpeech(rawText);
  if (cleanText.length <= maxLength) {
    return cleanText;
  }
  return cleanText.substring(0, maxLength) + '...';
}
