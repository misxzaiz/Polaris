/**
 * Diff 差异查看器组件
 * 简化版实现，使用纯文本渲染
 */

import { computeDiff } from '@/services/diffService';
import { logger } from '@/utils/logger';
import { useTranslation } from 'react-i18next';
import type { DiffChangeType } from '@/types/git';
import type { DiffLine } from '@/services/diffService';

export type DiffViewMode = 'unified' | 'split';

interface DiffViewerProps {
  /** 原始内容 */
  oldContent?: string;
  /** 修改后内容 */
  newContent?: string;
  /** 变更类型 */
  changeType?: DiffChangeType;
  /** 状态提示 */
  statusHint?: {
    has_conflict: boolean
    message?: string
    current_view: string
  };
  /** 是否显示状态提示（默认 true） */
  showStatusHint?: boolean;
  /** 最大高度（可选，用于限制高度） */
  maxHeight?: string;
  /** 内容是否被省略（如文件过大） */
  contentOmitted?: boolean;
  /** Diff 展示模式 */
  viewMode?: DiffViewMode;
}

type SplitSideType = 'context' | 'added' | 'removed' | 'empty' | 'folded';

interface SplitDiffRow {
  oldLineNumber: number | null;
  newLineNumber: number | null;
  oldContent: string;
  newContent: string;
  oldType: SplitSideType;
  newType: SplitSideType;
}

const isFoldedLine = (line: DiffLine) => line.content.startsWith('⋯') && line.content.endsWith('⋯');

function buildSplitRows(lines: DiffLine[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (isFoldedLine(line)) {
      rows.push({
        oldLineNumber: null,
        newLineNumber: null,
        oldContent: line.content,
        newContent: line.content,
        oldType: 'folded',
        newType: 'folded',
      });
      index++;
      continue;
    }

    if (line.type === 'context') {
      rows.push({
        oldLineNumber: line.oldLineNumber,
        newLineNumber: line.newLineNumber,
        oldContent: line.content,
        newContent: line.content,
        oldType: 'context',
        newType: 'context',
      });
      index++;
      continue;
    }

    if (line.type === 'removed') {
      const removedLines: DiffLine[] = [];
      const addedLines: DiffLine[] = [];

      while (index < lines.length && lines[index].type === 'removed') {
        removedLines.push(lines[index]);
        index++;
      }
      while (index < lines.length && lines[index].type === 'added') {
        addedLines.push(lines[index]);
        index++;
      }

      const rowCount = Math.max(removedLines.length, addedLines.length);
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
        const oldLine = removedLines[rowIndex];
        const newLine = addedLines[rowIndex];
        rows.push({
          oldLineNumber: oldLine?.oldLineNumber ?? null,
          newLineNumber: newLine?.newLineNumber ?? null,
          oldContent: oldLine?.content ?? '',
          newContent: newLine?.content ?? '',
          oldType: oldLine ? 'removed' : 'empty',
          newType: newLine ? 'added' : 'empty',
        });
      }
      continue;
    }

    const addedLines: DiffLine[] = [];
    while (index < lines.length && lines[index].type === 'added') {
      addedLines.push(lines[index]);
      index++;
    }

    for (const addedLine of addedLines) {
      rows.push({
        oldLineNumber: null,
        newLineNumber: addedLine.newLineNumber,
        oldContent: '',
        newContent: addedLine.content,
        oldType: 'empty',
        newType: 'added',
      });
    }
  }

  return rows;
}

/**
 * Diff 查看器组件 - 统一版本
 * 支持可选的状态提示显示
 */
