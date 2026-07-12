import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  ChevronDown,
  FileText,
  ExternalLink,
  Search,
  X,
  Copy,
  Check,
  List,
  FolderTree,
  Rows3,
  Columns2,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  FileClock,
  Clipboard,
} from 'lucide-react'
import { DiffViewer } from '@/components/Diff/DiffViewer'
import type { DiffViewMode } from '@/components/Diff/DiffViewer'
import type {
  GitCommit as GitCommitType,
  GitCommitDetails,
  GitDiffEntry,
} from '@/types/git'
import type { OpenDiffTabOptions } from '@/stores/tabStore'
import { resolveWorkspacePath } from '@/utils/path'
import { getDiffKey, formatRelativeTime } from './historyTabUtils'
import type { FileListMode, CopyAction } from './historyTabUtils'
import { ContextMenu, type ContextMenuItem } from '@/components/FileExplorer/ContextMenu'

interface CommitDetailsPaneProps {
  selectedCommit: GitCommitType | null
  selectedDetails: GitCommitDetails | null
  selectedFileDiff: GitDiffEntry | null
  isDetailsLoading: boolean
  detailsError: string | null
  fileSearchQuery: string
  fileListMode: FileListMode
  diffViewMode: DiffViewMode
  copiedAction: CopyAction | null
  isCommitMessageExpanded: boolean
  isFilePaneCollapsed: boolean
  filePaneWidth: number
  filteredSelectedFiles: GitDiffEntry[]
  groupedSelectedFiles: { directory: string; files: GitDiffEntry[] }[]
  normalizedFileSearchQuery: string
  isWorkbench: boolean
  isFileHistoryMode: boolean
  currentWorkspacePath: string | undefined
  onSetFileSearchQuery: (query: string) => void
  onSetFileListMode: (mode: FileListMode) => void
  onSetDiffViewMode: (mode: DiffViewMode) => void
  onSetCopiedAction: (action: CopyAction | null) => void
  onSetIsCommitMessageExpanded: (expanded: boolean | ((prev: boolean) => boolean)) => void
  onSetIsFilePaneCollapsed: (collapsed: boolean) => void
  onSetSelectedFileDiff: (file: GitDiffEntry | null) => void
  onClearSelection: () => void
  onCopyText: (text: string | undefined, action: CopyAction) => void
  onLoadFileHistory: (filePath: string) => void
  onOpenDiffInTab?: (diff: GitDiffEntry, options?: OpenDiffTabOptions) => void
  onOpenFileInEditor?: (filePath: string) => void
  onStartPaneResize: (pane: 'files', event: React.PointerEvent<HTMLDivElement>) => void
}

