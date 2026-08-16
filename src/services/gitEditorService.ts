/**
 * Git 编辑器数据服务
 *
 * 为编辑器集成（gutter / inline diff / blame hover / change navigator）提供
 * 当前打开文件在 Git 工作树中的变更信息。数据源是后端 git2 的
 * `git_get_worktree_file_diff` / `git_get_index_file_diff` / `git_get_status` / `git_blame_file`。
 *
 * 所有函数纯异步、无 zustand 依赖，供 CM6 ViewPlugin 直接调用。
 */

import { invoke } from '@/services/transport'
import { computeDiff, type FileDiff } from '@/services/diffService'
import type {
  GitBlameLine,
  GitBlameResult,
  GitDiffEntry,
  GitRepositoryStatus,
} from '@/types/git'

/** 文件在 git 中的变更级别 */
export type FileGitChangeLevel = 'unchanged' | 'modified' | 'added' | 'deleted'

/** 当前编辑器文件的 git 上下文（gutter / blame / 导航共用） */
export interface GitFileContext {
  /** 编辑器当前打开文件的绝对路径 */
  filePath?: string
  /** 工作区绝对路径（git 仓库根） */
  workspacePath?: string
}

/** 文件级 git 变更概要（编辑器 gutter 用） */
export interface FileGitState {
  /** 相对仓库根的工作区变更级别 */
  worktreeLevel: FileGitChangeLevel
  /** 相对仓库根的暂存变更级别 */
  indexLevel: FileGitChangeLevel
  /** 工作区 diff（vs worktree）的逐行信息 */
  worktreeDiff: FileDiff | null
  /** 暂存 diff（vs index/HEAD）的逐行信息 */
  indexDiff: FileDiff | null
  /** 是否在 git 仓库内 */
  inRepo: boolean
  /** 当前分支 */
  branch?: string
}

/** 工作区扫描缓存：key = workspacePath，避免编辑器每次打开文件都全量 status */
const workspaceStatusCache = new Map<string, GitRepositoryStatus>()
const statusCacheTimestamps = new Map<string, number>()
const STATUS_TTL_MS = 1500

/**
 * 判断文件路径是否位于某工作区内，返回相对路径。
 */
export function relativeToWorkspace(filePath: string, workspacePath: string): string | null {
  const normalizedFile = filePath.replace(/\\/g, '/')
  const normalizedWs = workspacePath.replace(/\\/g, '/').replace(/\/$/, '')
  if (!normalizedFile.startsWith(normalizedWs + '/')) {
    return null
  }
  return normalizedFile.slice(normalizedWs.length + 1)
}

/**
 * 获取工作区 git 状态（带短 TTL 缓存）。
 */
export async function getWorkspaceGitStatus(workspacePath: string): Promise<GitRepositoryStatus | null> {
  const now = Date.now()
  const lastTs = statusCacheTimestamps.get(workspacePath)
  if (lastTs != null && now - lastTs < STATUS_TTL_MS) {
    return workspaceStatusCache.get(workspacePath) ?? null
  }

  try {
    const status = await invoke<GitRepositoryStatus>('git_get_status', { workspacePath })
    workspaceStatusCache.set(workspacePath, status)
    statusCacheTimestamps.set(workspacePath, now)
    return status
  } catch (err) {
    workspaceStatusCache.delete(workspacePath)
    statusCacheTimestamps.delete(workspacePath)
    return null
  }
}

/**
 * 取当前文件在 git 中的变更状态与逐行 diff。
 *
 * @param filePath 绝对路径
 * @param workspacePath 工作区绝对路径
 * @param currentContent 编辑器当前内容（用于计算"未保存的文档 vs git 工作树"的 diff）
 */
