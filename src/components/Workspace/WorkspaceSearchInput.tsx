/**
 * WorkspaceSearchInput - 工作区搜索输入组件
 *
 * 提供工作区名称/路径搜索功能，支持防抖
 */

import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/utils/cn'
import { Search, X } from 'lucide-react'

interface WorkspaceSearchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  autoFocus?: boolean
}

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value)

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)

    return () => {
      clearTimeout(handler)
    }
  }, [value, delay])

  return debouncedValue
}

export function WorkspaceSearchInput({
  value,
  onChange,
  placeholder,
  className,
  autoFocus = false,
}: WorkspaceSearchInputProps) {
  const { t } = useTranslation('workspace')
  const [localValue, setLocalValue] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  const debouncedValue = useDebounce(localValue, 300)

  // 同步外部值变化
  useEffect(() => {
    setLocalValue(value)
  }, [value])

  // 防抖后通知父组件
  useEffect(() => {
    if (debouncedValue !== value) {
      onChange(debouncedValue)
    }
  }, [debouncedValue, onChange, value])

  // 自动聚焦
  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus()
    }
  }, [autoFocus])

  const handleClear = () => {
    setLocalValue('')
    onChange('')
  }

  return (
    <div className={cn('relative', className)}>
      <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none">
        <Search className="w-3.5 h-3.5 text-text-tertiary" />
      </div>

      <input
        ref={inputRef}
        type="text"
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        placeholder={placeholder || t('search.placeholder')}
        className={cn(
          'w-full pl-8 pr-7 py-1.5 text-sm',
          'bg-background-surface border border-border rounded-lg',
          'text-text-primary placeholder:text-text-tertiary',
          'focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary',
          'transition-colors'
        )}
      />

      {localValue && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute inset-y-0 right-0 pr-2 flex items-center text-text-tertiary hover:text-text-primary transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}

/**
 * 工作区搜索过滤 Hook
 *
 * @param workspaces - 工作区列表
 * @param query - 搜索关键词
 * @returns 过滤后的工作区列表
 */
export function useWorkspaceFilter<T extends { name: string; path: string }>(
  workspaces: T[],
  query: string
): T[] {
  const normalizedQuery = query.trim().toLowerCase()

  if (!normalizedQuery) {
    return workspaces
  }

  return workspaces.filter((workspace) => {
    const nameMatch = workspace.name.toLowerCase().includes(normalizedQuery)
    const pathMatch = workspace.path.toLowerCase().includes(normalizedQuery)
    return nameMatch || pathMatch
  })
}
