import { invoke } from '@/services/transport'

export interface BrowserSessionInfo {
  label: string
  tabId?: string | null
  url?: string | null
  title?: string | null
  updatedAt: number
}

export interface BrowserPageContext {
  title: string
  url: string
  selectedText: string
  metaDescription: string
  text: string
  headings: Array<{ level: number; text: string }>
  links: Array<{ text: string; href: string }>
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

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
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
