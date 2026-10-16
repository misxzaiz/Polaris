/**
 * jsonlCodec 单元测试
 *
 * 重点验证"根治对话错乱"的核心保证：
 * - 序列化/反序列化无损往返
 * - 消息顺序在任何情况下都正确（含行被打乱的极端情况）
 * - 坏数据容错
 */

import { describe, it, expect } from 'vitest'
import {
  serializeDialog,
  parseDialog,
  parseMeta,
  buildMeta,
  extractFirstUserText,
  extractTags,
  parseDialogLines,
  dedupeAssistantByContent,
} from './jsonlCodec'
import { DIALOG_FORMAT_VERSION } from './types'
import type {
  ChatMessage,
  UserChatMessage,
  AssistantChatMessage,
  SystemChatMessage,
  ToolChatMessage,
  ToolGroupChatMessage,
} from '@/types'

// ============================================================================
// 测试数据构造
// ============================================================================

function userMsg(id: string, content: string): UserChatMessage {
  return { id, type: 'user', timestamp: '2026-06-16T00:00:00.000Z', content }
}

function assistantMsg(id: string, text: string, toolName?: string): AssistantChatMessage {
  const blocks: AssistantChatMessage['blocks'] = [{ type: 'text', content: text }]
  if (toolName) {
    blocks.push({
      type: 'tool_call',
      id: `tc-${id}`,
      name: toolName,
      input: { foo: 'bar' },
      status: 'completed',
      startedAt: '2026-06-16T00:00:01.000Z',
    })
  }
  return { id, type: 'assistant', timestamp: '2026-06-16T00:00:02.000Z', blocks, engineId: 'claude-code' }
}

function systemMsg(id: string, content: string): SystemChatMessage {
  return { id, type: 'system', timestamp: '2026-06-16T00:00:00.000Z', content }
}

function toolMsg(id: string, toolName: string): ToolChatMessage {
  return {
    id,
    type: 'tool',
    timestamp: '2026-06-16T00:00:03.000Z',
    toolId: `tid-${id}`,
    toolName,
    status: 'completed',
    summary: `ran ${toolName}`,
    startedAt: '2026-06-16T00:00:03.000Z',
  }
}

function toolGroupMsg(id: string, names: string[]): ToolGroupChatMessage {
  return {
    id,
    type: 'tool_group',
    timestamp: '2026-06-16T00:00:04.000Z',
    toolIds: names.map((_, i) => `tg-${id}-${i}`),
    toolNames: names,
    status: 'completed',
    summary: `ran ${names.length} tools`,
    startedAt: '2026-06-16T00:00:04.000Z',
  }
}

const META_BASE = {
  externalId: 'conv-1',
  engineId: 'claude-code' as const,
  title: '测试会话',
}

// ============================================================================
// 往返保真
// ============================================================================

describe('jsonlCodec - 往返保真', () => {
  it('user + assistant(带 blocks) 序列化后能无损还原', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', '你好'),
      assistantMsg('a1', '你好，有什么可以帮你？', 'Read'),
    ]
    const meta = buildMeta({ ...META_BASE, messages })
    const jsonl = serializeDialog(meta, messages)
    const parsed = parseDialog(jsonl)

    expect(parsed).not.toBeNull()
    expect(parsed!.messages).toEqual(messages)
    expect(parsed!.meta.externalId).toBe('conv-1')
    expect(parsed!.meta.title).toBe('测试会话')
  })

  it('所有消息类型都能往返', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', '问题'),
      assistantMsg('a1', '思考中', 'Bash'),
      systemMsg('s1', '系统提示'),
      toolMsg('t1', 'Grep'),
      toolGroupMsg('g1', ['Read', 'Edit']),
    ]
    const meta = buildMeta({ ...META_BASE, messages })
    const parsed = parseDialog(serializeDialog(meta, messages))
    expect(parsed!.messages).toEqual(messages)
  })

  it('特殊字符（换行/引号/emoji/中文）无损', () => {
    const tricky = '行1\n行2 "引号" \\反斜杠\\ 🎉 中文'
    const messages: ChatMessage[] = [userMsg('u1', tricky)]
    const meta = buildMeta({ ...META_BASE, messages })
    const parsed = parseDialog(serializeDialog(meta, messages))
    expect((parsed!.messages[0] as UserChatMessage).content).toBe(tricky)
  })

  it('消息内容含换行不会破坏 JSONL 行结构', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'line A\nline B\nline C'),
      userMsg('u2', 'next'),
    ]
    const meta = buildMeta({ ...META_BASE, messages })
    const jsonl = serializeDialog(meta, messages)
    // JSON.stringify 会转义 \n，所以物理行数 = meta(1) + 消息数(2)
    expect(jsonl.split('\n').length).toBe(3)
    const parsed = parseDialog(jsonl)
    expect(parsed!.messages.length).toBe(2)
  })
})

