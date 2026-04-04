/**
 * 依赖注入 Slice
 *
 * 负责管理外部依赖注入，解耦 Store 间的直接依赖
 *
 * 使用方式：
 * 1. 在应用初始化时调用 setDependencies() 注入依赖
 * 2. 在 slice 中通过 get()._dependencies 或 getToolPanelActions() 等方法访问依赖
 */

import type { StateCreator } from 'zustand'
import { createLogger } from '../../utils/logger'

const log = createLogger('EventChatStore')
import type {
  EventChatState,
  DependencyState,
  DependencyActions,
  ExternalDependencies,
  ToolPanelActions,
  GitActions,
  ConfigActions,
  WorkspaceActions,
  SessionSyncActions,
} from './types'

/**
 * 创建依赖注入 Slice
 */
export const createDependencySlice: StateCreator<
  EventChatState,
  [],
  [],
  DependencyState & DependencyActions
> = (set, get) => ({
  // ===== 状态 =====
  _dependencies: null,

  // ===== 方法 =====

  setDependencies: (deps: ExternalDependencies) => {
    set({ _dependencies: deps })
    log.debug('依赖注入完成', { keys: Object.keys(deps) })
  },

  getToolPanelActions: (): ToolPanelActions | undefined => {
    return get()._dependencies?.toolPanelActions
  },

  getGitActions: (): GitActions | undefined => {
    return get()._dependencies?.gitActions
  },

  getConfigActions: (): ConfigActions | undefined => {
    return get()._dependencies?.configActions
  },

  getWorkspaceActions: (): WorkspaceActions | undefined => {
    return get()._dependencies?.workspaceActions
  },

  getSessionSyncActions: (): SessionSyncActions | undefined => {
    return get()._dependencies?.sessionSyncActions
  },
})
