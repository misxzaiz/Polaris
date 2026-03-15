/**
 * ActivityBar - 左侧 Activity Bar 组件
 *
 * 固定在左侧的图标栏,始终可见,用于切换面板
 * 参考 VSCode 的 Activity Bar 设计
 */

import { Files, GitPullRequest, CheckSquare, Settings, Languages, Clock, Terminal } from 'lucide-react'
import { useViewStore } from '@/stores/viewStore'
import { ActivityBarIcon } from './ActivityBarIcon'
import { useTranslation } from 'react-i18next'

interface ActivityBarProps {
  className?: string
  /** 可选: 打开设置的回调 */
  onOpenSettings?: () => void
}

export function ActivityBar({ className, onOpenSettings }: ActivityBarProps) {
  const { t } = useTranslation('common')
  const leftPanelType = useViewStore((state) => state.leftPanelType)
  const toggleLeftPanel = useViewStore((state) => state.toggleLeftPanel)

  const panelButtons = [
    {
      id: 'files' as const,
      icon: Files,
      label: t('labels.fileExplorer'),
    },
    {
      id: 'git' as const,
      icon: GitPullRequest,
      label: t('labels.gitPanel'),
    },
    {
      id: 'todo' as const,
      icon: CheckSquare,
      label: t('labels.todoPanel'),
    },
    {
      id: 'translate' as const,
      icon: Languages,
      label: t('labels.translatePanel'),
    },
    {
      id: 'scheduler' as const,
      icon: Clock,
      label: t('labels.schedulerPanel'),
    },
    {
      id: 'terminal' as const,
      icon: Terminal,
      label: t('labels.terminalPanel'),
    },
  ]

  return (
    <div
      className={`flex flex-col items-center shrink-0 w-12 py-2 bg-background-elevated border-r border-border ${className || ''}`}
    >
      {panelButtons.map((btn) => (
        <ActivityBarIcon
          key={btn.id}
          icon={btn.icon}
          label={btn.label}
          active={leftPanelType === btn.id}
          onClick={() => toggleLeftPanel(btn.id)}
        />
      ))}

      <div className="flex-1" />

      <ActivityBarIcon
        icon={Settings}
        label={t('labels.settings')}
        active={false}
        onClick={onOpenSettings || (() => {})}
      />
    </div>
  )
}
