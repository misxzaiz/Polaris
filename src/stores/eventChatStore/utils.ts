/**
 * EventChatStore 工具函数
 *
 * 包含事件处理、文件读取缓存等核心逻辑
 */

import { invoke } from '@tauri-apps/api/core'
import type { AIEvent } from '../../ai-runtime'
import type { EventChatState } from './types'
import { extractEditDiff, isEditTool } from '../../utils/diffExtractor'

// ============================================================================
// 文件读取缓存
// ============================================================================

/**
 * 文件读取缓存 - 避免同一文件重复读取
 * 用于 Edit 工具的异步读取优化
 */
const fileReadPromises = new Map<string, Promise<string>>()

/**
 * 带缓存的文件读取函数
 * 如果同一文件正在读取，返回现有 Promise，避免重复请求
 */
export function readFileWithCache(filePath: string): Promise<string> {
  // 如果正在读取，返回现有 Promise
  if (fileReadPromises.has(filePath)) {
    return fileReadPromises.get(filePath)!
  }

  // 创建新的读取 Promise
  const promise = invoke<string>('read_file_absolute', { path: filePath })
    .finally(() => {
      // 读取完成后清理缓存
      fileReadPromises.delete(filePath)
    })

  fileReadPromises.set(filePath, promise)
  return promise
}

/**
 * 清理文件读取缓存
 */
export function clearFileReadCache(): void {
  fileReadPromises.clear()
}

// ============================================================================
// AIEvent 处理器
// ============================================================================

/**
 * 处理 AIEvent 更新本地状态
 *
 * 这是统一的状态更新入口，所有 AIEvent 都通过这里更新本地状态。
 * 与 convertStreamEventToAIEvents() 配合使用，实现事件流统一处理。
 *
 * 设计说明：
 * - 只处理与本地状态相关的 AIEvent
 * - 不再直接处理 StreamEvent，避免重复逻辑
 * - 与 EventBus 分离，Store 只负责状态管理
 * - 使用依赖注入模式，通过 state 获取外部依赖
 *
 * @param event 要处理的 AIEvent
 * @param storeSet Zustand 的 set 函数
 * @param storeGet Zustand 的 get 函数
 * @param workspacePath 工作区路径
 */
