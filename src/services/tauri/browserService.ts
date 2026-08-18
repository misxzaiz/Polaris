import { invoke } from '@/services/transport'

export interface BrowserSessionInfo {
  label: string
  tabId?: string | null
  url?: string | null
  title?: string | null
  updatedAt: number
  boundAgentKey?: string | null
}

export interface BrowserAcquireRequest {
  requestId: string
  agentKey?: string | null
  url: string
  title?: string | null
  activate?: boolean | null
}

export interface BrowserAcquireResult {
  label: string
  tabId?: string | null
  url?: string | null
  title?: string | null
  created: boolean
  boundAgentKey?: string | null
}

export interface BrowserPageContext {
  title: string
  url: string
  selectedText: string
  metaDescription: string
  text: string
  headings: Array<{ level: number; text: string }>
  links: Array<{ text: string; href: string; rel?: string | null }>
  // P0: 结构化内容
  tables?: Array<{ rows: string[][]; caption?: string | null }>
  codeBlocks?: Array<{ language: string; code: string }>
  images?: Array<{ src: string; alt?: string; width?: number | null; height?: number | null }>
  structuredData?: unknown[]
  // P1: 扩展 meta & 列表/表单
  lists?: Array<{ ordered: boolean; items: string[] }>
  forms?: Array<{ action: string; method: string; fields: string[] }>
  canonical?: string | null
  ogTitle?: string | null
  ogImage?: string | null
}

export interface BrowserOperationEvent {
  label: string
  source: string
  action: string
  status: 'success' | 'warning' | 'error' | string
  message: string
  target?: string | null
  url?: string | null
  timestamp: number
}

export interface BrowserRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserViewport {
  width: number
  height: number
  devicePixelRatio: number
}

export interface BrowserInteractiveElement {
  index: number
  kind: string
  text: string
  value: string
  placeholder: string
  href: string
  disabled: boolean
  fillable: boolean
  // P0: 坐标、状态、选项、稳定定位
  rect?: BrowserRect | null
  checked?: boolean | null
  selected?: boolean | null
  options?: Array<{ value: string; text: string; selected?: boolean; disabled?: boolean }> | null
  selector?: string | null
  // P1: 工具提示、展开/按下态、只读、表单约束
  tooltip?: string | null
  expanded?: boolean | null
  pressed?: boolean | null
  readOnly?: boolean | null
  required?: boolean | null
  min?: number | null
  max?: number | null
  step?: number | null
  crossOrigin?: boolean | null
}

export interface BrowserConsoleMessage {
  level: string
  message: string
  url: string
  timestamp: number
}

export interface BrowserVisualElement {
  index: number
  kind: string
  text: string
  rect: BrowserRect
  fillable: boolean
  disabled: boolean
  // P1: 状态信息
  checked?: boolean | null
  selected?: boolean | null
  selector?: string | null
}

export interface BrowserScreenshot {
  mimeType: string
  data: string
  width: number
  height: number
  scale: number
}

export interface BrowserVisualSnapshot {
  title: string
  url: string
  viewport: BrowserViewport
  elements: BrowserVisualElement[]
  screenshot?: BrowserScreenshot | null
}

export interface BrowserDiagnostics {
  session?: BrowserSessionInfo | null
  context: BrowserPageContext
  elements: BrowserInteractiveElement[]
  visual: BrowserVisualSnapshot
  consoleMessages: BrowserConsoleMessage[]
  screenshotError?: string | null
}

export interface BrowserOverlayResult {
  enabled: boolean
  count: number
}

// ── 圈选区域 (Marquee Selection) ──

export interface BrowserMarqueeResult {
  enabled: boolean
  count: number
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

export interface BrowserRegionResult {
  url: string
  count: number
  elements: BrowserRegionElement[]
  htmlSnippet: string
  textSnippet?: string | null
  screenshot?: BrowserScreenshot | null
}

export interface BrowserRegionContext {
  title: string
  url: string
  regions: BrowserRegion[]
  userNote?: string
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

export type BrowserMarqueeRect = BrowserRect

export function formatMarqueeContext(context: BrowserRegionContext): string {
  const { title, url, regions, userNote } = context
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
      '我正在用 Polaris 内置浏览器查看一个页面，圈选了多个区域，请根据圈选区域的内容协助我修改项目。',
      '',
      `标题: ${title || 'Untitled'}`,
      `URL: ${url}`,
      '',
      userNote ? `用户意图：${userNote}` : '',
      '',
      regionBlocks,
      '',
      '请按区域分别定位到项目中对应的组件或文件，再给出修改方案；如果信息足够，可以直接实施修改。',
    ].filter(Boolean).join('\n')
  }

