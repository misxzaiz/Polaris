/**
 * Personal Hub links 主视图
 * 移植自 personal-hub LinksView.vue，集成：搜索 / 类型 tab / 标签 / 优先级 / 状态 /
 * 截止日期筛选 / 排序 / 分页 / 标签聚合 / todo 完成切换 / 加密描述。
 * 修正源码 bug：useEffect 监听 filterKey + 防抖 search 自动 refetch；
 * 搜索标签用 cd（contains）而非 cs；overdue 排除已完成。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Plus, RefreshCw, LogOut, Search, SlidersHorizontal, ChevronLeft, ChevronRight, X,
} from 'lucide-react'
import { getSupabase } from '@/services/personalHub/supabase'
import { getPersonalHubConfig } from '@/services/personalHub/supabase'
import type { Link } from '@/services/personalHub/types'
import { usePersonalHubAuthStore } from '@/stores/personalHubAuthStore'
import { useDebounce } from '@/hooks/useDebounce'
import { createLogger } from '@/utils/logger'
import {
  useLinkFilter,
  PRIORITY_OPTIONS, STATUS_OPTIONS, DUE_DATE_OPTIONS, SORT_OPTIONS, PAGE_SIZE_OPTIONS,
} from '@/hooks/personalHub/useLinkFilter'
import {
  TYPE_FILTER_TABS,
} from './constants'
import { LinkCard } from './LinkCard'
import { LinkDetailDialog } from './LinkDetailDialog'
import { LinkFormDialog, emptyDraft, draftFromLink, buildLinkData, type LinkDraft } from './LinkFormDialog'

const log = createLogger('PersonalHubLinks')

/** 构造 due_date 筛选的 [gte, lt] 区间（基于本地 0 点） */
function dueDateRange(filter: string): { gte?: string; lt?: string } | null {
  if (filter === 'all') return null
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const day = 86400000
  switch (filter) {
    case 'today':
      return { gte: today.toISOString(), lt: new Date(today.getTime() + day).toISOString() }
    case 'week':
      return { gte: today.toISOString(), lt: new Date(today.getTime() + 7 * day).toISOString() }
    case 'month':
      return { gte: today.toISOString(), lt: new Date(today.getTime() + 30 * day).toISOString() }
    case 'overdue':
      return { lt: today.toISOString() }
    default:
      return null
  }
}

