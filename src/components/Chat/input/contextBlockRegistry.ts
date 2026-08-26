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