// ============================================================================
// 顺序保证（核心：根治错乱）
// ============================================================================

describe('jsonlCodec - 顺序保证', () => {
  it('10 条消息 parse 后顺序与原始一致', () => {
    const messages: ChatMessage[] = []
    for (let i = 0; i < 10; i++) {
      messages.push(i % 2 === 0 ? userMsg(`u${i}`, `msg ${i}`) : assistantMsg(`a${i}`, `reply ${i}`))
    }
    const meta = buildMeta({ ...META_BASE, messages })
    const parsed = parseDialog(serializeDialog(meta, messages))
    expect(parsed!.messages.map((m) => m.id)).toEqual(messages.map((m) => m.id))
  })

  it('即使 JSONL 行被打乱，也能按 seq 还原正确顺序', () => {
    const messages: ChatMessage[] = [
      userMsg('u0', '第一'),
      assistantMsg('a1', '第二'),
      userMsg('u2', '第三'),
      assistantMsg('a3', '第四'),
    ]
    const meta = buildMeta({ ...META_BASE, messages })
    const jsonl = serializeDialog(meta, messages)

    // 打乱消息行顺序（保留 meta 在首行）
    const lines = jsonl.split('\n')
    const metaLine = lines[0]
    const msgLines = lines.slice(1)
    const shuffled = [msgLines[2], msgLines[0], msgLines[3], msgLines[1]]
    const shuffledJsonl = [metaLine, ...shuffled].join('\n')

    const parsed = parseDialog(shuffledJsonl)
    // 按 seq 还原后顺序应正确
    expect(parsed!.messages.map((m) => m.id)).toEqual(['u0', 'a1', 'u2', 'a3'])
  })
})

// ============================================================================
// 容错
// ============================================================================

describe('jsonlCodec - 容错', () => {
  it('坏行（非法 JSON）被跳过，不影响其余消息', () => {
    const messages: ChatMessage[] = [userMsg('u1', 'A'), userMsg('u2', 'B')]
    const meta = buildMeta({ ...META_BASE, messages })
    const jsonl = serializeDialog(meta, messages)
    const lines = jsonl.split('\n')
    // 插入坏行和空行
    const polluted = [lines[0], '{ 坏 json', lines[1], '', '   ', lines[2]].join('\n')

    const parsed = parseDialog(polluted)
    expect(parsed!.messages.map((m) => m.id)).toEqual(['u1', 'u2'])
  })

  it('无 meta 行返回 null', () => {
    const onlyMsg = JSON.stringify({ type: 'msg', seq: 0, message: userMsg('u1', 'x') })
    expect(parseDialog(onlyMsg)).toBeNull()
  })

  it('空字符串返回 null', () => {
    expect(parseDialog('')).toBeNull()
    expect(parseDialog('   \n  ')).toBeNull()
  })

  it('messageCount 被修正为实际解析出的消息数', () => {
    const messages: ChatMessage[] = [userMsg('u1', 'A'), userMsg('u2', 'B')]
    const meta = buildMeta({ ...META_BASE, messages })
    meta.messageCount = 999 // 故意写错
    const parsed = parseDialog(serializeDialog(meta, messages))
    expect(parsed!.meta.messageCount).toBe(2)
  })

  it('结构非法的消息被过滤（assistant 缺 blocks）', () => {
    const meta = buildMeta({ ...META_BASE, messages: [] })
    const badAssistant = JSON.stringify({
      type: 'msg',
      seq: 0,
      message: { id: 'bad', type: 'assistant', timestamp: 't' }, // 缺 blocks
    })
    const goodUser = JSON.stringify({ type: 'msg', seq: 1, message: userMsg('u1', 'ok') })
    const jsonl = [JSON.stringify(meta), badAssistant, goodUser].join('\n')
    const parsed = parseDialog(jsonl)
    expect(parsed!.messages.map((m) => m.id)).toEqual(['u1'])
  })
})

