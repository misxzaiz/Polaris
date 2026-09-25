/**
 * SessionOperationBar - 会话底部操作区（tab 化）
 *
 * 三个 tab：
 *  1. 运行过程（process）：过程块分组列表（复用 ProcessBlockGroupedList）
 *  2. 变更文件（files）：Edit/Write/apply_patch 工具提取的文件变更列表
 *  3. 产物（artifacts）：PRD/HTML 原型预览（复用 ArtifactPreviewRenderer）
 *
 * 与灵动岛共用 runArtifacts 派生数据源（extractFileChanges / extractProcessBlocks /
 * extractArtifacts），保证数据一致。挂载于 SessionMessagesView 底部，Virtuoso 之外，
 * 不随消息滚动消失。per-session：订阅对应 session store。
 */

import { memo, useCallback, useMemo, useState } from 'react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import {
  Activity,
  FileText,
  FolderOpen,
  ChevronDown,
  FilePlus,
} from 'lucide-react';
import type { ContentBlock } from '@/types';
import type { ArtifactPreviewBlock } from '@/types';
import { useFileEditorStore } from '@/stores/fileEditorStore';
import { useSessionStoreSubscription } from '../messages/useSessionStoreSubscription';
import {
  extractArtifacts,
  extractFileChanges,
  extractProcessBlocks,
  computeDiffStats,
  type FileChange,
} from '../chatUtils/runArtifacts';
import { ProcessBlockGroupedList } from '../tool-calls/blockGrouping';
import { ArtifactPreviewRenderer } from '../chatBlocks/ArtifactPreviewRenderer';
import { InlineDiffView } from '../chatBlocks/InlineDiffView';
import { CodePreviewView } from '../chatBlocks/CodePreviewView';

/** 底部操作区 tab 类型 */
type OperationTab = 'process' | 'files' | 'artifacts';

/** 空数据占位 */
function EmptyPanel({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-8 text-xs text-text-muted">
      {label}
    </div>
  );
}

