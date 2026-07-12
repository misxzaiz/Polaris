/**
 * 数据根（DataRoot）服务
 *
 * 封装数据存储相关的后端命令调用：
 * - 查询当前数据根信息
 * - 扫描旧版残留数据
 * - 在系统资源管理器中打开路径
 *
 * P1 阶段仅查询接口；P2/P3 后续会扩展迁移与切换路径接口。
 */

import { invoke } from '@/services/transport'

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

/** 获取数据根信息 */
export async function getDataRootInfo(): Promise<DataRootInfo> {
  return invoke<DataRootInfo>('get_data_root_info')
}

/** 扫描旧版数据 */
export async function scanLegacyData(): Promise<LegacySource[]> {
  return invoke<LegacySource[]>('scan_legacy_data_cmd')
}

/** 在系统资源管理器中打开路径 */
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
  return invoke<MigrateReport>('migrate_legacy_data', { options: { sources, overwrite } })
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
  return invoke<TargetValidation>('validate_data_root_target', { options })
}

export async function setDataRoot(options: SetDataRootOptions): Promise<SetDataRootReport> {
  return invoke<SetDataRootReport>('set_data_root', { options })
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
