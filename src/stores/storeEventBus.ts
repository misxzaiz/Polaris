/**
 * Store 间类型安全事件总线
 *
 * 用于跨 Store 域通信，替代直接 import 其他 Store。
 * 仅用于跨域通信，域内保持直接调用。
 *
 * 使用方式：
 *   // 发布事件
 *   storeEventBus.emit('WORKSPACE_CHANGED', { workspaceId: '...' })
 *
 *   // 订阅事件
 *   const unsub = storeEventBus.on('WORKSPACE_CHANGED', (payload) => { ... })
 *   // 清理时调用 unsub()
 */

type Listener<T = unknown> = (payload: T) => void

// ============================================================================
// 事件类型定义
// ============================================================================

/** 工作区变更事件 */
export interface WorkspaceChangedPayload {
  workspaceId: string
  action: 'switched' | 'added' | 'removed'
}

/** 会话配置变更事件 */
export interface SessionConfigChangedPayload {
  sessionId: string
  field: 'agent' | 'model' | 'effort' | 'permission'
  value: string
}

/** 文件保存事件 */
export interface FileSavedPayload {
  filePath: string
  content: string
}

/** Git 状态变更事件 */
export interface GitStatusChangedPayload {
  workDir: string
  hasChanges: boolean
}

/** Toast 请求事件（用于替代直接 import toastStore） */
export interface ToastRequestedPayload {
  message: string
  type: 'info' | 'success' | 'warning' | 'error'
  duration?: number
}

/** Tab 切换事件 */
export interface TabSwitchedPayload {
  tabId: string
  filePath?: string
}

/** 事件注册表 — 所有跨 Store 事件必须在此声明 */
export interface StoreEventMap {
  WORKSPACE_CHANGED: WorkspaceChangedPayload
  SESSION_CONFIG_CHANGED: SessionConfigChangedPayload
  FILE_SAVED: FileSavedPayload
  GIT_STATUS_CHANGED: GitStatusChangedPayload
  TOAST_REQUESTED: ToastRequestedPayload
  TAB_SWITCHED: TabSwitchedPayload
}

// ============================================================================
// EventBus 实现
// ============================================================================

type EventKey = keyof StoreEventMap

class StoreEventBus {
  private listeners = new Map<EventKey, Set<Listener>>()

  /** 订阅事件，返回取消订阅函数 */
  on<K extends EventKey>(event: K, listener: Listener<StoreEventMap[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    const set = this.listeners.get(event)
    if (set) {
      set.add(listener as Listener)
    }

    return () => {
      const s = this.listeners.get(event)
      if (s) {
        s.delete(listener as Listener)
        if (s.size === 0) {
          this.listeners.delete(event)
        }
      }
    }
  }

  /** 发布事件 */
  emit<K extends EventKey>(event: K, payload: StoreEventMap[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of set) {
      try {
        listener(payload)
      } catch (err) {
        console.error(`[StoreEventBus] Error in listener for "${event}":`, err)
      }
    }
  }

  /** 移除指定事件的所有监听器 */
  removeAllListeners(event?: EventKey): void {
    if (event) {
      this.listeners.delete(event)
    } else {
      this.listeners.clear()
    }
  }
}

/** 全局 Store 事件总线单例 */
export const storeEventBus = new StoreEventBus()
