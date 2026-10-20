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
import { useKernelSessionState } from '@/session-v2/hooks/useKernelSessionState'
import { useViewStore } from '@/stores'
import { formatGitDiffSummary, formatGitDiffWithContent } from '@/services/gitContextService'
import { useEngineMetadataStore } from '@/stores/engineMetadataStore'
import { pickLatestAssistantText } from '@/services/assistantTextUtils'
import type { GitDiffEntry } from '@/types/git'
import type { ConversationStoreInstance } from '@/stores/conversationStore/types'
import { createLogger } from '@/utils/logger'

const log = createLogger('CommitMessageChat')

/**
 * 判定引擎是否 agentic（具备工具调用能力，可自行跑 git 命令）。
 *
 * 判据为后端权威元数据 EngineCapabilities.tools（ai::traits）。
 * 元数据未加载/未知引擎时**安全降级为 false**（按非 agentic 处理 → 注入裁剪
 * diff 正文），宁可冗余上下文也不给幻觉脚本。见 master-plan C12/AI-1。
 */
export function isAgenticEngine(engineId: string): boolean {
  const engine = useEngineMetadataStore.getState().getEngine(engineId)
  return engine?.capabilities.tools ?? false
}

/**
 * 按引擎能力生成提交信息请求上下文（双档注入）：
 *
 * - agentic 引擎：只给变更清单，指挥其用 `git diff --cached` 自取完整内容
 *   （现有已验证路径）。
 * - 非 agentic 引擎：注入裁剪后的 diff 正文（formatGitDiffWithContent），
 *   **不得**引导其执行命令——纯文本引擎拿不到 diff 时会编造变更内容（幻觉路径）。
 */
export function buildCommitMessageUserContent(
  diffs: GitDiffEntry[],
  engineId: string
): string {
  const diffSummary = formatGitDiffSummary(diffs)

  if (isAgenticEngine(engineId)) {
    return (
      '本次提交涉及以下暂存的 Git 变更（变更清单）：\n\n' +
      diffSummary +
      '\n\n请使用 `git diff --cached` 查看完整变更内容（若无法运行命令则读取上述相关文件），据此生成一条 Conventional Commits 格式的提交信息。只输出消息本身，不要解释、不要代码块标记。内容使用中文。'
    )
  }

  return (
    '本次提交涉及以下暂存的 Git 变更（含各文件实际内容，已按预算裁剪）：\n\n' +
    diffSummary +
    '\n\n=== diff 内容 ===\n\n' +
    formatGitDiffWithContent(diffs) +
    '\n\n=== diff 内容结束 ===\n\n' +
    '以上是全部可见的变更内容。据此生成一条 Conventional Commits 格式的提交信息。' +
    '不要编造未提供的代码内容；若信息不足以判断某个文件的变更意图，用中性描述概括该文件。' +
    '只输出消息本身，不要解释、不要代码块标记。内容使用中文。'
  )
}

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

  const userContent = buildCommitMessageUserContent(diffs, engineId)

  await store.getState().sendMessage(userContent, workspacePath, undefined, {
    oneTimeSystemPrompt: COMMIT_MSG_SYSTEM_PROMPT,
  })

  return sessionId
}

/**
 * 从助手消息中提取纯文本 / 找出最新一条助手消息的文本：
 * 已抽至 @/services/assistantTextUtils 共享（提示词优化等场景复用）。
 */

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

  // 流式状态后端权威（不再读 store.isStreaming）
  const { isStreaming } = useKernelSessionState(sessionId)

  const cachedRef = useRef(EMPTY_SNAPSHOT)

  const getSnapshot = () => {
    if (!sessionId || !store) {
      return EMPTY_SNAPSHOT
    }
    const state = store.getState()
    const text = pickLatestAssistantText(state)
    const next = { text, isStreaming, sessionId }
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
