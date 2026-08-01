/**
 * CodePreviewView - 代码预览组件
 *
 * 用于 Write 工具展开态下的内容展示，直接渲染写入的代码。
 * 特性：
 * - 文件路径整合到头部，可点击打开编辑器
 * - 代码以等宽字体展示，深色背景
 * - 无工具栏、无行号、无折叠，保持简洁
 * - 与 InlineDiffView 一致的头部风格
 */

import { memo, useMemo } from 'react';
import { clsx } from 'clsx';
import { FileCode } from 'lucide-react';
import { getLanguageFromPath } from '@/utils/language';

interface CodePreviewViewProps {
  /** 文件路径 */
  filePath: string;
  /** 文件内容 */
  content: string;
  /** 点击文件路径回调 */
  onOpenFile?: (path: string) => void;
  /** 最大高度 */
  maxHeight?: string;
}

export const CodePreviewView = memo(function CodePreviewView({
  filePath,
  content,
  onOpenFile,
  maxHeight = '240px',
}: CodePreviewViewProps) {
  // 从文件路径推断语言
  const language = useMemo(() => {
    const lang = getLanguageFromPath(filePath);
    return lang || 'plaintext';
  }, [filePath]);

  // 文件名
  const fileName = filePath.split(/[/\\]/).pop() || filePath;

  const handleClick = () => {
    onOpenFile?.(filePath);
  };

  if (!content) {
    return null;
  }

  return (
    <div className="overflow-hidden">
      {/* 头部：文件路径 + 语言标签 */}
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

      {/* 代码内容：简洁 pre/code，无工具栏/行号/折叠 */}
      <div
        className="overflow-auto bg-background-base"
        style={{ maxHeight }}
      >
        <pre className="p-3 text-xs font-mono text-text-secondary leading-5 whitespace-pre-wrap break-all">
          <code>{content}</code>
        </pre>
      </div>
    </div>
  );
});