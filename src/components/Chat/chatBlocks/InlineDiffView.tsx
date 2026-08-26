/**
 * InlineDiffView - 紧凑内联 Diff 组件
 *
 * 用于工具卡片展开态下的文件变更展示，代替完整的 DiffViewer。
 * 特性：
 * - 无行号列，只保留 +/- 标记
 * - 文件路径整合到头部，可点击打开编辑器
 * - 统计 +N -M 合并到头部
 * - 支持两种数据源：
 *   1. diffString（Pi 引擎 output 自带的 diff）
 *   2. oldContent + newContent（Claude Code 格式，需要计算 diff）
 * - 大文件保护：超出阈值时跳过 diff 计算，减轻主线程压力
 */

import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { FileCode, ChevronRight, AlertTriangle } from 'lucide-react';
import { diffLines } from 'diff';
import { extractRelativeDirFromPath } from '@/utils/toolInputExtractor';

/** 超过此字符数时跳过 diff 计算，避免主线程卡顿（≈ 100KB 文本） */
const MAX_DIFF_CHARS = 100_000;

/** 超过此行数的 diff 结果也截断渲染（防止大量 DOM 节点） */
const MAX_DIFF_LINES = 5_000;

interface Edit {
  oldText: string;
  newText: string;
}

interface InlineDiffViewProps {
  /** 文件路径 */
  filePath: string;
  /** 引擎已计算好的 diff 字符串（优先使用） */
  diffString?: string;
  /** 旧内容（用于计算 diff） */
  oldContent?: string;
  /** 新内容（用于计算 diff） */
  newContent?: string;
  /** 原始 edits 数组 */
  edits?: Edit[];
  /** 点击文件路径回调 */
  onOpenFile?: (path: string) => void;
  /** 最大高度 */
  maxHeight?: string;
  /** 是否隐藏头部（由外部行提供文件名/统计时使用） */
  noHeader?: boolean;
}

interface DiffLineDisplay {
  type: 'context' | 'added' | 'removed';
  content: string;
}

/** 解析 unified diff 格式字符串为行数组 */
function parseUnifiedDiff(diff: string): DiffLineDisplay[] {
  const lines: DiffLineDisplay[] = [];
  const raw = diff.split('\n');

  for (const line of raw) {
    if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff')) {
      continue; // 跳过头部
    }
    if (line.startsWith('+')) {
      lines.push({ type: 'added', content: line.slice(1) });
    } else if (line.startsWith('-')) {
      lines.push({ type: 'removed', content: line.slice(1) });
    } else {
      lines.push({ type: 'context', content: line.startsWith(' ') ? line.slice(1) : line });
    }
  }
  return lines;
}

/** 从 oldContent/newContent 计算 diff 行 */
function computeDiffLines(oldContent: string, newContent: string): DiffLineDisplay[] {
  const changes = diffLines(oldContent, newContent);
  const lines: DiffLineDisplay[] = [];

  for (const part of changes) {
    if (part.added && part.value) {
      const content = part.value.replace(/\n$/, '');
      for (const line of content.split('\n')) {
        lines.push({ type: 'added', content: line });
      }
    } else if (part.removed && part.value) {
      const content = part.value.replace(/\n$/, '');
      for (const line of content.split('\n')) {
        lines.push({ type: 'removed', content: line });
      }
    } else if (part.value) {
      const content = part.value.replace(/\n$/, '');
      for (const line of content.split('\n')) {
        lines.push({ type: 'context', content: line });
      }
    }
  }

  return lines;
}

