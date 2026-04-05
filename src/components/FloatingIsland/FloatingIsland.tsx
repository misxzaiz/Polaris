/**
 * FloatingIsland - 悬浮岛主组件
 *
 * 位于聊天区域顶部居中，包含：
 * - 导航按钮（预留）
 * - 会话选择器
 * - 工作区选择器
 * - 更多工具按钮（预留）
 */

import { memo, useState, useCallback, useRef, useEffect } from 'react'
import { cn } from '@/utils/cn'
import { SessionSelector } from './SessionSelector'
import { WorkspaceSelector } from './WorkspaceSelector'
import { NavigationButton } from './NavigationButton'
import { MoreToolsButton } from './MoreToolsButton'

export const FloatingIsland = memo(function FloatingIsland() {
  // 下拉状态管理
  const [sessionDropdownOpen, setSessionDropdownOpen] = useState(false)
  const [workspaceDropdownOpen, setWorkspaceDropdownOpen] = useState(false)

  // 点击外部关闭
  const islandRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node

      // 检查是否点击了下拉面板（Portal 渲染到 body）
      const clickedDropdown =
        (target as Element)?.closest?.('[data-floating-dropdown]') !== null

      if (
        islandRef.current &&
        !islandRef.current.contains(target) &&
        !clickedDropdown
      ) {
        setSessionDropdownOpen(false)
        setWorkspaceDropdownOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // 会话下拉切换
  const handleSessionToggle = useCallback(() => {
    setSessionDropdownOpen(prev => !prev)
    setWorkspaceDropdownOpen(false) // 关闭另一个下拉
  }, [])

  // 工作区下拉切换
  const handleWorkspaceToggle = useCallback(() => {
    setWorkspaceDropdownOpen(prev => !prev)
    setSessionDropdownOpen(false) // 关闭另一个下拉
  }, [])

  // 关闭所有下拉
  const handleCloseAll = useCallback(() => {
    setSessionDropdownOpen(false)
    setWorkspaceDropdownOpen(false)
  }, [])

  return (
    <div
      ref={islandRef}
      className="absolute top-3 left-1/2 -translate-x-1/2 z-50"
    >
      {/* 主容器 */}
      <div
        className={cn(
          'flex items-center h-9 px-1.5 gap-1',
          'bg-background-elevated/90 backdrop-blur-xl',
          'rounded-full border border-border/50',
          'shadow-lg shadow-black/5'
        )}
      >
        {/* 左导航按钮（预留） */}
        <NavigationButton direction="prev" disabled />

        {/* 分隔线 */}
        <div className="w-px h-5 bg-border" />

        {/* 会话选择器 */}
        <SessionSelector
          isOpen={sessionDropdownOpen}
          onToggle={handleSessionToggle}
          onClose={handleCloseAll}
        />

        {/* 分隔线 */}
        <div className="w-px h-5 bg-border" />

        {/* 工作区选择器 */}
        <WorkspaceSelector
          isOpen={workspaceDropdownOpen}
          onToggle={handleWorkspaceToggle}
          onClose={handleCloseAll}
        />

        {/* 分隔线 */}
        <div className="w-px h-5 bg-border" />

        {/* 更多工具按钮 */}
        <MoreToolsButton />

        {/* 右导航按钮（预留） */}
        <NavigationButton direction="next" disabled />
      </div>
    </div>
  )
})