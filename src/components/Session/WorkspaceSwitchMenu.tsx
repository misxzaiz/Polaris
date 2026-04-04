/**
 * WorkspaceSwitchMenu - 工作区切换模式选择组件
 *
 * 提供三种切换模式：
 * 1. 本会话临时切换 - 仅当前会话使用该工作区
 * 2. 全局切换 - 影响所有自由会话
 * 3. 添加关联工作区 - 扩展 AI 访问范围
 */

import { cn } from '@/utils/cn'
import { ArrowLeft, Edit3, Globe, Users } from 'lucide-react'

interface WorkspaceSwitchMenuProps {
  workspaceName: string
  onSwitchMode: (mode: 'temporary' | 'global' | 'context') => void
  onBack: () => void
  onClose: () => void
}

interface SwitchModeOption {
  mode: 'temporary' | 'global' | 'context'
  title: string
  description: string
  icon: typeof Edit3
  iconColor: string
}

const switchModes: SwitchModeOption[] = [
  {
    mode: 'temporary',
    title: '本会话临时切换',
    description: '仅当前会话使用此工作区',
    icon: Edit3,
    iconColor: 'text-sky-500',
  },
  {
    mode: 'global',
    title: '全局切换',
    description: '切换全局工作区，影响所有自由会话',
    icon: Globe,
    iconColor: 'text-amber-500',
  },
  {
    mode: 'context',
    title: '添加关联工作区',
    description: '扩展 AI 可访问的文件范围',
    icon: Users,
    iconColor: 'text-green-500',
  },
]

export function WorkspaceSwitchMenu({
  workspaceName,
  onSwitchMode,
  onBack,
  onClose: _onClose,
}: WorkspaceSwitchMenuProps) {
  return (
    <div className="w-[240px] py-2 bg-background-elevated border border-border rounded-xl shadow-lg">
      {/* 头部 */}
      <div className="px-2 mb-2">
        <button
          onClick={onBack}
          className={cn(
            'flex items-center gap-1.5 px-1 py-1 -ml-1',
            'text-sm text-text-tertiary hover:text-text-secondary',
            'transition-colors'
          )}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          返回
        </button>

        <div className="mt-2 px-1">
          <div className="text-xs font-medium text-text-tertiary mb-1">
            切换到工作区
          </div>
          <div className="text-sm font-medium text-text-primary truncate">
            {workspaceName}
          </div>
        </div>
      </div>

      {/* 分割线 */}
      <div className="mx-2 my-1 border-t border-border" />

      {/* 切换模式选项 */}
      <div className="px-2 space-y-1">
        {switchModes.map((option) => {
          const Icon = option.icon

          return (
            <button
              key={option.mode}
              onClick={() => onSwitchMode(option.mode)}
              className={cn(
                'w-full px-3 py-2.5 rounded-lg text-left transition-colors',
                'hover:bg-background-hover'
              )}
            >
              <div className="flex items-start gap-2.5">
                {/* 图标 */}
                <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', option.iconColor)} />

                {/* 文本 */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text-primary">
                    {option.title}
                  </div>
                  <div className="text-xs text-text-tertiary mt-0.5">
                    {option.description}
                  </div>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}