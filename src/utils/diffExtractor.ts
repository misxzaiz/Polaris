/**
 * Diff 数据提取工具
 *
 * 从工具调用块中提取差异信息，用于在 Chat 中显示文件变更
 */

import type { ToolCallBlock } from '@/types/chat';

/** Diff 数据 */
export interface DiffData {
  oldContent: string;
  newContent: string;
  filePath: string;
}

/**
 * 判断是否为 Edit 工具
 */
export function isEditTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized === 'str_replace_editor' ||
         normalized === 'edit' ||
         normalized.includes('str_replace');
}

/**
 * 判断是否为 Write 工具
 */
export function isWriteTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized === 'write_file' ||
         normalized === 'create_file' ||
         normalized === 'write' ||
         normalized === 'create';
}

/**
 * 从 Edit 工具的输入中提取 Diff 数据
 *
 * Edit 工具（str_replace_editor）的输入格式：
 * {
 *   file_path: string,
 *   old_string: string,
 *   new_string: string
 * }
 */
export function extractEditDiff(block: ToolCallBlock): DiffData | null {
  if (!isEditTool(block.name)) {
    return null;
  }

  const input = block.input;

  // 支持多种命名格式
  const filePath = (input.file_path || input.path || input.filePath) as string;
  const oldContent = (input.old_string || input.old_str || input.oldContent) as string;
  const newContent = (input.new_string || input.new_str || input.newContent) as string;

  // 验证必需字段
  if (!filePath || typeof oldContent !== 'string' || typeof newContent !== 'string') {
    return null;
  }

  return {
    oldContent,
    newContent,
    filePath
  };
}

/**
 * 从 Write 工具的输入中提取文件路径和新内容
 *
 * Write 工具的输入格式：
 * {
 *   path: string,
 *   content: string
 * }
 *
 * 注意：这不会返回完整的 DiffData，因为缺少旧内容。
 * 旧内容需要从 Git 或文件系统异步获取。
 */
export function extractWriteInfo(block: ToolCallBlock): { filePath: string; newContent: string } | null {
  if (!isWriteTool(block.name)) {
    return null;
  }

  const input = block.input;

  // 支持多种命名格式
  const filePath = (input.file_path || input.path || input.filePath) as string;
  const newContent = (input.content || input.newContent) as string;

  if (!filePath || typeof newContent !== 'string') {
    return null;
  }

  return {
    filePath,
    newContent
  };
}

/**
 * 从工具调用块中提取 Diff 相关信息
 */
export function extractDiffInfo(block: ToolCallBlock): DiffData | null {
  // 优先尝试提取 Edit 工具的 Diff
  const editDiff = extractEditDiff(block);
  if (editDiff) {
    return editDiff;
  }

  // Write 工具需要异步获取旧内容，这里暂不处理
  return null;
}
