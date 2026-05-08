import { getEventBus, type SessionEndEvent } from '@/ai-runtime'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { useWorkspaceStore } from '@/stores'
import type { ChatMessage, ContentBlock } from '@/types/chat'
import { createLogger } from '@/utils/logger'
import { finishLongGoalSession, listLongGoals } from './longGoalService'

const log = createLogger('LongGoalSessionTracker')

let unsubscribeSessionEnd: (() => void) | null = null
const finishingSessions = new Set<string>()

type RoutedSessionEndEvent = SessionEndEvent & {
  _routeSessionId?: string
}

export function startLongGoalSessionTracker(): () => void {
  if (unsubscribeSessionEnd) {
    return stopLongGoalSessionTracker
  }

  unsubscribeSessionEnd = getEventBus().on('session_end', (event) => {
    void handleSessionEnd(event as RoutedSessionEndEvent)
  }, { namespace: 'long-goal-session-tracker' })

  return stopLongGoalSessionTracker
}

export function stopLongGoalSessionTracker(): void {
  unsubscribeSessionEnd?.()
  unsubscribeSessionEnd = null
  finishingSessions.clear()
}

async function handleSessionEnd(event: RoutedSessionEndEvent): Promise<void> {
  const frontendSessionId = event._routeSessionId || event.sessionId
  if (!frontendSessionId || finishingSessions.has(frontendSessionId)) return

  const target = await findLongGoalBySession(frontendSessionId)
  if (!target) return

  finishingSessions.add(frontendSessionId)
  try {
    await finishLongGoalSession({
      workspacePath: target.workspacePath,
      goalId: target.goalId,
      sessionId: frontendSessionId,
      summary: buildSessionSummary(frontendSessionId),
      result: event.reason || 'success',
    })
    notifyLongGoalUpdated()
  } catch (error) {
    log.warn('长期目标会话结束写回失败', {
      sessionId: frontendSessionId,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    finishingSessions.delete(frontendSessionId)
  }
}

async function findLongGoalBySession(sessionId: string): Promise<{
  workspacePath: string
  goalId: string
} | null> {
  const workspaceState = useWorkspaceStore.getState()
  const metadata = sessionStoreManager.getState().sessionMetadata.get(sessionId)
  const workspaces = metadata?.workspaceId
    ? workspaceState.workspaces.filter((workspace) => workspace.id === metadata.workspaceId)
    : workspaceState.workspaces

  for (const workspace of workspaces) {
    try {
      const goals = await listLongGoals(workspace.path)
      const goal = goals.find((item) => item.config.currentSessionId === sessionId)
      if (goal) {
        return {
          workspacePath: workspace.path,
          goalId: goal.config.id,
        }
      }
    } catch (error) {
      log.warn('读取长期目标列表失败', {
        workspacePath: workspace.path,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return null
}

function buildSessionSummary(sessionId: string): string {
  const store = sessionStoreManager.getState().getStore(sessionId)
  const messages = store?.messages ?? []
  const assistantMessage = [...messages].reverse().find((message) => message.type === 'assistant')
  const content = assistantMessage ? messageToText(assistantMessage) : ''
  return content.trim() || `会话 ${sessionId} 已结束，但未捕获到助手摘要。`
}

function messageToText(message: ChatMessage): string {
  if ('content' in message && typeof message.content === 'string' && message.content.trim()) {
    return message.content
  }
  if ('blocks' in message && Array.isArray(message.blocks)) {
    return message.blocks.map(blockToText).filter(Boolean).join('\n\n')
  }
  if ('summary' in message && typeof message.summary === 'string') {
    return message.summary
  }
  return ''
}

function blockToText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
    case 'thinking':
      return block.content
    case 'agent_run':
      return block.output || block.progressMessage || block.error || ''
    case 'tool_group':
      return block.summary
    case 'plan_mode':
      return block.description || block.title || ''
    default:
      return ''
  }
}

function notifyLongGoalUpdated(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('long-goal:updated'))
  }
}
