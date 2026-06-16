/**
 * JSONL 编解码（纯函数，无副作用，可完整单元测试）
 *
 * 负责 DialogRecord ↔ JSONL 字符串的双向转换。
 * 这是根治"对话错乱"的核心：
 * - serialize 按数组顺序逐行写，并标注 seq
 * - parse 按 seq 排序还原，即使行顺序被打乱也能恢复正确顺序
 * - 坏行（解析失败/缺字段）安全跳过，不污染整个会话
 */

import type { ChatMessage } from '@/types'
import {
  DIALOG_FORMAT_VERSION,
  type DialogMeta,
  type DialogMessageLine,
  type DialogRecord,
} from './types'

/**
 * 将一条 ChatMessage 提取首条用户文本（用于 meta.firstUserText）
 */
export function extractFirstUserText(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.type === 'user')
  if (firstUser && 'content' in firstUser && typeof firstUser.content === 'string') {
    return firstUser.content.slice(0, 200)
  }
  return ''
}

/**
 * 从消息列表提取标签（assistant.blocks 中的 tool_call 名称 + tool/tool_group 名称）
 */
export function extractTags(messages: ChatMessage[]): string[] {
  const tagSet = new Set<string>()
  for (const msg of messages) {
    if (msg.type === 'assistant' && Array.isArray(msg.blocks)) {
      for (const block of msg.blocks) {
        if (block.type === 'tool_call' && block.name) tagSet.add(block.name)
      }
    } else if (msg.type === 'tool' && msg.toolName) {
      tagSet.add(msg.toolName)
    } else if (msg.type === 'tool_group' && Array.isArray(msg.toolNames)) {
      for (const name of msg.toolNames) tagSet.add(name)
    }
  }
  return [...tagSet]
}

/**
 * 构建 DialogMeta
 */
export function buildMeta(input: {
  externalId: string
  engineId: DialogMeta['engineId']
  title: string
  workspaceId?: string | null
  workspacePath?: string | null
  messages: ChatMessage[]
  createdAt?: string
  updatedAt?: string
}): DialogMeta {
  const now = new Date().toISOString()
  return {
    v: DIALOG_FORMAT_VERSION,
    type: 'meta',
    externalId: input.externalId,
    engineId: input.engineId,
    title: input.title,
    workspaceId: input.workspaceId ?? null,
    workspacePath: input.workspacePath ?? null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    messageCount: input.messages.length,
    firstUserText: extractFirstUserText(input.messages),
    tags: extractTags(input.messages),
  }
}

/**
 * 序列化为 JSONL 字符串
 *
 * 第一行 meta，后续每行一条消息（带 seq）。
 * 每行末尾用 \n 分隔，最后不留多余空行。
 */
export function serializeDialog(meta: DialogMeta, messages: ChatMessage[]): string {
  const lines: string[] = []
  lines.push(JSON.stringify(meta))
  for (let i = 0; i < messages.length; i++) {
    const line: DialogMessageLine = { type: 'msg', seq: i, message: messages[i] }
    lines.push(JSON.stringify(line))
  }
  return lines.join('\n')
}

/**
 * 解析 JSONL 字符串为 DialogRecord
 *
 * 容错策略：
 * - 跳过空行和解析失败的行
 * - meta 行缺失时返回 null（视为无效会话）
 * - 消息行按 seq 升序排序；缺 seq 的按出现顺序兜底
 */
export function parseDialog(jsonl: string): DialogRecord | null {
  if (!jsonl || !jsonl.trim()) return null

  const rawLines = jsonl.split('\n')
  let meta: DialogMeta | null = null
  const msgLines: DialogMessageLine[] = []

  let fallbackSeq = 0
  for (const raw of rawLines) {
    const trimmed = raw.trim()
    if (!trimmed) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // 坏行跳过，不影响其余消息
      continue
    }

    if (!parsed || typeof parsed !== 'object') continue
    const obj = parsed as Record<string, unknown>

    if (obj.type === 'meta') {
      meta = normalizeMeta(obj)
    } else if (obj.type === 'msg' && obj.message && typeof obj.message === 'object') {
      const seq = typeof obj.seq === 'number' ? obj.seq : fallbackSeq
      msgLines.push({ type: 'msg', seq, message: obj.message as ChatMessage })
      fallbackSeq++
    }
  }

  if (!meta) return null

  // 按 seq 升序排序，保证顺序正确（核心：根治错乱）
  msgLines.sort((a, b) => a.seq - b.seq)
  const messages = msgLines
    .map((l) => l.message)
    .filter((m): m is ChatMessage => isValidMessage(m))

  // 用实际解析出的消息数修正 messageCount
  meta.messageCount = messages.length

  return { meta, messages }
}

/**
 * 仅解析 meta 行（用于列表展示，避免读取/解析全部消息）
 *
 * 优化：只需读到第一行 meta 即可返回，无需解析后续消息行。
 */
export function parseMeta(jsonl: string): DialogMeta | null {
  if (!jsonl || !jsonl.trim()) return null
  const firstNewline = jsonl.indexOf('\n')
  const firstLine = (firstNewline === -1 ? jsonl : jsonl.slice(0, firstNewline)).trim()
  if (!firstLine) return null
  try {
    const obj = JSON.parse(firstLine) as Record<string, unknown>
    if (obj && obj.type === 'meta') return normalizeMeta(obj)
  } catch {
    return null
  }
  return null
}

// ============================================================================
// 内部辅助
// ============================================================================

/** 规范化 meta 对象，补全缺失字段，防止脏数据 */
function normalizeMeta(obj: Record<string, unknown>): DialogMeta {
  return {
    v: typeof obj.v === 'number' ? obj.v : DIALOG_FORMAT_VERSION,
    type: 'meta',
    externalId: String(obj.externalId ?? ''),
    engineId: (obj.engineId as DialogMeta['engineId']) ?? 'claude-code',
    title: String(obj.title ?? '未命名会话'),
    workspaceId: (obj.workspaceId as string | null) ?? null,
    workspacePath: (obj.workspacePath as string | null) ?? null,
    createdAt: String(obj.createdAt ?? new Date().toISOString()),
    updatedAt: String(obj.updatedAt ?? new Date().toISOString()),
    messageCount: typeof obj.messageCount === 'number' ? obj.messageCount : 0,
    firstUserText: typeof obj.firstUserText === 'string' ? obj.firstUserText : undefined,
    tags: Array.isArray(obj.tags) ? (obj.tags as string[]) : undefined,
  }
}

/** 校验消息结构有效性（防止脏数据注入恢复流程） */
function isValidMessage(msg: unknown): msg is ChatMessage {
  if (!msg || typeof msg !== 'object') return false
  const m = msg as Record<string, unknown>
  if (typeof m.id !== 'string' || typeof m.type !== 'string') return false
  // assistant 必须有 blocks 数组
  if (m.type === 'assistant') return Array.isArray(m.blocks)
  // user/system 必须有 content
  if (m.type === 'user' || m.type === 'system') return typeof m.content === 'string'
  // tool/tool_group 放行（结构由上层保证）
  return m.type === 'tool' || m.type === 'tool_group'
}
