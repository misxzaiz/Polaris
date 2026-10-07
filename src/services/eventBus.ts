/**
 * EventBus - 类型化跨组件事件总线
 *
 * 取代散落 10 处的 window.dispatchEvent(new CustomEvent(...)) 和
 * 45 处 window.addEventListener(...) 自定义事件监听。
 *
 * 优势：
 *   - 事件名 + payload 类型化（TypeScript 校验，拼写错误编译即报错）
 *   - 监听器返回 cleanup 函数，hook 自动解绑（避免泄漏）
 *   - emit 同步派发（不用 requestAnimationFrame），接收方读到最新 state
 *   - 单一真源：所有自定义事件在此声明，新增事件 = 在此加一行
 *
 * 用法：
 *   // 派发
 *   eventBus.emit('chat:focus-input', undefined)
 *   eventBus.emit('polaris:open-settings', { tab: 'theme' })
 *
 *   // 监听（hook 内）
 *   useEffect(() => eventBus.on('chat:focus-input', () => focus()), [])
 *
 * 纪律：
 *   - 禁止 window.dispatchEvent(new CustomEvent(...))（ESLint 规则后续补）
 *   - 禁止 window.addEventListener('chat:...' / 'polaris:...' ...)
 *   - 浏览器原生事件（keydown/click/resize 等）不在此总线，仍走 addEventListener
 */

import { useEffect } from 'react'

export type PolarisEventMap = {
  /** 聚焦聊天输入框（创建会话后、关闭弹窗后调用） */
  'chat:focus-input': undefined
  /** 打开设置页（可指定初始 tab） */
  'polaris:open-settings': { tab?: string }
  /** 开发模式服务发现就绪 */
  'polaris:dev-discovery-ready': undefined
  /** 终端运行器打开请求 */
  'terminal:open-runner': undefined
  /** 终端输出（外部消费，如悬浮窗） */
  'terminal-output': { data: string; sessionId?: string }
  /** 工作区变更（路径/切换） */
  'workspace-changed': { workspaceId?: string; workspacePath?: string; path?: string }
  /** 工作区切换完成 */
  'workspace-switched': undefined
  /** 应用崩溃前紧急保存 */
  'app:crash-save': undefined
  /** 应用恢复 */
  'app:recover': undefined
  /** 导航到设置（当前无派发点，保留以兼容未来调用） */
  'navigate-to-settings': undefined
}

type EventHandler<T> = (payload: T) => void

class EventBus<TMap extends Record<string, unknown>> {
  private listeners = new Map<keyof TMap, Set<EventHandler<unknown>>>()

  /** 订阅事件。返回 cleanup 函数（useEffect 里直接 return） */
  on<K extends keyof TMap>(type: K, handler: EventHandler<TMap[K]>): () => void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(handler as EventHandler<unknown>)
    return () => this.off(type, handler)
  }

  /** 派发事件（同步派发，监听器立即执行） */
  emit<K extends keyof TMap>(type: K, payload: TMap[K]): void {
    const set = this.listeners.get(type)
    if (!set) return
    // 复制一份再遍历，避免遍历中 handler 注销/新增导致迭代异常
    for (const handler of [...set]) {
      try {
        (handler as EventHandler<TMap[K]>)(payload)
      } catch (e) {
        // 单个 handler 异常不阻断其他 handler
        // eslint-disable-next-line no-console
        console.error(`[EventBus] handler error for "${String(type)}":`, e)
      }
    }
  }

  /** 注销单个监听器 */
  off<K extends keyof TMap>(type: K, handler: EventHandler<TMap[K]>): void {
    const set = this.listeners.get(type)
    if (set) {
      set.delete(handler as EventHandler<unknown>)
      if (set.size === 0) this.listeners.delete(type)
    }
  }

  /** 清空所有监听器（测试用） */
  clear(): void {
    this.listeners.clear()
  }
}

/** 全局单例 */
export const eventBus = new EventBus<PolarisEventMap>()

/**
 * React hook：订阅事件，自动解绑。
 * handler 引用需稳定（useCallback 或模块级函数），否则每次渲染都重订阅。
 */
export function useEventBus<K extends keyof PolarisEventMap>(
  type: K,
  handler: EventHandler<PolarisEventMap[K]>,
): void {
  useEffect(() => {
    return eventBus.on(type, handler)
  }, [type, handler])
}
