/**
 * EventRouter — 事件路由器
 *
 * 职责（仅此一个）：
 * 1. 监听 Tauri 的 'chat-event' 通道
 * 2. 按 sessionId 路由到正确的 ConversationStore
 *
 * 不处理 Store 间通信（无此需求时勿扩展此模块）。
 * 如需全局 AI 事件广播（如 DeveloperPanel 调试面板），
 * 请使用 ai-runtime 的 EventBus。
 */

import { listen } from '@/services/transport'
import { createLogger } from '@/utils/logger'
import { sessionStoreManager } from '@/stores/conversationStore'
import type { AIEvent } from '@/ai-runtime'

const log = createLogger('EventRouter')

export type ContextId = 'main' | 'git-commit' | string

export interface RoutedEvent {
  contextId: ContextId
  payload: unknown
}

export type EventHandler = (payload: unknown) => void

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
  private unlisten: (() => void) | null = null
  private initialized = false
  private initPromise: Promise<void> | null = null
  private destroyed = false

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this.doInitialize()
    return this.initPromise
  }

  private async doInitialize(): Promise<void> {
    this.unlisten = await listen<string>('chat-event', (rawPayload) => {
      try {
        // 解析事件信封：{ contextId, payload } 或裸 payload
        let rawData: unknown
        if (typeof rawPayload === 'string') {
          try { rawData = JSON.parse(rawPayload) } catch { rawData = rawPayload }
        } else {
          rawData = rawPayload
        }

        let contextId: ContextId = 'main'
        let payload: unknown = rawData
        if (rawData && typeof rawData === 'object' && 'contextId' in rawData && 'payload' in rawData) {
          contextId = (rawData as { contextId: string }).contextId
          payload = (rawData as { payload: unknown }).payload
        }

        // 单一路由路径：从 contextId 解析前端 sessionId。
        // contextId 格式 "session-<sessionId>" 由 sendMessage 时注入（deps.contextId），
        // 后端原样回传，是稳定的路由通道。payload.sessionId 是后端 conversationId，不可作路由 key。
        const frontendSessionId = extractFrontendSessionId(contextId)
        if (frontendSessionId) {
          this.dispatchToSession(frontendSessionId, payload as AIEvent)
          return
        }

        // scheduler-/dispatch- 前缀：仍走 register/dispatch 旧路径（service 自行注入 _routeSessionId）
        if (contextId.startsWith('scheduler-') || contextId.startsWith('dispatch-')) {
          this.dispatch({ contextId, payload })
          return
        }

        // 无 contextId 或 'main'：旧式 handler 兜底（useChat 等外部监听）
        this.dispatch({ contextId, payload })
      } catch (e) {
        log.error('Failed to parse event', e instanceof Error ? e : new Error(String(e)))
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
    const existingHandlers = this.handlers.get(contextId)
    if (existingHandlers) {
      if (existingHandlers.size > 0) {
        log.info('contextId 已存在 handler，清除旧 handler', { contextId })
        existingHandlers.clear()
      }
    } else {
      this.handlers.set(contextId, new Set())
    }

    const handlers = this.handlers.get(contextId)
    if (handlers) {
      handlers.add(handler)
      log.info('注册 handler', { contextId })
    }

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
    log.info('检测到已销毁实例，创建新实例')
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
