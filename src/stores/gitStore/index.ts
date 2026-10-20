/**
 * Git Store
 *
 * Git 操作的状态管理，基于 Zustand slice 模式组织代码
 *
 * 架构说明：
 * - 将大型 store 拆分为多个职责单一的 slice
 * - 每个 slice 负责特定的 Git 操作领域
 *
 * Slice 结构：
 * - statusSlice: 状态数据和 Diff 操作
 * - branchSlice: 分支管理
 * - remoteSlice: 远程仓库操作
 * - tagSlice: 标签管理
 * - commitSlice: 提交和暂存
 * - stashSlice: Stash 操作
 * - advancedSlice: Cherry-pick 和 Revert
 * - prSlice: Pull Request 操作
 * - gitignoreSlice: .gitignore 管理
 * - utilitySlice: 工具方法
 */

import { create } from 'zustand'
import type { GitState } from './types'
import { createStatusSlice } from './statusSlice'
import { createBranchSlice } from './branchSlice'
import { createRemoteSlice } from './remoteSlice'
import { createTagSlice } from './tagSlice'
import { createCommitSlice } from './commitSlice'
import { createStashSlice } from './stashSlice'
import { createAdvancedSlice } from './advancedSlice'
import { createPRSlice } from './prSlice'
import { createGitignoreSlice } from './gitignoreSlice'
import { createUtilitySlice } from './utilitySlice'

/**
 * Git Store
 *
 * 组合所有 slice 创建统一的 store
 */
export const useGitStore = create<GitState>()((...a) => ({
  ...createStatusSlice(...a),
  ...createBranchSlice(...a),
  ...createRemoteSlice(...a),
  ...createTagSlice(...a),
  ...createCommitSlice(...a),
  ...createStashSlice(...a),
  ...createAdvancedSlice(...a),
  ...createPRSlice(...a),
  ...createGitignoreSlice(...a),
  ...createUtilitySlice(...a),
}))

// 导出类型
export type {
  GitState,
  StatusState,
  StatusActions,
  BranchState,
  BranchActions,
  RemoteState,
  RemoteActions,
  TagState,
  TagActions,
  CommitState,
  CommitActions,
  StashState,
  StashActions,
  AdvancedActions,
  PRState,
  PRActions,
  GitignoreActions,
  UtilityActions,
} from './types'

// 导出工具函数
export { parseGitError } from './types'
