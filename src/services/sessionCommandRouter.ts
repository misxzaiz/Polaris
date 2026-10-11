/**
 * 会话统一仲裁命令层（S4 · 对齐 ZCode CommandInbox + owner-lease）
 *
 * 封装 send/interrupt/resume 三个语义化命令，带 requestId（幂等键）+
 * deviceId（端级标识），返回 accepted/reason。
 *
 * 设计（spec §3.1 / §3.3）：
 * - 前端不再自决「能否发送」，统一走 cap.ai.chat + 后端仲裁
 * - accepted=true → 乐观应用（帧到达为准，与 S3 乐观合并一致）
 * - accepted=false → UI 显示 reason（already_running / not_owner 等）
 * - requestId 幂等：同 requestId 重发不双写，返回原结果
 *
 * 当前阶段（S4 前端层）：
 * - 命令仍走现有 cap.ai.chat action（start/continue/interrupt）
 * - requestId/deviceId 作为 payload 透传，后端仲裁接入后生效
 * - 乐观 UI 保留（accepted=true 立即回显）
 *
 * 后端仲裁接入（S4 后端阶段，spec §3.2）：
 * - start → request_start(conversationId, deviceId) → running 则 already_running
 * - interrupt → request_interrupt(conversationId, deviceId) → 非 owner 则 not_owner
 */

import { aiChatDispatch, aiChatDispatchStream } from '@/services/aiChatDispatch'
import { getDeviceId, newRequestId } from '@/utils/deviceId'
import { createLogger } from '@/utils/logger'

const log = createLogger('SessionCommandRouter')

// ============================================================================
// 类型
// ============================================================================

/** 仲裁结果：accepted=true 表示命令被接受，false 表示被拒绝（含 reason） */
export interface ArbitrateResult {
  accepted: boolean
  reason?: string
  ticketId?: string
  /** 幂等键回显（同 requestId 重发返回原结果） */
  requestId: string
}

/** 发送参数 */
export interface SessionSendParams {
  sessionId: string
  conversationId?: string
  message: string
  workspaceDir?: string
  attachments?: unknown[]
  sendOptions?: unknown
  /** 续聊标记（true 走 continue action，false 走 start） */
  continue?: boolean
}

/** 中断参数 */
export interface SessionInterruptParams {
  sessionId: string
  conversationId?: string
}

// ============================================================================
// 命令实现
// ============================================================================

/**
 * 统一发送/继续命令（带仲裁语义）。
 *
 * - continue=false → cap.ai.chat action=start
 * - continue=true  → cap.ai.chat action=continue
 *
 * 返回 accepted=true 时可乐观回显；accepted=false 时 UI 提示 reason。
 */
export async function sessionSend(params: SessionSendParams): Promise<ArbitrateResult> {
  const requestId = newRequestId()
  const deviceId = getDeviceId()
  const action = params.continue ? 'continue' : 'start'

  try {
    const ack = await aiChatDispatchStream({
      action,
      message: params.message,
      sessionId: params.sessionId,
      conversationId: params.conversationId,
      workspaceDir: params.workspaceDir,
      attachments: params.attachments,
      sendOptions: params.sendOptions,
      // 仲裁字段（后端接入后生效）
      requestId,
      deviceId,
    })

    log.info('sessionSend accepted', { action, sessionId: params.sessionId, requestId, msgId: ack.msgId })
    return {
      accepted: true,
      ticketId: ack.msgId,
      requestId,
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    log.warn('sessionSend rejected', { action, sessionId: params.sessionId, requestId, reason })

    // 识别已运行错误（后端仲裁接入后会返回明确 reason）
    const isAlreadyRunning = reason.includes('already_running') || reason.includes('正在运行')
    return {
      accepted: false,
      reason: isAlreadyRunning ? 'already_running' : reason,
      requestId,
    }
  }
}

/**
 * 统一中断命令（带 owner 校验语义）。
 *
 * 后端仲裁（S4 后端阶段）：
 * - running 且 startedByDevice == deviceId → 停
 * - 非 owner → not_owner（可配置允许任何端停）
 */
export async function sessionInterrupt(params: SessionInterruptParams): Promise<ArbitrateResult> {
  const requestId = newRequestId()
  const deviceId = getDeviceId()

  try {
    const result = await aiChatDispatch<{ interrupted?: boolean }>({
      action: 'interrupt',
      sessionId: params.sessionId,
      conversationId: params.conversationId,
      requestId,
      deviceId,
    })

    log.info('sessionInterrupt accepted', { sessionId: params.sessionId, requestId })
    return {
      accepted: result?.interrupted !== false,
      requestId,
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    log.warn('sessionInterrupt rejected', { sessionId: params.sessionId, requestId, reason })

    const isNotOwner = reason.includes('not_owner') || reason.includes('无权限')
    const isNotRunning = reason.includes('not_running') || reason.includes('未运行')
    return {
      accepted: false,
      reason: isNotOwner ? 'not_owner' : isNotRunning ? 'not_running' : reason,
      requestId,
    }
  }
}

/**
 * 统一续聊/重试命令（幂等：同 requestId 返回原结果）。
 *
 * 复用 sessionSend（continue=true），额外带 resumeFromSeq（可选）。
 */
export async function sessionResume(
  params: SessionSendParams & { resumeFromSeq?: number },
): Promise<ArbitrateResult> {
  const requestId = newRequestId()
  const deviceId = getDeviceId()

  try {
    const ack = await aiChatDispatchStream({
      action: 'continue',
      message: params.message,
      sessionId: params.sessionId,
      conversationId: params.conversationId,
      workspaceDir: params.workspaceDir,
      attachments: params.attachments,
      sendOptions: params.sendOptions,
      requestId,
      deviceId,
      resumeFromSeq: params.resumeFromSeq,
    })

    log.info('sessionResume accepted', { sessionId: params.sessionId, requestId, msgId: ack.msgId })
    return {
      accepted: true,
      ticketId: ack.msgId,
      requestId,
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    log.warn('sessionResume rejected', { sessionId: params.sessionId, requestId, reason })
    return {
      accepted: false,
      reason,
      requestId,
    }
  }
}
