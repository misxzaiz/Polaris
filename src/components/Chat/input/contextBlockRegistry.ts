/**
 * 上下文块注册表 / 统一格式化
 *
 * 临时上下文块（TCB）的统一处理入口：按 kind 分发格式化（发送转文本）。
 * 新增来源（文本选中、截图、插件产物…）只需在此注册 kind 处理器并补渲染，
 * 输入框 / 草稿 / 发送拼接链路零改动。
 *
 * 内置 kind：
 * - marquee-context：浏览器圈选，复用 browserService 的圈选文案模板
 * - 其他/未知 kind：降级为 data JSON 文本（不白屏、不阻塞发送）
 */

import type { ContextBlock } from '@/stores/conversationStore/types'
import {
  formatMarqueeContextBlock,
  type MarqueeContextBlock,
} from '@/services/tauri/browserService'
import { invoke } from '@/services/tauri'
import { joinPath } from '@/utils/path'
import { createLogger } from '@/utils/logger'

const log = createLogger('ContextBlockRegistry')

/** 圈选上下文临时文件落盘目录（相对工作区根），与会话续接/@对话 引用一致 */
const TCB_DIR = '.polaris-handoff'

/**
 * 把多条上下文块落盘为临时 markdown 文件，返回相对/绝对路径引用。
 *
 * 目的：避免把圈选全文（标题/URL/区域详情/DOM 片段）直接拼入用户消息造成
 * 消息体与上下文膨胀。改为落盘到工作区 .polaris-handoff/，消息里只放 @path
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
  log.info('圈选上下文已落盘', { absPath, blockCount: blocks.length })

  return { hasContent: true, fileRef: { relPath, absPath } }
}

/**
 * 构造「引导语 + @path 引用」的简短消息片段。
 * @relPath（无 / 前缀）会被 parseWorkspaceReferences 解析为 @/abs/path，
 * 引擎据此读取临时文件。
 */
export function buildTcbReferencePrompt(fileRef: { relPath: string }): string {
  return `我圈选了浏览器页面区域，内容已保存为上下文文件，请查看 @${fileRef.relPath} 并结合该内容协助我。`
}

/**
 * 按 kind 将上下文块格式化为发送文本。
 * 返回空串表示不参与发送拼接（如未知 kind 无 data）。
 */
export function formatContextBlock(block: ContextBlock): string {
  switch (block.kind) {
    case 'marquee-context': {
      // 双字段兼容：顶层字段优先，data 兜底（见 ContextBlock 类型注释）
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
    default: {
      // 未知 kind 降级：data JSON 文本
      const data = block.data
      if (!data || Object.keys(data).length === 0) return ''
      return `【${block.kind} 上下文】\n标题: ${block.title}\n${JSON.stringify(data, null, 2)}${
        block.userNote ? `\n\n用户意图：${block.userNote}` : ''
      }`
    }
  }
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