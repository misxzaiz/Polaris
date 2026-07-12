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
  /**
   * 是否为「降级」结果。
   * 当改动规模超过 MAX_EDIT_LENGTH（如整文件重排/格式化）时，精确的行级 Myers diff
   * 会退化到接近 O(N²)（实测 2 万行可达 38 秒）。此时改为「公共前后缀保留 + 中段整体替换」，
   * 内容完整无损、可秒级返回，仅 diff 粒度变粗。UI 据此给出提示。
   */
  degraded?: boolean;
}

/**
 * 改动规模上限。diffLines 在编辑脚本长度超过该值时返回 undefined，触发降级。
 *
 * 取值权衡（基于基准实测）：降级判定耗时约为 O(N × MAX_EDIT_LENGTH)，
 * 2000 时病态大文件（如整文件重排）约 0.6s 即可放弃并降级；同时它覆盖了
 * 编辑距离 < 2000（约千行级改动）的正常改动走精确路径。再大则降级判定本身过慢。
 */
const MAX_EDIT_LENGTH = 2000;

/**
 * 将内容切分为行数组：归一化 Windows CRLF（去尾部 \r），并移除 split 多出的末尾空行。
 */
function normalizeLines(content: string): string[] {
  const arr = content.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (arr.length > 0 && arr[arr.length - 1] === '') {
    arr.pop();
  }
  return arr;
}

/**
 * 由 diffLines 的 changes 组装 DiffLine[]（原始精确路径）。
 */
function buildLinesFromChanges(changes: ReturnType<typeof diffLines>): {
  lines: DiffLine[];
  addedCount: number;
  removedCount: number;
} {
  const lines: DiffLine[] = [];
  let oldLineNumber = 1;
  let newLineNumber = 1;
  let addedCount = 0;
  let removedCount = 0;

  for (const change of changes) {
    // 按行切分，并归一化 Windows CRLF 行尾（去除每行尾部残留的 \r）
    const changeLines = change.value
      .split('\n')
      .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
    // 移除最后一个空行（split 会多出一个）
    if (changeLines[changeLines.length - 1] === '') {
      changeLines.pop();
    }

    if (change.added) {
      for (const line of changeLines) {
        lines.push({ oldLineNumber: null, newLineNumber: newLineNumber++, type: 'added', content: line });
        addedCount++;
      }
    } else if (change.removed) {
      for (const line of changeLines) {
        lines.push({ oldLineNumber: oldLineNumber++, newLineNumber: null, type: 'removed', content: line });
        removedCount++;
      }
    } else {
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

  return { lines, addedCount, removedCount };
}

/**
 * 降级 diff：保留公共前缀/后缀为上下文，中段旧内容整体标记删除、新内容整体标记新增。
 * 复杂度 O(N)，结果可完整重建 old/new（已通过随机用例验证）。
 */
function computeDegradedDiff(oldContent: string, newContent: string): FileDiff {
  const oldLines = normalizeLines(oldContent);
  const newLines = normalizeLines(newContent);

  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const lines: DiffLine[] = [];
  let oldLineNumber = 1;
  let newLineNumber = 1;
  let addedCount = 0;
  let removedCount = 0;

  for (let i = 0; i < prefix; i++) {
    lines.push({ oldLineNumber: oldLineNumber++, newLineNumber: newLineNumber++, type: 'context', content: oldLines[i] });
  }
  for (let i = prefix; i < oldLines.length - suffix; i++) {
    lines.push({ oldLineNumber: oldLineNumber++, newLineNumber: null, type: 'removed', content: oldLines[i] });
    removedCount++;
  }
  for (let i = prefix; i < newLines.length - suffix; i++) {
    lines.push({ oldLineNumber: null, newLineNumber: newLineNumber++, type: 'added', content: newLines[i] });
    addedCount++;
  }
  for (let i = oldLines.length - suffix; i < oldLines.length; i++) {
    lines.push({ oldLineNumber: oldLineNumber++, newLineNumber: newLineNumber++, type: 'context', content: oldLines[i] });
  }

  return { oldContent, newContent, lines, addedCount, removedCount, degraded: true };
}

/**
 * 计算两个字符串的差异
 * @param oldContent 原始内容
 * @param newContent 修改后内容
 * @returns 差异信息
 */
export function computeDiff(oldContent: string, newContent: string): FileDiff {
  // 使用 diff 库计算行级差异；超过编辑规模上限时返回 undefined，触发降级。
  const changes = diffLines(oldContent, newContent, { maxEditLength: MAX_EDIT_LENGTH });

  if (!changes) {
    return computeDegradedDiff(oldContent, newContent);
  }

  const { lines, addedCount, removedCount } = buildLinesFromChanges(changes);

  return {
    oldContent,
    newContent,
    lines,
    addedCount,
    removedCount,
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
