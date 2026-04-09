/**
 * 统一建议下拉组件 - 合并工作区和文件建议
 */

import { useEffect, useRef } from 'react';
import type { FileMatch } from '../../services/fileSearch';
import type { Workspace } from '../../types';

// 分离文件名和目录路径
function splitPath(relativePath: string): { dir: string; name: string } {
  const parts = relativePath.split(/[/\\]/);
  const name = parts[parts.length - 1];
  const dir = parts.slice(0, -1).join('/');
  return { dir, name };
}

export interface SuggestionItem {
  type: 'workspace' | 'file';
  data: Workspace | FileMatch;
}

interface UnifiedSuggestionProps {
  items: SuggestionItem[];
  selectedIndex: number;
  onSelect: (item: SuggestionItem) => void;
  onHover: (index: number) => void;
  position: { top: number; left: number };
  currentWorkspaceId: string | null;
}

export function UnifiedSuggestion({
  items,
  selectedIndex,
  onSelect,
  onHover,
  position,
  currentWorkspaceId,
}: UnifiedSuggestionProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // 滚动选中项到视图
  useEffect(() => {
    if (containerRef.current) {
      const selectedEl = containerRef.current.querySelector(`[data-index="${selectedIndex}"]`) as HTMLElement;
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex]);

  if (items.length === 0) {
    return null;
  }

  // 分组
  const workspaceItems = items.filter(i => i.type === 'workspace');
  const fileItems = items.filter(i => i.type === 'file');

  return (
    <div
      ref={containerRef}
      className="fixed z-50 bg-background-surface border border-border rounded-lg shadow-lg max-h-80 overflow-auto"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
        minWidth: '280px',
        maxWidth: '450px',
      }}
    >
      {/* 工作区分组 */}
      {workspaceItems.length > 0 && (
        <>
          <div className="px-3 py-1.5 text-xs text-text-tertiary border-b border-border bg-background-elevated/50 sticky top-0">
            工作区
          </div>
          {workspaceItems.map((item) => {
            const globalIdx = items.findIndex(i => i === item);
            const workspace = item.data as Workspace;
            const isCurrent = workspace.id === currentWorkspaceId;

            return (
              <div
                key={workspace.id}
                data-index={globalIdx}
                className={`px-3 py-2 cursor-pointer flex items-center gap-2 text-sm ${
                  globalIdx === selectedIndex
                    ? 'bg-primary/20 text-text-primary'
                    : 'text-text-secondary hover:bg-background-hover'
                }`}
                onClick={() => onSelect(item)}
                onMouseEnter={() => onHover(globalIdx)}
              >
                <span className="shrink-0">
                  {isCurrent ? (
                    <span className="w-2 h-2 rounded-full bg-primary inline-block" />
                  ) : (
                    <span className="w-2 h-2 rounded-full bg-primary/50 inline-block" />
                  )}
                </span>
                <span className="flex-1 truncate font-medium">{workspace.name}</span>
                {isCurrent && (
                  <span className="text-xs text-text-tertiary bg-background-elevated px-1.5 py-0.5 rounded shrink-0">
                    当前
                  </span>
                )}
              </div>
            );
          })}
        </>
      )}

      {/* 文件分组 */}
      {fileItems.length > 0 && (
        <>
          <div className="px-3 py-1.5 text-xs text-text-tertiary border-b border-border bg-background-elevated/50 sticky top-0">
            当前工作区文件
          </div>
          {fileItems.map((item) => {
            const globalIdx = items.findIndex(i => i === item);
            const file = item.data as FileMatch;
            const { dir, name } = splitPath(file.relativePath);

            return (
              <div
                key={file.fullPath}
                data-index={globalIdx}
                className={`px-3 py-2 cursor-pointer flex items-center gap-2 text-sm ${
                  globalIdx === selectedIndex
                    ? 'bg-primary/20 text-text-primary'
                    : 'text-text-secondary hover:bg-background-hover'
                }`}
                onClick={() => onSelect(item)}
                onMouseEnter={() => onHover(globalIdx)}
              >
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
                <div className="flex-1 min-w-0 flex items-center gap-1.5">
                  {dir && (
                    <span className="text-text-tertiary text-xs truncate" title={dir}>
                      {dir}/
                    </span>
                  )}
                  <span className="font-medium truncate" title={name}>
                    {name}
                  </span>
                </div>
                {file.extension && !file.isDir && (
                  <span className="text-xs text-text-tertiary bg-background-elevated px-1.5 py-0.5 rounded shrink-0">
                    {file.extension}
                  </span>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// 保留旧组件用于向后兼容（如有其他地方使用）
export { FileSuggestion } from './FileSuggestionLegacy';
export { WorkspaceSuggestion } from './WorkspaceSuggestionLegacy';
