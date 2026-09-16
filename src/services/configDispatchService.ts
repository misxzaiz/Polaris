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
    // 桌面：config_patch_via_bus（补 emit 热切换广播）。该命令返回裸 Config
    // （Rust `Result<Config>`），不是 router_dispatch 的 {ok,result,error} 信封。
    if (currentMode === 'tauri') {
      return await invoke<Config>('config_patch_via_bus', {
        req: {
          target: 'cap.config',
          payload: { action: 'patch', patch },
        },
      })
    }
    // Web：router_dispatch（现状，无 emit）
    const res = await dispatchConfig('patch', { patch })
    return res as unknown as Config
  } catch (e) {
    log.warn('cap.config patchTop 失败', { error: String(e), mode: currentMode })
    throw e
  }
}

export async function configPatch(
  section: string,
  value: Record<string, unknown>,
): Promise<Config> {
  try {
    // 桌面：config_patch_via_bus（补 emit 热切换广播）。同上，返回裸 Config。
    if (currentMode === 'tauri') {
      return await invoke<Config>('config_patch_via_bus', {
        req: {
          target: 'cap.config',
          payload: { action: 'patch', section, value },
        },
      })
    }
    // Web：router_dispatch（现状，无 emit）
    const res = await dispatchConfig('patch', { section, value })
    return res as unknown as Config
  } catch (e) {
    log.warn('cap.config patch 失败', { section, error: String(e), mode: currentMode })
    throw e
  }
}

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