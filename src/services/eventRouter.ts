/**
 * 事件路由器
 *
 * 根据 sessionId 将 chat-event 路由到正确的 ConversationStore
 * 支持多会话并行运行，每个会话独立接收事件
 */

import { listen, UnlistenFn } from '@tauri-apps/api/event'
import { createLogger } from '../utils/logger'
import { sessionStoreManager } from '../stores/conversationStore'
import type { AIEvent } from '../ai-runtime'

const log = createLogger('EventRouter')

export type ContextId = 'main' | 'git-commit' | string

export interface RoutedEvent {
  contextId: ContextId
  payload: unknown
}

export type EventHandler = (payload: unknown) => void

/**
 * 从 AIEvent 中提取 sessionId
 */
function extractSessionId(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && 'sessionId' in payload) {
    const sessionId = (payload as { sessionId: unknown }).sessionId
    if (typeof sessionId === 'string') {
      return sessionId
    }
  }
  return null
}

/**
 * 从 contextId 中提取前端 sessionId
 * contextId 格式: "session-{sessionId}" 或 "main" 或其他自定义格式
 */
function extractFrontendSessionId(contextId: ContextId): string | null {
  // 格式: "session-{sessionId}"
  if (contextId.startsWith('session-')) {
    return contextId.substring('session-'.length)
  }
  // 其他格式（如 "main"、"git-commit"）返回 null
  return null
}

export class EventRouter {
  private handlers: Map<ContextId, Set<EventHandler>> = new Map()
  private unlisten: UnlistenFn | null = null
  private initialized = false
  private initPromise: Promise<void> | null = null
  private destroyed = false
  /** 是否启用 sessionId 路由（新架构） */
  private useSessionIdRouting = true

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

        // 多会话路由策略：
        // 1. scheduler 任务：使用 contextId 路由到 scheduler 注册的 handler
        // 2. session 会话：从 contextId 提取前端 sessionId 路由
        // 3. 其他情况：使用 payload.sessionId 路由
        // 4. 最后回退到旧架构的 contextId 路由

        // Scheduler 任务：contextId 格式为 "scheduler-{taskId}"
        // 必须使用 contextId 路由，让 scheduler handler 接收事件
        if (routedEvent.contextId.startsWith('scheduler-')) {
          log.debug('Scheduler 任务使用 contextId 路由', { contextId: routedEvent.contextId })
          this.dispatch(routedEvent)
          return
        }

        const frontendSessionId = extractFrontendSessionId(routedEvent.contextId)

        if (frontendSessionId && this.useSessionIdRouting) {
          // 使用 contextId 中的前端 sessionId 路由（最可靠）
          log.debug('使用 contextId 路由到前端会话', { contextId: routedEvent.contextId, frontendSessionId })
          this.dispatchToSession(frontendSessionId, routedEvent.payload as AIEvent)
          return
        }

        // 如果 contextId 不包含前端 sessionId，尝试使用 payload.sessionId 路由
        if (this.useSessionIdRouting) {
          const backendSessionId = extractSessionId(routedEvent.payload)
          if (backendSessionId) {
            log.debug('使用 payload.sessionId 路由', { backendSessionId })
            this.dispatchToSession(backendSessionId, routedEvent.payload as AIEvent)
            return
          }
        }

        // 回退到 contextId 路由（旧架构兼容）
        console.log('[EventRouter] 回退到 contextId 路由:', routedEvent.contextId, 'payload类型:', typeof routedEvent.payload)
        this.dispatch(routedEvent)
      } catch (e) {
        console.error('[EventRouter] Failed to parse event:', e)
      }
    })

    this.initialized = true
  }

  /**
   * 将事件分发到指定的会话 Store
   *
   * @param frontendSessionId 前端 sessionId（用于路由到正确的 store）
   * @param event AI 事件（包含后端 sessionId，用于 API 调用）
   */
  private dispatchToSession(frontendSessionId: string, event: AIEvent): void {
    try {
      // 使用 _routeSessionId 字段传递路由用的前端 sessionId
      // 不覆盖 event.sessionId（后端 sessionId），保持 API 调用正确
      const eventWithRouteId = {
        ...event,
        _routeSessionId: frontendSessionId,
      } as AIEvent & { _routeSessionId: string }
      sessionStoreManager.getState().dispatchEvent(eventWithRouteId)
    } catch (e) {
      log.error('分发事件到会话失败', e as Error, { frontendSessionId })
    }
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
      log.debug('dispatch 到 handlers', { contextId: event.contextId, count: handlers.size })
      handlers.forEach(handler => {
        try {
          handler(event.payload)
        } catch (e) {
          log.error(`Handler error`, e as Error, { contextId: event.contextId })
        }
      })
    } else {
      log.debug('没有找到 handler', { contextId: event.contextId })
    }

    const wildcardHandlers = this.handlers.get('*')
    if (wildcardHandlers) {
      wildcardHandlers.forEach(handler => {
        try {
          handler(event)
        } catch (e) {
          log.error('Wildcard handler error', e as Error)
        }
      })
    }
  }

  /**
   * 启用或禁用 sessionId 路由
   */
  setSessionIdRouting(enabled: boolean): void {
    this.useSessionIdRouting = enabled
    log.info(`sessionId 路由已${enabled ? '启用' : '禁用'}`)
  }

  destroy(): void {
    if (this.unlisten) {
      this.unlisten()
      this.unlisten = null
    }
    this.handlers.clear()
    this.initialized = false
    this.initPromise = null
    this.destroyed = true
  }

  isInitialized(): boolean {
    return this.initialized
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
}

let routerInstance: EventRouter | null = null

/**
 * 获取 EventRouter 单例实例
 *
 * 如果当前实例已销毁（destroyed = true），
 * 会创建新实例替换旧实例，确保返回可用的路由器。
 */
export function getEventRouter(): EventRouter {
  // 如果实例存在但已销毁，创建新实例
  if (routerInstance && routerInstance.isDestroyed()) {
    console.log('[EventRouter] 检测到已销毁实例，创建新实例')
    routerInstance = new EventRouter()
  } else if (!routerInstance) {
    routerInstance = new EventRouter()
  }
  return routerInstance
}

/**
 * 重置单例实例（仅用于测试）
 */
export function resetEventRouter(): void {
  if (routerInstance) {
    routerInstance.destroy()
    routerInstance = null
  }
}

export async function ensureEventRouterInitialized(): Promise<EventRouter> {
  const router = getEventRouter()
  await router.initialize()
  return router
}

export function createContextId(prefix: string = 'ctx'): ContextId {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}
