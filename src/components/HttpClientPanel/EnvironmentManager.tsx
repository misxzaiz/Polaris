/**
 * 环境变量管理器
 *
 * 增删改环境、编辑变量键值、设为当前环境。
 * 以面板内抽屉（absolute inset-0）形式覆盖，ESC 关闭。
 */

import { useEffect, useState } from 'react'
import { Plus, Trash2, X, Check, Star } from 'lucide-react'
import { useHttpClientStore } from '@/stores/httpClientStore'
import type { Environment, EnvVar } from './httpClientTypes'

export function EnvironmentManager({ onClose }: { onClose: () => void }) {
  const environments = useHttpClientStore((s) => s.environments)
  const activeEnvId = useHttpClientStore((s) => s.activeEnvId)
  const addEnvironment = useHttpClientStore((s) => s.addEnvironment)
  const updateEnvironment = useHttpClientStore((s) => s.updateEnvironment)
  const deleteEnvironment = useHttpClientStore((s) => s.deleteEnvironment)
  const setActiveEnv = useHttpClientStore((s) => s.setActiveEnv)

  const [selectedId, setSelectedId] = useState<string | null>(activeEnvId ?? environments[0]?.id ?? null)
  const [ newName, setNewName] = useState('')

  const selected = environments.find((e) => e.id === selectedId) ?? null

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const updateVar = (idx: number, key: 'name' | 'value', value: string) => {
    if (!selected) return
    const next = [...selected.variables]
    next[idx] = { ...next[idx], [key]: value }
    updateEnvironment(selected.id, { variables: next })
  }
  const addVar = () => {
    if (!selected) return
    updateEnvironment(selected.id, { variables: [...selected.variables, { name: '', value: '' }] })
  }
  const removeVar = (idx: number) => {
    if (!selected) return
    updateEnvironment(selected.id, { variables: selected.variables.filter((_, i) => i !== idx) })
  }

  return (
    <div className="absolute inset-0 z-30 bg-background-elevated flex flex-col shadow-2xl">
      <div className="flex items-center justify-between px-3 h-10 border-b border-border shrink-0">
        <span className="text-xs font-medium text-text-primary">环境变量管理</span>
        <button onClick={onClose} className="p-1.5 rounded hover:bg-background-elevated text-text-secondary hover:text-text-primary">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* 环境列表 */}
        <div className="w-40 shrink-0 border-r border-border overflow-y-auto">
          <div className="p-2 space-y-0.5">
            {environments.map((env: Environment) => (
              <div
                key={env.id}
                className={`flex items-center group rounded px-2 py-1.5 cursor-pointer text-xs ${
                  selectedId === env.id ? 'bg-background-elevated text-text-primary' : 'text-text-secondary hover:bg-background-elevated/50'
                }`}
                onClick={() => setSelectedId(env.id)}
              >
                <span className="flex-1 truncate">{env.name}</span>
                {activeEnvId === env.id && <Star className="w-3 h-3 text-primary shrink-0 fill-primary" />}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (confirm(`删除环境 "${env.name}"？`)) deleteEnvironment(env.id)
                  }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 text-text-tertiary hover:text-red-400"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
          <div className="p-2 border-t border-border">
            <div className="flex items-center gap-1">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="新环境名"
                className="flex-1 min-w-0 px-2 py-1 text-xs bg-background-elevated border border-border rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary/50"
              />
              <button
                onClick={() => {
                  if (newName.trim()) {
                    addEnvironment(newName.trim())
                    setNewName('')
                  }
                }}
                className="p-1 rounded bg-background-elevated hover:bg-background-hover text-text-secondary"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* 变量编辑 */}
        <div className="flex-1 min-w-0 flex flex-col">
          {selected ? (
            <>
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
                <input
                  value={selected.name}
                  onChange={(e) => updateEnvironment(selected.id, { name: e.target.value })}
                  className="flex-1 min-w-0 px-2 py-1 text-xs bg-background-elevated border border-border rounded text-text-primary focus:outline-none focus:border-primary/50"
                />
                <button
                  onClick={() => setActiveEnv(activeEnvId === selected.id ? null : selected.id)}
                  className={`flex items-center gap-1 px-2 py-1 text-[10px] rounded ${
                    activeEnvId === selected.id ? 'bg-primary text-white' : 'bg-background-elevated text-text-secondary hover:text-text-primary'
                  }`}
                >
                  <Check className="w-3 h-3" /> {activeEnvId === selected.id ? '当前环境' : '设为当前'}
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-1">
                <div className="flex items-center text-[10px] text-text-tertiary px-1 mb-1">
                  <span className="flex-1">变量名</span>
                  <span className="flex-1">值（在请求中以 {'{{变量名}}'} 引用）</span>
                  <span className="w-6" />
                </div>
                {selected.variables.map((v: EnvVar, idx) => (
                  <div key={idx} className="flex items-center gap-1">
                    <input
                      value={v.name}
                      onChange={(e) => updateVar(idx, 'name', e.target.value)}
                      placeholder="baseUrl"
                      className="flex-1 min-w-0 px-2 py-1 text-xs font-mono bg-background-elevated border border-border rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary/50"
                    />
                    <input
                      value={v.value}
                      onChange={(e) => updateVar(idx, 'value', e.target.value)}
                      placeholder="https://api.example.com"
                      className="flex-1 min-w-0 px-2 py-1 text-xs font-mono bg-background-elevated border border-border rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary/50"
                    />
                    <button
                      onClick={() => removeVar(idx)}
                      className="p-1 rounded hover:bg-background-elevated text-text-tertiary hover:text-red-400 w-6"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                <button
                  onClick={addVar}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
                >
                  <Plus className="w-3 h-3" /> 添加变量
                </button>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-text-tertiary">
              选择左侧环境或新建一个环境
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
