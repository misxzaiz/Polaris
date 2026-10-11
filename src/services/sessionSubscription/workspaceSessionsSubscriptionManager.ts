/**
 * WorkspaceSessionsSubscriptionManager（S3 · 订阅生命周期管理）
 *
 * 集中管理各 workspace 桶的会话索引订阅（WorkspaceSessionsSubscription）：
 * - 初始化：启动当前活跃 workspace（含 free 桶）的订阅
 * - workspace 切换：停旧桶订阅 → 启新桶订阅
 * - workspace 新增：启动其订阅
 * - workspace 删除：停止其订阅
 *
 * 接线点：
 * - useAppInit（应用启动后调用 init()）
 * - workspaceStore.switchWorkspace（切换时由 subscribe 回调触发）
 *
 * 对齐 ZCode：activeWorkspace 变化时 reconcile desired set（此处聚焦单活跃桶，
 * 每个 workspace 有独立订阅，但仅活跃桶的订阅运行——后台桶由拉取快照保底）。
 */

import { WorkspaceSessionsSubscription } from './workspaceSessionsSubscription'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { workspaceSessionSlice, FREE_WORKSPACE_KEY, resolveWorkspaceKeyFromPath } from '@/stores/workspaceSession'
import { createLogger } from '@/utils/logger'

const log = createLogger('SessionSubscriptionManager')

class WorkspaceSessionsSubscriptionManager {
  /** workspaceKey → 订阅实例 */
  private subscriptions = new Map<string, WorkspaceSessionsSubscription>()
  /** 当前订阅中的活跃 workspaceKey */
  private activeWorkspaceKey: string | null = null
  private initialized = false
  /** workspaceStore 退订函数 */
  private unsubscribeWorkspaceStore: (() => void) | null = null

  /**
   * 启动订阅管理。应用初始化时调用一次。
   * - 订阅 workspaceStore 变化（新增/删除/切换）
   * - 启动当前活跃 workspace（含 free 桶）的订阅
   */
  init(): void {
    if (this.initialized) return
    this.initialized = true

    // 订阅 workspace 增删切换：维护订阅集合
    this.unsubscribeWorkspaceStore = useWorkspaceStore.subscribe((state, prevState) => {
      // workspace 切换
      if (state.currentWorkspaceId !== prevState.currentWorkspaceId) {
        this.onWorkspaceSwitched(state.currentWorkspaceId)
      }
      // workspace 新增
      if (state.workspaces.length > prevState.workspaces.length) {
        for (const ws of state.workspaces) {
          const key = resolveWorkspaceKeyFromPath(ws.path)
          if (!this.subscriptions.has(key)) {
            this.ensureSubscription(key)
          }
        }
      }
      // workspace 删除
      if (state.workspaces.length < prevState.workspaces.length) {
        const prevKeys = new Set(prevState.workspaces.map((w) => resolveWorkspaceKeyFromPath(w.path)))
        for (const ws of state.workspaces) {
          prevKeys.delete(resolveWorkspaceKeyFromPath(ws.path))
        }
        // prevKeys 剩余 = 已删除的 workspace
        for (const key of prevKeys) {
          this.stopSubscription(key)
        }
      }
    })

    // 启动当前活跃 workspace 订阅（含 free 桶）
    const activeId = useWorkspaceStore.getState().currentWorkspaceId
    this.onWorkspaceSwitched(activeId)
    log.info('会话索引订阅管理器初始化完成', { activeWorkspaceKey: this.activeWorkspaceKey })
  }

  /**
   * 应用清理时调用（卸载时）。
   */
  dispose(): void {
    if (this.unsubscribeWorkspaceStore) {
      this.unsubscribeWorkspaceStore()
      this.unsubscribeWorkspaceStore = null
    }
    for (const sub of this.subscriptions.values()) {
      sub.stop()
    }
    this.subscriptions.clear()
    this.activeWorkspaceKey = null
    this.initialized = false
    log.info('会话索引订阅管理器已清理')
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /** workspace 切换：停旧订阅、启新订阅 */
  private onWorkspaceSwitched(workspaceId: string | null | undefined): void {
    const nextKey = workspaceId
      ? resolveWorkspaceKeyFromPath(
          useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)?.path,
        )
      : FREE_WORKSPACE_KEY

    // 同步活跃 workspace 指针（桶层），保证 UI 消费读取到正确的桶
    workspaceSessionSlice.getState().setActiveWorkspace(nextKey)

    if (this.activeWorkspaceKey === nextKey) return
    if (this.activeWorkspaceKey) {
      this.pauseSubscription(this.activeWorkspaceKey)
    }
    this.ensureSubscription(nextKey)
    this.activeWorkspaceKey = nextKey
    log.info('活跃 workspace 切换', { nextKey })
  }

  /** 确保订阅存在；若为活跃桶则 start() */
  private ensureSubscription(workspaceKey: string): void {
    if (this.subscriptions.has(workspaceKey)) return
    const sub = new WorkspaceSessionsSubscription(workspaceKey)
    this.subscriptions.set(workspaceKey, sub)
    if (workspaceKey === this.activeWorkspaceKey || this.activeWorkspaceKey === null) {
      void sub.start()
    }
  }

  /** 暂停订阅（非活跃桶保底由活跃桶拉取兜底；此处直接停止以省资源） */
  private pauseSubscription(workspaceKey: string): void {
    const sub = this.subscriptions.get(workspaceKey)
    if (sub) sub.stop()
  }

  /** 停止并移除订阅（workspace 删除） */
  private stopSubscription(workspaceKey: string): void {
    const sub = this.subscriptions.get(workspaceKey)
    if (sub) sub.stop()
    this.subscriptions.delete(workspaceKey)
    if (this.activeWorkspaceKey === workspaceKey) {
      this.activeWorkspaceKey = null
    }
  }
}

/** 全局单例 */
export const workspaceSessionsSubscriptionManager = new WorkspaceSessionsSubscriptionManager()