/** 文件变更 tab：列表 + 展开 diff/内容 */
const FileChangesPanel = memo(function FileChangesPanel({
  fileChanges,
}: {
  fileChanges: FileChange[];
}) {
  const { t } = useTranslation('chat');
  const openFile = useFileEditorStore((s) => s.openFile);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleFile = useCallback((fullPath: string, e: React.MouseEvent) => {
    // 点击文件名区域时不要切换展开/折叠
    if ((e.target as HTMLElement).closest('[data-file-open]')) return;
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(fullPath)) next.delete(fullPath);
      else next.add(fullPath);
      return next;
    });
  }, []);

  const handleOpenFile = useCallback((filePath: string) => {
    const fileName = filePath.split(/[/\\]/).pop() || filePath;
    openFile(filePath, fileName);
  }, [openFile]);

  if (fileChanges.length === 0) {
    return <EmptyPanel label={t('operationBar.filesEmpty')} />;
  }

  return (
    <div className="flex flex-col border border-border rounded-md overflow-hidden">
      {fileChanges.map((fc, i) => (
        <React.Fragment key={fc.fullPath}>
          {/* 文件行 */}
          <div
            className={clsx(
              'flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer transition-colors',
              'hover:bg-background-hover',
              i < fileChanges.length - 1 && !expanded.has(fc.fullPath) && 'border-b border-border',
              expanded.has(fc.fullPath) && 'bg-background-hover'
            )}
            onClick={(e) => toggleFile(fc.fullPath, e)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setExpanded(prev => {
                  const next = new Set(prev);
                  if (next.has(fc.fullPath)) next.delete(fc.fullPath);
                  else next.add(fc.fullPath);
                  return next;
                });
              }
            }}
            aria-expanded={expanded.has(fc.fullPath)}
          >
            {fc.changeType === 'created' ? (
              <FilePlus className="w-3.5 h-3.5 shrink-0 text-green-400" />
            ) : (
              <FileText className={clsx('w-3.5 h-3.5 shrink-0', fc.changeType === 'deleted' ? 'text-red-400' : 'text-orange-400')} />
            )}
            {/* 文件名（粗体） */}
            <span
              className="text-xs font-medium text-text-primary hover:text-primary hover:underline shrink-0 cursor-pointer"
              data-file-open
              onClick={(e) => {
                e.stopPropagation();
                handleOpenFile(fc.fullPath);
              }}
              title={fc.fullPath}
            >
              {fc.fileName}
            </span>
            {/* 目录路径（次要灰色） */}
            <span className="text-[11px] text-text-muted/60 flex-1 min-w-0 truncate" title={fc.fullPath}>
              {fc.dirPath}
            </span>
            {/* 统计：modified 显示 +N −M，created 显示 +N */}
            {fc.changeType === 'modified' && fc.diffData && (() => {
              const { added, removed } = computeDiffStats(fc.diffData);
              if (added === 0 && removed === 0) return null;
              return (
                <span className="text-[10px] tabular-nums shrink-0 text-text-muted">
                  {added > 0 && <span className="text-success">+{added}</span>}
                  {removed > 0 && <span className="text-error"> −{removed}</span>}
                </span>
              );
            })()}
            {fc.changeType === 'created' && fc.newContent && (
              <span className="text-[10px] tabular-nums shrink-0 text-text-muted">
                <span className="text-success">+{fc.newContent.replace(/\n$/, '').split('\n').length}</span>
              </span>
            )}
            <span className={clsx(
              'shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium',
              fc.changeType === 'created'
                ? 'bg-green-500/10 text-green-400'
                : fc.changeType === 'deleted'
                  ? 'bg-red-500/10 text-red-400'
                  : 'bg-orange-500/10 text-orange-400'
            )}>
              {fc.changeType === 'created' ? t('summary.fileCreated')
                : fc.changeType === 'deleted' ? t('summary.fileDeleted')
                : t('summary.fileModified')}
            </span>
            <ChevronDown className={clsx(
              'w-3 h-3 shrink-0 text-text-muted transition-transform duration-150',
              expanded.has(fc.fullPath) && 'rotate-180'
            )} />
          </div>
          {/* 展开内容：diff 或 newContent */}
          {expanded.has(fc.fullPath) && (
            <div className="border-b border-border bg-background-base">
              <div className="px-3 py-2">
                {fc.changeType === 'modified' && fc.diffData ? (
                  <InlineDiffView
                    filePath={fc.fileName}
                    oldContent={fc.diffData.oldContent}
                    newContent={fc.diffData.newContent}
                    diffString={fc.diffData.diffString}
                    onOpenFile={() => handleOpenFile(fc.fullPath)}
                    maxHeight="300px"
                    noHeader
                  />
                ) : fc.changeType === 'created' && fc.newContent ? (
                  <CodePreviewView
                    filePath={fc.fileName}
                    content={fc.newContent}
                    onOpenFile={() => handleOpenFile(fc.fullPath)}
                    maxHeight="300px"
                    noHeader
                  />
                ) : fc.changeType === 'deleted' ? (
                  <div className="text-xs text-text-muted italic py-4 text-center">
                    {t('summary.fileDeleted')}
                  </div>
                ) : (
                  <div className="text-xs text-text-muted italic py-4 text-center">
                    {t('summary.fileChangesTitle')}
                  </div>
                )}
              </div>
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
});

/** 产物 tab：ArtifactPreviewRenderer 列表（限定高度滚动） */
const ArtifactsPanel = memo(function ArtifactsPanel({
  artifacts,
}: {
  artifacts: ArtifactPreviewBlock[];
}) {
  const { t } = useTranslation('chat');

  if (artifacts.length === 0) {
    return <EmptyPanel label={t('operationBar.artifactsEmpty')} />;
  }

  return (
    <div className="flex flex-col gap-2">
      {artifacts.map((block, i) => (
        <ArtifactPreviewRenderer key={`${block.previewId || i}`} block={block} />
      ))}
    </div>
  );
});

/** 底部操作区主体 */
export const SessionOperationBar = memo(function SessionOperationBar({
  sessionId,
}: {
  sessionId: string;
}) {
  const { t } = useTranslation('chat');
  const [activeTab, setActiveTab] = useState<OperationTab>('process');

  // ===== 共享数据源（与灵动岛同源，实时派生） =====
  const messages = useSessionStoreSubscription(
    sessionId,
    useCallback((state) => state.messages, []),
    [] as import('@/types/chat').ChatMessage[]
  );
  const currentMessage = useSessionStoreSubscription(
    sessionId,
    useCallback((state) => state.currentMessage, []),
    null
  );

  // 合并流式消息（与 SessionMessagesView 同构）
  const allBlocks = useMemo(() => {
    const blocks: ContentBlock[] = [];
    for (const m of messages) {
      if (m.type === 'assistant' && m.blocks) blocks.push(...m.blocks);
    }
    if (currentMessage?.blocks) blocks.push(...currentMessage.blocks);
    return blocks;
  }, [messages, currentMessage]);

  const processBlocks = useMemo(() => extractProcessBlocks(allBlocks), [allBlocks]);
  const fileChanges = useMemo(() => extractFileChanges(allBlocks), [allBlocks]);
  const artifacts = useMemo(() => extractArtifacts(allBlocks), [allBlocks]);

  const isEmpty = processBlocks.length === 0 && fileChanges.length === 0 && artifacts.length === 0;

  if (isEmpty) return null;

  const tabs: { key: OperationTab; label: string; icon: React.ReactNode; count: number; leftBadge?: boolean }[] = [
    { key: 'process', label: t('operationBar.processTab'), icon: <Activity />, count: processBlocks.length },
    { key: 'files', label: t('operationBar.filesTab'), icon: <FolderOpen />, count: fileChanges.length, leftBadge: true },
    { key: 'artifacts', label: t('operationBar.artifactsTab'), icon: <FileText />, count: artifacts.length },
  ];

  return (
    <div className="op-bar flex-shrink-0 border-t border-border bg-background-elevated flex flex-col">
      {/* tab 条 */}
      <div className="flex items-center gap-0.5 px-2.5 pt-1">
        {tabs.map(tab => (
          <button
            key={tab.key}
            type="button"
            className={clsx(
              'inline-flex items-center gap-1.5 h-7 px-3 text-xs rounded-t-md transition-colors',
              'border-none cursor-pointer relative',
              activeTab === tab.key
                ? 'text-text-primary bg-background-base'
                : 'text-text-secondary hover:bg-background-surface hover:text-text-primary'
            )}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.count > 0 && (
              <span className={clsx(
                'min-w-4 h-4 px-1 inline-flex items-center justify-center rounded-full text-[10px] tabular-nums',
                tab.leftBadge ? 'bg-green-500/15 text-green-400' : 'bg-primary/15 text-primary'
              )}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
        <span className="flex-1" />
      </div>

      {/* 内容面板 */}
      <div className="op-body border-t border-border bg-background-base overflow-y-auto" style={{ maxHeight: '30vh', minHeight: '64px' }}>
        <div className="p-2.5 pb-3">
          {activeTab === 'process' && (
            processBlocks.length > 0 ? (
              <ProcessBlockGroupedList processBlocks={processBlocks} />
            ) : (
              <EmptyPanel label={t('operationBar.processEmpty')} />
            )
          )}
          {activeTab === 'files' && (
            <FileChangesPanel fileChanges={fileChanges} />
          )}
          {activeTab === 'artifacts' && (
            <ArtifactsPanel artifacts={artifacts} />
          )}
        </div>
      </div>
    </div>
  );
});