export async function getFileGitState(
  filePath: string,
  workspacePath: string,
  currentContent?: string,
): Promise<FileGitState> {
  const status = await getWorkspaceGitStatus(workspacePath)
  if (!status || !status.exists) {
    return {
      worktreeLevel: 'unchanged',
      indexLevel: 'unchanged',
      worktreeDiff: null,
      indexDiff: null,
      inRepo: false,
    }
  }

  const relPath = relativeToWorkspace(filePath, workspacePath) ?? filePath
  const inStatus = (list: Array<{ path: string }>) =>
    list.some((item) => item.path === relPath)

  const unstaged = inStatus(status.unstaged)
  const staged = inStatus(status.staged)
  const untracked = status.untracked.includes(relPath)

  let worktreeLevel: FileGitChangeLevel = 'unchanged'
  let indexLevel: FileGitChangeLevel = 'unchanged'

  if (untracked) worktreeLevel = 'added'
  else if (unstaged) worktreeLevel = 'modified'
  if (staged) indexLevel = 'modified'

  // 拉逐行 diff
  let worktreeDiff: FileDiff | null = null
  let indexDiff: FileDiff | null = null

  if (worktreeLevel !== 'unchanged' || indexLevel !== 'unchanged') {
    const [wtEntry, idxEntry] = await Promise.all([
      worktreeLevel !== 'unchanged'
        ? invoke<GitDiffEntry>('git_get_worktree_file_diff', { workspacePath, filePath: relPath })
            .catch(() => null)
        : Promise.resolve(null),
      indexLevel !== 'unchanged'
        ? invoke<GitDiffEntry>('git_get_index_file_diff', { workspacePath, filePath: relPath })
            .catch(() => null)
        : Promise.resolve(null),
    ])

    // 优先级：工作区 diff 优先（反映未保存内容）；若编辑器内容与磁盘不同，
    // 使用当前内容重新计算 vs 后端返回的 old_content
    if (wtEntry && wtEntry.new_content != null) {
      const oldContent = wtEntry.old_content ?? ''
      if (currentContent != null && currentContent !== wtEntry.new_content) {
        worktreeDiff = computeDiff(oldContent, currentContent)
      } else {
        worktreeDiff = computeDiff(oldContent, wtEntry.new_content)
      }
    }
    if (idxEntry && idxEntry.new_content != null) {
      const oldContent = idxEntry.old_content ?? ''
      indexDiff = computeDiff(oldContent, idxEntry.new_content)
    }
  }

  return {
    worktreeLevel,
    indexLevel,
    worktreeDiff,
    indexDiff,
    inRepo: true,
    branch: status.branch,
  }
}

/** blame 缓存：key = filePath，避免频繁切换文件重复拉取 */
const blameCache = new Map<string, { result: GitBlameResult; fetchedAt: number }>()
const BLAME_TTL_MS = 60000

/**
 * 获取文件的 blame 信息（带 60s 缓存）。
 */
export async function getFileBlame(filePath: string, workspacePath: string): Promise<GitBlameResult | null> {
  const cached = blameCache.get(filePath)
  if (cached && Date.now() - cached.fetchedAt < BLAME_TTL_MS) {
    return cached.result
  }

  const relPath = relativeToWorkspace(filePath, workspacePath) ?? filePath
  try {
    const result = await invoke<GitBlameResult>('git_blame_file', {
      workspacePath,
      filePath: relPath,
    })
    blameCache.set(filePath, { result, fetchedAt: Date.now() })
    return result
  } catch {
    return null
  }
}

/**
 * 取某一行的 blame 信息（从缓存结果中按行号匹配）。
 */
export async function getBlameForLine(
  filePath: string,
  workspacePath: string,
  lineNumber: number,
): Promise<GitBlameLine | null> {
  const result = await getFileBlame(filePath, workspacePath)
  if (!result) return null
  return result.lines.find((line) => line.lineNumber === lineNumber) ?? null
}

/** 清除文件级缓存（git 操作后调用） */
export function clearGitEditorCache(filePath?: string): void {
  if (filePath) {
    blameCache.delete(filePath)
  } else {
    blameCache.clear()
    workspaceStatusCache.clear()
    statusCacheTimestamps.clear()
  }
}