// ============================================================================
// parseMeta
// ============================================================================

describe('jsonlCodec - parseMeta', () => {
  it('只读第一行 meta，不解析消息', () => {
    const messages: ChatMessage[] = [userMsg('u1', 'A'), assistantMsg('a1', 'B')]
    const meta = buildMeta({ ...META_BASE, messages })
    const jsonl = serializeDialog(meta, messages)
    const parsedMeta = parseMeta(jsonl)
    expect(parsedMeta!.externalId).toBe('conv-1')
    expect(parsedMeta!.messageCount).toBe(2)
  })

  it('首行非 meta 返回 null', () => {
    expect(parseMeta(JSON.stringify({ type: 'msg', seq: 0 }))).toBeNull()
  })
})

// ============================================================================
// 分析列抽取
// ============================================================================

describe('jsonlCodec - 分析列', () => {
  it('extractFirstUserText 取首条用户消息', () => {
    const messages: ChatMessage[] = [
      assistantMsg('a0', 'hi'),
      userMsg('u1', '这是第一个用户问题'),
      userMsg('u2', '第二个'),
    ]
    expect(extractFirstUserText(messages)).toBe('这是第一个用户问题')
  })

  it('extractFirstUserText 截断到 200 字符', () => {
    const long = 'x'.repeat(500)
    expect(extractFirstUserText([userMsg('u1', long)]).length).toBe(200)
  })

  it('extractTags 收集工具名（assistant blocks + tool + tool_group），去重', () => {
    const messages: ChatMessage[] = [
      assistantMsg('a1', 'do', 'Read'),
      toolMsg('t1', 'Bash'),
      toolGroupMsg('g1', ['Read', 'Edit']), // Read 重复
    ]
    const tags = extractTags(messages)
    expect(tags).toContain('Read')
    expect(tags).toContain('Bash')
    expect(tags).toContain('Edit')
    expect(tags.filter((t) => t === 'Read').length).toBe(1) // 去重
  })

  it('buildMeta 填充 messageCount / firstUserText / tags', () => {
    const messages: ChatMessage[] = [userMsg('u1', '问题'), assistantMsg('a1', '答', 'Grep')]
    const meta = buildMeta({ ...META_BASE, messages })
    expect(meta.messageCount).toBe(2)
    expect(meta.firstUserText).toBe('问题')
    expect(meta.tags).toContain('Grep')
    expect(meta.v).toBe(DIALOG_FORMAT_VERSION)
    expect(meta.type).toBe('meta')
  })
})

// ============================================================================
// Phase 0：assistant 内容指纹去重（根治「重复 AI 回复」）
// ============================================================================

