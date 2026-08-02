/**
 * RadialMenu - 扇形菜单组件
 *
 * 点击触发器后展开的扇形菜单，包含侧边栏功能按钮
 * 支持动画展开、点击外部关闭
 */

import { useRef, useEffect } from 'react'
import { Settings, PanelRight } from 'lucide-react'
import { useViewStore } from '@/stores/viewStore'
import { useTranslation } from 'react-i18next'
import { pluginIconMap, pluginRegistry, type PluginLeftPanelType } from '@/plugin-system'
import { isPluginUiEnabled, usePluginStore } from '@/stores/pluginStore'

interface RadialMenuProps {
  /** 是否显示 */
  isOpen: boolean
  /** 关闭菜单回调 */
  onClose: () => void
  /** 打开设置的回调 */
  onOpenSettings?: () => void
  /** 切换右侧面板的回调 */
  onToggleRightPanel?: () => void
  /** 右侧面板是否折叠 */
  rightPanelCollapsed?: boolean
  /** 悬停状态变化回调 */
  onHover?: (isHovering: boolean) => void
}

interface MenuItem {
  id: PluginLeftPanelType | 'settings' | 'rightPanel'
  icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  onClick: () => void
}

/** 菜单容器定位样式 */
const MENU_CONTAINER_STYLE: React.CSSProperties = {
  left: '20px',
  top: '58%',
  transform: 'translateY(-50%)',
}

/** 触发器定位样式 */
const TRIGGER_STYLE: React.CSSProperties = {
  top: '50%',
  transform: 'translateY(-50%)',
  left: '0',
}

export function RadialMenu({
  isOpen,
  onClose,
  onOpenSettings,
  onToggleRightPanel,
  rightPanelCollapsed,
  onHover
}: RadialMenuProps) {
  const { t } = useTranslation('common')
  const leftPanelType = useViewStore((state) => state.leftPanelType)
  const toggleLeftPanel = useViewStore((state) => state.toggleLeftPanel)
  const pluginStates = usePluginStore((state) => state.pluginStates)
  const menuRef = useRef<HTMLDivElement>(null)

  const pluginMenuItems: MenuItem[] = pluginRegistry
    .listViewContributions('activityBar')
    .filter((view) => isPluginUiEnabled(pluginStates, view.pluginId))
    .map((view) => ({
      id: view.panelType,
      icon: pluginIconMap[view.icon],
      label: t(view.labelKey, { defaultValue: view.labelDefault ?? view.panelType }),
      onClick: () => {
        toggleLeftPanel(view.panelType)
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
      }
    },
    {
      id: 'settings',
      icon: Settings,
      label: t('labels.settings'),
      onClick: () => {
        onOpenSettings?.()
        onClose()
      }
    }
  ]

  // 点击外部关闭菜单
  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node)
      ) {
        onClose()
      }
    }

    // 延迟添加监听，避免立即关闭
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 100)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen, onClose])

  // ESC 键关闭菜单
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  // 扇形菜单项的位置计算
  // 从悬浮球位置（左边垂直居中）向右展开扇形
  // 在 CSS 坐标系中（x 向右，y 向下）：
  // - 顶部菜单项角度接近 -90° (或 270°)
  // - 底部菜单项角度接近 90°
  // - 右侧中间菜单项角度接近 0°
  // 使用 270° 到 90° 的范围，确保所有菜单项在右侧
  const itemCount = menuItems.length
  const startAngle = -90 // 从正上方开始（CSS 坐标系）
  const endAngle = 90 // 展开到正下方
  const angleRange = endAngle - startAngle
  const radius = 120 // 半径（像素），14 项需要更大半径避免拥挤
  const menuContainerSizeStyle: React.CSSProperties = {
    width: radius + 60,
    height: radius * 2 + 60,
    marginTop: -radius - 10,
  }

  // 计算菜单项位置
  const getMenuPosition = (index: number) => {
    const angle = startAngle + (angleRange / (itemCount - 1)) * index
    const radian = (angle * Math.PI) / 180
    // CSS 坐标系：x 向右，y 向下
    const x = Math.cos(radian) * radius // cos(-90)=0, cos(0)=1, cos(90)=0
    const y = Math.sin(radian) * radius // sin(-90)=-1(顶部), sin(0)=0, sin(90)=1(底部)
    return { x, y }
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-50 animate-in fade-in duration-150"
      style={MENU_CONTAINER_STYLE}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
    >
      {/* 菜单项容器 - 垂直布局 */}
      <div
        className="relative"
        style={menuContainerSizeStyle}
      >
        {menuItems.map((item, index) => {
          const { x, y } = getMenuPosition(index)

          const isActive = item.id === leftPanelType ||
            (item.id === 'rightPanel' && !rightPanelCollapsed)

          return (
            <button
              key={item.id}
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
                // 位置相对于容器中心
                left: radius - 80 + x - 22, // 中心偏移 + x坐标 - 按钮宽度一半
                top: radius + 10 + y - 22, // 中心偏移 + y坐标 - 按钮高度一半
                animationDelay: `${index * 20}ms`
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
 * RadialMenuTrigger - 扇形菜单触发器（贴边半圆悬浮球）
 *
 * 特点：
 * - 左边缘完全贴屏幕，形成半圆效果
 * - 位置：屏幕左边垂直居中
 * - 支持悬停触发（hover）和点击触发
 */
export function RadialMenuTrigger({
  onHover,
  onClick,
  onPressStart,
  isOpen
}: {
  onHover?: (isHovering: boolean) => void
  onClick: () => void
  /** 按下瞬间回调（pointerdown，早于触屏合成的 mouseenter，用于记录按下前菜单状态） */
  onPressStart?: () => void
  isOpen: boolean
}) {
  const { t } = useTranslation('common')

  return (
    <button
      onClick={onClick}
      onPointerDown={onPressStart}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      className={`
        fixed z-40
        /* 贴边半圆：左半圆在屏幕外，右半圆在屏幕内 */
        w-8 h-14 -ml-4
        rounded-r-full
        flex items-center justify-center
        transition-all duration-200 ease-out
        group
        /* 玻璃透明风格 */
        bg-background-elevated/85 backdrop-blur-xl
        border border-border/50 border-l-0
        shadow-lg shadow-black/10
        hover:bg-background-elevated/95 hover:shadow-xl
        ${isOpen ? 'bg-background-elevated/95 shadow-xl' : ''}
      `}
      style={TRIGGER_STYLE}
      title={t('labels.showActivityBar')}
    >
      {/* 网格图标 - 表示功能菜单 */}
      <div className={`
        w-4 h-4 grid grid-cols-2 gap-0.5
        transition-transform duration-200
        ${isOpen ? 'rotate-45' : 'group-hover:scale-110'}
      `}>
        <div className={`w-1.5 h-1.5 bg-text-secondary rounded-sm transition-all duration-200 ${isOpen ? 'bg-primary' : ''}`} />
        <div className={`w-1.5 h-1.5 bg-text-secondary rounded-sm transition-all duration-200 ${isOpen ? 'bg-primary' : ''}`} />
        <div className={`w-1.5 h-1.5 bg-text-secondary rounded-sm transition-all duration-200 ${isOpen ? 'bg-primary' : ''}`} />
        <div className={`w-1.5 h-1.5 bg-text-secondary rounded-sm transition-all duration-200 ${isOpen ? 'bg-primary' : ''}`} />
      </div>
    </button>
  )
}
