/**
 * Personal Hub 面板入口（内置插件 panel）
 *
 * 根据状态渲染：
 * - 未配置 Supabase → 提示去设置页配置
 * - 已配置未登录 → LoginCard
 * - 已登录 → LinksView
 */
import { useEffect, useState } from 'react'
import { Settings, BookOpen } from 'lucide-react'
import { usePersonalHubAuthStore } from '@/stores/personalHubAuthStore'
import { isSupabaseConfigured } from '@/services/personalHub/supabase'
import { LoginCard } from './LoginCard'
import { LinksView } from './LinksView'
import { createLogger } from '@/utils/logger'

const log = createLogger('PersonalHubPanel')

interface PersonalHubPanelProps {
  pluginId: string
  onOpenSettings?: () => void
}

export function PersonalHubPanel({ pluginId, onOpenSettings }: PersonalHubPanelProps) {
  void pluginId
  const { user, initialized, initAuth } = usePersonalHubAuthStore()
  // 配置是否就绪（用户可能在设置页变更，面板每次切换重新读取）
  const [configured, setConfigured] = useState(isSupabaseConfigured())

  useEffect(() => {
    const ready = isSupabaseConfigured()
    setConfigured(ready)
    if (ready) {
      initAuth().catch((e) => log.warn('initAuth error', { error: e instanceof Error ? e.message : String(e) }))
    }
  }, [initAuth])

  // 配置变更时（用户保存设置后切回面板）重新检测
  useEffect(() => {
    const check = () => {
      const ready = isSupabaseConfigured()
      if (ready !== configured) {
        setConfigured(ready)
        if (ready) {
          usePersonalHubAuthStore.setState({ initialized: false })
          initAuth().catch(() => {})
        }
      }
    }
    // 聚焦面板时重新检测配置（设置保存会更新 configStore）
    const id = window.setInterval(check, 1500)
    return () => window.clearInterval(id)
  }, [configured, initAuth])

  if (!configured) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <BookOpen size={28} className="text-text-tertiary" />
        <div className="text-sm font-medium text-text-primary">个人空间未配置</div>
        <div className="max-w-xs text-xs text-text-tertiary">
          请先在设置 → 个人空间中填写 Supabase URL 与 anon key，并可选配置加密密钥。
        </div>
        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-secondary hover:bg-background-hover"
          >
            <Settings size={12} /> 打开设置
          </button>
        )}
      </div>
    )
  }

  if (!initialized) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-xs text-text-muted">加载中...</div>
      </div>
    )
  }

  if (!user) {
    return <LoginCard />
  }

  return <LinksView />
}

export default PersonalHubPanel