export function CommitDetailsPane({
  selectedCommit,
  selectedDetails,
  selectedFileDiff,
  isDetailsLoading,
  detailsError,
  fileSearchQuery,
  fileListMode,
  diffViewMode,
  copiedAction,
  isCommitMessageExpanded,
  isFilePaneCollapsed,
  filePaneWidth,
  filteredSelectedFiles,
  groupedSelectedFiles,
  normalizedFileSearchQuery,
  isWorkbench,
  isFileHistoryMode,
  currentWorkspacePath,
  onSetFileSearchQuery,
  onSetFileListMode,
  onSetDiffViewMode,
  onSetIsCommitMessageExpanded,
  onSetIsFilePaneCollapsed,
  onSetSelectedFileDiff,
  onClearSelection,
  onCopyText,
  onLoadFileHistory,
  onOpenDiffInTab,
  onOpenFileInEditor,
  onStartPaneResize,
}: CommitDetailsPaneProps) {
  const { t } = useTranslation('git')

  const [fileContextMenu, setFileContextMenu] = useState<{ x: number; y: number; file: GitDiffEntry } | null>(null)

  const closeFileContextMenu = useCallback(() => setFileContextMenu(null), [])

  const buildFileContextMenuItems = useCallback((file: GitDiffEntry): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      {
        id: 'open-diff',
        label: t('history.openDiffInEditor'),
        icon: <ExternalLink size={14} />,
        action: () => {
          if (!selectedCommit || !onOpenDiffInTab) return
          onOpenDiffInTab(file, {
            identity: `history:${selectedCommit.sha}:${getDiffKey(file)}`,
            titleContext: selectedCommit.shortSha,
            metadata: {
              commitSha: selectedCommit.sha,
              shortSha: selectedCommit.shortSha,
              source: isFileHistoryMode ? 'file-history' : 'commit-history',
            },
          })
        },
      },
      {
        id: 'copy-path',
        label: t('history.copyFilePath'),
        icon: <Clipboard size={14} />,
        action: () => onCopyText(file.file_path, 'filePath'),
      },
      {
        id: 'view-history',
        label: t('history.viewFileHistory'),
        icon: <FileClock size={14} />,
        action: () => void onLoadFileHistory(file.file_path),
      },
    ]

    if (file.change_type !== 'deleted' && onOpenFileInEditor) {
      items.push({
        id: 'open-file',
        label: t('history.openFileInEditor'),
        icon: <FileText size={14} />,
        action: () => onOpenFileInEditor(resolveWorkspacePath(currentWorkspacePath, file.file_path)),
      })
    }

    return items
  }, [currentWorkspacePath, isFileHistoryMode, onLoadFileHistory, onOpenDiffInTab, onOpenFileInEditor, onCopyText, selectedCommit, t])

  const handleFileContextMenu = useCallback((e: React.MouseEvent, file: GitDiffEntry) => {
    e.preventDefault()
    e.stopPropagation()
    setFileContextMenu({ x: e.clientX, y: e.clientY, file })
  }, [])

  const openSelectedDiffInTab = useCallback(() => {
    if (!selectedCommit || !selectedFileDiff) return

    onOpenDiffInTab?.(selectedFileDiff, {
      identity: `history:${selectedCommit.sha}:${getDiffKey(selectedFileDiff)}`,
      titleContext: selectedCommit.shortSha,
      metadata: {
        commitSha: selectedCommit.sha,
        shortSha: selectedCommit.shortSha,
        source: isFileHistoryMode ? 'file-history' : 'commit-history',
      },
    })
  }, [isFileHistoryMode, onOpenDiffInTab, selectedCommit, selectedFileDiff])

  // 在当前文件列表中切换到上一个 / 下一个文件（供 diff 视图 ]/[ 键盘导航）
  const navigateFile = useCallback((delta: number) => {
    if (!selectedFileDiff || filteredSelectedFiles.length === 0) return
    const currentKey = getDiffKey(selectedFileDiff)
    const currentIndex = filteredSelectedFiles.findIndex((f) => getDiffKey(f) === currentKey)
    if (currentIndex === -1) return
    const nextIndex = (currentIndex + delta + filteredSelectedFiles.length) % filteredSelectedFiles.length
    onSetSelectedFileDiff(filteredSelectedFiles[nextIndex])
  }, [filteredSelectedFiles, selectedFileDiff, onSetSelectedFileDiff])

  const openSelectedFileInEditor = useCallback(() => {
    if (!selectedFileDiff || selectedFileDiff.change_type === 'deleted') return
    onOpenFileInEditor?.(resolveWorkspacePath(currentWorkspacePath, selectedFileDiff.file_path))
  }, [selectedFileDiff, onOpenFileInEditor, currentWorkspacePath])

  if (!selectedCommit && !isDetailsLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm p-6 text-center">
        {t('history.selectCommit')}
      </div>
    )
  }

  const selectedMessage = selectedCommit?.message ?? ''
  const selectedMessageLines = selectedMessage.split('\n')
  const selectedMessageSubject = selectedMessageLines[0] || selectedMessage
  const hasCommitMessageBody = selectedMessageLines.slice(1).some(line => line.trim().length > 0)
  const visibleCommitMessage = isCommitMessageExpanded ? selectedMessage : selectedMessageSubject
  const shouldShowFilePane = !isFileHistoryMode && (!isWorkbench || !isFilePaneCollapsed)

  const renderFileButton = (file: GitDiffEntry) => {
    const isSelected = selectedFileDiff ? getDiffKey(selectedFileDiff) === getDiffKey(file) : false

    return (
      <div
        key={getDiffKey(file)}
        title={file.file_path}
        className={`group flex items-center border-b border-border-subtle hover:bg-background-hover transition-colors ${
          isSelected ? 'bg-primary/5' : ''
        }`}
        onContextMenu={(e) => handleFileContextMenu(e, file)}
      >
        <button
          type="button"
          onClick={() => onSetSelectedFileDiff(file)}
          className="min-w-0 flex-1 px-4 py-2 flex items-center gap-2 text-left"
        >
          <FileText size={13} className="text-text-tertiary shrink-0" />
          <span className="flex-1 min-w-0 text-sm text-text-primary truncate">
            {file.file_path}
          </span>
          <span className="text-xs shrink-0">
            <span className="text-success">+{file.additions ?? 0}</span>
            <span className="text-danger ml-1">-{file.deletions ?? 0}</span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => void onLoadFileHistory(file.file_path)}
          className="mr-2 p-1.5 text-text-tertiary hover:text-primary hover:bg-primary/10 rounded transition-colors opacity-70 group-hover:opacity-100 shrink-0"
          title={t('history.viewFileHistory')}
        >
          <FileClock size={13} />
        </button>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-background-base">
      <div className="px-3 py-2 border-b border-border-subtle bg-background-surface shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className="text-xs font-mono text-text-tertiary bg-background-elevated px-1.5 py-0.5 rounded shrink-0">
              {selectedCommit?.shortSha}
            </span>
            {selectedCommit && selectedCommit.parents.length > 1 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-info/10 text-info shrink-0">
                {t('history.mergeCommit')}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div
                className={`text-sm text-text-primary font-medium ${
                  isCommitMessageExpanded
                    ? 'whitespace-pre-wrap break-words max-h-32 overflow-y-auto pr-1'
                    : 'truncate'
                }`}
                title={isCommitMessageExpanded ? undefined : selectedMessage}
              >
                {visibleCommitMessage}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-tertiary">
                <span className="truncate max-w-[220px]">{selectedCommit?.author}</span>
                <span>·</span>
                <span>{formatRelativeTime(selectedCommit?.timestamp, t)}</span>
                {selectedDetails && (
                  <>
                    <span>·</span>
                    <span>{t('history.filesChanged', { count: selectedDetails.files.length })}</span>
                    <span className="text-success">+{selectedDetails.totalAdditions}</span>
                    <span className="text-danger">-{selectedDetails.totalDeletions}</span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {selectedCommit && (
              <>
                {hasCommitMessageBody && (
                  <button
                    type="button"
                    onClick={() => onSetIsCommitMessageExpanded(prev => !prev)}
                    className="p-1 text-text-tertiary hover:text-primary hover:bg-background-hover rounded transition-colors"
                    title={isCommitMessageExpanded ? t('history.collapseMessage') : t('history.expandMessage')}
                  >
                    {isCommitMessageExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onCopyText(selectedCommit.sha, 'sha')}
                  className="p-1 text-text-tertiary hover:text-primary hover:bg-background-hover rounded transition-colors"
                  title={copiedAction === 'sha' ? t('history.copied') : t('history.copySha')}
                >
                  {copiedAction === 'sha' ? <Check size={14} /> : <Copy size={14} />}
                </button>
                <button
                  type="button"
                  onClick={() => onCopyText(selectedCommit.message, 'message')}
                  className="p-1 text-text-tertiary hover:text-primary hover:bg-background-hover rounded transition-colors"
                  title={copiedAction === 'message' ? t('history.copied') : t('history.copyMessage')}
                >
                  {copiedAction === 'message' ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClearSelection}
              className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors"
              title={t('history.closeDetails')}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      </div>

      {detailsError && (
        <div className="px-4 py-2 text-xs text-danger bg-danger/10 border-b border-danger/20">
          {t('history.detailLoadFailed')}: {detailsError}
        </div>
      )}

      {isDetailsLoading ? (
        <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
          <Loader2 size={16} className="animate-spin mr-2" />
          {t('history.loadingDetails')}
        </div>
      ) : selectedDetails ? (
        <div className={isWorkbench ? 'flex-1 flex min-h-0' : 'flex-1 flex flex-col min-h-0'}>
          {shouldShowFilePane && (
            <div
              className={`${isWorkbench ? 'relative border-r' : 'max-h-56 border-b'} border-border-subtle shrink-0 flex flex-col min-h-0`}
              style={isWorkbench ? { width: filePaneWidth } : undefined}
            >
              {selectedDetails.files.length === 0 ? (
                <div className="p-4 text-sm text-text-tertiary text-center">
                  {t('history.noFileChanges')}
                </div>
              ) : (
                <>
                  <div className="p-2 border-b border-border-subtle bg-background-surface shrink-0">
                    <div className="flex items-center gap-1.5">
                      <div className="relative flex-1 min-w-0">
                        <Search
                          size={13}
                          className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
                        />
                        <input
                          type="search"
                          value={fileSearchQuery}
                          onChange={(event) => onSetFileSearchQuery(event.target.value)}
                          placeholder={t('history.fileSearchPlaceholder')}
                          className="w-full h-7 pl-7 pr-7 text-xs bg-background-base border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder:text-text-tertiary"
                        />
                        {fileSearchQuery && (
                          <button
                            type="button"
                            onClick={() => onSetFileSearchQuery('')}
                            className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors"
                            title={t('history.clearFileSearch')}
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>
                      <div className="flex items-center bg-background-base border border-border rounded shrink-0">
                        <button
                          type="button"
                          onClick={() => onSetFileListMode('list')}
                          className={`p-1.5 transition-colors ${fileListMode === 'list' ? 'text-primary bg-primary/10' : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'}`}
                          title={t('history.listView')}
                        >
                          <List size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => onSetFileListMode('tree')}
                          className={`p-1.5 transition-colors ${fileListMode === 'tree' ? 'text-primary bg-primary/10' : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'}`}
                          title={t('history.treeView')}
                        >
                          <FolderTree size={13} />
                        </button>
                      </div>
                      {isWorkbench && (
                        <button
                          type="button"
                          onClick={() => onSetIsFilePaneCollapsed(true)}
                          className="p-1.5 text-text-tertiary hover:text-primary hover:bg-background-hover rounded transition-colors shrink-0"
                          title={t('history.collapseFilePane')}
                        >
                          <PanelLeftClose size={13} />
                        </button>
                      )}
                    </div>
                    {normalizedFileSearchQuery && (
                      <div className="mt-1.5 text-[11px] text-text-tertiary">
                        {t('history.fileSearchCount', {
                          shown: filteredSelectedFiles.length,
                          count: selectedDetails.files.length,
                        })}
                      </div>
                    )}
                  </div>

                  <div className="flex-1 overflow-y-auto min-h-0">
                    {filteredSelectedFiles.length === 0 ? (
                      <div className="p-4 text-sm text-text-tertiary text-center">
                        {t('history.noFileSearchResults')}
                      </div>
                    ) : fileListMode === 'tree' ? (
                      groupedSelectedFiles.map((group) => (
                        <div key={group.directory}>
                          <div className="sticky top-0 px-4 py-1.5 bg-background-surface border-b border-border-subtle text-[11px] font-medium text-text-tertiary flex items-center gap-1.5">
                            <FolderTree size={12} />
                            <span className="truncate">{group.directory}</span>
                          </div>
                          {group.files.map(renderFileButton)}
                        </div>
                      ))
                    ) : (
                      filteredSelectedFiles.map(renderFileButton)
                    )}
                  </div>
                </>
              )}
              {isWorkbench && (
                <div
                  role="separator"
                  aria-orientation="vertical"
                  onPointerDown={(event) => onStartPaneResize('files', event)}
                  className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/40 transition-colors"
                  title={t('history.resizePane')}
                />
              )}
            </div>
          )}

          <div className="flex-1 flex flex-col min-h-0">
            {selectedFileDiff ? (
              <>
                <div className="px-4 py-2 border-b border-border-subtle bg-background-surface flex items-center gap-2 shrink-0">
                  {isWorkbench && !isFileHistoryMode && isFilePaneCollapsed && (
                    <button
                      type="button"
                      onClick={() => onSetIsFilePaneCollapsed(false)}
                      className="p-1 text-text-tertiary hover:text-primary hover:bg-background-hover rounded transition-colors shrink-0"
                      title={t('history.expandFilePane')}
                    >
                      <PanelLeftOpen size={14} />
                    </button>
                  )}
                  <span className="flex-1 text-xs font-medium text-text-secondary truncate">
                    {selectedFileDiff.file_path}
                  </span>
                  {onOpenFileInEditor && selectedFileDiff.change_type !== 'deleted' && (
                    <button
                      type="button"
                      onClick={() => onOpenFileInEditor(resolveWorkspacePath(currentWorkspacePath, selectedFileDiff.file_path))}
                      className="p-1 text-text-tertiary hover:text-primary hover:bg-background-hover rounded transition-colors shrink-0"
                      title={t('history.openFileInEditor')}
                    >
                      <FileText size={14} />
                    </button>
                  )}
                  <div className="flex items-center bg-background-base border border-border rounded shrink-0">
                    <button
                      type="button"
                      onClick={() => onSetDiffViewMode('unified')}
                      className={`p-1.5 transition-colors ${diffViewMode === 'unified' ? 'text-primary bg-primary/10' : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'}`}
                      title={t('diff.unifiedView')}
                    >
                      <Rows3 size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onSetDiffViewMode('split')}
                      className={`p-1.5 transition-colors ${diffViewMode === 'split' ? 'text-primary bg-primary/10' : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'}`}
                      title={t('diff.splitView')}
                    >
                      <Columns2 size={13} />
                    </button>
                  </div>
                  {onOpenDiffInTab && (
                    <button
                      type="button"
                      onClick={openSelectedDiffInTab}
                      className="p-1 text-text-tertiary hover:text-primary hover:bg-background-hover rounded transition-colors"
                      title={t('history.openDiffInEditor')}
                    >
                      <ExternalLink size={14} />
                    </button>
                  )}
                </div>
                <DiffViewer
                  oldContent={selectedFileDiff.old_content}
                  newContent={selectedFileDiff.new_content}
                  changeType={selectedFileDiff.change_type}
                  statusHint={selectedFileDiff.status_hint}
                  contentOmitted={selectedFileDiff.content_omitted ?? false}
                  viewMode={diffViewMode}
                  filePath={selectedFileDiff.file_path}
                  autoFocus
                  onNextFile={() => navigateFile(1)}
                  onPrevFile={() => navigateFile(-1)}
                  onOpenFile={openSelectedFileInEditor}
                  onLineClick={openSelectedFileInEditor}
                  onClose={onClearSelection}
                />
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-text-tertiary p-6 text-center">
                {t('history.selectFile')}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {fileContextMenu && (
        <ContextMenu
          visible
          x={fileContextMenu.x}
          y={fileContextMenu.y}
          items={buildFileContextMenuItems(fileContextMenu.file)}
          onClose={closeFileContextMenu}
        />
      )}
    </div>
  )
}
