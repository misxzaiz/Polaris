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
  favicon?: string | null
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

/**
 * MarqueeContextBlock - 圈选上下文块（挂在 AI 输入框的附着块）
 *
 * 与普通附件（image/file）不同，它不进入后端 process_attachments 落盘，
 * 而是在发送时由 ChatInput 摘出并转成文本拼进用户消息。type 固定 'marquee-context'
 * 用于 ChatInput 区分渲染（可展开查看）与发送（转文本）。
 */
export interface MarqueeContextBlock {
  /** 块唯一标识 */
  id: string
  /** 上下文块类型（与 Attachment.type 区分开） */
  type: 'marquee-context'
  /** 页面标题 */
  title: string
  /** 页面 URL */
  url: string
  /** 圈选区域 */
  regions: BrowserRegion[]
  /** 用户补充说明（意图） */
  userNote?: string
  /** 来源浏览器标签 label（用于左侧边栏关联） */
  browserLabel?: string
}

/**
 * 将 MarqueeContextBlock 格式化为发送给 AI 的文本。
 * 复用 formatMarqueeContext 的拼装逻辑（单/多区域模板）。
 */
export function formatMarqueeContextBlock(block: MarqueeContextBlock): string {
  return formatMarqueeContext({
    title: block.title,
    url: block.url,
    regions: block.regions,
    userNote: block.userNote,
  })
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

// ── 页面内查找 ──────────────────────────────────────────────────────────

export interface BrowserFindResult {
  ok: boolean
  count: number
  current: number
  query: string
}

export async function browserFind(
  label: string,
  query: string,
  caseSensitive?: boolean,
): Promise<BrowserInteractionResult> {
  return invoke<BrowserInteractionResult>('browser_find', {
    label,
    query,
    caseSensitive: caseSensitive ?? null,
  })
}

export async function browserFindNext(
  label: string,
  forward?: boolean,
): Promise<BrowserInteractionResult> {
  return invoke<BrowserInteractionResult>('browser_find_next', {
    label,
    forward: forward ?? null,
  })
}

export async function browserZoom(
  label: string,
  scale: number,
): Promise<BrowserInteractionResult> {
  return invoke<BrowserInteractionResult>('browser_zoom', {
    label,
    scale,
  })
}

export async function browserSetMuted(label: string, mute: boolean): Promise<boolean> {
  return invoke<boolean>('browser_set_muted', { label, mute })
}

export interface BrowserReaderResult {
  enabled: boolean
  title?: string
  error?: string
}

/** 切换阅读模式，返回 { enabled, title? } */
export async function browserToggleReader(label: string): Promise<BrowserReaderResult> {
  return invoke<BrowserReaderResult>('browser_toggle_reader', { label })
}

/** 保存当前页面可见区域截图，返回保存路径（用户取消返回 null） */
export async function browserSaveScreenshot(label: string, scale?: number): Promise<string | null> {
  return invoke<string | null>('browser_save_screenshot', { label, scale: scale ?? null })
}

export interface BrowserNetworkInfo {
  loadTime: number
  domContentLoaded: number
  resourceCount: number
  totalSizeKB: number
  failedResources: number
  readyState: string
}

export async function browserGetNetworkInfo(label: string): Promise<BrowserNetworkInfo> {
  return invoke<BrowserNetworkInfo>('browser_get_network_info', { label })
}

// --- 书签 (Bookmarks) ---

export interface BrowserBookmark {
  id: string
  title: string
  url: string
  createdAt: number
}

export function browserBookmarksList(): Promise<BrowserBookmark[]> {
  return invoke<BrowserBookmark[]>('browser_bookmarks_list')
}

export function browserBookmarkAdd(title: string, url: string): Promise<BrowserBookmark> {
  return invoke<BrowserBookmark>('browser_bookmark_add', { title, url })
}

export function browserBookmarkDelete(id: string): Promise<void> {
  return invoke<void>('browser_bookmark_delete', { id })
}

export function browserBookmarkSetTitle(id: string, title: string): Promise<BrowserBookmark> {
  return invoke<BrowserBookmark>('browser_bookmark_set_title', { id, title })
}

export function browserBookmarkFind(url: string): Promise<BrowserBookmark | null> {
  return invoke<BrowserBookmark | null>('browser_bookmark_find', { url })
}

/** 导出书签为可移植 JSON 字符串 */
export function browserBookmarksExport(): Promise<string> {
  return invoke<string>('browser_bookmarks_export')
}

/** 从导出的 JSON 导入书签，返回新增/更新条数 */
export function browserBookmarksImport(raw: string): Promise<number> {
  return invoke<number>('browser_bookmarks_import', { raw })
}

// --- 访问历史 (History) ---

export interface BrowserHistoryEntry {
  id: string
  title: string
  url: string
  visitedAt: number
  visitCount: number
}

export function browserHistoryList(): Promise<BrowserHistoryEntry[]> {
  return invoke<BrowserHistoryEntry[]>('browser_history_list')
}

export function browserHistorySearch(query: string, limit?: number): Promise<BrowserHistoryEntry[]> {
  return invoke<BrowserHistoryEntry[]>('browser_history_search', { query, limit: limit ?? null })
}

export function browserHistoryDelete(id: string): Promise<void> {
  return invoke<void>('browser_history_delete', { id })
}

export function browserHistoryClear(): Promise<void> {
  return invoke<void>('browser_history_clear')
}

export function browserHistoryRecord(title: string, url: string): Promise<BrowserHistoryEntry> {
  return invoke<BrowserHistoryEntry>('browser_history_record', { title, url })
}

/** 导出历史为可移植 JSON 字符串 */
export function browserHistoryExport(): Promise<string> {
  return invoke<string>('browser_history_export')
}

/** 从导出的 JSON 导入历史，返回新增/更新条数 */
export function browserHistoryImport(raw: string): Promise<number> {
  return invoke<number>('browser_history_import', { raw })
}

// --- 地址栏搜索建议 (Suggestions) ---

export interface BrowserSuggestion {
  kind: 'bookmark' | 'history' | 'search'
  title: string
  url: string
  /** 访问次数（历史项），书签为 0 */
  visitCount?: number
  /** 最近访问时间（历史项），书签为 0 */
  visitedAt?: number
  createdAt?: number
}

export async function browserSuggestions(query: string): Promise<BrowserSuggestion[]> {
  const q = query.trim()
  if (!q) return []
  const lower = q.toLowerCase()

  // 历史 + 书签并发获取，本地直读
  const [historyItems, bookmarkItems] = await Promise.all([
    browserHistorySearch(lower, 50).catch(() => [] as BrowserHistoryEntry[]),
    browserBookmarksList().catch(() => [] as BrowserBookmark[]),
  ])

  const out: BrowserSuggestion[] = []
  const seen = new Set<string>()

  const add = (item: BrowserSuggestion) => {
    if (seen.has(item.url)) return
    seen.add(item.url)
    out.push(item)
  }

  // 历史项优先（按访问次数排序）
  const sortedHistory = [...historyItems].sort((a, b) => b.visitCount - a.visitCount)
  for (const h of sortedHistory) {
    if (
      h.url.toLowerCase().includes(lower) ||
      h.title.toLowerCase().includes(lower)
    ) {
      add({
        kind: 'history',
        title: h.title || h.url,
        url: h.url,
        visitCount: h.visitCount,
        visitedAt: h.visitedAt,
      })
    }
  }

  for (const b of bookmarkItems) {
    if (
      b.url.toLowerCase().includes(lower) ||
      b.title.toLowerCase().includes(lower)
    ) {
      add({
        kind: 'bookmark',
        title: b.title || b.url,
        url: b.url,
        createdAt: b.createdAt,
      })
    }
  }

  return out.slice(0, 8)
}
