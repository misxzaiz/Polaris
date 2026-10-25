/**
 * 上下文块注册表 / 引用映射库（行为面）
 *
 * 「引用和映射库」的行为面：kind → { icon, format } 注册表 + 发送单点物化。
 * 数据面是 InputDraft.contextBlocks（types.ts 三通道之一，source+dedupeKey 去重、
 * 插入序即发送序）。新增来源只需 registerContextBlockKind 注册 kind，
 * 输入框 chips / 草稿 / 落盘降级 / 末尾拼接 全链零改动接入。
 *
 * 内置 kind（模块加载时自注册）：
 * - marquee-context：浏览器圈选，复用 browserService 的圈选文案模板
 * - cap-help：/cap 能力引用（detail=单能力 describe 协议 / digest=全量速查），
 *   格式化复用 capSlashCommand 纯函数，数据为选中时刻的快照（所见即所发）
 * - 其他/未注册 kind：降级为 data JSON 文本（不白屏、不阻塞发送）
 *
 * 引用内容的消息内位置契约：**统一在用户正文之后（末尾包含）**——
 * 由 materializeContextBlocks 单点物化（前部引导语形态已退役，见 plans/reference-mapping-spec.md）。
 */

import type { ContextBlock, ContextBlockKindSpec } from '@/stores/conversationStore/types'
import {
  formatMarqueeContextBlock,
  type MarqueeContextBlock,
} from '@/services/tauri/browserService'
import { invoke } from '@/services/tauri'
import { joinPath } from '@/utils/path'
import { createLogger } from '@/utils/logger'
import { buildCapDetailBlock, buildCapDigestBlock, type CapCatalogEntry } from '@/services/capSlashCommand'

const log = createLogger('ContextBlockRegistry')

/** 圈选上下文临时文件落盘目录（相对工作区根），与会话续接/@对话 引用一致 */
const TCB_DIR = '.polaris-handoff'

// ---------------------------------------------------------------------------
// kind 注册表（引用映射库行为面）
// ---------------------------------------------------------------------------

const kindRegistry = new Map<string, ContextBlockKindSpec>()

/** 注册一个上下文块 kind（重复注册覆盖；模块加载期自注册 + 来源方按需注册） */
export function registerContextBlockKind(kind: string, spec: ContextBlockKindSpec): void {
  kindRegistry.set(kind, spec)
}

/** 查询 kind 规格（未注册返回 undefined，调用方走通用降级） */
export function getKindSpec(kind: string): ContextBlockKindSpec | undefined {
  return kindRegistry.get(kind)
}

/** marquee-context 格式化：双字段兼容读取（顶层优先，data 兜底，见 ContextBlock 类型注释） */
function formatMarqueeBlock(block: ContextBlock): string {
  const regions = block.regions ?? (block.data?.regions as MarqueeContextBlock['regions'] | undefined) ?? []
  const url = block.url ?? (block.data?.url as string | undefined) ?? ''
  const legacy: MarqueeContextBlock = {
    id: block.id,
    type: 'marquee-context',
    title: block.title,
    url,
    regions,
    userNote: block.userNote,
    browserLabel: block.browserLabel ?? (block.data?.browserLabel as string | undefined),
  }
  return formatMarqueeContextBlock(legacy)
}

/** cap-help 格式化：从 data 快照取参复用 capSlashCommand 纯函数（userNote 作为备注拼入） */
function formatCapHelpBlock(block: ContextBlock): string {
  const data = block.data as { mode?: unknown; entry?: CapCatalogEntry; caps?: CapCatalogEntry[] } | undefined
  if (!data) return ''
  if (data.mode === 'detail' && data.entry) return buildCapDetailBlock(data.entry, block.userNote)
  if (data.mode === 'digest' && data.caps && data.caps.length > 0) {
    return buildCapDigestBlock(data.caps, block.userNote)
  }
  return ''
}

registerContextBlockKind('marquee-context', { icon: '🎯', format: formatMarqueeBlock })
registerContextBlockKind('cap-help', { icon: '⚡', format: formatCapHelpBlock })

// ---------------------------------------------------------------------------
// 数据面：去重上插（单一权威，store 的 addContextBlock 复用同一语义）
// ---------------------------------------------------------------------------

/**
 * 按 source+dedupeKey 原位覆盖/追加（纯函数）。
 * 同源同 key → 覆盖旧块（保留原位置，快照刷新语义）；否则追加到末尾（插入序即发送序）。
 */
