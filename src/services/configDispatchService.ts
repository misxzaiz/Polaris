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
import { currentMode } from '@/services/transport'
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
 * 读取完整 config（D 阶段摘旧：前端 configStore 驱动 UI 需要全量）。
 * 等价旧 `get_config`；敏感字段仍脱敏。桌面走 router_dispatch（Bootstrap），
 * Web 走 HTTP router_dispatch（Remote，已认证）——cap.config get full 不限源。
 */
export async function configGetFull(): Promise<Config> {
  const res = await dispatchConfig('get', { section: 'full' })
  return res as unknown as Config
}

/**
 * 顶层对象 patch（D 阶段摘旧：前端 updateConfigPatch 切换后的协议）。
 * `patch` 内可混含白名单 section（严格深层合并）与自由顶层 key（透传
 * store.patch 整体替换），一次落盘全部。返回完整 Config。
 */
export async function configPatchTop(patch: Record<string, unknown>): Promise<Config> {
  try {
    // 桌面：config_patch_via_bus（补 emit 热切换广播）
    if (currentMode === 'tauri') {
      const res = await invoke<DispatchResponse>('config_patch_via_bus', {
        req: {
          target: 'cap.config',
          payload: { action: 'patch', patch },
        },
      })
      if (!res.ok) {
        throw new Error(res.error || `cap.config patch 失败`)
      }
      return (res.result || {}) as unknown as Config
    }
    // Web：router_dispatch（现状，无 emit）
    const res = await dispatchConfig('patch', { patch })
    return res as unknown as Config
  } catch (e) {
    log.warn('cap.config patchTop 失败', { error: String(e), mode: currentMode })
    throw e
  }
}

/**
 * patch 指定 section。多字段 section 内部先读现值再深层合并，
 * 不会丢其它字段。返回完整 Config（与旧 update_config_patch 对齐）。
 *
 * A2：桌面（tauri）走 `config_patch_via_bus`（经 RouterBus 补全量副作用
 * cascade→refresh→emit）；Web（http）走 `router_dispatch`（无 AppHandle，
 * emit 缺，与 handle_update_settings 现状一致，前端 applyConfig 兜底）。
 */
export async function configPatch(
  section: string,
  value: Record<string, unknown>,
): Promise<Config> {
  try {
    // 桌面：config_patch_via_bus（补 emit 热切换广播）
    if (currentMode === 'tauri') {
      const res = await invoke<DispatchResponse>('config_patch_via_bus', {
        req: {
          target: 'cap.config',
          payload: { action: 'patch', section, value },
        },
      })
      if (!res.ok) {
        throw new Error(res.error || `cap.config patch 失败`)
      }
      return (res.result || {}) as unknown as Config
    }
    // Web：router_dispatch（现状，无 emit）
    const res = await dispatchConfig('patch', { section, value })
    return res as unknown as Config
  } catch (e) {
    log.warn('cap.config patch 失败', { section, error: String(e), mode: currentMode })
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