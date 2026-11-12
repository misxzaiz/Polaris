/**
 * Git 相关类型 —— P1 瘦身后只保留宿主通用资产仍在消费的最小集。
 *
 * 归属说明（Git 域已整体出仓，架构方案 C）：
 * - `GitDiffEntry` / `DiffChangeType`：宿主通用 Diff 渲染（components/Diff）、
 *   diff tab（tabStore）消费；
 * - `GitFileStatus` / `GitFileChange` / `GitRepositoryStatus`：`gitEditorService`
 *   在 P2 编辑器扩展外迁前仍作为数据契约；
 * - `GitBlameLine` / `GitBlameResult`：同上（blame 悬浮）。
 *
 * 其余 Git 业务类型（提交/分支/远程/标签/Stash/PR/变基/冲突/Undo/操作流水）
 * 已随宿主 Git 后端与面板一并移除，由 polaris-git 插件自有类型承接。
 */

/**
 * Git 文件状态
 */
export type GitFileStatus =
  | 'untracked'     // 未跟踪
  | 'modified'       // 已修改
  | 'added'          // 已添加到暂存区
  | 'deleted'        // 已删除
  | 'renamed'        // 已重命名
  | 'copied'         // 已复制
  | 'unmerged'       // 未合并（冲突）

/**
 * Git 文件变更
 */
export interface GitFileChange {
  path: string          // 文件路径
  status: GitFileStatus // 状态
  oldPath?: string      // 重命名前的路径
  additions?: number    // 新增行数
  deletions?: number    // 删除行数
}

/**
 * Git 仓库状态
 */
export interface GitRepositoryStatus {
  exists: boolean                // 是否为 Git 仓库
  branch: string                 // 当前分支
  commit: string                 // 当前 commit SHA (完整)
  shortCommit: string            // 短 SHA (前8位)
  ahead: number                  // 领先提交数
  behind: number                 // 落后提交数
  staged: GitFileChange[]        // 已暂存变更
  unstaged: GitFileChange[]      // 未暂存变更
  untracked: string[]            // 未跟踪文件
  conflicted: string[]           // 冲突文件
  isEmpty: boolean               // 是否为空仓库
}

/**
 * Git Diff 变更类型
 */
export type DiffChangeType = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied'

/**
 * Git Diff 条目
 */
export interface GitDiffEntry {
  file_path: string
  old_file_path?: string
  change_type: DiffChangeType
  old_content?: string
  new_content?: string
  additions?: number
  deletions?: number
  is_binary: boolean
  content_omitted?: boolean  // 内容过大被省略
  status_hint?: {            // 状态冲突提示
    has_conflict: boolean
    message?: string
    current_view: string
  }
}

/**
 * Git Blame 单行信息
 */
export interface GitBlameLine {
  /** 行号（从 1 开始） */
  lineNumber: number
  /** 该行在原提交中的行号 */
  originalLineNumber: number
  /** 提交 SHA */
  commitSha: string
  /** 短 SHA */
  shortSha: string
  /** 作者名称 */
  author: string
  /** 作者邮箱 */
  authorEmail: string
  /** 提交时间（Unix 时间戳） */
  timestamp: number
  /** 提交消息（第一行） */
  summary?: string
  /** 文件内容 */
  content: string
}

/**
 * Git Blame 结果
 */
export interface GitBlameResult {
  /** 文件路径 */
  filePath: string
  /** Blame 行信息列表 */
  lines: GitBlameLine[]
  /** 总行数 */
  totalLines: number
}