export function upsertContextBlock(blocks: ContextBlock[], block: ContextBlock): ContextBlock[] {
  if (block.source && block.dedupeKey) {
    const idx = blocks.findIndex((b) => b.source === block.source && b.dedupeKey === block.dedupeKey)
    if (idx >= 0) {
      const next = [...blocks]
      next[idx] = block
      return next
    }
  }
  return [...blocks, block]
}

// ---------------------------------------------------------------------------
// 发送物化（单点）：引用内容统一在用户正文之后（末尾包含）
// ---------------------------------------------------------------------------

/**
 * 把多条上下文块物化为「追加在用户正文之后」的文本段。
 *
 * - blocks 为空 → trailing 空串（消息=正文原样）
 * - 有工作区且落盘成功 → 全部块按插入序落为一个 .polaris-handoff/tcb-<ts>.md，
 *   trailing = 固定引导句 + @relPath（引擎按引用读取：Claude 原生读 @abs，SimpleAI 走引导语）
 * - 无工作区 / 落盘失败 → trailing = 「[随消息附带的引用内容 · N 项]」+ 按 kind 格式化全文
 */
export async function materializeContextBlocks(
  blocks: ContextBlock[],
  workspacePath?: string,
): Promise<{ trailing: string }> {
  if (blocks.length === 0) return { trailing: '' }
  if (workspacePath) {
    try {
      const { hasContent, fileRef } = await packContextBlocksAsReference(blocks, workspacePath)
      if (hasContent) {
        return {
          trailing: `以下是随消息附带的引用内容（已保存为上下文文件），请查看 @${fileRef.relPath} 并结合该内容协助我。`,
        }
      }
    } catch (e) {
      log.warn('上下文块落盘失败，降级为末尾全文直拼', { error: String(e) })
    }
  }
  const body = formatContextBlocks(blocks)
  if (!body) return { trailing: '' }
  return { trailing: `[随消息附带的引用内容 · ${blocks.length} 项]\n\n${body}` }
}

/**
 * 把多条上下文块落盘为临时 markdown 文件，返回相对/绝对路径引用。
 *
 * 目的：避免把引用全文（describe JSON/圈选区域/DOM 片段）直接拼入用户消息造成
 * 消息体与上下文膨胀。改为落盘到工作区 .polaris-handoff/，消息末尾只放 @path
 * 引用，引擎通过工作区文件读取按需加载。
 *
 * 复用 packForReference（@对话 引用）同款落盘机制（create_file + .polaris-handoff）。
 */
export async function packContextBlocksAsReference(
  blocks: ContextBlock[],
  workspacePath: string,
): Promise<{ hasContent: boolean; fileRef: { relPath: string; absPath: string } }> {
  const markdown = formatContextBlocks(blocks)
  if (!markdown.trim()) {
    return { hasContent: false, fileRef: { relPath: '', absPath: '' } }
  }

  const fileName = `tcb-${Date.now()}.md`
  const relPath = `${TCB_DIR}/${fileName}`
  const absPath = joinPath(workspacePath, relPath)

  await invoke('create_file', { path: absPath, content: markdown })
  log.info('引用上下文已落盘', { absPath, blockCount: blocks.length })

  return { hasContent: true, fileRef: { relPath, absPath } }
}

/**
 * 按 kind 将上下文块格式化为发送文本（注册表查表分发）。
 * 已注册 kind → spec.format 的返回值（空串 = 不参与发送拼接）；
 * 未注册 kind → 降级为 data JSON 文本（不白屏、不阻塞发送）。
 */
export function formatContextBlock(block: ContextBlock): string {
  const spec = getKindSpec(block.kind)
  if (spec?.format) return spec.format(block)
  const data = block.data
  if (!data || Object.keys(data).length === 0) return ''
  return `【${block.kind} 上下文】\n标题: ${block.title}\n${JSON.stringify(data, null, 2)}${
    block.userNote ? `\n\n用户意图：${block.userNote}` : ''
  }`
}

/**
 * 拼接多条上下文块为发送文本（块间空行分隔，过滤空块）。
 */
export function formatContextBlocks(blocks: ContextBlock[]): string {
  return blocks
    .map((b) => formatContextBlock(b))
    .filter(Boolean)
    .join('\n\n')
}
