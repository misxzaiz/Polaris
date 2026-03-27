/**
 * RequirementPanel - 需求队列主面板
 *
 * 头部统计 + 搜索 + 状态筛选 + 排序 + 需求卡片列表
 * 使用 useRequirementStore 驱动数据
 */

import { useState, useEffect, useMemo } from 'react'
import {
  Plus,
  Search,
  ArrowUpDown,
  ClipboardList,
  Circle,
  CheckCircle,
  XCircle,
  Loader2,
  X as XIcon,
  AlertCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore } from '@/stores'
import { useRequirementStore } from '@/stores/requirementStore'
import { RequirementCard } from './RequirementCard'
import { RequirementDetailDialog } from './RequirementDetailDialog'
import { RequirementForm } from './RequirementForm'
import type { Requirement, RequirementStatus, RequirementPriority } from '@/types/requirement'
import { createLogger } from '@/utils/logger'

const log = createLogger('RequirementPanel')

/** 状态筛选按钮的图标和类型 */
type StatusFilterType = RequirementStatus | 'all'

/** 排序字段 */
type SortField = 'priority' | 'createdAt'
type SortOrder = 'desc' | 'asc'

/** 优先级权重 */
const PRIORITY_WEIGHT: Record<RequirementPriority, number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
}

/** 获取状态筛选按钮的图标 */
function StatusFilterIcon({ status }: { status: StatusFilterType }) {
  switch (status) {
    case 'pending': return <Circle size={12} />
    case 'approved': return <CheckCircle size={12} />
    case 'executing': return <Loader2 size={12} />
    case 'rejected': return <XCircle size={12} />
    case 'failed': return <AlertCircle size={12} />
    case 'completed': return <CheckCircle size={12} />
    default: return <ClipboardList size={12} />
  }
}

