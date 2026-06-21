/**
 * HTTP Client Store
 *
 * 管理多请求标签页、环境变量集合、已保存请求集合。
 * 模式：纯 Tauri 命令驱动（无 persist 中间件），照抄 snippetStore/terminalStore 范式。
 * 持久化落 <DataRoot>/http-client/{collection,environments}.json（原子写）。
 */

import { create } from 'zustand'
import { invoke } from '@/services/transport'
import { createLogger } from '@/utils/logger'
import {
  type Environment,
  type EnvironmentsFile,
  type HttpRequestSpec,
  type HttpResponseInfo,
  type RequestTab,
  type SavedRequest,
  type CollectionFile,
  emptySpec,
  deriveTabName,
} from '@/components/HttpClientPanel/httpClientTypes'
import { substituteEnv } from '@/components/HttpClientPanel/envSubstitution'

const log = createLogger('HttpClientStore')

const COLLECTION_FILE = 'collection.json'
const ENVIRONMENTS_FILE = 'environments.json'

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// 防止 React strict mode 重复调用 init 时并发创建多个初始 tab
let initPromise: Promise<void> | null = null

function newTab(saved: SavedRequest | null): RequestTab {
  if (saved) {
    return {
      id: uid('tab'),
      name: saved.name,
      spec: { ...saved.spec },
      response: null,
      loading: false,
      error: null,
      savedId: saved.id,
      dirty: false,
    }
  }
  return {
    id: uid('tab'),
    name: 'Untitled',
    spec: emptySpec(),
    response: null,
    loading: false,
    error: null,
    savedId: null,
    dirty: false,
  }
}

interface HttpClientState {
  tabs: RequestTab[]
  activeTabId: string | null
  environments: Environment[]
  activeEnvId: string | null
  collection: SavedRequest[]
  initialized: boolean
  /** 最近一次替换时缺失的变量名（针对当前 active tab 发送时记录） */
  missingVars: string[]

  // 生命周期
  init: () => Promise<void>

  // 标签页
  createTab: (saved?: SavedRequest | null) => void
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  renameTab: (id: string, name: string) => void
  updateTabSpec: (id: string, patch: Partial<HttpRequestSpec>) => void
  setTabResponse: (id: string, response: HttpResponseInfo | null) => void
  setTabLoading: (id: string, loading: boolean) => void
  setTabError: (id: string, error: string | null) => void
  sendActiveRequest: () => Promise<void>

  // 请求集合
  saveActiveAsNew: (name: string) => Promise<void>
  saveActiveOverExisting: () => Promise<void>
  deleteSaved: (id: string) => Promise<void>
  openSavedInNewTab: (id: string) => void
  persistCollection: () => Promise<void>

  // 环境
  addEnvironment: (name: string) => Promise<void>
  updateEnvironment: (id: string, patch: Partial<Environment>) => Promise<void>
  deleteEnvironment: (id: string) => Promise<void>
  setActiveEnv: (id: string | null) => Promise<void>
  persistEnvironments: () => Promise<void>

  // 派生
  getActiveTab: () => RequestTab | null
  getActiveEnv: () => Environment | null
}