export const InlineDiffView = memo(function InlineDiffView({
  filePath,
  diffString,
  oldContent,
  newContent,
  onOpenFile,
  maxHeight = '240px',
  noHeader = false,
}: InlineDiffViewProps) {
  const { t } = useTranslation('chat');

  // 检查内容是否过大，过大则跳过 diff 计算
  const isTooLarge = useMemo(() => {
    if (diffString) {
      return diffString.length > MAX_DIFF_CHARS;
    }
    if (oldContent !== undefined && newContent !== undefined) {
      return (oldContent.length + newContent.length) > MAX_DIFF_CHARS;
    }
    return false;
  }, [diffString, oldContent, newContent]);

  // 计算展示行（仅当内容不过大时）
  const displayLines = useMemo<DiffLineDisplay[]>(() => {
    if (isTooLarge) return [];
    if (diffString) {
      return parseUnifiedDiff(diffString);
    }
    if (oldContent !== undefined && newContent !== undefined) {
      return computeDiffLines(oldContent, newContent);
    }
    return [];
  }, [diffString, oldContent, newContent, isTooLarge]);

  // 检查 diff 结果行数是否过多
  const resultTooLarge = useMemo(() => {
    return displayLines.length > MAX_DIFF_LINES;
  }, [displayLines]);

  // 统计
  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const line of displayLines) {
      if (line.type === 'added') added++;
      if (line.type === 'removed') removed++;
    }
    return { added, removed };
  }, [displayLines]);

  // 文件名（主）
  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  // 相对目录（次，去根去文件名），无目录时为空
  const fileDir = extractRelativeDirFromPath(filePath);

  const handleClick = () => {
    onOpenFile?.(filePath);
  };

  if (displayLines.length === 0 && !isTooLarge) {
    return null;
  }

  return (
    <div className="overflow-hidden">
      {/* 头部：文件名（主）+ 相对目录（次）+ 统计（noHeader 时跳过） */}
      {!noHeader && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 bg-background-surface cursor-pointer hover:bg-background-hover transition-colors text-xs select-none"
          onClick={handleClick}
          title={filePath}
        >
          <FileCode className="w-3.5 h-3.5 text-primary shrink-0" />
          <span className="text-primary font-medium truncate shrink-0 max-w-[45%]">
            {fileName}
          </span>
          {fileDir && (
            <span className="text-text-tertiary truncate flex-1 min-w-0" title={filePath}>
              {fileDir}
            </span>
          )}
          {!isTooLarge && (stats.added > 0 || stats.removed > 0) && (
            <span className="flex items-center gap-1.5 shrink-0 tabular-nums">
              <span className="text-success">+{stats.added}</span>
              <span className="text-error">−{stats.removed}</span>
            </span>
          )}
          <ChevronRight className="w-3 h-3 text-text-muted" />
        </div>
      )}

      {/* Diff 内容 */}
      <div
        className="overflow-auto font-mono text-xs leading-5"
        style={{ maxHeight }}
      >
        {isTooLarge ? (
          <div className="flex items-center gap-2 px-3 py-4 text-text-tertiary">
            <AlertTriangle className="w-4 h-4 shrink-0 text-warning" />
            <span className="text-xs">
              {t('tool.fileTooLargeForDiff')}
            </span>
            <button
              onClick={handleClick}
              className="ml-auto text-xs text-primary hover:underline shrink-0"
            >
              {t('tool.openInEditor')}
            </button>
          </div>
        ) : resultTooLarge ? (
          <div>
            {displayLines.slice(0, MAX_DIFF_LINES).map((line, i) => (
              <div
                key={i}
                className={clsx(
                  'flex gap-0 px-3 min-w-max',
                  line.type === 'added' && 'bg-success/[0.04]',
                  line.type === 'removed' && 'bg-error/[0.04]',
                )}
              >
                <span
                  className={clsx(
                    'w-4 shrink-0 select-none text-center font-bold',
                    line.type === 'added' && 'text-success',
                    line.type === 'removed' && 'text-error',
                    line.type === 'context' && 'text-text-muted',
                  )}
                >
                  {line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}
                </span>
                <span
                  className={clsx(
                    'flex-1 whitespace-pre',
                    line.type === 'added' && 'text-text-primary',
                    line.type === 'removed' && 'text-text-tertiary',
                    line.type === 'context' && 'text-text-muted',
                  )}
                >
                  {line.content}
                </span>
              </div>
            ))}
            <div className="flex items-center gap-2 px-3 py-2 text-text-tertiary border-t border-border">
              <span className="text-xs">
                {t('tool.diffTruncated', { count: displayLines.length - MAX_DIFF_LINES })}
              </span>
              <button
                onClick={handleClick}
                className="ml-auto text-xs text-primary hover:underline"
              >
                {t('tool.openInEditor')}
              </button>
            </div>
          </div>
        ) : (
          displayLines.map((line, i) => (
            <div
              key={i}
              className={clsx(
                'flex gap-0 px-3 min-w-max',
                line.type === 'added' && 'bg-success/[0.04]',
                line.type === 'removed' && 'bg-error/[0.04]',
              )}
            >
              <span
                className={clsx(
                  'w-4 shrink-0 select-none text-center font-bold',
                  line.type === 'added' && 'text-success',
                  line.type === 'removed' && 'text-error',
                  line.type === 'context' && 'text-text-muted',
                )}
              >
                {line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}
              </span>
              <span
                className={clsx(
                  'flex-1 whitespace-pre',
                  line.type === 'added' && 'text-text-primary',
                  line.type === 'removed' && 'text-text-tertiary',
                  line.type === 'context' && 'text-text-muted',
                )}
              >
                {line.content}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
});