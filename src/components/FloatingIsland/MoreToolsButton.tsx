/**
 * MoreToolsButton - 更多工具按钮组件
 *
 * 下拉菜单包含：
 * - 导出聊天
 * - 历史会话
 * - 窗口置顶
 * - 最小化、最大化、关闭
 */

import { memo, useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/utils/cn'
import {
  MoreHorizontal,
  Download,
  Clock,
  Pin,
  Minus,
  Square,
  X,
  Loader2,
} from 'lucide-react'
import { useViewStore } from '@/stores'
import { useActiveSessionMessages } from '@/stores/conversationStore/useActiveSession'
import { exportToMarkdown, generateFileName } from '@/services/chatExport'
import * as tauri from '@/services/tauri'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { createLogger } from '@/utils/logger'

const log = createLogger('MoreToolsButton')

interface MoreToolsButtonProps {
  disabled?: boolean
}

export const MoreToolsButton = memo(function MoreToolsButton({
  disabled = false,
}: MoreToolsButtonProps) {
  const [isOpen, setIsOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })

  // 计算下拉菜单位置
  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setPosition({
        top: rect.bottom + 8,
        left: rect.right - 180, // 右对齐，菜单宽度 180px
      })
    }
  }, [isOpen])

  // 点击外部关闭
  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      const clickedDropdown =
        (target as Element)?.closest?.('[data-more-tools-dropdown]') !== null

      if (
        buttonRef.current &&
        !buttonRef.current.contains(target) &&
        !clickedDropdown
      ) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  const handleToggle = useCallback(() => {
    if (!disabled) {
      setIsOpen((prev) => !prev)
    }
  }, [disabled])

  return (
    <>
      <button
        ref={buttonRef}
        onClick={handleToggle}
        disabled={disabled}
        className={cn(
          'flex items-center justify-center w-7 h-7 rounded-full',
        'text-text-muted transition-colors',
          disabled
            ? 'opacity-40 cursor-not-allowed'
            : 'hover:bg-background-hover hover:text-text-secondary'
        )}
        title="更多工具"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>

      {/* 下拉菜单 - Portal 渲染 */}
      {isOpen &&
        createPortal(
          <MoreToolsDropdown
            position={position}
            onClose={() => setIsOpen(false)}
          />,
          document.body
        )}
    </>
  )
})

// ============================================================================
// MoreToolsDropdown - 更多工具下拉菜单
// ============================================================================

interface MoreToolsDropdownProps {
  position: { top: number; left: number }
  onClose: () => void
}

