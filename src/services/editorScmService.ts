/**
 * 编辑器 SCM 数据服务（H3）
 *
 * 为编辑器集成（gutter / inline diff / blame hover / change navigator）提供
 * 当前打开文件的变更信息。数据源是插件注册的 `EditorScmProvider`（插件内部
 * 自行访问自己的服务）—— 宿主不再内置任何 SCM 引擎，也不再直连 Git 命令。
 *
 * 所有函数纯异步、无 zustand 依赖，供 CM6 ViewPlugin 直接调用；provider 缺失
 * 时统一返回 null / 无变更，编辑器静默降级（不报错、不留残影）。
 */

import { computeDiff, type FileDiff } from '@/services/diffService'
import {
  getEditorScmProvider,
  type ScmBlameLine,
  type ScmBlameResult,
  type ScmStatusSnapshot,
} from '@/plugin-system/editorScmProvider'

/** 文件在 SCM 中的变更级别 */
export type FileScmChangeLevel = 'unchanged' | 'modified' | 'added' | 'deleted'

/** 当前编辑器文件的 SCM 上下文（gutter / blame / 导航共用） */
export interface ScmFileContext {
  /** 编辑器当前打开文件的绝对路径 */
  filePath?: string
  /** 工作区绝对路径 */
  workspacePath?: string
}

/** 文件级变更概要（编辑器 gutter 用） */
export interface FileScmState {
  /** 工作区变更级别 */
  worktreeLevel: FileScmChangeLevel
  /** 暂存区变更级别 */
  indexLevel: FileScmChangeLevel
  /** 工作区 diff 的逐行信息 */
  worktreeDiff: FileDiff | null
  /** 暂存区 diff 的逐行信息 */
  indexDiff: FileDiff | null
  /** 是否在 SCM 仓库内 */
  inRepo: boolean
  /** 当前分支 */
  branch?: string
}

/** 工作区扫描缓存：key = workspacePath，避免编辑器每次打开文件都全量取状态 */
const workspaceStatusCache = new Map<string, ScmStatusSnapshot>()
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
 * 获取工作区 SCM 状态（带短 TTL 缓存）。
 * provider 未注册 → null（编辑器不渲染任何变更装饰）。
 */
export async function getWorkspaceScmStatus(
  workspacePath: string,
): Promise<ScmStatusSnapshot | null> {
  const provider = getEditorScmProvider()
  if (!provider) return null

  const now = Date.now()
  const lastTs = statusCacheTimestamps.get(workspacePath)
  if (lastTs != null && now - lastTs < STATUS_TTL_MS) {
    return workspaceStatusCache.get(workspacePath) ?? null
  }

  try {
    const status = await provider.getStatus(workspacePath)
    if (!status) {
      workspaceStatusCache.delete(workspacePath)
      statusCacheTimestamps.delete(workspacePath)
      return null
    }
    workspaceStatusCache.set(workspacePath, status)
    statusCacheTimestamps.set(workspacePath, now)
    return status
  } catch {
    workspaceStatusCache.delete(workspacePath)
    statusCacheTimestamps.delete(workspacePath)
    return null
  }
}

/**
 * 取当前文件的变更状态与逐行 diff。
 *
 * @param filePath 绝对路径
 * @param workspacePath 工作区绝对路径
 * @param currentContent 编辑器当前内容（用于计算"未保存的文档 vs 磁盘工作树"的 diff）
 */
export async function getFileScmState(
  filePath: string,
  workspacePath: string,
  currentContent?: string,
): Promise<FileScmState> {
  const provider = getEditorScmProvider()
  const empty: FileScmState = {
    worktreeLevel: 'unchanged',
    indexLevel: 'unchanged',
    worktreeDiff: null,
    indexDiff: null,
    inRepo: false,
  }
  if (!provider) return empty

  const status = await getWorkspaceScmStatus(workspacePath)
  if (!status || !status.exists) return empty

  const relPath = relativeToWorkspace(filePath, workspacePath) ?? filePath
  const inStatus = (list: Array<{ path: string }>) => list.some((item) => item.path === relPath)

  const unstaged = inStatus(status.unstaged)
  const staged = inStatus(status.staged)
  const untracked = status.untracked.includes(relPath)

  let worktreeLevel: FileScmChangeLevel = 'unchanged'
  let indexLevel: FileScmChangeLevel = 'unchanged'

  if (untracked) worktreeLevel = 'added'
  else if (unstaged) worktreeLevel = 'modified'
  if (staged) indexLevel = 'modified'

  let worktreeDiff: FileDiff | null = null
  let indexDiff: FileDiff | null = null

  if (worktreeLevel !== 'unchanged' || indexLevel !== 'unchanged') {
    const [wtEntry, idxEntry] = await Promise.all([
      worktreeLevel !== 'unchanged'
        ? provider.getFileDiff(workspacePath, relPath, 'worktree').catch(() => null)
        : Promise.resolve(null),
      indexLevel !== 'unchanged'
        ? provider.getFileDiff(workspacePath, relPath, 'index').catch(() => null)
        : Promise.resolve(null),
    ])

    // 优先级：工作区 diff 优先（反映未保存内容）；若编辑器内容与磁盘不同，
    // 使用当前内容重新计算 vs provider 返回的 old_content
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
const blameCache = new Map<string, { result: ScmBlameResult; fetchedAt: number }>()
const BLAME_TTL_MS = 60000

/**
 * 获取文件的 blame 信息（带 60s 缓存）。
 */
export async function getFileBlame(
  filePath: string,
  workspacePath: string,
): Promise<ScmBlameResult | null> {
  const provider = getEditorScmProvider()
  if (!provider) return null

  const cached = blameCache.get(filePath)
  if (cached && Date.now() - cached.fetchedAt < BLAME_TTL_MS) {
    return cached.result
  }

  const relPath = relativeToWorkspace(filePath, workspacePath) ?? filePath
  try {
    const result = await provider.getBlame(workspacePath, relPath)
    if (!result) return null
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
): Promise<ScmBlameLine | null> {
  const result = await getFileBlame(filePath, workspacePath)
  if (!result) return null
  return result.lines.find((line) => line.lineNumber === lineNumber) ?? null
}

/** 清除文件级缓存（SCM 操作后调用） */
export function clearEditorScmCache(filePath?: string): void {
  if (filePath) {
    blameCache.delete(filePath)
  } else {
    blameCache.clear()
    workspaceStatusCache.clear()
    statusCacheTimestamps.clear()
  }
}
