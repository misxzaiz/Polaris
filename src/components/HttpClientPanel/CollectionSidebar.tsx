/**
 * 已保存请求集合侧栏
 *
 * 浏览/打开/删除已保存请求，新建命名请求（保存当前 tab）。
 */

import { useState } from 'react'
import { Plus, Trash2, FolderOpen, X } from 'lucide-react'
import { useHttpClientStore } from '@/stores/httpClientStore'
import type { SavedRequest } from './httpClientTypes'

const METHOD_COLOR: Record<string, string> = {
  GET: 'text-green-400',
  POST: 'text-yellow-400',
  PUT: 'text-blue-400',
  PATCH: 'text-purple-400',
  DELETE: 'text-red-400',
  HEAD: 'text-text-tertiary',
  OPTIONS: 'text-text-tertiary',
}

export function CollectionSidebar({ onClose }: { onClose: () => void }) {
  const collection = useHttpClientStore((s) => s.collection)
  const openSavedInNewTab = useHttpClientStore((s) => s.openSavedInNewTab)
  const deleteSaved = useHttpClientStore((s) => s.deleteSaved)
  const saveActiveAsNew = useHttpClientStore((s) => s.saveActiveAsNew)
  const getActiveTab = useHttpClientStore((s) => s.getActiveTab)

  const [showSaveInput, setShowSaveInput] = useState(false)
  const [saveName, setSaveName] = useState('')

  const doSave = () => {
    const name = saveName.trim()
    if (!name) return
    const tab = getActiveTab()
    if (tab) saveActiveAsNew(name)
    setSaveName('')
    setShowSaveInput(false)
  }

  return (
    <div className="absolute inset-0 z-30 bg-background-elevated flex flex-col shadow-2xl">
      <div className="flex items-center justify-between px-3 h-10 border-b border-border shrink-0">
        <span className="text-xs font-medium text-text-primary">请求集合</span>
        <button onClick={onClose} className="p-1.5 rounded hover:bg-background-elevated text-text-secondary hover:text-text-primary">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="p-2 border-b border-border">
        {showSaveInput ? (
          <div className="flex items-center gap-1">
            <input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doSave()}
              autoFocus
              placeholder="请求名称"
              className="flex-1 min-w-0 px-2 py-1 text-xs bg-background-elevated border border-border rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary/50"
            />
            <button onClick={doSave} className="px-2 py-1 text-[10px] bg-primary text-white rounded">
              保存
            </button>
            <button onClick={() => setShowSaveInput(false)} className="px-1.5 py-1 text-[10px] text-text-tertiary hover:text-text-primary">
              取消
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowSaveInput(true)}
            className="w-full flex items-center justify-center gap-1 px-2 py-1.5 text-xs bg-background-elevated hover:bg-background-hover rounded text-text-secondary hover:text-text-primary transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> 保存当前请求
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {collection.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-text-tertiary">
            <FolderOpen className="w-6 h-6 mb-2" />
            <span className="text-[10px]">尚无保存的请求</span>
          </div>
        ) : (
          <div>
            {collection.map((r: SavedRequest) => (
              <div
                key={r.id}
                className="group flex items-center gap-2 px-3 py-2 hover:bg-background-elevated/50 cursor-pointer border-b border-border/30"
                onClick={() => {
                  openSavedInNewTab(r.id)
                  onClose()
                }}
              >
                <span className={`font-mono text-[10px] font-bold w-12 shrink-0 ${METHOD_COLOR[r.method] ?? 'text-text-tertiary'}`}>
                  {r.method}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-text-primary truncate">{r.name}</div>
                  <div className="text-[10px] text-text-tertiary truncate">{r.url}</div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (confirm(`删除请求 "${r.name}"？`)) deleteSaved(r.id)
                  }}
                  className="opacity-0 group-hover:opacity-100 p-1 text-text-tertiary hover:text-red-400"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
