/**
 * 资源解析 + cap.kv 适配（机械拆分自 OverlayApp.tsx）。
 * 纯 IO 适配，无状态。
 * 规格：plans/pet-overlay-r2-spec.md §2.3 / §2.4
 */
import { invoke } from '@/services/transport'
import { FALLBACK_PORT } from './constants'

/** 解析 whale-pet 插件资源服务端口（cap.pluginServiceManager.list_status → port，兜底 FALLBACK_PORT）。
 *
 * 为什么走 list_status 而非旧的 plugin_service_list：该 command 已在 commands/ 整体
 * 删除时移除（管理面迁入 cap.pluginServiceManager，见 commands/mod.rs 注释）。
 * 旧代码调 invoke('plugin_service_list') 必抛 "command not found"，被 try/catch
 * 吞掉后永远落 FALLBACK_PORT=9863——而服务端口由 PluginServiceManager 动态分配，
 * 端口不匹配时悬浮窗拉不到任何资源。与插件面板 Panel.tsx 的 resolvePort 对齐。 */
export async function resolvePort(): Promise<number> {
  try {
    const res = await invoke<{ ok: boolean; result?: unknown; error?: string }>(
      'router_dispatch',
      { req: { target: 'cap.pluginServiceManager', payload: { action: 'list_status' } } },
    )
    if (res?.ok) {
      const arr = Array.isArray(res.result) ? res.result : []
      const svc = arr.find((s: unknown) => {
        const x = s as { pluginId?: string; serviceId?: string; port?: number }
        return x.pluginId === 'whale-pet' && x.serviceId === 'whale-pet-assets' && typeof x.port === 'number'
      }) as { port?: number } | undefined
      if (svc?.port) return svc.port
    }
  } catch { /* 兜底端口 */ }
  return FALLBACK_PORT
}

/** 双候选（localhost/127.0.0.1）探测资源服务，首个 /__health ok 即用。 */
export async function pickBase(): Promise<string | null> {
  const port = await resolvePort()
  for (const host of ['localhost', '127.0.0.1']) {
    const base = `http://${host}:${port}`
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 2500)
      const r = await fetch(`${base}/__health`, { signal: ctrl.signal })
      clearTimeout(timer)
      if (r.ok) return base
    } catch { /* 下一个候选 */ }
  }
  return null
}

/** 由 anim 名构造 webm 资源 URL。 */
export function assetUrl(base: string, anim: string): string {
  return `${base}/asset/webm/${encodeURIComponent(anim)}.webm`
}

/** router_dispatch envelope 形状：result 可能是 { value } 也可能是裸值。 */
export type KvEnvelope = { ok?: boolean; result?: { value?: unknown } | unknown; error?: unknown }

/** cap.kv get（经 router_dispatch）。失败/空均返回 null。 */
export async function kvGet(key: string): Promise<unknown | null> {
  try {
    const res = await invoke('router_dispatch', { req: { target: 'cap.kv', payload: { action: 'get', key } } }) as KvEnvelope
    const result = res?.result as { value?: unknown } | undefined
    if (result && 'value' in result) return result.value ?? null
    return null
  } catch { return null }
}

/** cap.kv set（经 router_dispatch）。失败不影响播放。 */
export async function kvSet(key: string, value: unknown): Promise<void> {
  try {
    await invoke('router_dispatch', { req: { target: 'cap.kv', payload: { action: 'set', key, value } } })
  } catch { /* 失败不影响播放 */ }
}
