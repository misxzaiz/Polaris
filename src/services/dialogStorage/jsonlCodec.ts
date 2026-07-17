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
 * 提取最后一条消息摘要（用于列表预览：续聊场景「上次聊到哪」比首条消息更有用）
 * 优先 assistant 末条 text block，其次 user content；压缩成单行、截 160 字。
 */
export function extractPreview(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    let text = ''
    if (msg.type === 'assistant' && Array.isArray(msg.blocks)) {
      for (let j = msg.blocks.length - 1; j >= 0; j--) {
        const block = msg.blocks[j]
        if (block.type === 'text' && block.content?.trim()) {
          text = block.content
          break
        }
      }
    } else if (msg.type === 'user' && typeof msg.content === 'string') {
      text = msg.content
    }
    if (text.trim()) {
      return text.trim().replace(/\s+/g, ' ').slice(0, 160)
    }
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
    preview: extractPreview(input.messages),
    tags: extractTags(input.messages),
  }
}

/** 序列化单条消息行（增量 append 用） */
export function serializeMessageLine(message: ChatMessage, seq: number): string {
  const line: DialogMessageLine = { type: 'msg', seq, message }
  return JSON.stringify(line)
}

/** 解析单条消息行（分页读取用）；坏行/非消息行返回 null */
export function parseMessageLine(raw: string): DialogMessageLine | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>
    if (obj?.type !== 'msg' || !obj.message || typeof obj.message !== 'object') return null
    const message = obj.message as ChatMessage
    if (!isValidMessage(message)) return null
    return {
      type: 'msg',
      seq: typeof obj.seq === 'number' ? obj.seq : 0,
      message,
    }
  } catch {
    return null
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
  const parsed = parseDialogLines(jsonl)
  if (!parsed) return null
  const messages = parsed.lines.map((l) => l.message)
  parsed.meta.messageCount = messages.length
  return { meta: parsed.meta, messages }
}

/**
 * 解析 JSONL 为 meta + 带 seq 的有序消息行（保留 seq，供分页/合并使用）。
 * 排序 + 按消息 id 去重（后写的行代表更新状态，保留首次出现位置 + 最后内容）。
 */
export function parseDialogLines(
  jsonl: string,
): { meta: DialogMeta; lines: DialogMessageLine[] } | null {
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
      if (!meta) meta = normalizeMeta(obj)
    } else if (obj.type === 'msg' && obj.message && typeof obj.message === 'object') {
      const seq = typeof obj.seq === 'number' ? obj.seq : fallbackSeq
      msgLines.push({ type: 'msg', seq, message: obj.message as ChatMessage })
      fallbackSeq++
    }
  }

  if (!meta) return null

  // 按 seq 升序排序，保证顺序正确（核心：根治错乱）
  msgLines.sort((a, b) => a.seq - b.seq)

  // 按消息 id 去重：WAL 式增量 append 与轮末整体覆写并存时，同一条消息可能出现
  // 多行（append 竞速 rewrite）。保留「首次出现的位置 + 最后一次出现的内容」。
  const byId = new Map<string, DialogMessageLine>()
  for (const l of msgLines) {
    if (!isValidMessage(l.message)) continue
    const existing = byId.get(l.message.id)
    if (existing) {
      existing.message = l.message
    } else {
      byId.set(l.message.id, { ...l })
    }
  }

  return { meta, lines: [...byId.values()] }
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
    preview: typeof obj.preview === 'string' ? obj.preview : undefined,
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
