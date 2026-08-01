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
  /** 原始 edits 数组（用于统一展示，引擎无关） */
  edits?: Array<{ oldText: string; newText: string }>;
  /** 引擎已计算好的 diff 字符串（如 Pi 引擎的 details.diff） */
  diffString?: string;
  /** 引擎已计算好的 patch 字符串 */
  patchString?: string;
  /** 首个变更行号（用于编辑器导航） */
  firstChangedLine?: number;
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
 * 支持两种输入格式：
 *
 * 1. Claude Code（str_replace_editor）：
 *   { file_path: string, old_string: string, new_string: string }
 *
 * 2. Pi 引擎（edit）：
 *   { path: string, edits: [{ oldText: string, newText: string }] }
 */
export function extractEditDiff(block: ToolCallBlock): DiffData | null {
  if (!isEditTool(block.name)) {
    return null;
  }

  const input = block.input;

  // 支持多种命名格式
  const filePath = (input.file_path || input.path || input.filePath) as string;

  // Claude Code 格式：old_string / new_string
  let oldContent = (input.old_string || input.old_str || input.oldContent) as string;
  let newContent = (input.new_string || input.new_str || input.newContent) as string;

  // Pi 引擎格式：edits[{oldText, newText}]（完整数组）
  let edits: Array<{ oldText: string; newText: string }> | undefined;
  if (Array.isArray(input.edits) && input.edits.length > 0) {
    edits = input.edits as Array<{ oldText: string; newText: string }>;
    if (!oldContent || !newContent) {
      const first = edits[0];
      oldContent = first.oldText;
      newContent = first.newText;
    }
  }

  // 验证必需字段
  if (!filePath || typeof oldContent !== 'string' || typeof newContent !== 'string') {
    return null;
  }

  // 尝试从 Pi 引擎的 output 中解析 details.diff / details.patch
  let diffString: string | undefined;
  let patchString: string | undefined;
  let firstChangedLine: number | undefined;
  if (block.output) {
    try {
      const parsed = JSON.parse(block.output);
      if (parsed && typeof parsed === 'object') {
        diffString = parsed.diff ?? parsed.details?.diff;
        patchString = parsed.patch ?? parsed.details?.patch;
        firstChangedLine = parsed.firstChangedLine ?? parsed.details?.firstChangedLine;
      }
    } catch {
      // 非 JSON 输出（如 Claude 的纯文本 "File has been updated."），忽略
    }
  }

  return {
    oldContent,
    newContent,
    filePath,
    edits,
    diffString,
    patchString,
    firstChangedLine,
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