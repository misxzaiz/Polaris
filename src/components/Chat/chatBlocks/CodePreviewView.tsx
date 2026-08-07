/**
 * CodePreviewView - 代码预览组件
 *
 * 用于 Write 工具展开态下的内容展示，直接渲染写入的代码。
 * 特性：
 * - 文件路径整合到头部，可点击打开编辑器
 * - 代码以等宽字体展示，深色背景
 * - 大文件保护：超出阈值时跳过语法高亮，减少主线程压力
 * - 无工具栏、无行号、无折叠，保持简洁
 * - 与 InlineDiffView 一致的头部风格
 */

import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { FileCode, AlertTriangle } from 'lucide-react';
import { getLanguageFromPath } from '@/utils/language';
import { highlightCode } from '@/utils/syntaxHighlight';

/** 超过此字符数时跳过语法高亮，直接渲染纯文本（≈ 100KB 文本） */
const MAX_PREVIEW_CHARS = 100_000;

/** 超过此行数时截断预览内容 */
const MAX_PREVIEW_LINES = 3_000;

interface CodePreviewViewProps {
  /** 文件路径 */
  filePath: string;
  /** 文件内容 */
  content: string;
  /** 点击文件路径回调 */
  onOpenFile?: (path: string) => void;
  /** 最大高度 */
  maxHeight?: string;
  /** 是否隐藏头部（由外部行提供文件名时使用） */
  noHeader?: boolean;
}

export const CodePreviewView = memo(function CodePreviewView({
  filePath,
  content,
  onOpenFile,
  maxHeight = '240px',
  noHeader = false,
}: CodePreviewViewProps) {
  const { t } = useTranslation('chat');

  // compactor 压缩后 input 被置为 {}，filePath/content 可能均为 undefined。
  // 在各 useMemo 内守卫，避免 getLanguageFromPath(undefined) 触发
  // `Cannot read properties of undefined (reading 'split')`（scroll 重渲染路径）。
  // 不用提前 return：会违反 React Hooks 顺序规则（条件性跳过后续 useMemo）。

  // 从文件路径推断语言
  const language = useMemo(() => {
    const lang = filePath ? getLanguageFromPath(filePath) : 'plaintext';
    return lang || 'plaintext';
  }, [filePath]);

  // 内容是否过大
  const isTooLarge = useMemo(() => {
    return content ? content.length > MAX_PREVIEW_CHARS : false;
  }, [content]);

  // 内容行数是否过多（截断预览）
  const lineCount = useMemo(() => {
    return content ? content.split('\n').length : 0;
  }, [content]);

  const isTooManyLines = useMemo(() => {
    return lineCount > MAX_PREVIEW_LINES;
  }, [lineCount]);

  // 语法高亮（仅当内容不过大时，过大时直接显示纯文本）
  const highlighted = useMemo(() => {
    if (!content) return null;
    if (isTooLarge) return null;
    if (isTooManyLines) {
      // 行数过多时只对前 N 行做高亮
      const truncated = content.split('\n').slice(0, MAX_PREVIEW_LINES).join('\n');
      return highlightCode(truncated, language);
    }
    return highlightCode(content, language);
  }, [content, language, isTooLarge, isTooManyLines]);

  // 文件名（filePath 在渲染层守卫，避免 undefined.split）
  const fileName = filePath ? (filePath.split(/[/\\]/).pop() || filePath) : '';

  const handleClick = () => {
    onOpenFile?.(filePath);
  };

  // 纯文本内容（过大或行数过多时截断，避免 DOM 膨胀）
  const plainContent = useMemo(() => {
    if (!content) return '';
    if (isTooLarge || isTooManyLines) {
      return content.split('\n').slice(0, MAX_PREVIEW_LINES).join('\n');
    }
    return content;
  }, [content, isTooLarge, isTooManyLines]);

  // 无内容则不渲染（compactor 压缩态 input 为空对象）。所有 hooks 之后才 return，
  // 避免违反 React Hooks 顺序规则。
  if (!content) {
    return null;
  }

  return (
    <div className="overflow-hidden">
      {/* 头部：文件路径 + 语言标签（noHeader 时跳过） */}
      {!noHeader && (
        <div
          className={clsx(
            'flex items-center gap-2 px-3 py-1.5 bg-background-surface',
            'cursor-pointer hover:bg-background-hover transition-colors text-xs select-none',
          )}
          onClick={handleClick}
          title={filePath}
        >
          <FileCode className="w-3.5 h-3.5 text-primary shrink-0" />
          <span className="text-primary hover:underline truncate flex-1 min-w-0">
            {fileName}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-background-secondary text-text-tertiary shrink-0">
            {language}
          </span>
        </div>
      )}

      {/* 代码内容：简洁 pre/code，无工具栏/行号/折叠 */}
      <div
        className="overflow-auto bg-background-base"
        style={{ maxHeight }}
      >
        {/* 大文件警告 */}
        {isTooLarge && (
          <div className="flex items-center gap-2 px-3 pt-3 pb-1 text-text-tertiary">
            <AlertTriangle className="w-4 h-4 shrink-0 text-warning" />
            <span className="text-xs">{t('tool.fileTooLargeForPreview')}</span>
          </div>
        )}
        <pre className="p-3 text-xs font-mono leading-5 whitespace-pre-wrap break-all">
          {highlighted ? (
            <code dangerouslySetInnerHTML={{ __html: highlighted }} />
          ) : (
            <code className="text-text-secondary">{plainContent}</code>
          )}
        </pre>
        {/* 截断提示 */}
        {(isTooLarge || isTooManyLines) && (
          <div className="flex items-center gap-2 px-3 pb-3 pt-1 text-text-tertiary border-t border-border">
            <span className="text-xs">
              {isTooLarge && isTooManyLines
                ? t('tool.previewTruncatedByLines', { count: lineCount - MAX_PREVIEW_LINES })
                : isTooLarge
                  ? t('tool.previewTruncatedBySize')
                  : t('tool.previewTruncatedByLines', { count: lineCount - MAX_PREVIEW_LINES })
              }
            </span>
            <button
              onClick={handleClick}
              className="ml-auto text-xs text-primary hover:underline"
            >
              {t('tool.openInEditor')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
});