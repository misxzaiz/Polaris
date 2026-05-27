import type { GitDiffEntry } from '@/types/git'
import type { DiffViewMode } from '@/components/Diff/DiffViewer'

export const PAGE_SIZE = 20
export const FILE_LIST_MODE_STORAGE_KEY = 'polaris.git.history.fileListMode'
export const COMMIT_LIST_WIDTH_STORAGE_KEY = 'polaris.git.history.commitListWidth'
export const FILE_PANE_WIDTH_STORAGE_KEY = 'polaris.git.history.filePaneWidth'
export const FILE_PANE_COLLAPSED_STORAGE_KEY = 'polaris.git.history.filePaneCollapsed'
export const DIFF_VIEW_MODE_STORAGE_KEY = 'polaris.git.history.diffViewMode'
export const COMMIT_LIST_MIN_WIDTH = 280
export const COMMIT_LIST_MAX_WIDTH = 560
export const FILE_PANE_MIN_WIDTH = 240
export const FILE_PANE_MAX_WIDTH = 520

export type FileListMode = 'list' | 'tree'
export type CopyAction = 'sha' | 'message'

export const getDiffKey = (file: GitDiffEntry) => `${file.old_file_path ?? ''}:${file.file_path}`

export const readLocalStorage = (key: string) => {
  if (typeof window === 'undefined') return null

  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export const writeLocalStorage = (key: string, value: string) => {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage can be unavailable in restricted browser contexts; keep UI state in memory.
  }
}

export const getInitialFileListMode = (): FileListMode => {
  return readLocalStorage(FILE_LIST_MODE_STORAGE_KEY) === 'tree' ? 'tree' : 'list'
}

export const getInitialDiffViewMode = (): DiffViewMode => {
  return readLocalStorage(DIFF_VIEW_MODE_STORAGE_KEY) === 'split' ? 'split' : 'unified'
}

export const getInitialFilePaneCollapsed = () => readLocalStorage(FILE_PANE_COLLAPSED_STORAGE_KEY) === 'true'

export const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

export const getInitialPaneWidth = (key: string, fallback: number, min: number, max: number) => {
  const stored = Number(readLocalStorage(key))
  return Number.isFinite(stored) && stored > 0 ? clamp(stored, min, max) : fallback
}
