/**
 * Claude Code Session
 *
 * 实现 AISession 接口，封装 Claude Code CLI 的调用逻辑。
 * 这是 Claude Code Adapter 的核心实现。
 */

import type { AISessionConfig } from '../../ai-runtime'
import type { AITask, AIEvent } from '../../ai-runtime'
import { BaseSession } from '../../ai-runtime/base'
import { createEventIterable } from '../../ai-runtime/base'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createLogger } from '../../utils/logger'

const log = createLogger('ClaudeCodeSession')

/**
 * Claude Code 会话配置
 */
export interface ClaudeSessionConfig extends AISessionConfig {
  /** Claude Code CLI 路径 */
  claudePath?: string
  /** 工作区目录 */
  workspacePath?: string
}

/**
 * Tauri Chat 事件类型（来自 Rust 后端）
 *
 * 后端已发送标准 AIEvent 格式，结构为：
 * { contextId: string, payload: AIEvent }
 */
interface TauriChatEvent {
  contextId?: string
  payload: AIEvent
}

/**
 * Claude Code Session 实现
 *
 * 负责：
 * 1. 启动 Claude Code CLI 进程
 * 2. 将 stdout/stderr 解析为 AIEvent
 * 3. 处理 abort（中断）
 * 4. 管理进程生命周期
 */
export class ClaudeCodeSession extends BaseSession {
  protected config: ClaudeSessionConfig
  private currentTaskId: string | null = null
  private unlistenChatEvent: (() => void) | null = null

  constructor(id: string, config?: ClaudeSessionConfig) {
    super({ id, config })
    this.config = {
      workspaceDir: config?.workspacePath,
      verbose: config?.verbose,
      timeout: config?.timeout,
      claudePath: config?.claudePath,
      options: config?.options,
    }
  }

  /**
   * 执行具体任务 - 由 BaseSession.run() 模板方法调用
   */
  protected async executeTask(task: AITask): Promise<AsyncIterable<AIEvent>> {
    this.currentTaskId = task.id

    // 设置 Tauri 事件监听
    await this.setupEventListeners()

    // 调用 Tauri 后端启动 Claude CLI
    await this.startClaudeProcess(task)

    // 使用基类的工厂函数创建事件迭代器
    return createEventIterable(
      this.eventEmitter,
      (event) => event.type === 'session_end' || event.type === 'error'
    )
  }

  /**
   * 中断任务的具体实现
   */
  protected abortTask(taskId?: string): void {
    if (taskId && taskId !== this.currentTaskId) {
      return
    }

    // 调用 Tauri 后端中断 CLI 进程
    invoke('interrupt_chat', { sessionId: this.id })
      .catch((error) => {
        console.error('[ClaudeCodeSession] Failed to abort:', error)
      })
      .finally(() => {
        this.currentTaskId = null
      })
  }

  /**
   * 释放资源的具体实现
   */
  protected disposeResources(): void {
    // 移除事件监听
    if (this.unlistenChatEvent) {
      this.unlistenChatEvent()
      this.unlistenChatEvent = null
    }

    this.currentTaskId = null
  }

  /**
   * 设置 Tauri 事件监听
   */
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
      console.error('[ClaudeCodeSession] Failed to setup event listeners:', error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  /**
   * 启动 Claude CLI 进程
   */
  private async startClaudeProcess(task: AITask): Promise<void> {
    const message = this.buildPrompt(task)

    const args = {
      message,
      sessionId: this.id,
      workspaceDir: this.config.workspaceDir,
      verbose: this.config.verbose || false,
      // 不需要传递 claudePath，后端会从配置中读取
    }

    try {
      await invoke('start_chat', args)
    } catch (error) {
      log.error('Failed to start Claude process:', error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  /**
   * 构建发送给 Claude 的提示词
   */
  private buildPrompt(task: AITask): string {
    let prompt = task.input.prompt

    // 处理工作区上下文（如果存在）
    const workspaceContext = task.input.extra?.workspaceContext as
      { currentWorkspace: { name: string; path: string }; contextWorkspaces: Array<{ name: string; path: string }> } | undefined

    if (workspaceContext) {
      // 将工作区上下文作为系统提示词注入
      const contextHeader = this.formatWorkspaceContext(workspaceContext)
      if (contextHeader) {
        prompt = `${contextHeader}\n\n${prompt}`
      }
    }

    // 如果有指定文件，添加上下文
    if (task.input.files && task.input.files.length > 0) {
      // Claude CLI 会自动处理工作区中的文件引用
      // 这里我们保持原样，让 CLI 去处理
    }

    return prompt
  }

  /**
   * 格式化工作区上下文为提示词
   *
   * 关联工作区已通过 --add-dir 传递给 CLI，此处仅保留主工作区信息。
   */
  private formatWorkspaceContext(
    workspaceContext: { currentWorkspace: { name: string; path: string }; contextWorkspaces: Array<{ name: string; path: string }> }
  ): string {
    const lines: string[] = []

    lines.push(`当前工作区: ${workspaceContext.currentWorkspace.name}`)
    lines.push(`  路径: ${workspaceContext.currentWorkspace.path}`)

    // 关联工作区路径已通过 --add-dir 传递，不再需要在 prompt 中描述

    return lines.join('\n')
  }

  /**
   * 处理来自 Tauri 的事件
   * 后端已发送标准 AIEvent，直接使用 payload
   */
  private handleTauriEvent(event: TauriChatEvent): void {
    // 后端发送的事件格式: { contextId: string, payload: AIEvent }
    // 直接提取 payload 作为 AIEvent
    const aiEvent = event.payload
    this.emit(aiEvent)
  }

  /**
   * 继续会话（用于多轮对话）
   */
  async continue(prompt: string): Promise<void> {
    if (this.isDisposed) {
      throw new Error('[ClaudeCodeSession] Session has been disposed')
    }

    try {
      await invoke('continue_chat', {
        sessionId: this.id,
        message: prompt,
      })
      this._status = 'running'
    } catch (error) {
      console.error('[ClaudeCodeSession] Failed to continue chat:', error)
      throw error
    }
  }
}

/**
 * Claude Session 工厂函数
 */
export function createClaudeSession(
  sessionId: string,
  config?: ClaudeSessionConfig
): ClaudeCodeSession {
  return new ClaudeCodeSession(sessionId, config)
}
