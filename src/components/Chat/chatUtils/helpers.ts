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
 * 从 markdown 源码中提取纯文本，用于 TTS 朗读。
 *
 * 处理规则：
 *   - 代码块（``` ... ```）→ 移除
 *   - 行内代码（`code`）→ 保留文字内容
 *   - 链接 [text](url) → 仅保留 text
 *   - 加粗/斜体/删除线 → 保留文字内容
 *   - 标题标记（#） → 移除
 *   - 水平线（---）→ 移除
 *   - 表格语法 → 保留文字内容
 *   - 任务列表 [ ] / [x] → 移除
 *   - 列表标记（-、*、1.）→ 保留（作为换行节奏）
 *   - HTML 标签 → 移除
 *   - 转义字符（\#、\`） → 还原
 */
export function stripMarkdown(text: string): string {
  if (!text) return '';

  let s = text;

  // 1. 移除 fenced code blocks（``` ... ```）
  s = s.replace(/```[\s\S]*?```/g, '');

  // 2. 链接 [text](url) → text
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  // 3. 图片 ![alt](src) → 移除（alt 文本通常只是描述性的）
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '');

  // 4. 加粗 **text** 或 __text__
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');

  // 5. 斜体 *text* 或 _text_
  s = s.replace(/(\*|_)(.*?)\1/g, '$2');

  // 6. 行内代码 `code` → 保留文字
  s = s.replace(/`([^`]+)`/g, '$1');

  // 7. 删除线 ~~text~~
  s = s.replace(/~~(.*?)~~/g, '$1');

  // 8. 转义字符还原（\# → #，\` → `，等）
  s = s.replace(/\\([\\`*_{}\[\]()#\+\-=|>~!\^\-])/g, '$1');

  // 9. 标题标记（### 标题）
  s = s.replace(/^#{1,6}\s*/gm, '');

  // 10. 任务列表标记 [ ] / [x] / [X]
  s = s.replace(/\[[ xX]\]\s*/g, '');

  // 11. 列表标记（-、*、+、1.）
  s = s.replace(/^(\s*)([-*+]|\d+\.)\s+/gm, '$1');

  // 12. 表格分隔线 |---|---|
  s = s.replace(/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/gm, '');

  // 13. 表格单元格分隔符 |
  s = s.replace(/\|/g, ' ');

  // 14. HTML 标签
  s = s.replace(/<[^>]+>/g, '');

  // 15. 水平线 --- / ***
  s = s.replace(/^[-*_]{3,}\s*$/gm, '');

  // 16. 引用标记 >
  s = s.replace(/^>\s*/gm, '');

  // 17. 清理多余空白：连续空白合并为单个空格，多余空行压缩
  s = s.replace(/[\t\r]+/g, ' ');
  s = s.replace(/[ \t]{2,}/g, ' ');

  return s.trim();
}

/**
 * 从消息中提取适合 TTS 朗读的纯文本。
 *
 * 策略：
 *   - 有 message.blocks（Assistant 消息）：遍历 blocks，仅从 textBlock 提取，
 *     并经过 stripMarkdown 处理；跳过 codeBlock / toolCall / thinking 等不可读 block
 *   - 无 blocks（User 消息或旧格式）：对 message.content 做 stripMarkdown
 */
export function extractReadableText(
  message: { content?: string; blocks?: ContentBlock[] },
): string {
  if (message.blocks && message.blocks.length > 0) {
    const readable: string[] = [];
    for (const block of message.blocks) {
      if (block.type === 'text') {
        const stripped = stripMarkdown(block.content);
        if (stripped) readable.push(stripped);
      }
      // 其他 block 类型（thinking / tool_call / artifact_preview 等）不参与朗读
    }
    return readable.join('\n\n');
  }
  if (message.content) {
    return stripMarkdown(message.content);
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
