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

export async function browserToggleDevtools(label: string): Promise<void> {
  return invoke<void>('browser_toggle_devtools', { label })
}
