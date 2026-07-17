/**
 * OPFS → 远程后端 对话存储迁移
 *
 * 把存在于浏览器 OPFS 中的历史 jsonl 对话迁移到服务端 `<DataRoot>/dialogs/`。
 *
 * 触发条件：transport 可达（Tauri 桌面端 IPC 或 Web/HTTP）。
 * Web 模式此前把会话存进浏览器私有 OPFS（跨浏览器不互通的根因），
 * 统一改走远程后端后，本迁移负责把存量数据上行。
 *
 * 迁移流程：
 *   1. 探测 OPFS 是否可用（不可用 → 跳过，无事可做）
 *   2. 列举 OPFS 全部 jsonl
 *   3. 逐个读 OPFS → 写远程后端 → 读回校验
 *   4. 全部成功后写本地标记，避免重复迁移
 *   5. 失败的项目记录到报告，用户可重试
 *
 * 不主动删除 OPFS 数据：用户可在迁移成功后手动清理（避免不可逆）。
 */

import { OPFSBackend, RemoteBackend } from './dialogBackend'
import { isTauri, isWeb } from '@/utils/platform'
import { createLogger } from '@/utils/logger'

const log = createLogger('OpfsMigration')

const MIGRATED_FLAG_KEY = 'polaris.dialog.opfs_migrated'

export interface OpfsMigrationItemError {
  name: string
  error: string
}

export interface OpfsMigrationReport {
  /** OPFS 中找到的对话总数（含迁移前已存在的，但去重不在前端做） */
  total: number
  /** 实际成功迁移条数 */
  success: number
  /** 已存在跳过 */
  skipped: number
  /** 失败条数 */
  failed: number
  /** 错误详情 */
  errors: OpfsMigrationItemError[]
  /** 完成时是否写入了"已迁移"标记 */
  flagged: boolean
}

function isOPFSAvailable(): boolean {
  try {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.storage &&
      typeof navigator.storage.getDirectory === 'function'
    )
  } catch {
    return false
  }
}

/** 是否曾经标记过迁移完成 */
export function isOpfsMigrated(): boolean {
  try {
    return localStorage.getItem(MIGRATED_FLAG_KEY) === '1'
  } catch {
    return false
  }
}

/** 重置迁移标记（用于测试或用户主动重新迁移） */
export function resetOpfsMigratedFlag(): void {
  try {
    localStorage.removeItem(MIGRATED_FLAG_KEY)
  } catch {
    // ignore
  }
}

/** 估算 OPFS 中的对话数量（不读内容，仅 list） */
export async function probeOpfsDialogCount(): Promise<number> {
  if (!isOPFSAvailable()) return 0
  try {
    const opfs = new OPFSBackend()
    const files = await opfs.listFiles()
    return files.length
  } catch (e) {
    log.warn('探测 OPFS 失败', { error: String(e) })
    return 0
  }
}

/**
 * 执行迁移。
 *
 * @param overwrite 当 Tauri 端已有同名文件时是否覆盖；默认 false（跳过保留磁盘数据）。
 */
export async function migrateOpfsToTauri(
  overwrite = false,
): Promise<OpfsMigrationReport> {
  if (!isTauri() && !isWeb()) {
    throw new Error('OPFS 迁移需要后端可达（Tauri IPC 或 HTTP）')
  }
  if (!isOPFSAvailable()) {
    return { total: 0, success: 0, skipped: 0, failed: 0, errors: [], flagged: false }
  }

  const opfs = new OPFSBackend()
  const remote = new RemoteBackend()

  let names: string[] = []
  try {
    names = await opfs.listFiles()
  } catch (e) {
    throw new Error(`列举 OPFS 失败: ${String(e)}`)
  }

  const errors: OpfsMigrationItemError[] = []
  let success = 0
  let skipped = 0
  let failed = 0

  // 预读远程端已存在列表，避免逐个 read 浪费 IPC
  let remoteExisting: Set<string>
  try {
    remoteExisting = new Set(await remote.listFiles())
  } catch (e) {
    log.warn('列举远程后端失败，按未存在处理', { error: String(e) })
    remoteExisting = new Set()
  }

  for (const name of names) {
    try {
      if (!overwrite && remoteExisting.has(name)) {
        skipped++
        continue
      }
      const content = await opfs.readFile(name)
      if (content == null) {
        // OPFS 列出却读不到，记为失败
        failed++
        errors.push({ name, error: 'OPFS 读取返回 null' })
        continue
      }
      await remote.writeFile(name, content)
      // 校验：读回比对
      const back = await remote.readFile(name)
      if (back !== content) {
        failed++
        errors.push({ name, error: '写入后校验内容不一致' })
        continue
      }
      success++
    } catch (e) {
      failed++
      errors.push({ name, error: String(e) })
    }
  }

  let flagged = false
  if (failed === 0) {
    try {
      localStorage.setItem(MIGRATED_FLAG_KEY, '1')
      flagged = true
    } catch {
      // ignore
    }
  }

  log.info('OPFS 对话迁移完成', { total: names.length, success, skipped, failed })

  return {
    total: names.length,
    success,
    skipped,
    failed,
    errors,
    flagged,
  }
}

/**
 * 启动时静默自动迁移（幂等）。
 *
 * Web 端此前把会话存进浏览器 OPFS,统一改走远程后端后,
 * 首次启动把存量数据上行；无存量/已迁移则打标记跳过。
 * 失败不打扰用户,下次启动自动重试。
 */
export async function maybeAutoMigrateOpfs(): Promise<void> {
  try {
    if (!isTauri() && !isWeb()) return
    if (isOpfsMigrated()) return
    const count = await probeOpfsDialogCount()
    if (count === 0) {
      try {
        localStorage.setItem(MIGRATED_FLAG_KEY, '1')
      } catch {
        /* ignore */
      }
      return
    }
    const report = await migrateOpfsToTauri(false)
    log.info('OPFS 存量会话自动迁移完成', {
      total: report.total,
      success: report.success,
      skipped: report.skipped,
      failed: report.failed,
    })
  } catch (e) {
    log.warn('OPFS 自动迁移失败（下次启动重试）', { error: String(e) })
  }
}

/** 清空 OPFS 对话目录（用户在迁移成功后可选执行） */
export async function clearOpfsDialogs(): Promise<{ deleted: number; failed: number }> {
  if (!isOPFSAvailable()) return { deleted: 0, failed: 0 }
  const opfs = new OPFSBackend()
  let deleted = 0
  let failed = 0
  try {
    const names = await opfs.listFiles()
    for (const name of names) {
      try {
        await opfs.deleteFile(name)
        deleted++
      } catch {
        failed++
      }
    }
  } catch (e) {
    log.warn('清空 OPFS 失败', { error: String(e) })
  }
  return { deleted, failed }
}