export function LinksView() {
  const user = usePersonalHubAuthStore((s) => s.user)
  const signOut = usePersonalHubAuthStore((s) => s.signOut)

  const { state, actions, hasActiveFilters, activeFiltersCount, filterKey } = useLinkFilter()
  const debouncedSearch = useDebounce(state.searchQuery, 500)

  const [links, setLinks] = useState<Link[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [availableTags, setAvailableTags] = useState<string[]>([])
  const [draft, setDraft] = useState<LinkDraft | null>(null)
  const [detailLink, setDetailLink] = useState<Link | null>(null)
  const [saving, setSaving] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const totalPages = Math.max(1, Math.ceil(totalCount / state.pageSize))

  /** 拉取标签聚合（全部 links 的 tags 并集，按计数降序） */
  const fetchTags = useCallback(async () => {
    if (!user) return
    try {
      const { data, error: e } = await getSupabase()
        .from('links')
        .select('tags')
        .eq('user_id', user.id)
        .not('tags', 'is', null)
      if (e) throw e
      const counts: Record<string, number> = {}
      ;(data || []).forEach((item: { tags?: string[] | null }) => {
        ;(item.tags || []).forEach((tag) => {
          counts[tag] = (counts[tag] || 0) + 1
        })
      })
      const sorted = Object.entries(counts)
        .sort(([, a], [, b]) => b - a)
        .map(([tag]) => tag)
      setAvailableTags(sorted)
    } catch (e) {
      log.warn('fetchTags failed', { error: e instanceof Error ? e.message : String(e) })
    }
  }, [user])

  /** 拉取列表（含搜索/筛选/排序/分页） */
  const fetchLinks = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setError(null)
    try {
      let query = getSupabase()
        .from('links')
        .select('*', { count: 'exact' })
        .eq('user_id', user.id)

      if (state.filterType !== 'all') {
        query = query.eq('type', state.filterType)
      }

      // 标签多选：cd（contains，行 tags 包含所有选中标签）
      if (state.selectedTags.length > 0) {
        query = query.contains('tags', state.selectedTags)
      }

      // todo 专属筛选
      if (state.filterType === 'todo' || state.filterType === 'all') {
        if (state.selectedPriorities.length > 0) {
          query = query.in('priority', state.selectedPriorities)
        }
        if (state.selectedStatus === 'pending') {
          query = query.eq('completed', false)
        } else if (state.selectedStatus === 'completed') {
          query = query.eq('completed', true)
        }
        const range = dueDateRange(state.selectedDueDate)
        if (range) {
          if (range.gte) query = query.gte('due_date', range.gte)
          if (range.lt) query = query.lt('due_date', range.lt)
        }
      }

      // 搜索：title/description ilike + tags cd（修正源码错误的 cs）
      const term = debouncedSearch.trim()
      if (term) {
        query = query.or(
          `title.ilike.%${term}%,description.ilike.%${term}%,tags.cd.{${term}}`,
        )
      }

      query = query.order(state.sortBy, { ascending: state.sortOrder === 'asc' })

      const from = (state.currentPage - 1) * state.pageSize
      const to = from + state.pageSize - 1
      query = query.range(from, to)

      const { data, count, error: e } = await query
      if (e) throw e
      setLinks((data || []) as Link[])
      setTotalCount(count || 0)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error('fetchLinks failed', e instanceof Error ? e : new Error(msg))
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [user, state, debouncedSearch])

  // filterKey 变化（筛选/排序/分页）触发 refetch
  useEffect(() => {
    fetchLinks()
  }, [fetchLinks, filterKey])

  // 防抖搜索单独触发（因 debouncedSearch 不在 filterKey 内）
  useEffect(() => {
    fetchLinks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch])

  // 首次加载 + 用户变化时拉标签
  useEffect(() => {
    fetchTags()
  }, [fetchTags])

  const refresh = useCallback(async () => {
    await Promise.all([fetchTags(), fetchLinks()])
  }, [fetchTags, fetchLinks])

  const handleSave = async () => {
    if (!user || !draft) return
    if (!draft.title.trim()) {
      setError('标题不能为空')
      return
    }
    setError(null)
    setSaving(true)
    try {
      const linkData = buildLinkData(draft)
      if (draft.id) {
        const { error: e } = await getSupabase().from('links').update(linkData).eq('id', draft.id)
        if (e) throw e
      } else {
        const { error: e } = await getSupabase()
          .from('links')
          .insert({ ...linkData, user_id: user.id })
        if (e) throw e
      }
      setDraft(null)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除这条记录吗？')) return
    try {
      const { error: e } = await getSupabase().from('links').delete().eq('id', id)
      if (e) throw e
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleToggleComplete = async (link: Link) => {
    try {
      const { error: e } = await getSupabase()
        .from('links')
        .update({ completed: !link.completed })
        .eq('id', link.id)
      if (e) throw e
      // 本地更新，不 refetch
      setLinks((prev) => prev.map((l) => (l.id === link.id ? { ...l, completed: !l.completed } : l)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const startEdit = (link: Link) => {
    setDetailLink(null)
    setDraft(draftFromLink(link, getPersonalHubConfig().encryptionKey.trim().length > 0))
  }

  const sortLabel = useMemo(() => {
    const opt = SORT_OPTIONS.find((o) => o.value === state.sortBy)
    return `${opt?.label ?? ''} ${state.sortOrder === 'asc' ? '↑' : '↓'}`
  }, [state.sortBy, state.sortOrder])

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-2 shrink-0">
        <span className="text-sm font-medium text-text-primary truncate">{user?.email ?? '个人空间'}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={refresh}
            disabled={loading}
            title="刷新"
            className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-background-hover disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => signOut()}
            title="登出"
            className="p-1.5 rounded-md text-text-secondary hover:text-danger hover:bg-background-hover"
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>

      {/* 搜索栏 */}
      <div className="px-3 py-2 border-b border-border-subtle shrink-0">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={state.searchQuery}
            onChange={(e) => actions.setSearchQuery(e.target.value)}
            placeholder="搜索标题、描述、标签..."
            className="w-full pl-8 pr-7 py-1.5 bg-surface border border-border rounded-md text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {state.searchQuery && (
            <button
              onClick={() => actions.setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* 类型 tab + 新增 */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-1 overflow-x-auto">
          {TYPE_FILTER_TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => actions.setFilterType(t.value)}
              className={`px-2.5 py-1 text-xs rounded-md whitespace-nowrap transition-colors ${
                state.filterType === t.value
                  ? 'bg-primary text-white'
                  : 'text-text-secondary hover:bg-background-hover'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className={`relative inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border ${
            hasActiveFilters
              ? 'border-primary/40 text-primary bg-primary/5'
              : 'border-border text-text-secondary hover:bg-background-hover'
          }`}
        >
          <SlidersHorizontal size={12} />
          筛选
          {activeFiltersCount > 0 && (
            <span className="ml-0.5 px-1 rounded-full bg-primary text-white text-[9px] leading-none py-0.5">
              {activeFiltersCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setDraft(emptyDraft(state.filterType === 'all' ? 'navigation' : state.filterType))}
          className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-primary text-white rounded-md hover:bg-primary/90"
        >
          <Plus size={12} /> 新增
        </button>
      </div>

      {/* 高级筛选面板 */}
      {showAdvanced && (
        <div className="px-3 py-2 border-b border-border-subtle bg-surface/50 shrink-0 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-text-tertiary">高级筛选</span>
            <button onClick={actions.resetAll} className="text-[10px] text-primary hover:underline">
              重置
            </button>
          </div>

          {/* 标签 */}
          {availableTags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {availableTags.slice(0, 12).map((tag) => {
                const active = state.selectedTags.includes(tag)
                return (
                  <button
                    key={tag}
                    onClick={() => actions.toggleTag(tag)}
                    className={`px-1.5 py-0.5 rounded text-[10px] border ${
                      active
                        ? 'bg-primary text-white border-primary'
                        : 'border-border text-text-secondary hover:bg-background-hover'
                    }`}
                  >
                    {tag}
                  </button>
                )
              })}
            </div>
          )}

          {/* todo 专属筛选（仅当当前 tab 含 todo） */}
          {(state.filterType === 'todo' || state.filterType === 'all') && (
            <div className="grid grid-cols-3 gap-2">
              {/* 优先级 */}
              <div>
                <div className="text-[10px] text-text-tertiary mb-1">优先级</div>
                <div className="flex flex-wrap gap-1">
                  {PRIORITY_OPTIONS.map((p) => {
                    const active = state.selectedPriorities.includes(p.value)
                    return (
                      <button
                        key={p.value}
                        onClick={() => actions.togglePriority(p.value)}
                        className={`px-1.5 py-0.5 rounded text-[10px] border ${
                          active ? 'text-white border-transparent' : 'border-border text-text-secondary hover:bg-background-hover'
                        }`}
                        style={active ? { backgroundColor: p.color } : undefined}
                      >
                        {p.label}
                      </button>
                    )
                  })}
                </div>
              </div>
              {/* 状态 */}
              <div>
                <div className="text-[10px] text-text-tertiary mb-1">状态</div>
                <div className="flex flex-wrap gap-1">
                  {STATUS_OPTIONS.map((s) => (
                    <button
                      key={s.value}
                      onClick={() => actions.setStatus(s.value)}
                      className={`px-1.5 py-0.5 rounded text-[10px] border ${
                        state.selectedStatus === s.value
                          ? 'bg-primary text-white border-primary'
                          : 'border-border text-text-secondary hover:bg-background-hover'
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
              {/* 截止日期 */}
              <div>
                <div className="text-[10px] text-text-tertiary mb-1">截止</div>
                <div className="flex flex-wrap gap-1">
                  {DUE_DATE_OPTIONS.map((d) => (
                    <button
                      key={d.value}
                      onClick={() => actions.setDueDate(d.value)}
                      className={`px-1.5 py-0.5 rounded text-[10px] border ${
                        state.selectedDueDate === d.value
                          ? 'bg-primary text-white border-primary'
                          : 'border-border text-text-secondary hover:bg-background-hover'
                      }`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 排序 + 结果数 */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-subtle shrink-0">
        <span className="text-[10px] text-text-tertiary">共 {totalCount} 条</span>
        <div className="flex items-center gap-1">
          {SORT_OPTIONS.map((s) => {
            const active = state.sortBy === s.value
            return (
              <button
                key={s.value}
                onClick={() => actions.setSort(s.value)}
                className={`px-1.5 py-0.5 rounded text-[10px] ${
                  active ? 'text-primary font-medium' : 'text-text-muted hover:text-text-secondary'
                }`}
                title={active ? sortLabel : s.label}
              >
                {s.label}{active && (state.sortOrder === 'asc' ? ' ↑' : ' ↓')}
              </button>
            )
          })}
        </div>
      </div>

      {error && (
        <div className="mx-3 mt-2 rounded-md bg-danger/10 border border-danger/20 px-3 py-2 text-xs text-danger shrink-0">
          {error}
        </div>
      )}

      {/* 列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
        {links.length === 0 && !loading ? (
          <div className="text-center text-xs text-text-tertiary py-10">暂无记录，点击「新增」添加</div>
        ) : (
          links.map((link) => (
            <LinkCard
              key={link.id}
              link={link}
              onOpen={setDetailLink}
              onEdit={(l) => { setDetailLink(null); setDraft(draftFromLink(l, getPersonalHubConfig().encryptionKey.trim().length > 0)) }}
              onDelete={handleDelete}
              onToggleComplete={handleToggleComplete}
            />
          ))
        )}
      </div>

      {/* 分页 */}
      {totalCount > 0 && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-border-subtle shrink-0">
          <select
            value={state.pageSize}
            onChange={(e) => actions.setPageSize(Number(e.target.value))}
            className="text-[10px] bg-surface border border-border rounded px-1.5 py-0.5 text-text-secondary focus:outline-none"
          >
            {PAGE_SIZE_OPTIONS.map((s) => (
              <option key={s} value={s}>{s} 条/页</option>
            ))}
          </select>
          <div className="flex items-center gap-2 text-[10px] text-text-tertiary">
            <span>{state.currentPage} / {totalPages}</span>
            <button
              onClick={() => actions.setCurrentPage(Math.max(1, state.currentPage - 1))}
              disabled={state.currentPage <= 1}
              className="p-1 rounded hover:bg-background-hover disabled:opacity-30"
            >
              <ChevronLeft size={12} />
            </button>
            <button
              onClick={() => actions.setCurrentPage(Math.min(totalPages, state.currentPage + 1))}
              disabled={state.currentPage >= totalPages}
              className="p-1 rounded hover:bg-background-hover disabled:opacity-30"
            >
              <ChevronRight size={12} />
            </button>
          </div>
        </div>
      )}

      {/* 详情对话框 */}
      {detailLink && (
        <LinkDetailDialog
          link={detailLink}
          onClose={() => setDetailLink(null)}
          onEdit={startEdit}
        />
      )}

      {/* 编辑/新增 抽屉 */}
      {draft && (
        <LinkFormDialog
          draft={draft}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSave={handleSave}
          saving={saving}
        />
      )}
    </div>
  )
}
