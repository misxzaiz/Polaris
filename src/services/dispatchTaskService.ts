/**
 * 派发任务服务
 *
 * 处理 polaris-dispatch MCP（dispatch_task 工具）发起的会话间任务委派：
 * 后端 ask_listener 收到 dispatch 帧后 emit `dispatch-task-request`，本服务
 * 监听该事件并：
 *   1. 创建静默后台会话（dispatch-{depth}-{id}，不抢占当前 Tab）
 *   2. 通过 start_chat 驱动引擎执行任务（复用 scheduler 的执行路径）
 *   3. 通过 eventRouter 把事件路由到该会话 Store（后台胶囊/完成通知复用现有机制）
 *   4. 会话结束时向后端回报状态与结果摘要（供 check_dispatched_task 查询）
 *
 * 引擎与工作区默认继承来源会话，派发方也可在工具参数中显式指定。
 */

import { listen, invoke } from '@/services/transport'
import { getEventRouter } from '@/services/eventRouter'
import { sessionStoreManager } from '@/stores/conversationStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { AIEvent } from '@/ai-runtime'
import type { ChatMessage } from '@/types/chat'
import { createLogger } from '@/utils/logger'
import i18n from '@/i18n'

const log = createLogger('DispatchTask')

/** dispatch-task-request 事件负载（与 ask_listener::emit_dispatch_request_event 对齐） */
export interface DispatchTaskRequestEvent {
  dispatchId: string
  /** 目标会话 ID，格式 dispatch-{depth}-{shortid} */
  sessionId: string
  /** 来源会话 ID（可能为空字符串） */
  sourceSessionId?: string | null
  prompt: string
  title?: string | null
  workDir?: string | null
  engineId?: string | null
}

/** 回报执行状态到后端注册表（失败仅记日志，不影响会话运行） */
async function reportStatus(
  dispatchId: string,
  status: 'running' | 'completed' | 'failed',
  summary?: string
): Promise<void> {
  try {
    await invoke('dispatch_report_status', { dispatchId, status, summary })
  } catch (e) {
    log.warn('回报派发状态失败', { dispatchId, status, error: String(e) })
  }
}

/** 从会话消息中提取最后一条助手回复文本，作为结果摘要 */
function extractSummary(sessionId: string): string | undefined {
  const store = sessionStoreManager.getState().stores.get(sessionId)
  if (!store) return undefined
  const messages: ChatMessage[] = store.getState().messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.type !== 'assistant') continue
    if (typeof msg.content === 'string' && msg.content.trim()) {
      return msg.content
    }
    const text = (msg.blocks || [])
      .filter((b): b is { type: 'text'; content: string } => b.type === 'text')
      .map((b) => b.content)
      .join('\n')
      .trim()
    if (text) return text
  }
  return undefined
}

/** 解析派发会话的工作区：显式 workDir > 来源会话工作区 > 当前工作区 */
function resolveWorkspace(event: DispatchTaskRequestEvent): {
  workDir: string | undefined
  workspaceId: string | undefined
} {
  if (event.workDir && event.workDir.trim()) {
    return { workDir: event.workDir.trim(), workspaceId: undefined }
  }

  const workspaceState = useWorkspaceStore.getState()
  const sourceSessionId = event.sourceSessionId || ''
  const sourceMeta = sessionStoreManager.getState().sessionMetadata.get(sourceSessionId)
  if (sourceMeta?.workspaceId) {
    const workspace = workspaceState.workspaces.find((w) => w.id === sourceMeta.workspaceId)
    if (workspace) {
      return { workDir: workspace.path, workspaceId: workspace.id }
    }
  }

  const current = workspaceState.getCurrentWorkspace()
  return { workDir: current?.path, workspaceId: current?.id }
}

/** 解析派发会话的引擎：显式 engineId > 来源会话引擎（createSession 内部再兜底全局默认） */
function resolveEngineId(event: DispatchTaskRequestEvent): string | undefined {
  if (event.engineId && event.engineId.trim()) {
    return event.engineId.trim()
  }
  const sourceSessionId = event.sourceSessionId || ''
  return sessionStoreManager.getState().sessionMetadata.get(sourceSessionId)?.engineId
}

/** 处理单个派发请求：创建静默会话 → 注册事件路由 → 启动引擎 → 回报状态 */
export async function handleDispatchTaskRequest(event: DispatchTaskRequestEvent): Promise<void> {
  const { dispatchId, sessionId, prompt } = event
  if (!dispatchId || !sessionId || !prompt?.trim()) {
    log.warn('派发请求缺少必要字段，忽略', { dispatchId, sessionId })
    return
  }

  const title = event.title?.trim() || i18n.t('chat:dispatch.defaultTitle', '派发任务')
  const { workDir, workspaceId } = resolveWorkspace(event)
  const engineId = resolveEngineId(event)

  log.info('收到派发请求', { dispatchId, sessionId, title, workDir, engineId })

  const manager = sessionStoreManager.getState()

  // 静默创建后台会话（不抢占当前 Tab）；加入 background 列表以获得
  // 完成 Toast/通知（dispatchEvent 的 session_end 分支）与 LRU 驱逐保护
  manager.createSession({
    id: sessionId,
    type: workspaceId ? 'project' : 'free',
    workspaceId,
    title,
    engineId,
    silentMode: true,
  })
  sessionStoreManager.getState().addToBackground(sessionId)

  // 事件路由：dispatch- contextId 事件转发到会话 Store；结束时回报状态
  const router = getEventRouter()
  await router.initialize()
  const unsubscribe = router.register(sessionId, (payload: unknown) => {
    const aiEvent = payload as AIEvent

    sessionStoreManager.getState().dispatchEvent({
      ...aiEvent,
      _routeSessionId: sessionId,
    } as AIEvent & { _routeSessionId: string })

    if (aiEvent.type === 'session_end') {
      // reason 正常为 'completed' | 'aborted'；中断/异常结束都视为未完成
      const reason = (aiEvent as { reason?: string }).reason
      const failed = reason !== undefined && reason !== 'completed'
      void reportStatus(
        dispatchId,
        failed ? 'failed' : 'completed',
        extractSummary(sessionId)
      )
      unsubscribe()
    } else if (aiEvent.type === 'error') {
      void reportStatus(dispatchId, 'failed', extractSummary(sessionId))
      unsubscribe()
    }
  })

  try {
    const conversationId = await invoke<string>('start_chat', {
      message: prompt,
      options: {
        workDir,
        contextId: sessionId,
        engineId,
        enableMcpTools: true,
      },
    })
    log.info('派发会话已启动', { dispatchId, sessionId, conversationId })
    void reportStatus(dispatchId, 'running')
  } catch (e) {
    log.error('派发会话启动失败', e instanceof Error ? e : new Error(String(e)), { dispatchId })
    unsubscribe()
    void reportStatus(
      dispatchId,
      'failed',
      e instanceof Error ? e.message : String(e)
    )
  }
}

/**
 * 安装派发请求监听（App 级常驻，useAppEvents 中调用）
 * 返回清理函数。
 */
export function initDispatchTaskListener(): () => void {
  const unlistenPromise = listen<DispatchTaskRequestEvent>(
    'dispatch-task-request',
    (event) => {
      void handleDispatchTaskRequest(event)
    }
  )

  return () => {
    unlistenPromise.then((unlisten) => unlisten())
  }
}