export const useHttpClientStore = create<HttpClientState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  environments: [],
  activeEnvId: null,
  collection: [],
  initialized: false,
  missingVars: [],

  init: async () => {
    if (get().initialized) return
    // 并发去重：strict mode 重复触发时复用同一个 init Promise
    if (initPromise) return initPromise
    initPromise = (async () => {
      try {
      const [colRaw, envRaw] = await Promise.all([
        invoke<string | null>('http_client_read', { name: COLLECTION_FILE }),
        invoke<string | null>('http_client_read', { name: ENVIRONMENTS_FILE }),
      ])

      let collection: SavedRequest[] = []
      if (colRaw) {
        try {
          const parsed = JSON.parse(colRaw) as CollectionFile
          collection = Array.isArray(parsed.requests) ? parsed.requests : []
        } catch (e) {
          log.warn('collection.json 解析失败', { error: e })
        }
      }

      let environments: Environment[] = []
      let activeEnvId: string | null = null
      if (envRaw) {
        try {
          const parsed = JSON.parse(envRaw) as EnvironmentsFile
          environments = Array.isArray(parsed.environments) ? parsed.environments : []
          activeEnvId = parsed.activeId ?? null
        } catch (e) {
          log.warn('environments.json 解析失败', { error: e })
        }
      }

      // 首次启动：创建一个空标签页
      const tab = newTab(null)
      set({
        collection,
        environments,
        activeEnvId,
        tabs: [tab],
        activeTabId: tab.id,
        initialized: true,
      })
      } catch (e) {
        log.error('初始化失败', e instanceof Error ? e : new Error(String(e)))
        const tab = newTab(null)
        set({ tabs: [tab], activeTabId: tab.id, initialized: true })
      }
    })()
    return initPromise
  },

  createTab: (saved = null) => {
    const tab = newTab(saved)
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }))
  },

  closeTab: (id) => {
    set((state) => {
      const idx = state.tabs.findIndex((t) => t.id === id)
      if (idx === -1) return state
      const tabs = state.tabs.filter((t) => t.id !== id)
      let activeTabId = state.activeTabId
      if (activeTabId === id) {
        // 切到相邻标签，无则新建空标签
        if (tabs.length === 0) {
          const fresh = newTab(null)
          return { tabs: [fresh], activeTabId: fresh.id }
        }
        const next = tabs[Math.min(idx, tabs.length - 1)]
        activeTabId = next.id
      }
      return { tabs, activeTabId }
    })
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  renameTab: (id, name) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, name } : t)),
    })),

  updateTabSpec: (id, patch) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              spec: { ...t.spec, ...patch },
              dirty: true,
              name: patch.url !== undefined || patch.method !== undefined ? deriveTabName({ ...t.spec, ...patch }) : t.name,
            }
          : t,
      ),
    })),

  setTabResponse: (id, response) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, response, dirty: response ? t.dirty : t.dirty } : t)),
    })),

  setTabLoading: (id, loading) =>
    set((state) => ({ tabs: state.tabs.map((t) => (t.id === id ? { ...t, loading } : t)) })),

  setTabError: (id, error) =>
    set((state) => ({ tabs: state.tabs.map((t) => (t.id === id ? { ...t, error } : t)) })),

  sendActiveRequest: async () => {
    const state = get()
    const tab = state.getActiveTab()
    if (!tab) return

    // 变量替换
    const env = state.getActiveEnv()
    const { spec, missing } = substituteEnv(tab.spec, env)
    set({ missingVars: missing })

    state.setTabLoading(tab.id, true)
    state.setTabError(tab.id, null)
    try {
      const response = await invoke<HttpResponseInfo>('http_request', { spec })
      state.setTabResponse(tab.id, response)
    } catch (e) {
      state.setTabError(tab.id, e instanceof Error ? e.message : String(e))
    } finally {
      state.setTabLoading(tab.id, false)
    }
  },

  // ===== 请求集合 =====

  saveActiveAsNew: async (name) => {
    const tab = get().getActiveTab()
    if (!tab) return
    const saved: SavedRequest = {
      id: uid('req'),
      name,
      method: tab.spec.method,
      url: tab.spec.url,
      spec: { ...tab.spec },
      updatedAt: Date.now(),
    }
    set((state) => ({
      collection: [...state.collection, saved],
      tabs: state.tabs.map((t) =>
        t.id === tab.id ? { ...t, savedId: saved.id, dirty: false, name } : t,
      ),
    }))
    await get().persistCollection()
  },

  saveActiveOverExisting: async () => {
    const tab = get().getActiveTab()
    if (!tab || !tab.savedId) return
    const savedId = tab.savedId
    set((state) => ({
      collection: state.collection.map((r) =>
        r.id === savedId
          ? {
              ...r,
              name: tab.name,
              method: tab.spec.method,
              url: tab.spec.url,
              spec: { ...tab.spec },
              updatedAt: Date.now(),
            }
          : r,
      ),
      tabs: state.tabs.map((t) => (t.id === tab.id ? { ...t, dirty: false } : t)),
    }))
    await get().persistCollection()
  },

  deleteSaved: async (id) => {
    set((state) => ({
      collection: state.collection.filter((r) => r.id !== id),
      tabs: state.tabs.map((t) => (t.savedId === id ? { ...t, savedId: null, dirty: true } : t)),
    }))
    await get().persistCollection()
  },

  openSavedInNewTab: (id) => {
    const saved = get().collection.find((r) => r.id === id)
    if (!saved) return
    get().createTab(saved)
  },

  persistCollection: async () => {
    const file: CollectionFile = { version: 1, requests: get().collection }
    try {
      await invoke('http_client_write', { name: COLLECTION_FILE, content: JSON.stringify(file, null, 2) })
    } catch (e) {
      log.error('保存请求集合失败', e instanceof Error ? e : new Error(String(e)))
    }
  },

  // ===== 环境 =====

  addEnvironment: async (name) => {
    const env: Environment = { id: uid('env'), name, variables: [] }
    set((state) => ({ environments: [...state.environments, env] }))
    await get().persistEnvironments()
  },

  updateEnvironment: async (id, patch) => {
    set((state) => ({
      environments: state.environments.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    }))
    await get().persistEnvironments()
  },

  deleteEnvironment: async (id) => {
    set((state) => ({
      environments: state.environments.filter((e) => e.id !== id),
      activeEnvId: state.activeEnvId === id ? null : state.activeEnvId,
    }))
    await get().persistEnvironments()
  },

  setActiveEnv: async (id) => {
    set({ activeEnvId: id })
    await get().persistEnvironments()
  },

  persistEnvironments: async () => {
    const file: EnvironmentsFile = {
      version: 1,
      environments: get().environments,
      activeId: get().activeEnvId,
    }
    try {
      await invoke('http_client_write', { name: ENVIRONMENTS_FILE, content: JSON.stringify(file, null, 2) })
    } catch (e) {
      log.error('保存环境变量失败', e instanceof Error ? e : new Error(String(e)))
    }
  },

  getActiveTab: () => {
    const { tabs, activeTabId } = get()
    return tabs.find((t) => t.id === activeTabId) ?? null
  },

  getActiveEnv: () => {
    const { environments, activeEnvId } = get()
    if (!activeEnvId) return null
    return environments.find((e) => e.id === activeEnvId) ?? null
  },
}))
