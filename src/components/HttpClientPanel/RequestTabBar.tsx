/**
 * 请求标签栏
 *
 * 多请求 tab：新建、切换、关闭、右键关闭其他。
 * 标签名显示 method 色块 + url 摘要 + dirty 点。
 */

import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { useHttpClientStore } from '@/stores/httpClientStore'
import type { RequestTab } from './httpClientTypes'

const METHOD_COLOR: Record<string, string> = {
  GET: 'text-green-400',
  POST: 'text-yellow-400',
  PUT: 'text-blue-400',
  PATCH: 'text-purple-400',
  DELETE: 'text-red-400',
  HEAD: 'text-text-tertiary',
  OPTIONS: 'text-text-tertiary',
}

export function RequestTabBar() {
  const tabs = useHttpClientStore((s) => s.tabs)
  const activeTabId = useHttpClientStore((s) => s.activeTabId)
  const setActiveTab = useHttpClientStore((s) => s.setActiveTab)
  const createTab = useHttpClientStore((s) => s.createTab)
  const closeTab = useHttpClientStore((s) => s.closeTab)

  const [menuTabId, setMenuTabId] = useState<string | null>(null)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)

  const closeOthers = (keepId: string) => {
    tabs.filter((t) => t.id !== keepId).forEach((t) => closeTab(t.id))
    setMenuTabId(null)
  }

  const closeAll = () => {
    tabs.forEach((t) => closeTab(t.id))
    setMenuTabId(null)
  }

  return (
    <div className="flex items-center gap-0.5 px-1.5 h-8 border-b border-border shrink-0 overflow-x-auto">
      {tabs.map((tab: RequestTab) => {
        const isActive = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenuTabId(tab.id)
              setMenuPos({ x: e.clientX, y: e.clientY })
            }}
            className={`group flex items-center gap-1.5 px-2 h-6 rounded text-[11px] cursor-pointer whitespace-nowrap transition-colors ${
              isActive ? 'bg-background-elevated text-text-primary' : 'text-text-tertiary hover:bg-background-elevated/50 hover:text-text-secondary'
            }`}
          >
            <span className={`font-mono font-bold ${METHOD_COLOR[tab.spec.method] ?? 'text-text-tertiary'}`}>
              {tab.spec.method}
            </span>
            <span className="max-w-[120px] truncate">{tab.name}</span>
            {tab.dirty && <span className="w-1 h-1 rounded-full bg-primary shrink-0" />}
            <button
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
              className="p-0.5 rounded hover:bg-background-hover text-text-tertiary hover:text-text-primary opacity-0 group-hover:opacity-100"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </div>
        )
      })}
      <button
        onClick={() => createTab(null)}
        className="p-1 mx-1 rounded hover:bg-background-elevated text-text-tertiary hover:text-text-primary shrink-0"
        title="新建请求"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>

      {menuTabId && menuPos && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuTabId(null)} />
          <div
            className="fixed z-50 bg-background-elevated border border-border rounded shadow-lg py-1 min-w-[120px]"
            style={{ left: menuPos.x, top: menuPos.y }}
          >
            <button
              onClick={() => {
                closeTab(menuTabId)
                setMenuTabId(null)
              }}
              className="w-full text-left px-3 py-1.5 text-[11px] text-text-primary hover:bg-background-hover"
            >
              关闭
            </button>
            <button
              onClick={() => closeOthers(menuTabId)}
              className="w-full text-left px-3 py-1.5 text-[11px] text-text-primary hover:bg-background-hover"
            >
              关闭其他
            </button>
            <button
              onClick={closeAll}
              className="w-full text-left px-3 py-1.5 text-[11px] text-text-primary hover:bg-background-hover"
            >
              关闭全部
            </button>
          </div>
        </>
      )}
    </div>
  )
}