export function DiffViewer({
  oldContent,
  newContent,
  changeType,
  statusHint,
  showStatusHint = true,
  maxHeight,
  contentOmitted = false,
  viewMode = 'unified'
}: DiffViewerProps) {
  const { t } = useTranslation('git');

  // 添加调试日志（仅在开发环境）
  logger.debug('[DiffViewer] 渲染:', {
    oldContentLength: oldContent?.length ?? 0,
    newContentLength: newContent?.length ?? 0,
    changeType,
    contentOmitted,
    timestamp: new Date().toISOString()
  });

  // 如果内容被省略，显示提示信息
  if (contentOmitted) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <svg className="w-12 h-12 text-text-tertiary mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
        <div className="text-text-secondary mb-2">{t('diff.fileTooLarge')}</div>
        <div className="text-text-tertiary text-sm">
          {t('diff.contentOmittedHint')}
        </div>
      </div>
    );
  }

  // 根据 change_type 处理 undefined
  const effectiveOldContent = (() => {
    if (changeType === 'added' && oldContent === undefined) {
      return ''  // 新增文件：旧内容为空
    }
    return oldContent ?? ''
  })()

  const effectiveNewContent = (() => {
    if (changeType === 'deleted' && newContent === undefined) {
      return ''  // 删除文件：新内容为空
    }
    return newContent ?? ''
  })()

  const diff = computeDiff(effectiveOldContent, effectiveNewContent);
  const splitRows = viewMode === 'split' ? buildSplitRows(diff.lines) : [];

  const renderSplitCell = (content: string, type: SplitSideType) => {
    const isEmpty = type === 'empty';
    const isFolded = type === 'folded';

    return (
      <span
        className={`px-3 py-0.5 whitespace-pre ${
          isFolded
            ? 'text-text-tertiary italic text-center'
            : type === 'removed'
              ? 'bg-red-500/10 text-text-tertiary line-through'
              : type === 'added'
                ? 'bg-green-500/10 text-text-secondary'
                : isEmpty
                  ? 'bg-background-elevated/30 text-text-tertiary'
                  : 'text-text-secondary'
        }`}
      >
        {content || '\u00A0'}
      </span>
    );
  };

  return (
    <div
      className="flex flex-col overflow-auto font-mono text-sm"
      style={{ maxHeight, height: maxHeight ? undefined : '100%' }}
    >
      {/* 状态提示（可选） */}
      {showStatusHint && statusHint && (
        <div className={`px-4 py-2 border-b flex items-center gap-3 text-xs shrink-0 ${
          statusHint.has_conflict
            ? 'bg-yellow-500/10 border-yellow-500/20'
            : 'bg-blue-500/5 border-blue-500/10'
        }`}>
          {statusHint.has_conflict && (
            <span className="text-yellow-600">⚠️</span>
          )}
          <span className="text-text-secondary flex-1">
            {statusHint.message || (statusHint.has_conflict ? t('diff.note') : t('diff.info'))}
          </span>
          <span className="text-text-tertiary">
            {statusHint.current_view}
          </span>
        </div>
      )}

      {/* 差异摘要 */}
      <div className="flex items-center gap-4 px-4 py-2 bg-background-elevated border-b border-border text-xs shrink-0">
        <span className="text-text-secondary">{t('diff.diffSummary')}</span>
        <span className="text-green-500">+{diff.addedCount} {t('diff.linesAdded')}</span>
        <span className="text-red-500">-{diff.removedCount} {t('diff.linesRemoved')}</span>
        {diff.truncated && (
          <span className="text-text-tertiary ml-auto">
            Showing {diff.lines.length} of {diff.totalLines} lines
          </span>
        )}
      </div>

      {/* 差异内容 */}
      <div className="flex-1 overflow-auto p-4">
        {diff.lines.length === 0 ? (
          <div className="text-text-tertiary text-center py-8">{t('diff.noChanges')}</div>
        ) : viewMode === 'split' ? (
          <div className="min-w-[900px]">
            <div className="grid grid-cols-[4rem_minmax(16rem,1fr)_4rem_minmax(16rem,1fr)] sticky top-0 z-10 bg-background-elevated border-b border-border text-xs text-text-tertiary">
              <span className="px-2 py-1 text-right select-none">#</span>
              <span className="px-3 py-1 font-sans">{t('diff.oldVersion')}</span>
              <span className="px-2 py-1 text-right select-none">#</span>
              <span className="px-3 py-1 font-sans">{t('diff.newVersion')}</span>
            </div>
            <div className="space-y-0.5">
              {splitRows.map((row, idx) => {
                const rowIsFolded = row.oldType === 'folded' && row.newType === 'folded';
                return (
                  <div
                    key={idx}
                    className={`grid grid-cols-[4rem_minmax(16rem,1fr)_4rem_minmax(16rem,1fr)] ${
                      rowIsFolded ? 'bg-background-elevated/50' : ''
                    }`}
                  >
                    <span className="px-2 py-0.5 text-right text-text-tertiary shrink-0 select-none border-r border-border-subtle">
                      {row.oldLineNumber ?? (row.oldType === 'empty' ? '' : '×')}
                    </span>
                    {renderSplitCell(row.oldContent, row.oldType)}
                    <span className="px-2 py-0.5 text-right text-text-tertiary shrink-0 select-none border-l border-r border-border-subtle">
                      {row.newLineNumber ?? (row.newType === 'empty' ? '' : '×')}
                    </span>
                    {renderSplitCell(row.newContent, row.newType)}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="space-y-0.5">
            {diff.lines.map((line, idx) => {
              const isFolded = line.content.startsWith('⋯') && line.content.endsWith('⋯');
              return (
                <div
                  key={idx}
                  className={`flex gap-4 px-2 py-0.5 ${
                    isFolded
                      ? 'bg-background-elevated/50 text-text-tertiary italic text-center justify-center'
                      : line.type === 'added'
                        ? 'bg-green-500/10'
                        : line.type === 'removed'
                          ? 'bg-red-500/10'
                          : ''
                  }`}
                >
                  {!isFolded && (
                    <>
                      {/* 旧行号 */}
                      <span className="w-8 text-right text-text-tertiary shrink-0 select-none">
                        {line.oldLineNumber ?? '×'}
                      </span>
                      {/* 新行号 */}
                      <span className="w-8 text-right text-text-tertiary shrink-0 select-none">
                        {line.newLineNumber ?? '×'}
                      </span>
                      {/* 标记 */}
                      <span
                        className={`w-4 shrink-0 select-none font-bold ${
                          line.type === 'added'
                            ? 'text-green-500'
                            : line.type === 'removed'
                              ? 'text-red-500'
                              : 'text-text-tertiary'
                        }`}
                      >
                        {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                      </span>
                    </>
                  )}
                  {/* 内容：使用 whitespace-pre 保留行首缩进与行内对齐空白，
                      nowrap 会折叠连续空格导致缩进丢失；pre 不自动换行，
                      由外层 overflow-auto 提供横向滚动，与 split 视图一致 */}
                  <span
                    className={`flex-1 whitespace-pre ${
                      line.type === 'removed' && !isFolded ? 'text-text-tertiary line-through' : 'text-text-secondary'
                    }`}
                  >
                    {line.content || '\u00A0'}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 简化版 Diff 查看器 - 不显示状态提示
 * 为了向后兼容保留的别名
 */
export function SimpleDiffViewer({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  return (
    <DiffViewer
      oldContent={oldContent}
      newContent={newContent}
      showStatusHint={false}
    />
  );
}
