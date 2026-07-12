/**
 * Mimo Code Session
 *
 * 实现 AISession 接口，封装 Mimo (Mimocode) CLI 的调用逻辑。
 * 与 ClaudeCodeSession / CodexSession 结构对称，通过 Tauri invoke/listen 与后端通信。
 */

import type { AISessionConfig } from '@/ai-runtime'
import type { AITask, AIEvent } from '@/ai-runtime'
import { BaseSession } from '@/ai-runtime/base'
import { createEventIterable } from '@/ai-runtime/base'
import { invoke, listen } from '@/services/tauri'
import { createLogger } from '@/utils/logger'

const log = createLogger('MimoCodeSession')

/**
 * Mimo Code 会话配置
 */
export interface MimoSessionConfig extends AISessionConfig {
  /** 工作区目录 */
  workspacePath?: string
}

/**
 * Tauri Chat 事件类型（来自 Rust 后端）
 */
interface TauriChatEvent {
  contextId?: string
  payload: AIEvent
}

/**
 * Mimo Code Session 实现
 *
 * 通过 Tauri IPC 调用后端 MimocodeEngine，事件格式与其他引擎完全一致。
 */
export class MimoCodeSession extends BaseSession {
  protected config: MimoSessionConfig
  private currentTaskId: string | null = null
  private unlistenChatEvent: (() => void) | null = null

  constructor(id: string, config?: MimoSessionConfig) {
    super({ id, config })
    this.config = {
      workspaceDir: config?.workspacePath,
      verbose: config?.verbose,
      timeout: config?.timeout,
      options: config?.options,
    }
  }

  protected async executeTask(task: AITask): Promise<AsyncIterable<AIEvent>> {
    this.currentTaskId = task.id

    await this.setupEventListeners()
    await this.startMimoProcess(task)

    return createEventIterable(
      this.eventEmitter,
      (event) => event.type === 'session_end' || event.type === 'error'
    )
  }

  protected abortTask(taskId?: string): void {
    if (taskId && taskId !== this.currentTaskId) {
      return
    }

    invoke('interrupt_chat', { sessionId: this.id, engineId: 'mimo' })
      .catch((error) => {
        log.error('Failed to abort:', error instanceof Error ? error : new Error(String(error)))
      })
      .finally(() => {
        this.currentTaskId = null
      })
  }

  protected disposeResources(): void {
    if (this.unlistenChatEvent) {
      this.unlistenChatEvent()
      this.unlistenChatEvent = null
    }
    this.currentTaskId = null
  }

  private async setupEventListeners(): Promise<void> {
    if (this.unlistenChatEvent) {
      return
    }

    try {
      this.unlistenChatEvent = await listen<TauriChatEvent>(
        'chat-event',
        (event) => {
          const parsed = typeof event.payload === 'string'
            ? JSON.parse(event.payload)
            : event.payload
          this.handleTauriEvent(parsed)
        }
      )
    } catch (error) {
      log.error('Failed to setup event listeners:', error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  private async startMimoProcess(task: AITask): Promise<void> {
    const message = this.buildPrompt(task)

    try {
      await invoke('start_chat', {
        message,
        options: {
          engineId: 'mimo',
          workDir: this.config.workspaceDir,
          enableMcpTools: true,
        },
      })
    } catch (error) {
      log.error('Failed to start Mimo process:', error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  private buildPrompt(task: AITask): string {
    return task.input.prompt
  }

  private handleTauriEvent(event: TauriChatEvent): void {
    const aiEvent = event.payload
    this.emit(aiEvent)
  }

  /**
   * 继续会话（多轮对话）
   */
  async continue(prompt: string): Promise<void> {
    if (this.isDisposed) {
      throw new Error('[MimoCodeSession] Session has been disposed')
    }

    try {
      await invoke('continue_chat', {
        sessionId: this.id,
        message: prompt,
        options: {
          engineId: 'mimo',
          workDir: this.config.workspaceDir,
          enableMcpTools: true,
        },
      })
      this._status = 'running'
    } catch (error) {
      log.error('Failed to continue chat:', error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }
}

/**
 * Mimo Code Session 工厂函数
 */
export function createMimoSession(
  sessionId: string,
  config?: MimoSessionConfig
): MimoCodeSession {
  return new MimoCodeSession(sessionId, config)
}
