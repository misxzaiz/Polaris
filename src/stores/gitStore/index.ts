/**
 * Git Store —— 宿主最小状态层（P0 瘦身后的过渡形态）
 *
 * 内置 Git 面板已迁移到 polaris-git 插件，插件使用自己的 repoStore。
 * 这里只保留宿主其余 UI 仍在消费的最小面：
 *   - FileExplorer/GitStatusIndicator → status
 *   - Layout/CenterStage（diff tab 恢复）→ getDiffs
 *   - App.tsx → initGitStatusWatcher
 *
 * 其余 slice / subscriber 及其测试已在 P0 删除；本文件与
 * statusSlice / fileWatcherSubscriber / types 将在 P1 整体外迁到插件后移除。
 */

import { create } from 'zustand'
import type { GitState } from './types'
import { createStatusSlice } from './statusSlice'

export const useGitStore = create<GitState>()((...a) => ({
  ...createStatusSlice(...a),
}))

export type { GitState, StatusState, StatusActions } from './types'
export { parseGitError } from './types'
