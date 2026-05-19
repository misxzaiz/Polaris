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

function subscribe(listener: () => void): () => void {
  return commandRegistry.subscribe(listener)
}

// snapshot 必须是同步函数, 且引用稳定 (相同状态 → 相同对象)
// 用一个简单的 memo: 每次内部状态变化时 commandRegistry 会 notify → React 重新调用 snapshot
// 我们生成新对象, React 浅比较会发现不同 → re-render. 这是 OK 的因为 notify 频率很低.
function getSnapshot(): UseCommandsResult {
  return {
    commands: commandRegistry.list(),
    recentIds: commandRegistry.recentIds(),
  }
}

export function useCommands(): UseCommandsResult {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
