/**
 * cap.config 统一配置服务
 *
 * 第八步：系统配置读写着总线（router_dispatch → cap.config）。
 * 与 simpleTodoService / contextService 同一范式：经 RouterBus dispatch
 * 而非直接 tauri command，获得统一权限 gate + 审计 + 深层合并保存。
 *
 * 与旧 `update_config_patch` 的关键差异：
 * - patch 走 cap.config 白名单 schema 校验（未列入的字段/section 拒绝）
 * - patch 对多字段 section（performance 等）先读现值再深层合并，
 *   **避免顶层整体替换丢其它开关**（ConfigStore::patch 只并第一层）
 * - get 读取时对敏感字段（web.token / modelProfiles.apiKey）脱敏
 */

import { invoke } from '@/services/transport'
import type { Config } from '@/types'
import { createLogger } from '@/utils/logger'

const log = createLogger('ConfigDispatchService')

/**
 * router_dispatch 返回形态（与 commands/router.rs RouterDispatchResponse 对应）
 */
interface DispatchResponse {
  msgId: string
  ok: boolean
  result: Record<string, unknown> | null
  error: string | null
  trace: string
}

/** cap.config schema 动作返回的 section 声明 */
export interface ConfigSectionSchema {
  name: string
  fields: string[]
  write: 'write' | 'read' | 'locked'
}

/**
 * 经 RouterBus dispatch 调用 cap.config
 */
async function dispatchConfig(
  action: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await invoke<DispatchResponse>('router_dispatch', {
    req: {
      target: 'cap.config',
      payload: {
        action,
        ...payload,
      },
    },
  })

  if (!res.ok) {
    throw new Error(res.error || `cap.config ${action} 失败`)
  }
  return res.result || {}
}

/**
 * 读取指定 section（缺省 all → 白名单全部）。
 * 敏感字段（token/apiKey）已脱敏。
 */
export async function configGet(section: string = 'all'): Promise<Record<string, unknown>> {
  try {
    return await dispatchConfig('get', { section })
  } catch (e) {
    log.warn('cap.config get 失败', { section, error: String(e) })
    throw e
  }
}

/**
 * patch 指定 section。多字段 section 内部先读现值再深层合并，
 * 不会丢其它字段。返回完整 Config（与旧 update_config_patch 对齐）。
 */
export async function configPatch(
  section: string,
  value: Record<string, unknown>,
): Promise<Config> {
  try {
    const res = await dispatchConfig('patch', { section, value })
    return res as unknown as Config
  } catch (e) {
    log.warn('cap.config patch 失败', { section, error: String(e) })
    throw e
  }
}

/**
 * 白名单 schema（纯声明，前端据此渲染配置控件）。
 */
export async function configSchema(): Promise<{ schemaVersion: number; sections: ConfigSectionSchema[] }> {
  try {
    return (await dispatchConfig('schema', {})) as unknown as {
      schemaVersion: number
      sections: ConfigSectionSchema[]
    }
  } catch (e) {
    log.warn('cap.config schema 失败', { error: String(e) })
    throw e
  }
}