export function RequirementPanel() {
  const { t } = useTranslation('requirement')
  const currentWorkspace = useWorkspaceStore(state => state.getCurrentWorkspace())

  const {
    requirements,
    loading,
    error,
    initialized,
    stats,
    filter,
    init,
    setFilter,
    deleteRequirement,
    approveRequirements,
    rejectRequirements,
    createRequirement,
    updateRequirement,
    readPrototype,
  } = useRequirementStore()

  // 本地 UI 状态
  const [statusFilter, setStatusFilter] = useState<StatusFilterType>('all')
  const [sortBy, setSortBy] = useState<SortField>('createdAt')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')

  // Dialog 状态
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [selectedRequirement, setSelectedRequirement] = useState<Requirement | null>(null)

  // 初始化：工作区驱动
  useEffect(() => {
    if (currentWorkspace && !initialized) {
      init(currentWorkspace.path)
    }
  }, [currentWorkspace, initialized, init])

  // 当工作区变化时重新初始化
  useEffect(() => {
    if (currentWorkspace) {
      init(currentWorkspace.path)
    }
  }, [currentWorkspace?.path])

  // 状态筛选变更同步到 store
  useEffect(() => {
    setFilter({ status: statusFilter })
  }, [statusFilter, setFilter])

  // 本地搜索和排序
  const displayRequirements = useMemo(() => {
    let result = [...requirements]

    // 搜索过滤（store 的 filter.search 由外部设置，这里也可以直接用本地 state）
    if (filter.search?.trim()) {
      const keyword = filter.search.toLowerCase()
      result = result.filter(r =>
        r.title.toLowerCase().includes(keyword) ||
        r.description.toLowerCase().includes(keyword) ||
        r.tags.some(tag => tag.toLowerCase().includes(keyword))
      )
    }

    // 排序
    result.sort((a, b) => {
      let cmp = 0
      if (sortBy === 'priority') {
        cmp = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority]
      } else {
        cmp = a.createdAt - b.createdAt
      }
      return sortOrder === 'desc' ? -cmp : cmp
    })

    return result
  }, [requirements, filter.search, sortBy, sortOrder])

  // --- 事件处理 ---

  const handleApprove = async (req: Requirement) => {
    try {
      await approveRequirements([req.id])
    } catch (e) {
      log.error('批准需求失败', e instanceof Error ? e : new Error(String(e)))
      alert(t('toast.updateFailed'))
    }
  }

  const handleReject = async (req: Requirement) => {
    const reason = prompt(t('detail.actions.rejectPlaceholder'))
    if (reason === null) return // 用户取消
    try {
      await rejectRequirements([req.id], reason || undefined)
    } catch (e) {
      log.error('拒绝需求失败', e instanceof Error ? e : new Error(String(e)))
      alert(t('toast.updateFailed'))
    }
  }

  const handleDelete = async (req: Requirement) => {
    try {
      await deleteRequirement(req.id)
    } catch (e) {
      log.error('删除需求失败', e instanceof Error ? e : new Error(String(e)))
      alert(t('toast.deleteFailed'))
    }
  }

  const handleSearchChange = (value: string) => {
    setFilter({ search: value })
  }

  // --- 渲染 ---

  if (!currentWorkspace) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary">
        <p>{t('empty.noRequirements')}</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary">
        <Loader2 size={24} className="animate-spin mr-2" />
        <span className="text-sm">{t('loading')}</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-background-elevated">
      {/* 头部：标题 + 统计 + 新建按钮 */}
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-primary">
            {t('title')}
            {stats && stats.total > 0 && (
              <span className="ml-2 text-xs font-normal text-text-secondary">
                ({stats.total} {t('stats.total', { count: stats.total })})
              </span>
            )}
          </h2>
          <button
            onClick={() => setShowCreateDialog(true)}
            className="p-1.5 rounded-lg bg-primary text-white hover:bg-primary/90 transition-all"
            title={t('newRequirement')}
          >
            <Plus size={16} />
          </button>
        </div>

        {/* 搜索框 */}
        <div className="mb-3">
          <div className="relative">
            {filter.search ? (
              <button
                onClick={() => setFilter({ search: '' })}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
              >
                <XIcon size={16} />
              </button>
            ) : (
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
            )}
            <input
              type="text"
              value={filter.search || ''}
              onChange={e => handleSearchChange(e.target.value)}
              placeholder={t('filter.search')}
              className="w-full pl-9 pr-3 py-2 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 text-text-primary placeholder-text-tertiary"
            />
          </div>
        </div>

        {/* 状态筛选按钮 */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1 flex-wrap">
            {(['all', 'pending', 'approved', 'executing', 'completed'] as StatusFilterType[]).map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-2 py-1 text-xs rounded flex items-center gap-1 whitespace-nowrap transition-all ${
                  statusFilter === s
                    ? 'bg-primary text-white'
                    : 'hover:bg-background-hover text-text-secondary'
                }`}
              >
                <StatusFilterIcon status={s} />
                {s === 'all' ? t('filter.allStatus') : t(`status.${s}`)}
                {s !== 'all' && stats && (
                  <span className="ml-0.5 opacity-70">
                    {s === 'pending' ? stats.pending
                      : s === 'approved' ? stats.approved
                      : s === 'executing' ? stats.executing
                      : s === 'completed' ? stats.completed
                      : 0}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* 排序 */}
          <div className="flex items-center justify-end gap-1">
            <ArrowUpDown size={14} className="text-text-tertiary flex-shrink-0" />
            <select
              value={`${sortBy}-${sortOrder}`}
              onChange={e => {
                const [field, order] = e.target.value.split('-') as [SortField, SortOrder]
                setSortBy(field)
                setSortOrder(order)
              }}
              className="px-2 py-1 text-xs bg-background-surface border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary/50 text-text-secondary cursor-pointer max-w-[200px]"
            >
              <option value="createdAt-desc">{t('sort.createdAtDesc')}</option>
              <option value="createdAt-asc">{t('sort.createdAtAsc')}</option>
              <option value="priority-desc">{t('sort.priorityDesc')}</option>
              <option value="priority-asc">{t('sort.priorityAsc')}</option>
            </select>
          </div>
        </div>
      </div>

      {/* 需求列表 */}
      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2">
        {error && (
          <div className="p-2 text-xs text-red-500 bg-red-500/10 rounded-lg">
            {error}
          </div>
        )}

        {displayRequirements.map(req => (
          <RequirementCard
            key={req.id}
            requirement={req}
            onApproveClick={handleApprove}
            onRejectClick={handleReject}
            onDeleteClick={handleDelete}
            onEditClick={req => setSelectedRequirement(req)}
            onClick={req => setSelectedRequirement(req)}
          />
        ))}

        {/* 空状态 */}
        {displayRequirements.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center py-12 text-text-tertiary">
            <ClipboardList size={48} className="mb-3 opacity-50" />
            <p className="text-sm">
              {t('empty.noRequirements')}
            </p>
          </div>
        )}
      </div>

      {/* 创建需求弹窗 */}
      {showCreateDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <RequirementForm
            mode="create"
            onSubmit={async (data) => {
              try {
                await createRequirement(data)
                setShowCreateDialog(false)
              } catch (e) {
                log.error('创建需求失败', e instanceof Error ? e : new Error(String(e)))
                alert(t('toast.createFailed'))
              }
            }}
            onCancel={() => setShowCreateDialog(false)}
          />
        </div>
      )}

      {/* 需求详情弹窗 */}
      {selectedRequirement && (
        <RequirementDetailDialog
          requirement={selectedRequirement}
          open={!!selectedRequirement}
          onClose={() => setSelectedRequirement(null)}
          onEditSubmit={async (data) => {
            try {
              await updateRequirement(selectedRequirement.id, data)
            } catch (e) {
              log.error('更新需求失败', e instanceof Error ? e : new Error(String(e)))
              alert(t('toast.updateFailed'))
            }
          }}
          onDelete={async () => {
            try {
              await deleteRequirement(selectedRequirement.id)
              setSelectedRequirement(null)
            } catch (e) {
              log.error('删除需求失败', e instanceof Error ? e : new Error(String(e)))
              alert(t('toast.deleteFailed'))
            }
          }}
          onApprove={handleApprove}
          onReject={handleReject}
          onReadPrototype={readPrototype}
        />
      )}
    </div>
  )
}
