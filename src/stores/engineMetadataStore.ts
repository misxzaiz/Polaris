/**
 * 引擎元数据 Store
 *
 * 从后端 `get_engine_metadata_list` Tauri 命令获取所有已注册引擎的元数据，
 * 作为前端引擎信息的单一事实源。所有消费方（AIEngineTab、engineDisplay 等）
 * 统一从此 store 获取数据，无需硬编码引擎列表。
 *
 * 新增引擎时只需在后端注册到 EngineRegistry，此 store 自动包含新引擎。
 */

import { create } from 'zustand'
import { invoke } from '@/services/transport'
import { createLogger } from '@/utils/logger'
import type { EngineMetadata } from '@/types/engineMetadata'

const log = createLogger('EngineMetadataStore')

export interface EngineMetadataStore {
  /** 引擎元数据列表 */
  metadatas: EngineMetadata[]
  /** 是否已加载 */
  loaded: boolean
  /** 是否加载中 */
  loading: boolean
  /** 错误信息 */
  error: string | null
  /** 加载引擎元数据 */
  load: () => Promise<void>
  /** 重新加载引擎元数据（强制重新请求） */
  reload: () => Promise<void>
  /** 获取指定引擎的元数据 */
  getEngine: (engineId: string) => EngineMetadata | undefined
  /** 获取所有引擎 ID 列表 */
  getEngineIds: () => string[]
  /** 获取引擎显示名称 */
  getEngineDisplayName: (engineId: string) => string
  /** 获取引擎完整名称 */
  getEngineFullName: (engineId: string) => string
  /** 判断引擎是否存在 */
  hasEngine: (engineId: string) => boolean
}

export const useEngineMetadataStore = create<EngineMetadataStore>((set, get) => ({
  metadatas: [],
  loaded: false,
  loading: false,
  error: null,

  load: async () => {
    if (get().loaded || get().loading) return
    set({ loading: true, error: null })
    try {
      const metadatas = await invoke<EngineMetadata[]>('get_engine_metadata_list')
      set({ metadatas, loaded: true, loading: false })
      log.info(`已加载 ${metadatas.length} 个引擎元数据`)
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      log.error('加载引擎元数据失败', err)
      set({ error: err.message, loading: false })
    }
  },

  /** 重新加载引擎元数据（强制重新请求） */
  reload: async () => {
    set({ loaded: false, loading: false })
    await get().load()
  },

  getEngine: (engineId: string) => {
    return get().metadatas.find(m => m.id === engineId)
  },

  getEngineIds: () => {
    return get().metadatas.map(m => m.id)
  },

  getEngineDisplayName: (engineId: string) => {
    const meta = get().getEngine(engineId)
    if (meta) {
      // 从 name 中提取简短显示名（如 "Claude Code" → "Claude"）
      const name = meta.name
      if (name === 'Claude Code') return 'Claude'
      if (name === 'OpenAI Codex') return 'Codex'
      return name
    }
    // 降级：用 engineId 本身
    return engineId
  },

  getEngineFullName: (engineId: string) => {
    const meta = get().getEngine(engineId)
    return meta?.name ?? engineId
  },

  hasEngine: (engineId: string) => {
    return get().metadatas.some(m => m.id === engineId)
  },
}))

/**
 * 初始化引擎元数据（在应用启动时调用）
 */
export async function initEngineMetadata(): Promise<void> {
  const store = useEngineMetadataStore.getState()
  if (!store.loaded) {
    await store.load()
  }
}