/**
 * AI-2 原子提交 · AI 解释层会话服务
 *
 * 克隆 commitMessageChat.ts 范式（handoff §7 step 2）：
 * - kind='git-atomic' + workspaceLocked + commitWorkspaceId（按 workspace 隔离回流）
 * - **只投喂低置信组**（lowConfidenceOnly=true）：高置信组是确定性骨架，不消耗 token
 *   （master-plan 裁决 8 · AI 三禁之一：不让 AI 碰确定性的活）
 * - 输入裁剪：低置信组 diff 用 formatGitDiffWithContent（单文件 600 chars / 总量 12k），
 *   组清单用 formatGitDiffSummary —— 绝不推全量 diff（PRD §3 Note）
 * - 回流 hook：useAtomicCommitSuggestion 返回低置信组的 AI 建议文本，供「调整分组」回流
 */

import { useMemo, useRef, useSyncExternalStore } from 'react'
import { useStore } from 'zustand'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { useKernelSessionState } from '@/session-v2/hooks/useKernelSessionState'
import { useViewStore } from '@/stores'
import { formatGitDiffWithContent } from '@/services/gitContextService'
import { pickLatestAssistantText } from '@/services/assistantTextUtils'
import type { AtomicCommitGroup } from '@/services/gitAtomicGrouping'
import type { GitDiffEntry } from '@/types/git'
import type { ConversationStoreInstance } from '@/stores/conversationStore/types'
import { createLogger } from '@/utils/logger'

const log = createLogger('AtomicCommitChat')

/**
 * 只投喂低置信组的用户内容：
 * - 组清单：全部组（含高置信组目录，给 AI 全局观）
 * - diff 正文：仅低置信组文件走 formatGitDiffWithContent 裁剪注入
 */
export function buildAtomicCommitUserContent(
  groups: AtomicCommitGroup[],
  diffs: GitDiffEntry[],
  lowConfidenceOnly = true,
): string {
  const lowGroups = lowConfidenceOnly
    ? groups.filter((g) => g.confidence === 'low')
    : groups

  if (lowGroups.length === 0) {
    return '当前工作区变更为高置信分组，无需 AI 解释。'
  }

  const listLines = groups.map((g) =>
    `- [${g.confidence}] ${g.message}（${g.files.length} 个文件：${g.files.map((f) => f.path).join(', ')}）`
  ).join('\n')

  const lowSet = new Set(
    lowGroups.flatMap((g) => g.files.map((f) => f.path)),
  )
  const lowDiffs = diffs.filter((d) => lowSet.has(d.file_path))

  const listHeader = `全部组清单：\n${listLines}\n\n`

  return (
    '当前仓库有一揽子改动，本地预检已分组。以下是你需要解释的「低置信」组（跨目录/语义不清）：\n\n' +
    listHeader +
    `低置信组涉及 ${lowDiffs.length} 个文件，diff 内容如下（已按预算裁剪）：\n\n` +
    '=== diff 内容 ===\n\n' +
    formatGitDiffWithContent(lowDiffs) +
    '\n\n=== diff 内容结束 ===\n\n' +
    '请给出每组应如何拆分/合并的建议（如「目录 A 的 2 个文件应并入组 X」），' +
    '并说明理由。只输出建议，不要代码块标记。内容使用中文。'
  )
}

/** 一次性系统提示：约束 AI 只解释低置信分组，不重写整体分组。 */
export const ATOMIC_COMMIT_SYSTEM_PROMPT = `You are a Git commit planner. Given a proposed atomic-commit grouping, review ONLY the low-confidence groups and suggest concrete adjustments.

Rules:
1. High-confidence groups (directory-clustered, single change-type) are NOT your concern — do not touch them.
2. For each low-confidence group, decide: keep / merge into another group / split further.
3. Suggest a Conventional Commits message for each adjusted group.
4. Be concise. Respond with a bulleted plan. No code fences.`

export interface OpenAtomicCommitChatOptions {
  workspaceId: string
  workspacePath: string
  engineId: string
  groups: AtomicCommitGroup[]
  diffs: GitDiffEntry[]
  lowConfidenceOnly?: boolean
}

/**
 * 打开（或复用）git-atomic 会话并发送低置信组上下文。
 * 同一 workspace 仅维护一个 git-atomic 会话；返回会话 ID。
 */
export async function openAtomicCommitChat(
  options: OpenAtomicCommitChatOptions,
): Promise<string> {
  const { workspaceId, workspacePath, engineId, groups, diffs, lowConfidenceOnly = true } = options

  const manager = sessionStoreManager.getState()

  // 查找已存在的 git-atomic 会话（按 workspace 隔离）
  let sessionId: string | null = null
  for (const [id, meta] of manager.sessionMetadata) {
    if (meta.kind === 'git-atomic' && meta.commitWorkspaceId === workspaceId) {
      sessionId = id
      break
    }
  }

  if (sessionId) {
    log.info('复用 git-atomic 会话', { sessionId })
    manager.switchSession(sessionId)
  } else {
    sessionId = manager.createSession({
      type: 'project',
      workspaceId,
      contextWorkspaceIds: [workspaceId],
      workspaceLocked: true,
      engineId,
      title: '原子提交分组建议',
      kind: 'git-atomic',
      commitWorkspaceId: workspaceId,
    })
    log.info('新建 git-atomic 会话', { sessionId })
  }

  // 确保右侧 AI 面板展开
  const viewState = useViewStore.getState()
  if (viewState.rightPanelCollapsed) {
    viewState.toggleRightPanel()
  }

  const store = sessionStoreManager.getState().stores.get(sessionId)
  if (!store) {
    throw new Error('git-atomic 会话 store 不存在')
  }

  const userContent = buildAtomicCommitUserContent(groups, diffs, lowConfidenceOnly)
  await store.getState().sendMessage(userContent, workspacePath, undefined, {
    oneTimeSystemPrompt: ATOMIC_COMMIT_SYSTEM_PROMPT,
  })

  return sessionId
}

const EMPTY_SNAPSHOT: { text: string; isStreaming: boolean; sessionId: string | null } = {
  text: '',
  isStreaming: false,
  sessionId: null,
}

/**
 * 订阅指定 workspace 的 git-atomic 会话最新助手消息（「调整分组」回流）。
 */
export function useAtomicCommitSuggestion(workspaceId: string | null | undefined) {
  const stores = useStore(sessionStoreManager, (state) => state.stores)
  const sessionMetadata = useStore(sessionStoreManager, (state) => state.sessionMetadata)

  const sessionId = useMemo(() => {
    if (!workspaceId) return null
    for (const [id, meta] of sessionMetadata) {
      if (meta.kind === 'git-atomic' && meta.commitWorkspaceId === workspaceId) {
        return id
      }
    }
    return null
  }, [sessionMetadata, workspaceId])

  const store: ConversationStoreInstance | null = sessionId ? (stores.get(sessionId) ?? null) : null

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
      return sessionStoreManager.subscribe(onChange)
    }
    return store.subscribe(onChange)
  }

  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SNAPSHOT)
}