/**
 * useCommands — React hook 订阅 commandRegistry
 *
 * 返回当前所有命令 + recent ids; 自动随 register/unregister/execute 重新渲染.
 * 使用 useSyncExternalStore 直接订阅, 避免 store 同步陷阱.
 */

import { useSyncExternalStore } from 'react'
import { commandRegistry, type Command } from '@/services/commandRegistry'

interface UseCommandsResult {
  commands: Command[]
  recentIds: string[]
}

let cachedSnapshot: UseCommandsResult = {
  commands: [],
  recentIds: [],
}

function subscribe(listener: () => void): () => void {
  return commandRegistry.subscribe(listener)
}

function sameCommands(a: Command[], b: Command[]): boolean {
  return a.length === b.length && a.every((cmd, idx) => cmd === b[idx])
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, idx) => value === b[idx])
}

// snapshot 必须是同步函数, 且在 registry 未变化时返回同一个引用.
// React 会在提交阶段再次读取 snapshot; 若每次都返回新对象, 会触发无限重渲染.
function getSnapshot(): UseCommandsResult {
  const commands = commandRegistry.list()
  const recentIds = commandRegistry.recentIds()

  if (
    sameCommands(commands, cachedSnapshot.commands) &&
    sameStrings(recentIds, cachedSnapshot.recentIds)
  ) {
    return cachedSnapshot
  }

  cachedSnapshot = { commands, recentIds }
  return cachedSnapshot
}

export function useCommands(): UseCommandsResult {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
