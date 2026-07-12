/**
 * links 列表筛选/排序/搜索/分页状态管理
 *
 * 移植自 personal-hub useLinkFilter.ts，修正源码 bug：
 * - 切换非 todo 类型时清空 todo 专属筛选（priority/status/dueDate）
 * - 提供序列化 key 供 useEffect 监听自动 refetch（修源码"改状态不重取"缺陷）
 * - 搜索标签语义用 cd（contains）而非源码错误的 cs
 */
import { useCallback, useMemo, useState } from 'react'
import type {
  DueDateFilter,
  LinkType,
  Priority,
  SortField,
  SortOrder,
  StatusFilter,
} from '@/services/personalHub/types'

export type FilterType = LinkType | 'all'

export interface LinkFilterState {
  filterType: FilterType
  selectedTags: string[]
  selectedPriorities: Priority[]
  selectedStatus: StatusFilter
  selectedDueDate: DueDateFilter
  sortBy: SortField
  sortOrder: SortOrder
  searchQuery: string
  currentPage: number
  pageSize: number
}

export interface LinkFilterActions {
  setFilterType: (t: FilterType) => void
  toggleTag: (tag: string) => void
  togglePriority: (p: Priority) => void
  setStatus: (s: StatusFilter) => void
  setDueDate: (d: DueDateFilter) => void
  setSort: (field: SortField) => void
  setSearchQuery: (q: string) => void
  setCurrentPage: (p: number) => void
  setPageSize: (s: number) => void
  resetAll: () => void
}

export const PRIORITY_OPTIONS: { value: Priority; label: string; color: string }[] = [
  { value: 'high', label: '高', color: '#ef4444' },
  { value: 'medium', label: '中', color: '#f59e0b' },
  { value: 'low', label: '低', color: '#10b981' },
]

export const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待完成' },
  { value: 'completed', label: '已完成' },
]

export const DUE_DATE_OPTIONS: { value: DueDateFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'today', label: '今天' },
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
  { value: 'overdue', label: '已过期' },
]

export const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'created_at', label: '创建时间' },
  { value: 'updated_at', label: '更新时间' },
  { value: 'title', label: '标题' },
  { value: 'priority', label: '优先级' },
  { value: 'due_date', label: '截止日期' },
]

export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

const DEFAULT_STATE: LinkFilterState = {
  filterType: 'all',
  selectedTags: [],
  selectedPriorities: [],
  selectedStatus: 'all',
  selectedDueDate: 'all',
  sortBy: 'created_at',
  sortOrder: 'desc',
  searchQuery: '',
  currentPage: 1,
  pageSize: 10,
}

export function useLinkFilter() {
  const [state, setState] = useState<LinkFilterState>(DEFAULT_STATE)

  const patch = useCallback((p: Partial<LinkFilterState>) => {
    setState((prev) => ({ ...prev, ...p }))
  }, [])

  const resetPage = useCallback(() => {
    setState((prev) => ({ ...prev, currentPage: 1 }))
  }, [])

  const setFilterType = useCallback((t: FilterType) => {
    // 切换到非 todo 类型时清空 todo 专属筛选
    if (t !== 'todo') {
      setState((prev) => ({
        ...prev,
        filterType: t,
        selectedPriorities: [],
        selectedStatus: 'all',
        selectedDueDate: 'all',
        currentPage: 1,
      }))
    } else {
      setState((prev) => ({ ...prev, filterType: t, currentPage: 1 }))
    }
  }, [])

  const toggleTag = useCallback((tag: string) => {
    setState((prev) => {
      const exists = prev.selectedTags.includes(tag)
      return {
        ...prev,
        selectedTags: exists
          ? prev.selectedTags.filter((t) => t !== tag)
          : [...prev.selectedTags, tag],
        currentPage: 1,
      }
    })
  }, [])

  const togglePriority = useCallback((p: Priority) => {
    setState((prev) => {
      const exists = prev.selectedPriorities.includes(p)
      return {
        ...prev,
        selectedPriorities: exists
          ? prev.selectedPriorities.filter((x) => x !== p)
          : [...prev.selectedPriorities, p],
        currentPage: 1,
      }
    })
  }, [])

  const setStatus = useCallback((s: StatusFilter) => {
    patch({ selectedStatus: s })
    resetPage()
  }, [patch, resetPage])

  const setDueDate = useCallback((d: DueDateFilter) => {
    patch({ selectedDueDate: d })
    resetPage()
  }, [patch, resetPage])

  const setSort = useCallback((field: SortField) => {
    setState((prev) => ({
      ...prev,
      sortBy: field,
      // 点击相同字段切换升降序，新字段默认降序
      sortOrder: prev.sortBy === field ? (prev.sortOrder === 'asc' ? 'desc' : 'asc') : 'desc',
      currentPage: 1,
    }))
  }, [])

  const setSearchQuery = useCallback((q: string) => {
    patch({ searchQuery: q })
    resetPage()
  }, [patch, resetPage])

  const setCurrentPage = useCallback((p: number) => patch({ currentPage: p }), [patch])

  const setPageSize = useCallback((s: number) => {
    patch({ pageSize: s })
    resetPage()
  }, [patch, resetPage])

  const resetAll = useCallback(() => setState(DEFAULT_STATE), [])

  const hasActiveFilters = useMemo(() => {
    return (
      state.selectedTags.length > 0 ||
      state.selectedPriorities.length > 0 ||
      state.selectedStatus !== 'all' ||
      state.selectedDueDate !== 'all' ||
      state.searchQuery.trim().length > 0
    )
  }, [state])

  const activeFiltersCount = useMemo(() => {
    let n = 0
    if (state.selectedTags.length > 0) n++
    if (state.selectedPriorities.length > 0) n++
    if (state.selectedStatus !== 'all') n++
    if (state.selectedDueDate !== 'all') n++
    if (state.searchQuery.trim().length > 0) n++
    return n
  }, [state])

  // 序列化 key：用于 useEffect 依赖，任一筛选/排序/分页变化即变化（searchQuery 单独防抖后传入）
  const filterKey = useMemo(() => JSON.stringify({
    t: state.filterType,
    tags: state.selectedTags,
    pri: state.selectedPriorities,
    st: state.selectedStatus,
    dd: state.selectedDueDate,
    sb: state.sortBy,
    so: state.sortOrder,
    pg: state.currentPage,
    ps: state.pageSize,
  }), [state])

  return {
    state,
    actions: {
      setFilterType,
      toggleTag,
      togglePriority,
      setStatus,
      setDueDate,
      setSort,
      setSearchQuery,
      setCurrentPage,
      setPageSize,
      resetAll,
    },
    hasActiveFilters,
    activeFiltersCount,
    filterKey,
  }
}
