/**
 * 新建会话偏好记忆服务（cap.kv）
 *
 * 记录「新建会话」面板最近一次选择的 模型供应商（官方 / 指定 Profile）+ 模型，
 * 并按 AI 引擎分层（key = `new-session-prefs:{engineId}`）：切换引擎时互相独立，
 * 各自恢复自己的供应商/模型，符合「按 AI 引擎记住选择」的要求。
 *
 * 存储通道与 promptHistoryService 一致：RouterBus dispatch 调 cap.kv，
 * 数据落数据根 <DataRoot>/stores/kv.db，桌面与 Web 共用一份事实，
 * 不引入 localStorage（遵守数据根单点原则）。
 *
 * 读失败/解析失败一律返回 null（调用方降级为全局默认），只 warn 不阻塞 UI。
 */

import { invoke } from '@/services/transport'
import { createLogger } from '@/utils/logger'
import type { ProfileMode } from '@/types/sessionConfig'

const log = createLogger('NewSessionPrefs')

/** router_dispatch 返回形态（与 commands/router.rs RouterDispatchResponse 对应） */
interface DispatchResponse {
  msgId: string
  ok: boolean
  result: Record<string, unknown> | null
  error: string | null
  trace: string
}

/** 按引擎记忆的一条「新建会话偏好」记录 */
export interface NewSessionPrefs {
  /** 供应商模式（official=官方 API / profile=指定 Profile） */
  providerMode: ProfileMode
  /** Profile id；official 模式下恒为空串（哨兵 OFFICIAL_API_PROFILE 只用于会话级覆盖，不落到记忆层） */
  modelProfileId: string
  /** 选定的模型名（可能为空 = 跟随 Profile 默认 / 官方默认） */
  model: string
}

/**
 * 校验并归一化从 kv 读回的偏好；结构不合法返回 null（调用方降级）。
 * 「official 却携带 Profile id」「profile 却无 id」这类手改/旧数据一律归一化
 * （profile 无 id → 视为无效记忆，整体降级全局默认），
 * 防止恢复出与显示语义不一致的状态。
 */
export function normalizeNewSessionPrefs(raw: unknown): NewSessionPrefs | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const mode = r.providerMode
  const providerMode: ProfileMode | null = mode === 'official' || mode === 'profile' ? mode : null
  if (!providerMode) return null
  const modelProfileId = typeof r.modelProfileId === 'string' ? r.modelProfileId : ''
  // profile 模式必须携带真实 Profile id，否则视为无效记忆（降级全局默认）
  if (providerMode === 'profile' && !modelProfileId) return null
  const model = typeof r.model === 'string' ? r.model : ''
  return {
    providerMode,
    modelProfileId: providerMode === 'official' ? '' : modelProfileId,
    model,
  }
}

/** cap.kv 键：按引擎分层，避免与其它 kv 使用方冲突 */
export function newSessionPrefsKey(engineId: string): string {
  return `new-session-prefs:${engineId}`
}

/** 经 RouterBus dispatch 调用 cap.kv */
async function dispatchKv(
  action: 'get' | 'set',
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await invoke<DispatchResponse>('router_dispatch', {
    req: {
      target: 'cap.kv',
      payload: {
        action,
        ...payload,
      },
    },
  })

  if (!res.ok) {
    throw new Error(res.error || `cap.kv ${action} 失败`)
  }
  return res.result || {}
}

/**
 * 读取指定引擎的新建会话偏好。读失败/解析失败一律返回 null，
 * 调用方降级为全局默认（记忆是增强功能，失败只降级不报错）。
 */
export async function readNewSessionPrefs(engineId: string): Promise<NewSessionPrefs | null> {
  try {
    const result = await dispatchKv('get', { key: newSessionPrefsKey(engineId) })
    return normalizeNewSessionPrefs(result.value)
  } catch (e) {
    log.warn('读取新建会话偏好失败，按全局默认降级', { engineId, error: String(e) })
    return null
  }
}

/**
 * 写入指定引擎的新建会话偏好。写失败仅 warn 不重试：
 * 面板内存态已是浏览态事实源，落库失败只影响下次打开恢复。
 */
export async function persistNewSessionPrefs(
  engineId: string,
  prefs: NewSessionPrefs,
): Promise<void> {
  try {
    const normalized = normalizeNewSessionPrefs(prefs)
    if (!normalized) return
    await dispatchKv('set', {
      key: newSessionPrefsKey(engineId),
      value: normalized,
    })
  } catch (e) {
    log.warn('写入新建会话偏好失败', { engineId, error: String(e) })
  }
}