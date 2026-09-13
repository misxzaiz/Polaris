/**
 * 数据根（DataRoot）服务
 *
 * 第七步阶段 C：数据根管理上总线（router_dispatch → cap.data_root）。
 * 业务函数签名保持与旧命令层 invoke 一致（消费方零改动），内部改走
 * RouterBus dispatch，获得统一权限 gate + 审计。
 *
 * 唯一例外：`openPathInExplorer` 属平台壳命令（step7 §3 边界：资源管理器
 * 不进总线），保留直接 invoke。
 */

import { invoke } from '@/services/transport'
import { createLogger } from '@/utils/logger'

const log = createLogger('DataRootService')

/** router_dispatch 返回形态（与 commands/router.rs RouterDispatchResponse 对应） */
interface DispatchResponse {
  msgId: string
  ok: boolean
  result: Record<string, unknown> | null
  error: string | null
  trace: string
}

/** 数据根子目录信息 */
export interface SubdirInfo {
  /** 子目录名 */
  name: string
  /** 子目录绝对路径 */
  path: string
  /** 字节占用 */
  sizeBytes: number
  /** 文件数 */
  fileCount: number
}

/** 数据根总览 */
export interface DataRootInfo {
  /** 当前数据根绝对路径 */
  root: string
  /** 锚点文件路径（永远固定在 OS config_dir/Polaris/anchor.json） */
  anchorFile: string
  /** 是否使用了用户自定义路径 */
  isCustom: boolean
  /** 数据根总占用字节数 */
  totalSizeBytes: number
  /** 数据根总文件数 */
  totalFileCount: number
  /** 各子目录详情 */
  subdirs: SubdirInfo[]
}

/** 旧版数据源 */
export interface LegacySource {
  /** 源路径 */
  path: string
  /** 描述 */
  label: string
  /** 占用字节数 */
  sizeBytes: number
  /** 文件总数 */
  fileCount: number
  /** 是否存在 */
  exists: boolean
}

// ============================================================================
// 统一 dispatch 封装（cap.data_root）
// ============================================================================

/**
 * 经 RouterBus dispatch 调用 cap.data_root
 */
async function dispatchDataRoot(
  action: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await invoke<DispatchResponse>('router_dispatch', {
    req: {
      target: 'cap.data_root',
      payload: {
        action,
        ...payload,
      },
    },
  })

  if (!res.ok) {
    throw new Error(res.error || `cap.data_root ${action} 失败`)
  }
  return res.result || {}
}

/** 获取数据根信息 */
export async function getDataRootInfo(): Promise<DataRootInfo> {
  try {
    const res = await dispatchDataRoot('get_info', {})
    return res as unknown as DataRootInfo
  } catch (e) {
    log.warn('cap.data_root get_info 失败', { error: String(e) })
    throw e
  }
}

/** 扫描旧版数据 */
export async function scanLegacyData(): Promise<LegacySource[]> {
  try {
    const res = await dispatchDataRoot('scan_legacy', {})
    return res as unknown as LegacySource[]
  } catch (e) {
    log.warn('cap.data_root scan_legacy 失败', { error: String(e) })
    throw e
  }
}

/** 在系统资源管理器中打开路径（平台壳命令，直接 invoke） */
export async function openPathInExplorer(path: string): Promise<void> {
  await invoke<void>('open_path_in_explorer', { path })
}

// ============================================================================
// 旧数据迁移
// ============================================================================

/** 迁移单文件状态 */
export type MigrateStatus = 'copied' | 'skipped' | 'conflicted' | 'failed'

/** 单文件迁移结果 */
export interface MigrateItem {
  source: string
  target: string
  status: MigrateStatus
  message: string | null
}

/** 迁移总报告 */
export interface MigrateReport {
  successCount: number
  skippedCount: number
  conflictCount: number
  errorCount: number
  logFile: string
  items: MigrateItem[]
}

/** 迁移旧版数据
 *
 * @param sources 用户勾选的源路径
 * @param overwrite 冲突策略；false（默认）= 合并 + .legacy 副本；true = 旧版直接覆盖新版
 */
export async function migrateLegacyData(
  sources: string[],
  overwrite = false,
): Promise<MigrateReport> {
  try {
    const res = await dispatchDataRoot('migrate', {
      options: { sources, overwrite },
    })
    return res as unknown as MigrateReport
  } catch (e) {
    log.warn('cap.data_root migrate 失败', { error: String(e) })
    throw e
  }
}

// ============================================================================
// 切换数据根
// ============================================================================

export type SetDataRootMode = 'switch_only' | 'move_data'

export interface SetDataRootOptions {
  /** 新数据根绝对路径；为空表示恢复默认 */
  newPath: string | null
  mode: SetDataRootMode
}

export interface TargetValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
  resolvedPath: string
  currentSizeBytes: number
}

export interface MoveReport {
  successCount: number
  skippedCount: number
  conflictCount: number
  errorCount: number
  logFile: string
  itemsTruncated: boolean
  items: MigrateItem[]
}

export interface SetDataRootReport {
  oldRoot: string
  newRoot: string
  mode: string
  moveReport: MoveReport | null
  restartRequired: boolean
}

export async function validateDataRootTarget(
  options: SetDataRootOptions,
): Promise<TargetValidation> {
  try {
    const res = await dispatchDataRoot('validate_target', { options })
    return res as unknown as TargetValidation
  } catch (e) {
    log.warn('cap.data_root validate_target 失败', { error: String(e) })
    throw e
  }
}

export async function setDataRoot(options: SetDataRootOptions): Promise<SetDataRootReport> {
  try {
    const res = await dispatchDataRoot('set_root', { options })
    return res as unknown as SetDataRootReport
  } catch (e) {
    log.warn('cap.data_root set_root 失败', { error: String(e) })
    throw e
  }
}

/** 字节数格式化（人类可读） */
export function formatBytes(bytes: number): string {
  if (bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`
}
