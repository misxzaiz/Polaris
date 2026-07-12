/**
 * apply_patch 多文件补丁渲染器
 *
 * 为 apply_patch 工具调用块提供展开态的文件级 Diff 渲染。
 * 每个文件可独立折叠，内嵌 DiffViewer。
 */

import { memo, useState } from 'react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { ChevronRight, FilePlus, FileEdit, Trash2 } from 'lucide-react';
import type { ToolCallBlock } from '@/types';
import { DiffViewer } from '../../Diff/DiffViewer';
import { useFileEditorStore } from '@/stores/fileEditorStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';

/** 单个文件的操作类型标签 */
const FILE_TYPE_CONFIG = {
  add: { label: '新建', icon: FilePlus, color: 'text-success', bg: 'bg-success/10' },
  update: { label: '修改', icon: FileEdit, color: 'text-warning', bg: 'bg-warning/10' },
  delete: { label: '删除', icon: Trash2, color: 'text-error', bg: 'bg-error/10' },
};

function getFilePathLabel(change: { type: 'add' | 'update' | 'delete'; filePath: string; movePath?: string }): string {
  const filePath = change.filePath || '';
  const movePath = change.movePath;

  const prefix = change.type === 'add' ? '+ ' : change.type === 'delete' ? '− ' : '';

  if (change.type === 'update' && movePath && movePath !== filePath) {
    return `${prefix}${filePath} → ${movePath}`;
  }
  return `${prefix}${filePath}`;
}

export const PatchDiffRenderer = memo(function PatchDiffRenderer({
  block,
}: {
  block: ToolCallBlock;
}) {
  const { t } = useTranslation('chat');
  const openFile = useFileEditorStore((s) => s.openFile);
  const currentWorkspace = useWorkspaceStore((s) => {
    const { workspaces, currentWorkspaceId } = s;
    return workspaces.find((w) => w.id === currentWorkspaceId) || null;
  });

  const patchData = block.patchData;
  if (!patchData || patchData.length === 0) return null;

  const totalFiles = patchData.length;
  const totalAdded = patchData.reduce((sum, f) => sum + f.addedLines, 0);
  const totalRemoved = patchData.reduce((sum, f) => sum + f.removedLines, 0);

  // 展开态：每个文件的折叠状态
  const [expandedFiles, setExpandedFiles] = useState<Record<number, boolean>>({});

  const toggleFile = (index: number) => {
    setExpandedFiles((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  const handleFilePathClick = (e: React.MouseEvent, filePath: string) => {
    e.stopPropagation();
    if (!filePath) return;
    const isAbsolute = filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath);
    const absolutePath = isAbsolute
      ? filePath
      : currentWorkspace
        ? currentWorkspace.path.replace(/[\\/]+$/, '') + '/' + filePath.replace(/^[\\/]+/, '')
        : filePath;
    const fileName = filePath.split(/[/\\]/).pop() || filePath;
    openFile(absolutePath, fileName);
  };

  // 构建 Diff 的 key
  const diffKey = (index: number) => `patch-diff-${index}`;

  return (
    <div className="mb-3">
      <div className="text-xs text-text-muted mb-2 flex items-center gap-1.5">
        <FileEdit className="w-3 h-3" />
        <span>
          {t('tool.fileChanges')}: {totalFiles} {t('output.files')} ·
          <span className="text-success"> +{totalAdded}</span>
          <span className="text-error"> −{totalRemoved}</span>
        </span>
      </div>

      <div className="space-y-1.5">
        {patchData.map((change, index) => {
          const config = FILE_TYPE_CONFIG[change.type];
          const Icon = config.icon;
          const isExpanded = !!expandedFiles[index];

          return (
            <div
              key={index}
              className={clsx(
                'border border-border rounded-md overflow-hidden transition-all duration-150',
                change.type === 'add' && 'border-success/30',
                change.type === 'delete' && 'border-error/30'
              )}
            >
              {/* 文件头 */}
              <div
                className={clsx(
                  'flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-background-hover transition-colors',
                  'text-xs'
                )}
                onClick={() => toggleFile(index)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleFile(index);
                  }
                }}
                tabIndex={0}
                role="button"
                aria-expanded={isExpanded}
              >
                <Icon className={clsx('w-3.5 h-3.5', config.color)} />
                <span
                  className="text-primary hover:underline cursor-pointer flex-1 min-w-0 truncate"
                  onClick={(e) => handleFilePathClick(e, change.movePath || change.filePath)}
                  title={getFilePathLabel(change)}
                >
                  {getFilePathLabel(change)}
                </span>
                {/* 行数统计 */}
                {(change.addedLines > 0 || change.removedLines > 0) && (
                  <span className="text-[10px] text-text-muted flex-shrink-0 flex items-center gap-1">
                    {change.addedLines > 0 && <span className="text-success">+{change.addedLines}</span>}
                    {change.removedLines > 0 && <span className="text-error">−{change.removedLines}</span>}
                  </span>
                )}
                {/* 状态标签 */}
                <span className={clsx('text-[10px] px-1.5 py-0.5 rounded flex-shrink-0', config.bg, config.color)}>
                  {t(config.label)}
                </span>
                <ChevronRight
                  className={clsx(
                    'w-3 h-3 text-text-muted transition-transform duration-200',
                    isExpanded && 'rotate-90'
                  )}
                />
              </div>

              {/* Diff 内容 */}
              {isExpanded && change.type !== 'delete' && (
                <div className="border-t border-border">
                  <DiffViewer
                    key={diffKey(index)}
                    oldContent={change.oldContent}
                    newContent={change.newContent}
                    changeType="modified"
                    showStatusHint={false}
                    maxHeight="300px"
                  />
                </div>
              )}

              {/* 删除文件：仅显示状态 */}
              {isExpanded && change.type === 'delete' && (
                <div className="border-t border-border px-3 py-2 text-xs text-text-tertiary">
                  {t('tool.fileDeleted')}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
