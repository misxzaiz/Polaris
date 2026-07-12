/**
 * ConversationPackager 类型定义
 *
 * 把「源对话」打包成「目标引擎可消费的上下文产物」。
 * 核心目标是控制新会话初始上下文体积：默认只注入摘要，全文落盘但不主动注入，
 * 仅在源对话较短时才直注全文，避免上下文膨胀。
 *
 * 四种打包模式：
 * - fork          同引擎 + 目标支持 fork：引擎原生续接，不占额外上下文（结构完整）
 * - full-file     源较短：全文落盘并主动 @ 引用注入（本身小，无负担）
 * - message-history 仅 simple-ai 目标 + 中等长度：走 SessionOptions.message_history 直注
 * - summary       默认兜底：只注入结构化摘要（~2k token），全文落盘作回查库
 */

import type { EngineId } from '@/types'
import type { ChatMessage } from '@/types/chat'

/** 打包模式 */
export type TransferMode = 'summary' | 'full-file' | 'message-history' | 'fork'

/** 模式决策入参 */
export interface TransferModeInput {
  /** 源会话引擎（归一化前亦可，内部会 normalize） */
  sourceEngineId: EngineId
  /** 目标会话引擎 */
  targetEngineId: EngineId
  /** 源对话消息数 */
  messageCount: number
  /** 源对话预估 token 数 */
  estimatedTokens: number
}

/** 源对话元信息（用于审计与 UI 展示） */
export interface PackSourceMeta {
  /** 源前端会话 ID（live session 场景） */
  sessionId?: string
  /** 源后端 conversationId（CLI 原生历史场景） */
  conversationId?: string
  /** 源引擎（归一化后） */
  engineId: EngineId
  /** 源会话标题 */
  title: string
  /** 源对话消息数 */
  messageCount: number
}

/** 文件引用产物（full-file / summary 模式都会落盘，区别在于是否主动注入） */
export interface PackFileRef {
  /** 绝对路径 */
  absPath: string
  /** 相对工作区根的路径（用于 @ 引用展示） */
  relPath: string
  /** 产物预估 token 数 */
  tokenEstimate: number
}

/** 打包产物 */
export interface ConversationPack {
  /** 实际采用的打包模式 */
  mode: TransferMode
  /** 源对话元信息 + 快照时间戳 */
  source: PackSourceMeta & {
    /** 快照时间戳（ms），标注「基于截止此刻的内容」 */
    snapshotAt: number
  }
  /** 落盘文件引用（full-file 主动注入；summary 仅作回查库不主动注入） */
  fileRef?: PackFileRef
  /** message-history 模式：直注 SessionOptions.message_history（仅 simple-ai 消费） */
  messageHistory?: ChatMessage[]
  /** fork 模式：源会话 id，作为 forkSessionId 传入 start_chat */
  forkSessionId?: string
  /** summary 模式：结构化摘要文本（默认注入这个，控制上下文体积） */
  summary?: {
    text: string
    tokenEstimate: number
  }
}

/** packToFile 的返回（PR1 仅暴露文件打包能力，PR2 的 pack() 在此基础上编排） */
export interface PackToFileResult {
  fileRef: PackFileRef
  /** 落盘的 markdown 全文（供 summary 模式作为总结输入复用） */
  markdown: string
}
