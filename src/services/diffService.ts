/**
 * Diff 差异计算服务
 * 用于计算文件修改前后的差异
 */

import { diffLines } from 'diff';

/**
 * 差异行信息
 */
export interface DiffLine {
  /** 行号 (原始文件) */
  oldLineNumber: number | null;
  /** 行号 (修改后文件) */
  newLineNumber: number | null;
  /** 行类型 */
  type: 'context' | 'added' | 'removed';
  /** 行内容 */
  content: string;
}

/**
 * 文件差异信息
 */
export interface FileDiff {
  /** 原始内容 */
  oldContent: string;
  /** 修改后内容 */
  newContent: string;
  /** 差异行列表 */
  lines: DiffLine[];
  /** 添加的行数 */
  addedCount: number;
  /** 删除的行数 */
  removedCount: number;
  /** 是否被裁剪（行数超过 maxLines） */
  truncated?: boolean;
  /** 裁剪前的总行数 */
  totalLines?: number;
}

/**
 * 计算两个字符串的差异
 * @param oldContent 原始内容
 * @param newContent 修改后内容
 * @returns 差异信息
 */
export function computeDiff(oldContent: string, newContent: string): FileDiff {
  // 使用 diff 库计算行级差异
  const changes = diffLines(oldContent, newContent);

  const lines: DiffLine[] = [];
  let oldLineNumber = 1;
  let newLineNumber = 1;
  let addedCount = 0;
  let removedCount = 0;

  for (const change of changes) {
    const changeLines = change.value.split('\n');
    // 移除最后一个空行（split 会多出一个）
    if (changeLines[changeLines.length - 1] === '') {
      changeLines.pop();
    }

    if (change.added) {
      // 添加的行
      for (const line of changeLines) {
        lines.push({
          oldLineNumber: null,
          newLineNumber: newLineNumber++,
          type: 'added',
          content: line,
        });
        addedCount++;
      }
    } else if (change.removed) {
      // 删除的行
      for (const line of changeLines) {
        lines.push({
          oldLineNumber: oldLineNumber++,
          newLineNumber: null,
          type: 'removed',
          content: line,
        });
        removedCount++;
      }
    } else {
      // 上下文行
      for (const line of changeLines) {
        lines.push({
          oldLineNumber: oldLineNumber++,
          newLineNumber: newLineNumber++,
          type: 'context',
          content: line,
        });
      }
    }
  }

  return {
    oldContent,
    newContent,
    lines,
    addedCount,
    removedCount,
    truncated: false,
    totalLines: lines.length,
  };
}

/**
 * 检查是否有差异
 */
export function hasChanges(diff: FileDiff): boolean {
  return diff.addedCount > 0 || diff.removedCount > 0;
}

/**
 * 获取差异摘要
 */
export function getDiffSummary(diff: FileDiff): string {
  const parts: string[] = [];
  if (diff.addedCount > 0) {
    parts.push(`+${diff.addedCount}`);
  }
  if (diff.removedCount > 0) {
    parts.push(`-${diff.removedCount}`);
  }
  if (parts.length === 0) {
    return '无变化';
  }
  return parts.join(' ');
}