  const region = regions[0]
  if (!region) return ''

  return [
    '我正在用 Polaris 内置浏览器查看一个页面，圈选了页面中一个区域，请根据圈选区域的内容协助我修改项目。',
    '',
    `标题: ${title || 'Untitled'}`,
    `URL: ${url}`,
    `圈选区域: 坐标(${region.rect.x},${region.rect.y})，尺寸${region.rect.width}×${region.rect.height}，包含 ${region.count} 个交互元素`,
    '',
    userNote ? `用户意图：${userNote}` : '',
    '',
    formatRegion(region, 0),
    '',
    '请先判断这可能对应项目中的哪些文件或组件，再给出修改方案；如果信息足够，可以直接实施修改。',
  ].filter(Boolean).join('\n')
}

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserInteractionResult {
  ok: boolean
  action: string
  index: number | null
  text: string
  url: string
  message: string
}

export function makeBrowserWebviewLabel(tabId: string): string {
  return `browser-${tabId.replace(/[^a-zA-Z0-9_:/-]/g, '-')}`
}

export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return 'https://www.bing.com'

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) {
    return trimmed
  }

  if (/\s/.test(trimmed) || !trimmed.includes('.')) {
    return `https://www.bing.com/search?q=${encodeURIComponent(trimmed)}`
  }

  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/.*)?$/i.test(trimmed)) {
    return `http://${trimmed}`
  }

  return `https://${trimmed}`
}

export async function browserRegister(
  label: string,
  tabId?: string,
  url?: string,
  title?: string
): Promise<BrowserSessionInfo> {
  return invoke<BrowserSessionInfo>('browser_register', { label, tabId, url, title })
}

export async function browserCreate(
  label: string,
  tabId: string,
  url: string,
  bounds: BrowserBounds,
  title = 'Browser'
): Promise<BrowserSessionInfo> {
  return invoke<BrowserSessionInfo>('browser_create', { label, tabId, url, bounds, title })
}

export async function browserSetBounds(label: string, bounds: BrowserBounds): Promise<void> {
  return invoke<void>('browser_set_bounds', { label, bounds })
}

export async function browserSetAiOverlay(label: string, enabled: boolean): Promise<BrowserOverlayResult> {
  return invoke<BrowserOverlayResult>('browser_set_ai_overlay', { label, enabled })
}

export async function browserClose(label: string): Promise<void> {
  return invoke<void>('browser_close', { label })
}

export async function browserClearData(label: string): Promise<void> {
  return invoke<void>('browser_clear_data', { label })
}

export async function browserUnregister(label: string): Promise<void> {
  return invoke<void>('browser_unregister', { label })
}

export async function browserListSessions(): Promise<BrowserSessionInfo[]> {
  return invoke<BrowserSessionInfo[]>('browser_list_sessions')
}

/** 清理所有已注册但无对应活跃 WebView 的残留浏览器会话 */
export async function browserClearOrphanedSessions(): Promise<number> {
  return invoke<number>('browser_clear_orphaned_sessions')
}

export async function browserAcquireComplete(params: {
  requestId: string
  label?: string
  tabId?: string
  url?: string
  title?: string
  created?: boolean
  error?: string
}): Promise<void> {
  return invoke<void>('browser_acquire_complete', params)
}

export async function browserAcquire(params: {
  agentKey?: string
  label?: string
  url?: string
  title?: string
  mode?: 'auto' | 'create' | 'reuse'
  activate?: boolean
}): Promise<BrowserAcquireResult> {
  return invoke<BrowserAcquireResult>('browser_acquire', params)
}

export async function browserNavigate(label: string, url: string): Promise<string> {
  return invoke<string>('browser_navigate', { label, url })
}

export async function browserReload(label: string): Promise<void> {
  return invoke<void>('browser_reload', { label })
}

