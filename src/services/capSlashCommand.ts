/**
 * capSlashCommand —— /cap 斜杠命令的纯逻辑（解析 / 匹配 / 注入块构造）
 *
 * 数据地基：cap describe 契约归一（07c9f1c0）后，cap.help index 返回的每个
 * 能力都带标准形状 describe `{id, name中文短名, summary, note?, actions}`。
 * 本文件只做文本变换，不做第二份协议文档——注入块内容全部实时来自 cap.help，
 * 前端缓存（capCatalogStore）仅省一次 IPC 往返。
 *
 * 语义：
 * - `/cap`            → 全量紧凑速查（id + 中文短名 + summary 一行）
 * - `/cap <查询> 正文` → 查询唯一命中时注入该能力完整 describe 协议
 * - 查询命中顺序：id 精确 > 中文名精确 > id 后缀 > 子串
 */

import type { ContextBlock } from '@/stores/conversationStore/types'

/** 目录条目（capCatalogStore 从 cap.help index 解析而来） */
export interface CapCatalogEntry {
  /** cap id，如 cap.todo */
  id: string
  /** 中文短名（describe.name），缺省回退 id 本身 */
  name: string
  /** 一句话说明（describe.summary） */
  summary: string
  /** 是否流式能力（cap_dispatch 同步不可调，注入块中标注） */
  streaming: boolean
  /** 原始 describe 对象（注入详情块用）；缺省 null */
  describe: Record<string, unknown> | null
}

/** /cap 解析结果 */
export interface CapSlashParse {
  /** `/cap ` 之后的原文（可为空） */
  rest: string
  /** rest 首个空白分隔 token（查询候选；可为空） */
  firstToken: string
  /** firstToken 之后的正文（可为空） */
  remainder: string
}

/**
 * 解析消息首的 /cap 命令。非 /cap 开头返回 null。
 * 注意：匹配的是 trim 后的整条消息——/cap 是消息级命令，不出现在句中。
 */
export function parseCapSlashCommand(text: string): CapSlashParse | null {
  const trimmed = text.trim()
  const m = trimmed.match(/^\/cap(?:\s+([\s\S]+))?$/)
  if (!m) return null
  const rest = m[1] ?? ''
  const firstToken = rest.split(/\s+/)[0] ?? ''
  const remainder = firstToken ? rest.slice(firstToken.length).trimStart() : ''
  return { rest, firstToken, remainder }
}

/**
 * 按查询匹配能力。空查询返回全量（供建议列表兜底展示）。
 * 命中优先级：id 精确 > 中文名精确 > id 后缀 > 子串（id/中文名/summary），
 * 同级按数组原序稳定排序。
 */
export function matchCaps(caps: CapCatalogEntry[], query: string): CapCatalogEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...caps]
  const scored = caps.map((cap) => {
    const id = cap.id.toLowerCase()
    const name = cap.name.toLowerCase()
    const summary = cap.summary.toLowerCase()
    let score = 0
    if (id === q) score = 4
    else if (name === q) score = 3
    else if (id === `cap.${q}` || id.endsWith(`.${q}`)) score = 2
    else if (id.includes(q) || name.includes(q) || summary.includes(q)) score = 1
    return { cap, score }
  })
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.cap)
}

/**
 * 全量紧凑速查块：每个能力一行（id + 中文短名 + summary）。
 * 注入后 AI 无需调用 cap_list 即知「有什么」；「怎么调」引导到 cap.help show / cap_list。
 */
export function buildCapDigestBlock(caps: CapCatalogEntry[], note?: string): string {
  const lines = caps.map((c) => {
    const summary = c.summary ? `：${c.summary}` : ''
    const tag = c.streaming ? '（流式，同步 cap_dispatch 不可调）' : ''
    return `- ${c.id}（${c.name}）${tag}${summary}`
  })
  let head = `[cap 能力速查 · ${caps.length} 项 · 实时来自 cap.help；动作协议细节用 cap.help show target=<id> 或 cap_list 查询，不要凭记忆猜]`
  if (note) head += `\n（用户备注：${note}）`
  return [head, ...lines].join('\n')
}

/** 详情块头：唯一命中时注入该能力完整协议 */
export function buildCapDetailBlock(cap: CapCatalogEntry, note?: string): string {
  let header = `[cap 协议 · ${cap.id}（${cap.name}）${cap.streaming ? '· 流式能力，同步 cap_dispatch 不可调' : ''} · 实时来自 cap.help，下方 JSON 即完整调用协议]`
  if (note) header += `\n（用户备注：${note}）`
  const body = cap.describe
    ? `\n\`\`\`json\n${JSON.stringify(cap.describe, null, 2)}\n\`\`\``
    : '\n（该能力未提供 describe 自描述，协议用 cap_list 实时查询）'
  return header + body
}

/**
 * 构造 cap 引用块（cap-help ContextBlock）——/cap 选中的轻量引用形态。
 *
 * 引用映射库的接入点：数据存 block.data **选中时刻的快照**（所见即所发、离线可发，
 * 重选同 cap 由 source+dedupeKey 原位覆盖刷新），block.userNote 承载用户备注，
 * 发送时由 contextBlockRegistry 的 cap-help.format 物化（buildCapDetail/DigestBlock 复用）。
 */
export function buildCapReferenceBlock(entry?: CapCatalogEntry, digestCaps?: CapCatalogEntry[]): ContextBlock {
  return entry
    ? {
        id: crypto.randomUUID(),
        kind: 'cap-help',
        title: `cap 协议 · ${entry.name}`,
        source: 'cap-slash',
        dedupeKey: entry.id,
        data: { mode: 'detail', entry },
      }
    : {
        id: crypto.randomUUID(),
        kind: 'cap-help',
        title: `cap 能力速查`,
        source: 'cap-slash',
        dedupeKey: '__digest__',
        data: { mode: 'digest', caps: digestCaps ?? [] },
      }
}
