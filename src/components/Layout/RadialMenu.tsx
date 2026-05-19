/**
 * RadialMenu - 扇形菜单组件 (折叠态 ActivityBar 的替代品)
 *
 * 支持左/右两种位置 (side prop):
 * - side='left': 触发器贴左边,扇形向右展开 (-90° ~ 90°)
 * - side='right': 触发器贴右边,扇形向左展开 (90° ~ 270°)
 */

import { useRef, useEffect } from 'react'
import { Settings, PanelRight } from 'lucide-react'
import { useLayoutStore } from '@/stores/layoutStore'
import { useTranslation } from 'react-i18next'
import { pluginIconMap, pluginRegistry } from '@/plugin-system'
import { isPluginUiEnabled, usePluginStore } from '@/stores/pluginStore'
import type { ModuleId } from '@/types/layout'

interface RadialMenuProps {
  isOpen: boolean
  onClose: () => void
  side?: 'left' | 'right'
  onOpenSettings?: () => void
  onToggleRightPanel?: () => void
  rightPanelCollapsed?: boolean
  onHover?: (isHovering: boolean) => void
}

interface MenuItem {
  id: ModuleId | 'settings' | 'rightPanel'
  icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  onClick: () => void
}

export function RadialMenu({
  isOpen,
  onClose,
  side = 'left',
  onOpenSettings,
  onToggleRightPanel,
  rightPanelCollapsed,
  onHover,
}: RadialMenuProps) {
  const { t } = useTranslation('common')
  const slots = useLayoutStore((s) => s.slots)
  const activateModule = useLayoutStore((s) => s.activateModule)
  const pluginStates = usePluginStore((state) => state.pluginStates)
  const menuRef = useRef<HTMLDivElement>(null)

  const pluginMenuItems: MenuItem[] = pluginRegistry
    .listViewContributions('activityBar')
    .filter((view) => isPluginUiEnabled(pluginStates, view.pluginId))
    .filter((view) => view.moduleId !== 'chat')
    .map((view) => ({
      id: view.moduleId,
      icon: pluginIconMap[view.icon],
      label: t(view.labelKey, { defaultValue: view.labelDefault ?? view.moduleId }),
      onClick: () => {
        activateModule(view.moduleId)
        onClose()
      },
    }))

  const menuItems: MenuItem[] = [
    ...pluginMenuItems,
    {
      id: 'rightPanel',
      icon: PanelRight,
      label: rightPanelCollapsed ? t('labels.showAIPanel') : t('labels.hideAIPanel'),
      onClick: () => {
        onToggleRightPanel?.()
        onClose()
      },
    },
    {
      id: 'settings',
      icon: Settings,
      label: t('labels.settings'),
      onClick: () => {
        onOpenSettings?.()
        onClose()
      },
    },
  ]

  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 100)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen, onClose])

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  // 扇形角度范围:
  // - left: 从 -90° (上) 到 90° (下),向右展开 (x = cos(angle) > 0)
  // - right: 从 90° (下) 到 270° (上),向左展开 (x = cos(angle) < 0)
  const itemCount = menuItems.length
  const startAngle = side === 'left' ? -90 : 90
  const endAngle = side === 'left' ? 90 : 270
  const angleRange = endAngle - startAngle
  const radius = 120
  const buttonSize = 44
  const padding = 16

  const getMenuPosition = (index: number) => {
    const angle = startAngle + (angleRange / Math.max(itemCount - 1, 1)) * index
    const radian = (angle * Math.PI) / 180
    return { x: Math.cos(radian) * radius, y: Math.sin(radian) * radius }
  }

  const isModuleActive = (id: ModuleId | 'settings' | 'rightPanel') => {
    if (id === 'rightPanel') return !rightPanelCollapsed
    if (id === 'settings') return false
    return Object.values(slots).some((s) => s.activeModule === id)
  }

  // 容器尺寸: 半径 + 按钮 + padding 在每边
  const containerWidth = radius + buttonSize + padding
  const containerHeight = radius * 2 + buttonSize + padding
  const containerPosStyle = side === 'left' ? { left: '20px' } : { right: '20px' }
  // 圆心选择:
  // - left side: 圆心贴容器左边 (按钮 +x 向右展开)
  // - right side: 圆心贴容器右边 (按钮 -x 向左展开,镜像)
  const originX = side === 'left' ? buttonSize / 2 : containerWidth - buttonSize / 2
  const originY = containerHeight / 2

  return (
    <div
      ref={menuRef}
      className="fixed z-50 animate-in fade-in duration-150"
      style={{
        ...containerPosStyle,
        top: '58%',
        transform: 'translateY(-50%)',
      }}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
    >
      <div
        className="relative"
        style={{
          width: containerWidth,
          height: containerHeight,
          marginTop: -containerHeight / 2,
        }}
      >
        {menuItems.map((item, index) => {
          const { x, y } = getMenuPosition(index)
          const isActive = isModuleActive(item.id)
          return (
            <button
              key={item.id}
              type="button"
              onClick={item.onClick}
              className={`
                absolute w-11 h-11 rounded-xl flex items-center justify-center
                transition-all duration-200 ease-out transform
                hover:scale-110
                ${isActive
                  ? 'bg-primary/20 text-primary border border-primary/30 shadow-md'
                  : 'bg-background-surface text-text-secondary hover:text-text-primary hover:bg-background-hover border border-border shadow-sm'
                }
              `}
              style={{
                left: originX + x - buttonSize / 2,
                top: originY + y - buttonSize / 2,
                animationDelay: `${index * 20}ms`,
              }}
              title={item.label}
            >
              <item.icon size={18} className={isActive ? 'text-primary' : ''} />
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * RadialMenuTrigger - 扇形菜单触发器(贴边半圆悬浮球)
 *
 * side='left' 时贴屏幕左边,半圆开口朝右;side='right' 时贴屏幕右边,半圆开口朝左。
 */
export function RadialMenuTrigger({
  onHover,
  onClick,
  isOpen,
  side = 'left',
}: {
  onHover?: (isHovering: boolean) => void
  onClick: () => void
  isOpen: boolean
  side?: 'left' | 'right'
}) {
  const { t } = useTranslation('common')
  const positionStyle =
    side === 'left' ? { left: '0', top: '50%' } : { right: '0', top: '50%' }
  const sideClass =
    side === 'left' ? 'rounded-r-full -ml-4 border-l-0' : 'rounded-l-full -mr-4 border-r-0'

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      className={`
        fixed z-40
        w-8 h-14
        ${sideClass}
        flex items-center justify-center
        transition-all duration-200 ease-out
        group
        bg-background-elevated/85 backdrop-blur-xl
        border border-border/50
        shadow-lg shadow-black/10
        hover:bg-background-elevated/95 hover:shadow-xl
        ${isOpen ? 'bg-background-elevated/95 shadow-xl' : ''}
      `}
      style={{
        ...positionStyle,
        transform: 'translateY(-50%)',
      }}
      title={t('labels.showActivityBar')}
    >
      <div
        className={`
          w-4 h-4 grid grid-cols-2 gap-0.5
          transition-transform duration-200
          ${isOpen ? 'rotate-45' : 'group-hover:scale-110'}
        `}
      >
        <div className={`w-1.5 h-1.5 bg-text-secondary rounded-sm transition-all duration-200 ${isOpen ? 'bg-primary' : ''}`} />
        <div className={`w-1.5 h-1.5 bg-text-secondary rounded-sm transition-all duration-200 ${isOpen ? 'bg-primary' : ''}`} />
        <div className={`w-1.5 h-1.5 bg-text-secondary rounded-sm transition-all duration-200 ${isOpen ? 'bg-primary' : ''}`} />
        <div className={`w-1.5 h-1.5 bg-text-secondary rounded-sm transition-all duration-200 ${isOpen ? 'bg-primary' : ''}`} />
      </div>
    </button>
  )
}
