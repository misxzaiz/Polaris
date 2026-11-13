/**
 * 会话宿主 API（plans/session-history-plugin-prd.md P0）
 *
 * 插件面板经 `window.__POLARIS_SESSION_API__` 恢复历史会话 / 创建分支。
 * 内部委托 sessionRestore（宿主保留的恢复核心，与 v2-kernel RecoveryCapability
 * 同源）；不暴露 sessionStoreManager 句柄（最小面）。
 *
 * 纪律（对齐 hostWorkspaceApi）：
 * - 所有变更委托宿主既有链路执行（恢复入多窗口、Fork 建新会话）；
 * - 只允许动作调用，不允许读取宿主内部 store；
 * - conversationId 的存在性由调用方先经 cap.history（query / archive_page）
 *   证实——本 API 不做二次校验（恢复链路自身对空消息已有失败兜底）。
 */

import { forkSession, restoreFromHistory } from '@/services/sessionRestore'
import { createLogger } from '@/utils/logger'

const log = createLogger('PluginSessionHostApi')

/** 插件可见的会话宿主 API（按插件实例化，便于审计与卸载隔离） */
export interface PluginSessionHostApi {
  /**
   * 恢复历史会话到本端窗口（等价内置面板「继续」全链路：
   * 加载消息 → createSessionFromHistory → kernel.resyncSession → 入多窗口）。
   * @returns 新会话 id；失败返回 null
   */
  restore(conversationId: string, opts?: {
    engineId?: string
    projectPath?: string
    claudeProjectName?: string
    title?: string
  }): Promise<string | null>
  /**
   * 从历史会话创建分支（等价内置面板 Fork）。
   * @returns 新会话 id；失败返回 null
   */
  fork(conversationId: string, opts?: {
    engineId?: string
    projectPath?: string
    claudeProjectName?: string
    branchName?: string
  }): Promise<string | null>
}

export function createHostSessionApi(pluginId = '<host>'): PluginSessionHostApi {
  return {
    async restore(conversationId, opts) {
      if (!conversationId) return null
      log.info('插件恢复会话', { pluginId, conversationId })
      return restoreFromHistory(
        conversationId,
        opts?.engineId,
        opts?.projectPath,
        opts?.claudeProjectName,
        opts?.title,
      )
    },
    async fork(conversationId, opts) {
      if (!conversationId) return null
      log.info('插件创建分支', { pluginId, conversationId, branchName: opts?.branchName })
      return forkSession(
        conversationId,
        opts?.engineId,
        opts?.projectPath,
        opts?.claudeProjectName,
        opts?.branchName,
      )
    },
  }
}
