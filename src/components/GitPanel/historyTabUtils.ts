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

export function formatRelativeTime(timestamp: number | undefined, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!timestamp) return ''

  const date = new Date(timestamp * 1000)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return t('history.justNow')
  if (diffMins < 60) return t('history.minutesAgo', { count: diffMins })
  if (diffHours < 24) return t('history.hoursAgo', { count: diffHours })
  if (diffDays < 7) return t('history.daysAgo', { count: diffDays })
  return date.toLocaleDateString()
}

// 内联文件清单的最大高度（px）：超出后容器内部滚动，
// 避免文件多的提交把后续提交挤出视口。
export const INLINE_FILES_MAX_HEIGHT = 240

/**
 * 依据 Conventional Commits 前缀推断提交类型的强调色，
 * 用于高密度提交列表左侧的状态点。返回可直接用于内联 style 的 CSS 颜色，
 * 取自主题 CSS 变量，避免依赖 Tailwind 颜色 token 是否注册。
 */
export function getCommitTypeColor(message: string): string {
  const match = /^(\w+)(?:\([^)]*\))?!?:/.exec((message ?? '').trim())
  switch (match?.[1]?.toLowerCase()) {
    case 'feat':
      return 'rgb(var(--c-status-success))'
    case 'fix':
      return 'rgb(var(--c-status-danger))'
    case 'perf':
      return 'rgb(var(--c-accent-ai))'
    case 'refactor':
      return 'rgb(var(--c-status-info))'
    case 'docs':
      return 'rgb(var(--c-status-warning))'
    default:
      return 'rgb(var(--c-text-tertiary))'
  }
}

/**
 * 变更类型对应的徽标字母与基色 CSS 变量名。
 * 颜色经 rgb(var(--x) / a) 内联使用，背景取低透明度、文字取实色。
 */
export function getFileStatusBadge(changeType: string): { letter: string; colorVar: string } {
  switch (changeType) {
    case 'added':
      return { letter: 'A', colorVar: '--c-status-success' }
    case 'deleted':
      return { letter: 'D', colorVar: '--c-status-danger' }
    case 'renamed':
      return { letter: 'R', colorVar: '--c-status-info' }
    default:
      return { letter: 'M', colorVar: '--c-status-warning' }
  }
}