export function handleAIEvent(
  event: AIEvent,
  storeSet: (partial: Partial<EventChatState> | ((state: EventChatState) => Partial<EventChatState>)) => void,
  storeGet: () => EventChatState,
  workspacePath?: string
): void {
  // 强制诊断日志
  console.log('[handleAIEvent] 收到事件:', event.type, {
    hasToken: event.type === 'token',
    tokenLength: event.type === 'token' ? event.value?.length : 0,
    timestamp: new Date().toISOString()
  })

  const state = storeGet()
  const toolPanelActions = state.getToolPanelActions()
  const gitActions = state.getGitActions()

  switch (event.type) {
    case 'session_start':
      storeSet({ conversationId: event.sessionId, isStreaming: true })
      console.log('[EventChatStore] Session started:', event.sessionId)
      if (toolPanelActions) {
        toolPanelActions.clearTools()
      }
      break

    case 'session_end':
      state.finishMessage()
      storeSet({ isStreaming: false, progressMessage: null })
      console.log('[EventChatStore] Session ended:', event.reason)

      // 会话结束时刷新 Git 状态（防抖）
      if (workspacePath && gitActions) {
        gitActions.refreshStatusDebounced(workspacePath).catch(err => {
          console.warn('[EventChatStore] 会话结束时刷新 Git 状态失败:', err)
        })
      }
      break

    case 'token':
      state.appendTextBlock(event.value)
      break

    case 'thinking':
      state.appendThinkingBlock(event.content)
      break

    case 'assistant_message':
      state.appendTextBlock(event.content)
      // 注意：工具调用会通过独立的 tool_call_start 事件处理，不在这里处理
      break

    case 'tool_call_start': {
      const toolName = event.tool
      const callId = event.callId || crypto.randomUUID()

      // 检测是否为 AskUserQuestion 工具
      if (toolName === 'ask_user_question' || toolName === 'AskUserQuestion') {
        const args = event.args as Record<string, unknown>
        const header = String(args.header || args.question || args.message || '请选择：')
        const rawOptions = args.options as Array<{ value: string; label?: string }> | string[] | undefined
        const options = Array.isArray(rawOptions)
          ? rawOptions.map(opt =>
              typeof opt === 'string' ? { value: opt, label: opt } : opt
            )
          : []
        const multiSelect = Boolean(args.multiSelect || args.multi_select)
        const allowCustomInput = Boolean(args.allowCustomInput || args.allow_custom_input || args.allowInput)

        state.appendQuestionBlock(
          callId,
          header,
          options,
          multiSelect,
          allowCustomInput
        )
        break
      }

      state.appendToolCallBlock(
        callId,
        toolName,
        event.args
      )

      // 对 Edit 工具，在执行前读取完整文件内容
      if (isEditTool(event.tool)) {
        const args = event.args as Record<string, unknown>
        const filePath = (args.file_path || args.path || args.filePath) as string

        if (filePath) {
          const callId = event.callId || crypto.randomUUID()

          // 修复：使用缓存的读取函数，避免重复读取
          readFileWithCache(filePath)
            .then(fullContent => {
              // 存储完整内容到 block
              const blockIndex = storeGet().toolBlockMap.get(callId)
              if (blockIndex !== undefined) {
                storeGet().updateToolCallBlockFullContent(
                  callId,
                  fullContent
                )
              }
            })
            .catch(err => {
              console.warn('[EventChatStore] 读取文件内容失败:', err)
            })
        }
      }
      break
    }

    case 'tool_call_end': {
      if (!event.callId) {
        console.warn('[EventChatStore] tool_call_end 事件缺少 callId，工具状态无法更新:', event.tool)
        break
      }

      // 检查是否为 AskUserQuestion 工具
      const questionBlockIndex = storeGet().questionBlockMap.get(event.callId)
      if (questionBlockIndex !== undefined) {
        // AskUserQuestion 工具结束，如果还没有答案则从 result 提取
        const questionBlock = storeGet().currentMessage?.blocks[questionBlockIndex]
        if (questionBlock?.type === 'question' && !questionBlock.answer) {
          // 尝试从 result 提取答案（如果后端返回了）
          const result = event.result as Record<string, unknown> | undefined
          if (result) {
            const selected = result.selected as string[] | undefined
            const customInput = result.customInput as string | undefined
            if (selected || customInput) {
              state.updateQuestionBlock(event.callId, {
                selected: selected || [],
                customInput,
              })
            }
          }
        }
        // AskUserQuestion 不需要走 tool_call 流程
        break
      }

      state.updateToolCallBlock(
        event.callId,
        event.success ? 'completed' : 'failed',
        String(event.result || '')
      )

      // 对 Edit 工具，提取 Diff 数据
      // 修复：不使用 event.tool 判断，而是在获取 block 后用 block.name 判断
      if (event.success) {
        const currentState = storeGet()
        const blockIndex = currentState.toolBlockMap.get(event.callId)

        if (currentState.currentMessage && blockIndex !== undefined) {
          const block = currentState.currentMessage.blocks[blockIndex]

          if (block && block.type === 'tool_call' && isEditTool(block.name)) {
            const diffData = extractEditDiff(block)
            if (diffData) {
              currentState.updateToolCallBlockDiff(event.callId, diffData)

              // 修复：降级策略也使用缓存读取，避免重复请求
              if (!block.diffData?.fullOldContent && diffData.filePath) {
                // 捕获 callId，避免异步回调中的类型问题
                const callId = event.callId
                readFileWithCache(diffData.filePath)
                  .then(fullContent => {
                    // 再次检查是否还需要设置（避免竞态）
                    const checkState = storeGet()
                    const blockIdx = checkState.toolBlockMap.get(callId)
                    if (blockIdx !== undefined) {
                      const currentBlock = checkState.currentMessage?.blocks[blockIdx]
                      if (currentBlock?.type === 'tool_call' && !currentBlock.diffData?.fullOldContent) {
                        console.log('[EventChatStore] 降级策略：从文件系统读取完整内容')
                        checkState.updateToolCallBlockFullContent(callId, fullContent)
                      }
                    }
                  })
                  .catch(err => {
                    console.warn('[EventChatStore] 降级读取失败，无法读取文件内容:', err)
                    // 标记为无法精确撤销
                    storeGet().updateToolCallBlockFullContent(callId, '')
                  })
              }
            }
          }
        }
      }

      // 工具完成后刷新 Git 状态（防抖）
      if (workspacePath && gitActions) {
        gitActions.refreshStatusDebounced(workspacePath).catch(err => {
          console.warn('[EventChatStore] 工具完成后刷新 Git 状态失败:', err)
        })
      }
      break
    }

    case 'progress':
      storeSet({ progressMessage: event.message || null })
      break

    case 'error':
      state.finishMessage()
      storeSet({ error: event.error, isStreaming: false })
      break

    case 'user_message':
      // 用户消息由 sendMessage 直接添加，这里不需要处理
      break

    default:
      console.log('[EventChatStore] 未处理的 AIEvent 类型:', (event as { type: string }).type)
  }
}
