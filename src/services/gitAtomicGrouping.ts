/**
 * AI-2 原子提交 · 本地分组预检（纯函数，无 IO）
 *
 * master-plan C12 / §1.2 降格形态：确定性本地启发式先行（目录聚类 + change_type），
 * AI 只解释置信低项。本模块只做「分组」这个确定性骨架，不碰 AI。
 *
 * 输入：统一视角的变更清单（worktree + index 合并去重）。
 * 输出：AtomicCommitGroup[] —— 每组 = 文件集 + 拟 message + 理由 + 置信度。
 *
 * 分组规则（文档化，spec §2.1）：
 * 1. 目录聚类优先：按 dirname 聚类，同目录文件归一组。
 * 2. change_type 判别：同目录内 change_type 不纯时按 change_type 拆分子组。
 * 3. 「不适合拆分」预检：跨目录多 hunk → confidence:'low' 合并组候选（AI 解释层处理）。
 * 4. 单文件孤目录 → confidence:'high'，message 按 change_type 生成。
 */

import type { GitFileChange, GitFileStatus } from '@/types/git'

/** 统一变更条目：合并 worktree + index 双视角为单文件变更 */
export interface AtomicChangeFile {
  path: string
  changeType: GitFileStatus
  fromWorktree: boolean
  fromIndex: boolean
}

/** 单组原子提交方案 */
export interface AtomicCommitGroup {
  /** 稳定组 id（排序后文件集 hash，用于 React key / 回流锚点） */
  id: string
  /** 拟提交信息（Conventional Commits；本地启发式生成，AI 可解释层改写） */
  message: string
  /** 组内文件 */
  files: AtomicChangeFile[]
  /** 分组理由（目录聚类 / change_type / 不适合拆分） */
  reason: string
  /** 高置信（确定性判定直接可提交）| 低置信（需 AI 解释） */
  confidence: 'high' | 'low'
  /** 主导 change_type */
  changeType: GitFileStatus
  /** 主导目录（相对仓库根；'' 表示根目录） */
  dir: string
}

/** 归一化路径分隔符为 '/' */
function normPath(p: string): string {
  return p.replace(/\\/g, '/')
}

/** 目录名（相对仓库根；根目录文件返回 ''） */
export function dirnameOf(path: string): string {
  const norm = normPath(path)
  const idx = norm.lastIndexOf('/')
  return idx < 0 ? '' : norm.slice(0, idx)
}

/**
 * 合并 worktree + index 为统一变更清单。
 * 同 path 双视角：取高优先级 change_type（renamed > added > modified > deleted > untracked）。
 * index 视图优先（暂存态更能代表语义意图；worktree 只补 index 缺失的文件）。
 */
export function mergeChangeViews(
  index: GitFileChange[],
  worktree: GitFileChange[],
  untracked: string[],
): AtomicChangeFile[] {
  const byPath = new Map<string, AtomicChangeFile>()

  const PRIORITY: Record<GitFileStatus, number> = {
    renamed: 6,
    copied: 5,
    added: 4,
    modified: 3,
    deleted: 2,
    untracked: 1,
    unmerged: 7,
  }

  const upsert = (
    path: string,
    changeType: GitFileStatus,
    view: 'index' | 'worktree',
  ) => {
    const key = normPath(path)
    const existing = byPath.get(key)
    if (!existing) {
      byPath.set(key, {
        path: key,
        changeType,
        fromWorktree: view === 'worktree',
        fromIndex: view === 'index',
      })
      return
    }
    // 合并视角：index 视图优先于 worktree；change_type 取更高优先级
    existing.fromIndex = existing.fromIndex || view === 'index'
    existing.fromWorktree = existing.fromWorktree || view === 'worktree'
    if (PRIORITY[changeType] > PRIORITY[existing.changeType]) {
      existing.changeType = changeType
    }
  }

  for (const f of index) upsert(f.path, f.status, 'index')
  for (const f of worktree) upsert(f.path, f.status, 'worktree')
  for (const p of untracked) upsert(p, 'untracked', 'worktree')

  return Array.from(byPath.values())
}

/** change_type → Conventional Commits type */
function typeFor(changeType: GitFileStatus): string {
  switch (changeType) {
    case 'added': return 'feat'
    case 'deleted': return 'refactor'
    case 'renamed': return 'refactor'
    case 'copied': return 'feat'
    case 'untracked': return 'feat'
    case 'unmerged': return 'fix'
    default: return 'fix'
  }
}

/** 目录段 → scope（取末段；'' 视为 'root'） */
function scopeFor(dir: string): string {
  const norm = dir.replace(/^\/+/, '')
  if (!norm) return 'root'
  const last = norm.split('/').pop() || 'root'
  return last.toLowerCase()
}

