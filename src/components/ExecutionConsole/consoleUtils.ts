/**
 * 执行控制台工具函数
 */

import type { SessionStatus } from '@/types/session'
import type { Platform } from '@/types'

/** 格式化运行时长（ms → "2m14s" / "12s" / "1h03m"） */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  const remMinutes = minutes % 60
  return `${hours}h${remMinutes.toString().padStart(2, '0')}m`
}

/** 格式化时间戳为 HH:mm:ss */
export function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** scheduler 执行状态 → StatusSymbol 用的 SessionStatus */
export function schedulerStateToSessionStatus(state: 'idle' | 'running' | 'success' | 'failed'): SessionStatus {
  switch (state) {
    case 'running': return 'running'
    case 'failed': return 'error'
    default: return 'idle'
  }
}

/** 集成执行状态 → StatusSymbol 用的 SessionStatus */
export function integrationStatusToSessionStatus(status: 'running' | 'success' | 'failed'): SessionStatus {
  switch (status) {
    case 'running': return 'running'
    case 'failed': return 'error'
    default: return 'idle'
  }
}

/** 平台显示名 i18n key（executionConsole 命名空间） */
export function platformLabelKey(platform: Platform): string {
  return `platform.${platform}`
}