describe('jsonlCodec - assistant 内容指纹去重', () => {
  it('同内容不同 id 收敛为一条（保留最后一条）', () => {
    const lines = [
      { type: 'msg' as const, seq: 0, message: assistantMsg('id-1', '重复回复') },
      { type: 'msg' as const, seq: 1, message: assistantMsg('id-2', '重复回复') },
    ]
    const result = dedupeAssistantByContent(lines)
    expect(result).toHaveLength(1)
    expect(result[0].message.id).toBe('id-2')
  })

  it('保留首次出现的位置（顺序稳定）', () => {
    const lines = [
      { type: 'msg' as const, seq: 0, message: userMsg('u1', '问') },
      { type: 'msg' as const, seq: 1, message: assistantMsg('id-1', '复') },
      { type: 'msg' as const, seq: 2, message: assistantMsg('id-2', '复') },
      { type: 'msg' as const, seq: 3, message: userMsg('u2', '追问') },
    ]
    const result = dedupeAssistantByContent(lines)
    expect(result.map((l) => l.message.id)).toEqual(['u1', 'id-2', 'u2'])
  })

  it('不同内容的 assistant 都保留', () => {
    const lines = [
      { type: 'msg' as const, seq: 0, message: assistantMsg('a1', '内容A') },
      { type: 'msg' as const, seq: 1, message: assistantMsg('a2', '内容B') },
    ]
    const result = dedupeAssistantByContent(lines)
    expect(result).toHaveLength(2)
  })

  it('流式快照(st=True) + 完成版(st=False) 同内容收敛为完成版', () => {
    const streaming = { ...assistantMsg('same-id', '回复'), isStreaming: true }
    const done = { ...assistantMsg('same-id', '回复'), isStreaming: false }
    const lines = [
      { type: 'msg' as const, seq: 0, message: streaming },
      { type: 'msg' as const, seq: 1, message: done },
    ]
    const result = dedupeAssistantByContent(lines)
    expect(result).toHaveLength(1)
    expect((result[0].message as AssistantChatMessage).isStreaming).toBe(false)
  })

  it('实测场景：3 个不同 id 同内容收敛为 1', () => {
    const lines = [
      { type: 'msg' as const, seq: 0, message: assistantMsg('b045bc1d', '你好，我是 Polaris') },
      { type: 'msg' as const, seq: 1, message: assistantMsg('41b1597c', '你好，我是 Polaris') },
      { type: 'msg' as const, seq: 2, message: assistantMsg('3bdf9456', '你好，我是 Polaris') },
    ]
    const result = dedupeAssistantByContent(lines)
    expect(result).toHaveLength(1)
    expect(result[0].message.id).toBe('3bdf9456')
  })

  it('空指纹（无 text 块）的 assistant 不参与去重', () => {
    const empty1: AssistantChatMessage = {
      id: 'e1', type: 'assistant', timestamp: 't', engineId: 'e',
      blocks: [{ type: 'tool_call', id: 'tc1', name: 'bash', input: {}, status: 'completed' }],
    }
    const empty2: AssistantChatMessage = { ...empty1, id: 'e2' }
    const lines = [
      { type: 'msg' as const, seq: 0, message: empty1 },
      { type: 'msg' as const, seq: 1, message: empty2 },
    ]
    const result = dedupeAssistantByContent(lines)
    expect(result).toHaveLength(2)
  })

  it('幂等：无重复时原样返回', () => {
    const lines = [
      { type: 'msg' as const, seq: 0, message: userMsg('u1', 'q') },
      { type: 'msg' as const, seq: 1, message: assistantMsg('a1', '回复A') },
      { type: 'msg' as const, seq: 2, message: assistantMsg('a2', '回复B') },
    ]
    const result = dedupeAssistantByContent(lines)
    expect(result.map((l) => l.message.id)).toEqual(['u1', 'a1', 'a2'])
  })

  it('parseDialogLines 端到端：磁盘同内容多 id 经解析后收敛', () => {
    const meta = buildMeta({
      ...META_BASE,
      messages: [assistantMsg('id-1', '重复回复')],
    })
    const jsonl = [
      JSON.stringify(meta),
      JSON.stringify({ type: 'msg', seq: 0, message: assistantMsg('id-1', '重复回复') }),
      JSON.stringify({ type: 'msg', seq: 1, message: assistantMsg('id-2', '重复回复') }),
      JSON.stringify({ type: 'msg', seq: 2, message: assistantMsg('id-3', '重复回复') }),
    ].join('\n')
    const result = parseDialogLines(jsonl)
    expect(result).not.toBeNull()
    expect(result!.lines).toHaveLength(1)
    expect(result!.lines[0].message.id).toBe('id-3')
  })
})
