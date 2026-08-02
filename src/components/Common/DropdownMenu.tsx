/**
 * 下拉菜单组件
 *
 * 用于显示操作菜单
 */

import { useRef, useEffect, useState } from 'react'

export interface DropdownMenuItem {
  key: string
  label: string
  icon?: React.ReactNode
  variant?: 'default' | 'danger' | 'warning'
  disabled?: boolean
  onClick: () => void
}

interface DropdownMenuProps {
  trigger: React.ReactNode
  items: DropdownMenuItem[]
  align?: 'left' | 'right'
  className?: string
}

export function DropdownMenu({
  trigger,
  items,
  align = 'left',
  className = ''
}: DropdownMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  const handleItemClick = (item: DropdownMenuItem) => {
    if (item.disabled) return
    setIsOpen(false)
    item.onClick()
  }

  const getVariantClass = (variant?: string) => {
    switch (variant) {
      case 'danger':
        return 'text-danger hover:bg-danger/10'
      case 'warning':
        return 'text-warning hover:bg-warning/10'
      default:
        return 'text-text-primary hover:bg-background-hover'
    }
  }

  return (
    <div className={`relative ${className}`} ref={menuRef}>
      {/* 触发器 */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="cursor-pointer"
      >
        {trigger}
      </div>

      {/* 菜单内容 */}
      {isOpen && (
        <div
          className={`absolute z-50 min-w-[160px] py-1 mt-1 bg-background-elevated border border-border rounded-lg shadow-lg ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {items.map((item) => (
            <button
              key={item.key}
              onClick={() => handleItemClick(item)}
              disabled={item.disabled}
              className={`w-full px-3 py-2 text-sm text-left flex items-center gap-2 transition-colors ${
                item.disabled
                  ? 'text-text-tertiary cursor-not-allowed'
                  : getVariantClass(item.variant)
              }`}
            >
              {item.icon && <span className="shrink-0">{item.icon}</span>}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