export async function browserHistory(label: string, direction: 'back' | 'forward'): Promise<void> {
  return invoke<void>('browser_history', { label, direction })
}

export async function browserGetPageContext(label: string): Promise<BrowserPageContext> {
  return invoke<BrowserPageContext>('browser_get_page_context', { label })
}

export async function browserGetDiagnostics(
  label: string,
  includeScreenshot = false
): Promise<BrowserDiagnostics> {
  return invoke<BrowserDiagnostics>('browser_get_diagnostics', { label, includeScreenshot })
}

export async function browserToggleDevtools(label: string): Promise<void> {
  return invoke<void>('browser_toggle_devtools', { label })
}

export interface BrowserHistoryState {
  canGoBack: boolean
  canGoForward: boolean
}

export async function browserGetHistoryState(label: string): Promise<BrowserHistoryState> {
  return invoke<BrowserHistoryState>('browser_get_history_state', { label })
}

export async function browserShowOverflowMenu(
  label: string,
  x: number,
  y: number,
): Promise<void> {
  return invoke<void>('browser_show_overflow_menu', { label, x, y })
}

export async function browserSetMarquee(label: string, enabled: boolean): Promise<BrowserMarqueeResult> {
  return invoke<BrowserMarqueeResult>('browser_set_marquee', { label, enabled })
}

export async function browserGetMarqueeResult(label: string): Promise<{ rects: BrowserMarqueeRect[]; done: boolean }> {
  const raw = await invoke<Record<string, unknown>>('browser_get_marquee_result', { label })
  const rects = (raw.rects as Array<BrowserMarqueeRect>) ?? []
  const done = raw.done === true
  return { rects, done }
}

export async function browserSelectRegion(
  label: string,
  rect: BrowserMarqueeRect,
): Promise<BrowserRegionResult> {
  return invoke<BrowserRegionResult>('browser_select_region', { label, region: rect })
}

export async function browserGetRegionScreenshot(
  label: string,
  rect: BrowserMarqueeRect,
): Promise<BrowserScreenshot> {
  return invoke<BrowserScreenshot>('browser_get_region_screenshot', { label, region: rect })
}

// ── 浏览器新命令（Phase 1 P0/P1） ──────────────────────────────────────

export interface BrowserWaitOptions {
  condition: 'url_change' | 'text_appear' | 'element_appear' | 'network_idle' | 'navigation' | 'timeout'
  text?: string | null
  index?: number | null
  ms?: number | null
  timeoutMs?: number | null
}

export async function browserWait(
  label: string,
  options: BrowserWaitOptions,
): Promise<BrowserInteractionResult> {
  return invoke<BrowserInteractionResult>('browser_wait', {
    label,
    condition: options.condition,
    text: options.text ?? null,
    index: options.index ?? null,
    ms: options.ms ?? null,
    timeoutMs: options.timeoutMs ?? null,
  })
}

export async function browserScroll(
  label: string,
  mode: 'to_element' | 'by' | 'to' | 'top' | 'bottom' | 'up' | 'down' | 'left' | 'right',
  options?: {
    index?: number
    text?: string
    x?: number
    y?: number
    amount?: number
  },
): Promise<BrowserInteractionResult> {
  return invoke<BrowserInteractionResult>('browser_scroll', {
    label,
    mode,
    index: options?.index ?? null,
    text: options?.text ?? null,
    x: options?.x ?? null,
    y: options?.y ?? null,
    amount: options?.amount ?? null,
  })
}

export async function browserPressKey(
  label: string,
  keys: string,
  options?: { index?: number; text?: string },
): Promise<BrowserInteractionResult> {
  return invoke<BrowserInteractionResult>('browser_press_key', {
    label,
    keys,
    index: options?.index ?? null,
    text: options?.text ?? null,
  })
}

export async function browserTypeText(
  label: string,
  text: string,
  options?: { index?: number; elementText?: string; delayMs?: number },
): Promise<BrowserInteractionResult> {
  return invoke<BrowserInteractionResult>('browser_type_text', {
    label,
    text,
    index: options?.index ?? null,
    elementText: options?.elementText ?? null,
    delayMs: options?.delayMs ?? null,
  })
}
