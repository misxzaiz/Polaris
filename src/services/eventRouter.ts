/**
 * 事件路由器
 *
 * 根据 contextId 将 chat-event 路由到正确的处理器
 * 解决多个监听者同时监听 chat-event 导致的会话混乱问题
 */

import { listen, UnlistenFn } from '@tauri-apps/api/event'

export type ContextId = 'main' | 'git-commit' | string

export interface RoutedEvent {
  contextId: ContextId
  payload: unknown
}

export type EventHandler = (payload: unknown) => void

export class EventRouter {
  private handlers: Map<ContextId, Set<EventHandler>> = new Map()
  private unlisten: UnlistenFn | null = null
  private initialized = false
  private initPromise: Promise<void> | null = null

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this.doInitialize()
    return this.initPromise
  }

  private async doInitialize(): Promise<void> {
    this.unlisten = await listen<string>('chat-event', (event) => {
      try {
        const rawPayload = event.payload
        console.log('[EventRouter] 收到原始事件类型:', typeof rawPayload, '内容:', typeof rawPayload === 'string' ? rawPayload.slice(0, 200) : JSON.stringify(rawPayload).slice(0, 200))

        // 处理不同类型的 payload
        let rawData: unknown
        if (typeof rawPayload === 'string') {
          try {
            rawData = JSON.parse(rawPayload)
          } catch {
            // 如果解析失败，直接使用原始字符串
            rawData = rawPayload
          }
        } else {
          // 已经是对象
          rawData = rawPayload
        }

        let routedEvent: RoutedEvent

        if (rawData && typeof rawData === 'object' && 'contextId' in rawData && 'payload' in rawData) {
          routedEvent = {
            contextId: (rawData as { contextId: string }).contextId,
            payload: (rawData as { payload: unknown }).payload
          }
        } else {
          routedEvent = {
            contextId: 'main',
            payload: rawData
          }
        }

        console.log('[EventRouter] 路由事件到:', routedEvent.contextId, 'payload类型:', typeof routedEvent.payload)
        this.dispatch(routedEvent)
      } catch (e) {
        console.error('[EventRouter] Failed to parse event:', e)
      }
    })

    this.initialized = true
  }

  register(contextId: ContextId, handler: EventHandler): () => void {
    // 强制单例模式：每个 contextId 只保留一个 handler
    // 这是防止 React StrictMode 导致重复注册的最可靠方式
    if (this.handlers.has(contextId)) {
      const existingHandlers = this.handlers.get(contextId)!
      if (existingHandlers.size > 0) {
        console.log('[EventRouter] contextId', contextId, '已存在 handler，清除旧 handler')
        existingHandlers.clear()
      }
    } else {
      this.handlers.set(contextId, new Set())
    }
    
    this.handlers.get(contextId)!.add(handler)
    console.log('[EventRouter] 注册 handler for', contextId)

    return () => {
      this.handlers.get(contextId)?.delete(handler)
    }
  }

  private dispatch(event: RoutedEvent): void {
    const handlers = this.handlers.get(event.contextId)
    if (handlers) {
      console.log('[EventRouter] dispatch 到', handlers.size, '个 handler')
      handlers.forEach(handler => {
        try {
          handler(event.payload)
        } catch (e) {
          console.error(`[EventRouter] Handler error for ${event.contextId}:`, e)
        }
      })
    } else {
      console.log('[EventRouter] 没有找到 handler for', event.contextId)
    }

    const wildcardHandlers = this.handlers.get('*')
    if (wildcardHandlers) {
      wildcardHandlers.forEach(handler => {
        try {
          handler(event)
        } catch (e) {
          console.error('[EventRouter] Wildcard handler error:', e)
        }
      })
    }
  }

  destroy(): void {
    if (this.unlisten) {
      this.unlisten()
      this.unlisten = null
    }
    this.handlers.clear()
    this.initialized = false
    this.initPromise = null
  }

  isInitialized(): boolean {
    return this.initialized
  }
}

let routerInstance: EventRouter | null = null

export function getEventRouter(): EventRouter {
  if (!routerInstance) {
    routerInstance = new EventRouter()
  }
  return routerInstance
}

export async function ensureEventRouterInitialized(): Promise<EventRouter> {
  const router = getEventRouter()
  await router.initialize()
  return router
}

export function createContextId(prefix: string = 'ctx'): ContextId {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}