/** change_type → 中文短语 */
function phraseFor(changeType: GitFileStatus, count: number): string {
  switch (changeType) {
    case 'added': return `新增 ${count} 个文件`
    case 'deleted': return `删除 ${count} 个文件`
    case 'renamed': return `重命名 ${count} 个文件`
    case 'copied': return `复制 ${count} 个文件`
    case 'untracked': return `纳入 ${count} 个新文件`
    case 'unmerged': return `解决 ${count} 个冲突文件`
    default: return `更新 ${count} 个文件`
  }
}

/** 稳定组 id：排序后文件集 join 的短 hash（djb2） */
function groupId(paths: string[]): string {
  const sorted = paths.join('\x00')
  let h = 5381
  for (let i = 0; i < sorted.length; i++) {
    h = ((h << 5) + h + sorted.charCodeAt(i)) >>> 0
  }
  return `g${(h >>> 0).toString(36)}`
}

/**
 * 本地分组预检（纯函数）。
 *
 * 策略：目录聚类为主；同目录 change_type 不纯则按 change_type 拆分；
 * 跨目录文件聚成「低置信合并组」（不应硬拆，交由 AI 解释层或用户决定）。
 */
export function groupChangesForAtomicCommit(
  changes: AtomicChangeFile[],
  opts?: { minFilesPerGroup?: number },
): AtomicCommitGroup[] {
  if (changes.length === 0) return []

  const min = opts?.minFilesPerGroup ?? 1

  // 按目录聚类
  const byDir = new Map<string, AtomicChangeFile[]>()
  for (const c of changes) {
    const dir = dirnameOf(c.path)
    const arr = byDir.get(dir) ?? []
    arr.push(c)
    byDir.set(dir, arr)
  }

  const groups: AtomicCommitGroup[] = []

  for (const [dir, files] of byDir) {
    // 目录内 change_type 不纯 → 按 change_type 拆分子组
    const byType = new Map<GitFileStatus, AtomicChangeFile[]>()
    for (const f of files) {
      const arr = byType.get(f.changeType) ?? []
      arr.push(f)
      byType.set(f.changeType, arr)
    }

    if (byType.size === 1) {
      const sub = (byType.values().next().value as AtomicChangeFile[]) ?? files
      groups.push(makeGroup(dir, sub, 'directory-cluster'))
      continue
    }

    // 不纯：每个 change_type 独立成组（高低置信以冲突与否区分）
    for (const [ct, sub] of byType) {
      if (sub.length >= min) {
        groups.push(makeGroup(dir, sub, `change-type:${ct}`))
      }
    }
  }

  // 目录聚类后的单文件组若孤立（唯一目录 + 单文件）→ 已是 high；无需额外处理。
  // 跨目录多 hunk 的「不适合拆分」预检：若变化文件分散在 >2 目录且总数 ≥6，
  // 追加一个低置信「合并组」候选（用户可整包提交或走后 AI 解释）。
  const distinctDirs = byDir.size
  if (distinctDirs > 2 && changes.length >= 6) {
    groups.push({
      id: groupId(changes.map((c) => c.path)),
      message: 'chore: 通读后再拆分',
      files: [...changes],
      reason: '跨目录多 hunk 改动，建议人工复核后按语义拆分',
      confidence: 'low',
      changeType: 'modified',
      dir: '',
    })
  }

  return groups
}

function makeGroup(
  dir: string,
  files: AtomicChangeFile[],
  reason: string,
): AtomicCommitGroup {
  const paths = files.map((f) => f.path)
  // 主导 change_type：取组内出现最多者
  const typeCount = new Map<GitFileStatus, number>()
  for (const f of files) {
    typeCount.set(f.changeType, (typeCount.get(f.changeType) ?? 0) + 1)
  }
  const dominant = [...typeCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'modified'

  // 置信判定：目录聚类 / change_type 拆分都是确定性计算 → high。
  // low 只在调用方显式构造的「跨目录不适合拆分」候选组出现（groupChangesForAtomicCommit 尾部）。
  const confidence: 'high' | 'low' = 'high'

  const type = typeFor(dominant)
  const scope = scopeFor(dir)
  const phrase = phraseFor(dominant, files.length)
  const message = ` ${type}(${scope}): ${phrase}`

  return {
    id: groupId(paths),
    message: message.trim(),
    files,
    reason: reason === 'directory-cluster'
      ? `目录聚类：${dir || '(根)'}`
      : `change_type 拆分：${dominant}`,
    confidence,
    changeType: dominant,
    dir,
  }
}