const MoreToolsDropdown = memo(function MoreToolsDropdown({
  position,
  onClose,
}: MoreToolsDropdownProps) {
  const { toggleSessionHistory } = useViewStore()
  const { messages } = useActiveSessionMessages()
  const [isExporting, setIsExporting] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false)

  // 同步窗口状态
  useEffect(() => {
    const syncWindowState = async () => {
      try {
        const window = getCurrentWindow()
        const [maximized, onTop] = await Promise.all([
          window.isMaximized(),
          invoke<boolean>('is_always_on_top'),
        ])
        setIsMaximized(maximized)
        setIsAlwaysOnTop(onTop)
      } catch (error) {
        // 非 Tauri 环境会抛出错误，忽略即可
        log.warn('Failed to sync window state:', { error: String(error) })
      }
    }

    syncWindowState()

    // 监听窗口大小变化
    try {
      const window = getCurrentWindow()
      const unlisten = window.onResized(() => {
        syncWindowState()
      })

      return () => {
        unlisten.then((fn) => fn())
      }
    } catch {
      // 非 Tauri 环境，忽略
    }
  }, [])

  // 导出聊天
  const handleExport = async () => {
    if (messages.length === 0 || isExporting) return

    setIsExporting(true)
    try {
      const content = exportToMarkdown(messages)
      const fileName = generateFileName('md')
      const filePath = await tauri.saveChatToFile(content, fileName)

      if (filePath) {
        log.info('导出聊天成功', { path: filePath })
      }
    } catch (error) {
      log.error(
        '导出聊天失败',
        error instanceof Error ? error : new Error(String(error))
      )
    } finally {
      setIsExporting(false)
    }
  }

  // 历史会话
  const handleHistory = () => {
    toggleSessionHistory()
    onClose()
  }

  // 窗口置顶
  const handleToggleAlwaysOnTop = async () => {
    try {
      const newOnTop = !isAlwaysOnTop
      await invoke('set_always_on_top', { alwaysOnTop: newOnTop })
      setIsAlwaysOnTop(newOnTop)
      log.info(`窗口置顶: ${newOnTop}`)
    } catch (error) {
      log.error(
        '切换置顶失败',
        error instanceof Error ? error : new Error(String(error))
      )
    }
  }

  // 最小化
  const handleMinimize = async () => {
    await tauri.minimizeWindow()
  }

  // 最大化/还原
  const handleToggleMaximize = async () => {
    await tauri.toggleMaximizeWindow()
    setIsMaximized((prev) => !prev)
  }

  // 关闭
  const handleClose = async () => {
    await tauri.closeWindow()
  }

  const hasMessages = messages.length > 0

  return (
    <>
      {/* 背景遮罩 */}
      <div className="fixed inset-0 z-40" onClick={onClose} />

      {/* 下拉菜单 */}
      <div
        data-more-tools-dropdown
        style={{
          position: 'fixed',
          top: position.top,
          left: position.left,
          width: 180,
        }}
        className={cn(
          'z-50 bg-background-elevated border border-border rounded-xl',
          'shadow-xl overflow-hidden',
          'animate-in fade-in-0 zoom-in-95 duration-150'
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 功能操作组 */}
        <div className="py-1">
          <MenuItem
            icon={isExporting ? Loader2 : Download}
            label="导出聊天"
            disabled={!hasMessages || isExporting}
            spinning={isExporting}
            onClick={handleExport}
          />
          <MenuItem
            icon={Clock}
            label="历史会话"
            onClick={handleHistory}
          />
        </div>

        {/* 窗口控制组 */}
        <div className="h-px bg-border-subtle" />
        <div className="py-1">
          <MenuItem
            icon={Pin}
            label="窗口置顶"
            active={isAlwaysOnTop}
            onClick={handleToggleAlwaysOnTop}
          />
        </div>

        <div className="h-px bg-border-subtle" />
        <div className="py-1">
          <MenuItem
            icon={Minus}
            label="最小化"
            onClick={handleMinimize}
          />
          <MenuItem
            icon={Square}
            label={isMaximized ? '还原' : '最大化'}
            onClick={handleToggleMaximize}
          />
          <MenuItem
            icon={X}
            label="关闭"
            danger
            onClick={handleClose}
          />
        </div>
      </div>
    </>
  )
})

// ============================================================================
// MenuItem - 菜单项
// ============================================================================

interface MenuItemProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  disabled?: boolean
  active?: boolean
  danger?: boolean
  spinning?: boolean
  onClick: () => void
}

const MenuItem = memo(function MenuItem({
  icon: Icon,
  label,
  disabled = false,
  active = false,
  danger = false,
  spinning = false,
  onClick,
}: MenuItemProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        active && 'text-primary bg-primary/10',
        danger && !disabled && 'text-danger hover:bg-danger/10',
        !active &&
          !danger &&
          !disabled &&
          'text-text-secondary hover:text-text-primary hover:bg-background-hover'
      )}
    >
      <Icon
        className={cn(
          'w-4 h-4',
          active && 'text-primary',
          danger && !disabled && 'text-danger',
          !active && !danger && 'text-text-muted',
          spinning && 'animate-spin'
        )}
      />
      <span className={cn(active && 'text-primary', danger && !disabled && 'text-danger')}>
        {label}
      </span>
    </button>
  )
})
