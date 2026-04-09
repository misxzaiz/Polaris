/**
 * 旧版文件建议组件 - 保留用于向后兼容
 */

import { useEffect, useRef } from 'react';
import type { FileMatch } from '../../services/fileSearch';

interface FileSuggestionProps {
  files: FileMatch[];
  selectedIndex: number;
  onSelect: (file: FileMatch) => void;
  onHover: (index: number) => void;
  position: { top: number; left: number };
}

// 分离文件名和目录路径
function splitPath(relativePath: string): { dir: string; name: string } {
  const parts = relativePath.split(/[/\\]/);
  const name = parts[parts.length - 1];
  const dir = parts.slice(0, -1).join('/');
  return { dir, name };
}

export function FileSuggestion({
  files,
  selectedIndex,
  onSelect,
  onHover,
  position,
}: FileSuggestionProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // 滚动选中项到视图
  useEffect(() => {
    if (containerRef.current) {
      const selectedEl = containerRef.current.children[selectedIndex] as HTMLElement;
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex]);

  if (files.length === 0) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className="fixed z-50 bg-background-surface border border-border rounded-lg shadow-lg max-h-60 overflow-auto"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
        minWidth: '280px',
        maxWidth: '450px',
      }}
    >
      {/* 当前工作区文件标题 */}
      <div className="px-3 py-1.5 text-xs text-text-tertiary border-b border-border bg-background-elevated/50">
        当前工作区文件
      </div>
      {files.map((file, index) => {
        const { dir, name } = splitPath(file.relativePath);

        return (
          <div
            key={file.fullPath}
            className={`px-3 py-2 cursor-pointer flex items-center gap-2 text-sm ${
              index === selectedIndex
                ? 'bg-primary/20 text-text-primary'
                : 'text-text-secondary hover:bg-background-hover'
            }`}
            onClick={() => onSelect(file)}
            onMouseEnter={() => onHover(index)}
          >
            {/* 文件图标 */}
            <span className="shrink-0">
              {file.isDir ? (
                <svg className="w-4 h-4 text-warning" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                </svg>
              ) : (
                <svg className="w-4 h-4 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              )}
            </span>

            {/* 路径和文件名 */}
            <div className="flex-1 min-w-0 flex items-center gap-1.5">
              {/* 目录路径（浅色） */}
              {dir && (
                <span className="text-text-tertiary text-xs truncate" title={dir}>
                  {dir}/
                </span>
              )}
              {/* 文件名（深色） */}
              <span className="font-medium truncate" title={name}>
                {name}
              </span>
            </div>

            {/* 扩展名标签 */}
            {file.extension && !file.isDir && (
              <span className="text-xs text-text-tertiary bg-background-elevated px-1.5 py-0.5 rounded shrink-0">
                {file.extension}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
