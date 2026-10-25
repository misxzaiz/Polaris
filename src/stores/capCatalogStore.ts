/**
 * capCatalogStore —— cap 能力目录缓存（/cap 斜杠命令的建议与注入数据源）
 *
 * 数据经 router_dispatch("cap.help", index) 取自后端注册表（describe 单一权威，
 * 07c9f1c0），前端只做一次会话级缓存省 IPC 往返；不维护第二份能力清单。
 * 加载失败不阻塞 UI（caps 保持空，/cap 发送时 toast 引导重试）。
 */

import { create } from 'zustand'
import { invoke } from '@/services/transport'
import { createLogger } from '@/utils/logger'
import type { CapCatalogEntry } from '@/services/capSlashCommand'

const log = createLogger('CapCatalogStore')

/** router_dispatch 返回形态（与 commands/router.rs RouterDispatchResponse 对应） */
interface DispatchResponse {
  msgId: string
  ok: boolean
  result: Record<string, unknown> | null
  error: string | null
  trace: string
}

/** cap.help index 的单条目形状（router/mod.rs described_capabilities） */
interface DescribedEntry {
  id?: unknown
  streaming?: unknown
  describe?: unknown
}

function parseEntry(entry: DescribedEntry): CapCatalogEntry | null {
  if (typeof entry.id !== 'string' || !entry.id) return null
  const describe =
    entry.describe && typeof entry.describe === 'object' && !Array.isArray(entry.describe)
      ? (entry.describe as Record<string, unknown>)
      : null
  const name = typeof describe?.name === 'string' && describe.name ? describe.name : entry.id
  const summary = typeof describe?.summary === 'string' ? describe.summary : ''
  return {
    id: entry.id,
    name,
    summary,
    streaming: entry.streaming === true,
    describe,
  }
}

interface CapCatalogState {
  caps: CapCatalogEntry[]
  loaded: boolean
  loading: boolean
  /** 懒加载（本会话缓存一次）；force=true 强制刷新 */
  ensure: (force?: boolean) => Promise<void>
}

export const useCapCatalogStore = create<CapCatalogState>((set, get) => ({
  caps: [],
  loaded: false,
  loading: false,

  ensure: async (force = false) => {
    if (get().loading) return
    if (get().loaded && !force) return
    set({ loading: true })
    try {
      const res = await invoke<DispatchResponse>('router_dispatch', {
        req: { target: 'cap.help', payload: { action: 'index' } },
      })
      if (!res.ok) throw new Error(res.error || 'cap.help index 失败')
      const raw = (res.result?.capabilities ?? []) as DescribedEntry[]
      const caps = raw
        .map(parseEntry)
        .filter((c): c is CapCatalogEntry => c !== null)
        .sort((a, b) => a.id.localeCompare(b.id))
      set({ caps, loaded: true, loading: false })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('cap 目录加载失败', err instanceof Error ? err : new Error(msg))
      // loaded 保持 false：下次 ensure 重试；不阻塞输入框
      set({ loading: false })
    }
  },
}))
