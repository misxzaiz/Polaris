/**
 * AI 提交信息生成服务
 *
 * 把 GitPanel 的"生成提交信息"从 headless 一次性调用改为：
 * 在右侧 AI 面板新建/复用一个会话，把选中变更格式化后作为上下文自动发送，
 * 用户可选引擎、可追问微调，并通过 useCommitMessageSuggestion 一键回流到提交输入框。
 *
 * 复用成熟的会话基建（sessionStoreManager + sendMessage），绕开旧 headless 路径的
 * 超时 / 跑偏 / 静默兜底问题。
 */

import { useMemo, useRef, useSyncExternalStore } from 'react'
import { useStore } from 'zustand'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { useViewStore } from '@/stores'
import { formatGitDiffSummary } from '@/services/gitContextService'
import { isTextBlock } from '@/types/chat'
import type { AssistantChatMessage } from '@/types/chat'
import type { GitDiffEntry } from '@/types/git'
import type { ConversationState, ConversationStoreInstance } from '@/stores/conversationStore/types'
import { createLogger } from '@/utils/logger'

const log = createLogger('CommitMessageChat')

/**
 * 一次性系统提示：约束 AI 仅输出 Conventional Commits 格式的提交信息。
 * 经 sendMessage 的 oneTimeSystemPrompt 通道注入，不进入消息流。
 */
export const COMMIT_MSG_SYSTEM_PROMPT = `You are a Git commit message generator. Analyze the staged changes and generate a concise, meaningful commit message following conventional commits format.

Rules:
1. Use conventional commits format: type(scope): description
2. Types: feat, fix, docs, style, refactor, test, chore, perf, ci, build, revert
3. Keep the first line under 72 characters
4. Use imperative mood ("add feature" not "added feature")
5. Don't end the first line with a period
6. If there are multiple types of changes, focus on the most significant one
7. Respond with ONLY the commit message, no explanations, no code fences`

export interface OpenCommitMessageChatOptions {
  workspaceId: string
  workspacePath: string
  engineId: string
  diffs: GitDiffEntry[]
}

/**
 * 打开（或复用）提交信息生成会话并发送 diff 上下文。
 *
 * 同一 workspace 仅维护一个 commit-message 会话：存在则 switchSession 复用并追加一轮，
 * 不存在则新建。返回会话 ID。
 */
export async function openCommitMessageChat(
  options: OpenCommitMessageChatOptions
): Promise<string> {
  const { workspaceId, workspacePath, engineId, diffs } = options

  const manager = sessionStoreManager.getState()

  // 查找已存在的 commit-message 会话（按 workspace 隔离）
  let sessionId: string | null = null
  for (const [id, meta] of manager.sessionMetadata) {
    if (meta.kind === 'commit-message' && meta.commitWorkspaceId === workspaceId) {
      sessionId = id
      break
    }
  }

  if (sessionId) {
    log.info('复用 commit-message 会话', { sessionId })
    manager.switchSession(sessionId)
  } else {
    sessionId = manager.createSession({
      type: 'project',
      workspaceId,
      contextWorkspaceIds: [workspaceId],
      workspaceLocked: true,
      engineId,
      title: '生成提交信息',
      kind: 'commit-message',
      commitWorkspaceId: workspaceId,
    })
    log.info('新建 commit-message 会话', { sessionId })
  }

  // 确保右侧 AI 面板展开
  const viewState = useViewStore.getState()
  if (viewState.rightPanelCollapsed) {
    viewState.toggleRightPanel()
  }

  const store = sessionStoreManager.getState().stores.get(sessionId)
  if (!store) {
    throw new Error('commit-message 会话 store 不存在')
  }

  const diffSummary = formatGitDiffSummary(diffs)
  const userContent =
    '本次提交涉及以下暂存的 Git 变更（变更清单）：\n\n' +
    diffSummary +
    '\n\n请使用 `git diff --cached` 查看完整变更内容（若无法运行命令则读取上述相关文件），据此生成一条 Conventional Commits 格式的提交信息。只输出消息本身，不要解释、不要代码块标记。消息具体内容使用中文。'

  await store.getState().sendMessage(userContent, workspacePath, undefined, {
    oneTimeSystemPrompt: COMMIT_MSG_SYSTEM_PROMPT,
  })

  return sessionId
}

/**
 * 从助手消息中提取纯文本（拼接所有 text block）。
 */
function extractAssistantText(message: AssistantChatMessage | null | undefined): string {
  if (!message) return ''
  if (message.content) return message.content
  return message.blocks
    .filter(isTextBlock)
    .map((b) => (b as { content: string }).content)
    .join('')
}

/**
 * 找出最新一条助手消息的文本。
 *
 * 流式中的 currentMessage 优先于已归档 messages 的末条 assistant，
 * 这样追问微调时回流条能实时跟随最新输出。
 */
function pickLatestAssistantText(state: ConversationState): string {
  if (state.currentMessage) {
    const text = extractAssistantText({
      id: state.currentMessage.id,
      type: 'assistant',
      engineId: state.currentMessage.engineId,
      blocks: state.currentMessage.blocks,
      isStreaming: true,
      timestamp: new Date().toISOString(),
    } as AssistantChatMessage)
    if (text) return text
  }

  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i]
    if (msg.type === 'assistant') {
      const text = extractAssistantText(msg as AssistantChatMessage)
      if (text) return text
    }
  }
  return ''
}

const EMPTY_SNAPSHOT: { text: string; isStreaming: boolean; sessionId: string | null } = {
  text: '',
  isStreaming: false,
  sessionId: null,
}

/**
 * 订阅指定 workspace 的 commit-message 会话最新助手消息。
 *
 * 用于 GitPanel 提交输入框的"AI 建议"回流条：
 * - 会话不存在或被 LRU 驱逐时返回空快照
 * - 流式中实时跟随 currentMessage 输出
 *
 * 返回 { text, isStreaming, sessionId }。
 */
export function useCommitMessageSuggestion(workspaceId: string | null | undefined) {
  const stores = useStore(sessionStoreManager, (state) => state.stores)
  const sessionMetadata = useStore(sessionStoreManager, (state) => state.sessionMetadata)

  // 定位本 workspace 的 commit-message 会话
  const sessionId = useMemo(() => {
    if (!workspaceId) return null
    for (const [id, meta] of sessionMetadata) {
      if (meta.kind === 'commit-message' && meta.commitWorkspaceId === workspaceId) {
        return id
      }
    }
    return null
  }, [sessionMetadata, workspaceId])

  const store: ConversationStoreInstance | null = sessionId ? (stores.get(sessionId) ?? null) : null

  const cachedRef = useRef(EMPTY_SNAPSHOT)

  const getSnapshot = () => {
    if (!sessionId || !store) {
      return EMPTY_SNAPSHOT
    }
    const state = store.getState()
    const text = pickLatestAssistantText(state)
    const next = { text, isStreaming: state.isStreaming, sessionId }
    if (
      cachedRef.current.text === next.text &&
      cachedRef.current.isStreaming === next.isStreaming &&
      cachedRef.current.sessionId === next.sessionId
    ) {
      return cachedRef.current
    }
    cachedRef.current = next
    return next
  }

  const subscribe = (onChange: () => void) => {
    if (!store) {
      // store 缺失时订阅 manager，等会话创建后重算
      return sessionStoreManager.subscribe(onChange)
    }
    return store.subscribe(onChange)
  }

  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SNAPSHOT)
}
