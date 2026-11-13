/**
 * 浏览器域共享类型（browser-desk 插件化后主仓仅保留的兼容类型）。
 *
 * 来源：原 `services/tauri/browserService.ts` 的圈选（marquee）类型段。
 * 消息历史（ContextBlock.regions / MarqueeContextBlock）中仍持久化着
 * 圈选数据，类型随数据兼容保留；产生圈选的内置浏览器面板已由
 * browser-desk 插件承接（CDP 引擎），主仓不再携带其实现。
 */

export interface BrowserRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserScreenshot {
  mimeType: string
  data: string
  width: number
  height: number
  scale: number
}

export interface BrowserRegionElement {
  index: number
  kind: string
  text: string
  rect: BrowserRect
  fillable: boolean
  disabled: boolean
  selector?: string | null
}

export interface BrowserRegion {
  id: number
  rect: BrowserRect
  count: number
  elements: BrowserRegionElement[]
  htmlSnippet: string
  textSnippet?: string | null
  screenshot?: BrowserScreenshot | null
}

/** MarqueeContextBlock - 圈选上下文块（挂在 AI 输入框的附着块） */
export interface MarqueeContextBlock {
  id: string
  type: 'marquee-context'
  title?: string
  url: string
  regions: BrowserRegion[]
  userNote?: string
  browserLabel?: string
}

/** 将 MarqueeContextBlock 格式化为发送给 AI 的文本（纯函数，发送链路消费） */
export function formatMarqueeContextBlock(block: MarqueeContextBlock): string {
  const { title, url, regions, userNote } = block
  const isMulti = regions.length > 1

  const formatRegion = (r: BrowserRegion, i: number) => {
    const elems = r.elements.length > 0
      ? r.elements.map((e) => `  · ${e.kind} "${e.text}"`).join('\n')
      : '  （无交互元素）'
    const parts = [
      `【区域 ${i + 1}】坐标(${r.rect.x},${r.rect.y})，尺寸${r.rect.width}×${r.rect.height}，包含 ${r.count} 个交互元素`,
      elems,
    ]
    if (r.textSnippet && r.textSnippet.trim()) {
      parts.push('区域内文本：', r.textSnippet.trim())
    }
    if (r.htmlSnippet && r.htmlSnippet.trim()) {
      parts.push('圈选区域 DOM 片段：', '```html', r.htmlSnippet, '```')
    }
    return parts.join('\n')
  }

  if (isMulti) {
    const regionBlocks = regions.map(formatRegion).join('\n\n')
    return [
      '我正在用 Polaris 内置浏览器查看一个页面，圈选了多个区域，请根据圈选区域的内容协助我处理。',
      '',
      `标题: ${title || 'Untitled'}`,
      `URL: ${url}`,
      '',
      userNote ? `用户意图：${userNote}` : '',
      '',
      regionBlocks,
      '',
    ].filter(Boolean).join('\n')
  }

  const r = regions[0]
  if (!r) return ''

  const elems = r.elements.length > 0
    ? r.elements.map((e) => `  · ${e.kind} "${e.text}"`).join('\n')
    : '  （无交互元素）'
  const regionParts = [
    `【区域 1】坐标(${r.rect.x},${r.rect.y})，尺寸${r.rect.width}×${r.rect.height}，包含 ${r.count} 个交互元素`,
    elems,
  ]
  if (r.textSnippet && r.textSnippet.trim()) {
    regionParts.push('区域内文本：', r.textSnippet.trim())
  }
  if (r.htmlSnippet && r.htmlSnippet.trim()) {
    regionParts.push('圈选区域 DOM 片段：', '```html', r.htmlSnippet, '```')
  }

  const parts = [
    '我正在用 Polaris 内置浏览器查看一个页面，圈选了页面中一个区域，请根据圈选区域的内容协助我修改项目。',
    '',
    `标题: ${title || 'Untitled'}`,
    `URL: ${url}`,
    `圈选区域: 坐标(${r.rect.x},${r.rect.y})，尺寸${r.rect.width}×${r.rect.height}，包含 ${r.count} 个交互元素`,
    '',
    userNote ? `用户意图：${userNote}` : '',
    '',
    regionParts.join('\n'),
    '',
    '请先判断这可能对应项目中的哪些文件或组件，再给出修改方案；如果信息足够，可以直接实施修改。',
  ]
  return parts.filter(Boolean).join('\n')
}
