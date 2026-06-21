/**
 * HTTP Client 面板（内置插件 panel）
 *
 * 生产级 API 调试器：多请求标签页 + 环境变量 {{}} 替换 + cURL 导入 +
 * 响应多视图（美化/树/表格/预览）+ 请求集合持久化 + 全屏。
 */

import { useEffect, useState } from 'react'
import { Globe, Maximize2, Minimize2, Send, FolderOpen, Settings2 } from 'lucide-react'
import { useHttpClientStore } from '@/stores/httpClientStore'
import { useViewStore } from '@/stores/viewStore'
import { RequestTabBar } from './RequestTabBar'
import { RequestEditor } from './RequestEditor'
import { ResponseViewer } from './ResponseViewer'
import { EnvironmentManager } from './EnvironmentManager'
import { CollectionSidebar } from './CollectionSidebar'

interface HttpClientPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

export function HttpClientPanel({ onSendToChat }: HttpClientPanelProps) {
  const init = useHttpClientStore((s) => s.init)
  const initialized = useHttpClientStore((s) => s.initialized)
  // 订阅 tabs/activeTabId 以驱动重渲染（发送请求、切换 tab 后刷新）
  const tabs = useHttpClientStore((s) => s.tabs)
  const activeTabId = useHttpClientStore((s) => s.activeTabId)

  const httpClientFullscreen = useViewStore((s) => s.httpClientFullscreen)
  const toggleFullscreen = useViewStore((s) => s.toggleHttpClientFullscreen)

  const [showEnv, setShowEnv] = useState(false)
  const [showCollection, setShowCollection] = useState(false)

  useEffect(() => {
    init()
  }, [init])

  // ESC 退出全屏
  useEffect(() => {
    if (!httpClientFullscreen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        toggleFullscreen()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [httpClientFullscreen, toggleFullscreen])

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  const handleSendToChat = () => {
    if (!onSendToChat || !activeTab?.response) return
    const r = activeTab.response
    const lines = [
      `${activeTab.spec.method} ${activeTab.spec.url}`,
      `→ HTTP ${r.status} ${r.statusText} | ${r.elapsedMs} ms | ${r.size} bytes`,
      '',
      r.body.slice(0, 2000),
    ]
    onSendToChat(lines.join('\n'))
  }

  if (!initialized || !activeTab) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-text-tertiary">
        初始化中…
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full relative">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-10 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-text-secondary" />
          <span className="text-xs font-medium text-text-primary">HTTP Client</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { setShowCollection(true); setShowEnv(false) }}
            className="p-1.5 rounded hover:bg-background-elevated text-text-secondary hover:text-text-primary transition-colors"
            title="请求集合"
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => { setShowEnv(true); setShowCollection(false) }}
            className="p-1.5 rounded hover:bg-background-elevated text-text-secondary hover:text-text-primary transition-colors"
            title="环境变量"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
          {onSendToChat && (
            <button
              onClick={handleSendToChat}
              disabled={!activeTab.response}
              className="p-1.5 rounded hover:bg-background-elevated text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40"
              title="发送响应到聊天"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={toggleFullscreen}
            className={`p-1.5 rounded transition-colors ${
              httpClientFullscreen ? 'bg-background-elevated text-text-primary' : 'text-text-secondary hover:bg-background-elevated hover:text-text-primary'
            }`}
            title={httpClientFullscreen ? '退出全屏 (Esc)' : '全屏'}
          >
            {httpClientFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* 多请求标签栏 */}
      <RequestTabBar />

      {/* 主体：编辑器 + 响应（全屏时左右分栏，否则上下） */}
      <div className={`flex-1 min-h-0 ${httpClientFullscreen ? 'flex-row' : 'flex-col'} flex`}>
        <div className={`${httpClientFullscreen ? 'w-1/2 border-r' : 'shrink-0'} border-border min-h-0 overflow-y-auto`}>
          <RequestEditor tab={activeTab} />
        </div>
        <div className="flex-1 min-h-0 flex flex-col">
          <ResponseViewer response={activeTab.response} error={activeTab.error} />
        </div>
      </div>

      {/* 抽屉：环境 / 集合 */}
      {showEnv && <EnvironmentManager onClose={() => setShowEnv(false)} />}
      {showCollection && <CollectionSidebar onClose={() => setShowCollection(false)} />}
    </div>
  )
}
