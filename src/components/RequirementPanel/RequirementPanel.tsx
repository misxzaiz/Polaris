/**
 * RequirementPanel - 需求队列主面板
 *
 * 头部统计 + 搜索 + 状态筛选 + 排序 + 需求卡片列表
 * 使用 useRequirementStore 驱动数据
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
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
  RefreshCw,
  Sparkles,
  Wand2,
  FolderOpen,
  Globe,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore, useConfigStore } from '@/stores'
import { useRequirementStore } from '@/stores/requirementStore'
import type { QueryScopeType } from '@/services/requirementService'
import { useSchedulerStore } from '@/stores/schedulerStore'
import { useToastStore } from '@/stores/toastStore'
import { ConfirmDialog } from '@/components/Common/ConfirmDialog'
import { RequirementCard } from './RequirementCard'
import { RequirementDetailDialog } from './RequirementDetailDialog'
import { RequirementForm } from './RequirementForm'
import { RequirementGenerateDialog } from './RequirementGenerateDialog'
import type { Requirement, RequirementStatus, RequirementCreateParams } from '@/types/requirement'
import { AiExtractDialog } from '@/components/Common/AiExtractDialog'
import { extractRequirement } from '@/services/structuredExtractionService'
import { PRIORITY_WEIGHT } from './constants'
import { createLogger } from '@/utils/logger'

const log = createLogger('RequirementPanel')

/** 状态筛选按钮的图标和类型 */
type StatusFilterType = RequirementStatus | 'all'

/** 排序字段 */
type SortField = 'priority' | 'createdAt'
type SortOrder = 'desc' | 'asc'

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
  const toast = useToastStore()

  const {
    requirements,
    loading,
    error,
    stats,
    filter,
    scope,
    init,
    reload,
    setFilter,
    setScope,
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
  const [showGenerateDialog, setShowGenerateDialog] = useState(false)
  const [showExtractDialog, setShowExtractDialog] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedRequirement = selectedId ? requirements.find(r => r.id === selectedId) ?? null : null

  // 操作进行中追踪（防止重复点击）
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set())

  // 确认对话框
  const [confirmDialog, setConfirmDialog] = useState<{
    title?: string
    message: string
    onConfirm: () => void
    type?: 'danger' | 'warning' | 'info'
  } | null>(null)

  const setProcessing = useCallback((id: string, processing: boolean) => {
    setProcessingIds(prev => {
      const next = new Set(prev)
      if (processing) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  // 初始化：工作区驱动，工作区变化时重新加载
  useEffect(() => {
    if (currentWorkspace?.path) {
      init(currentWorkspace.path)
    }
  }, [currentWorkspace?.path, init])

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

    // 状态筛选
    if (statusFilter !== 'all') {
      result = result.filter(r => r.status === statusFilter)
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
  }, [requirements, filter.search, statusFilter, sortBy, sortOrder])

  // --- 事件处理 ---

  const handleApprove = async (req: Requirement) => {
    setProcessing(req.id, true)
    try {
      await approveRequirements([req.id])
      toast.success(t('toast.approveSuccess'))
    } catch (e) {
      log.error('批准需求失败', e instanceof Error ? e : new Error(String(e)))
      toast.error(t('toast.updateFailed'))
    } finally {
      setProcessing(req.id, false)
    }
  }

  const handleReject = async (req: Requirement, reason?: string) => {
    setProcessing(req.id, true)
    try {
      await rejectRequirements([req.id], reason || undefined)
      toast.success(t('toast.rejectSuccess'))
    } catch (e) {
      log.error('拒绝需求失败', e instanceof Error ? e : new Error(String(e)))
      toast.error(t('toast.updateFailed'))
    } finally {
      setProcessing(req.id, false)
    }
  }

  const handleDelete = async (req: Requirement) => {
    setProcessing(req.id, true)
    try {
      await deleteRequirement(req.id)
      toast.success(t('toast.deleteSuccess'))
    } catch (e) {
      log.error('删除需求失败', e instanceof Error ? e : new Error(String(e)))
      toast.error(t('toast.deleteFailed'))
    } finally {
      setProcessing(req.id, false)
    }
  }

  const handleSearchChange = (value: string) => {
    setFilter({ search: value })
  }

  /** 触发 AI 生成需求 */
  const handleGenerate = async (scope: string, context: string) => {
    const workspacePath = currentWorkspace?.path
    if (!workspacePath) return

    setGenerating(true)
    try {
      const config = useConfigStore.getState().config
      const engineId = config?.defaultEngine || 'claude-code'

      const scopeLabel = t(`generate.scope${scope.charAt(0).toUpperCase() + scope.slice(1)}` as 'generate.scopeAll' | 'generate.scopeFrontend' | 'generate.scopeBackend')
      const taskName = `[需求生成] ${scopeLabel}`

      await useSchedulerStore.getState().createTask({
        name: taskName,
        triggerType: 'once',
        triggerValue: '',
        engineId,
        prompt: `分析项目并生成需求。范围: ${scope}。项目上下文: ${context}`,
        workDir: workspacePath,
      })

      toast.success(t('toast.generateTaskCreated'))
      toast.success(t('toast.generateTriggered'))
    } catch (e) {
      log.error('触发生成需求失败:', e instanceof Error ? e : new Error(String(e)))
      toast.error(t('toast.generateTriggerFailed'))
    } finally {
      setGenerating(false)
    }
  }

  /** 触发 AI 执行需求分析 */
  const handleExecute = async (req: Requirement) => {
    setProcessing(req.id, true)
    try {
      const workspacePath = currentWorkspace?.path
      if (!workspacePath) return

      const config = useConfigStore.getState().config
      const engineId = config?.defaultEngine || 'claude-code'

      const taskName = `[需求执行] ${req.title}`

      await useSchedulerStore.getState().createTask({
        name: taskName,
        triggerType: 'once',
        triggerValue: '',
        engineId,
        prompt: `执行需求分析: ${req.title}`,
        workDir: workspacePath,
      })

      toast.success(t('toast.executeTaskCreated'))
      toast.success(t('toast.executeTriggered'))
    } catch (e) {
      log.error('触发执行需求失败:', e instanceof Error ? e : new Error(String(e)))
      toast.error(t('toast.executeTriggerFailed'))
    } finally {
      setProcessing(req.id, false)
    }
  }

  /** 触发 AI 生成原型 */
  const handleGeneratePrototype = async (req: Requirement) => {
    setProcessing(req.id, true)
    try {
      const workspacePath = currentWorkspace?.path
      if (!workspacePath) return

      const config = useConfigStore.getState().config
      const engineId = config?.defaultEngine || 'claude-code'

      const taskName = `[原型生成] ${req.title}`

      await useSchedulerStore.getState().createTask({
        name: taskName,
        triggerType: 'once',
        triggerValue: '',
        engineId,
        prompt: `为需求《${req.title}》生成一个自包含的 HTML 原型页面（单文件、内联 CSS、可含少量原生 JS、暗色主题）。需求描述：${req.description}。要求：直接输出可在 iframe(sandbox=allow-scripts)中预览的完整 HTML，不引用任何外部资源（CDN/字体/图片全部内联）；完成后调用 MCP 工具 save_requirement_prototype 保存，id="${req.id}"，html 为完整 HTML 字符串。`,
        workDir: workspacePath,
      })

      toast.success(t('toast.prototypeTriggered'))
    } catch (e) {
      log.error('触发生成原型失败:', e instanceof Error ? e : new Error(String(e)))
      toast.error(t('toast.prototypeTriggerFailed'))
    } finally {
      setProcessing(req.id, false)
    }
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
                ({t('stats.total', { count: stats.total })})
              </span>
            )}
          </h2>
          <div className="flex items-center gap-1">
            <button
              onClick={() => reload()}
              disabled={loading}
              className="p-1.5 rounded-lg hover:bg-background-hover text-text-secondary hover:text-text-primary transition-all disabled:opacity-50"
              title={t('refresh')}
              aria-label={t('refresh')}
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={() => setShowGenerateDialog(true)}
              disabled={generating}
              className="p-1.5 rounded-lg hover:bg-accent-ai/10 text-text-secondary hover:text-accent-ai transition-all disabled:opacity-50"
              title={t('generate.title')}
              aria-label={t('generate.title')}
            >
              <Sparkles size={16} className={generating ? 'animate-pulse' : ''} />
            </button>
            <button
              onClick={() => setShowExtractDialog(true)}
              className="p-1.5 rounded-lg hover:bg-background-hover text-text-secondary hover:text-text-primary transition-all"
              title={t('aiExtract.button')}
              aria-label={t('aiExtract.button')}
            >
              <Wand2 size={16} />
            </button>
            <button
              onClick={() => setShowCreateDialog(true)}
              className="p-1.5 rounded-lg bg-primary text-on-primary hover:bg-primary/90 transition-all"
              title={t('newRequirement')}
              aria-label={t('newRequirement')}
            >
              <Plus size={16} />
            </button>
          </div>
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
              aria-label={t('filter.search')}
              className="w-full pl-9 pr-3 py-2 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 text-text-primary placeholder-text-tertiary"
            />
          </div>
        </div>

        {/* 状态筛选按钮 */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1 flex-wrap">
            {(['all', 'pending', 'approved', 'executing', 'completed', 'draft', 'rejected', 'failed'] as StatusFilterType[]).map(s => {
              const count = s === 'all' ? null
                : stats ? stats[s as keyof typeof stats] as number ?? 0 : null
              return count !== null && count === 0 && s !== 'all' ? null : (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  aria-pressed={statusFilter === s}
                  className={`px-2 py-1 text-xs rounded flex items-center gap-1 whitespace-nowrap transition-all ${
                    statusFilter === s
                      ? 'bg-primary text-on-primary'
                      : 'hover:bg-background-hover text-text-secondary'
                  }`}
                >
                  <StatusFilterIcon status={s} />
                  {s === 'all' ? t('filter.allStatus') : t(`status.${s}`)}
                  {s !== 'all' && count !== null && (
                    <span className="ml-0.5 opacity-70">{count}</span>
                  )}
                </button>
              )
            })}
          </div>

          {/* 排序 + 范围筛选 */}
          <div className="flex items-center justify-between gap-1">
            {/* 范围筛选 */}
            <div className="flex items-center gap-1">
              {scope === 'all' ? (
                <Globe size={14} className="text-text-tertiary" />
              ) : (
                <FolderOpen size={14} className="text-text-tertiary" />
              )}
              <select
                value={scope}
                onChange={e => setScope(e.target.value as QueryScopeType)}
                aria-label={t('filter.scopeLabel')}
                className="px-2 py-1 text-xs bg-background-surface border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary/50 text-text-secondary cursor-pointer"
              >
                <option value="all">{t('filter.scopeAll')}</option>
                <option value="workspace">{t('filter.scopeWorkspace')}</option>
              </select>
            </div>

            {/* 排序 */}
            <div className="flex items-center gap-1">
              <ArrowUpDown size={14} className="text-text-tertiary flex-shrink-0" />
              <select
                value={`${sortBy}-${sortOrder}`}
                onChange={e => {
                  const [field, order] = e.target.value.split('-') as [SortField, SortOrder]
                  setSortBy(field)
                  setSortOrder(order)
                }}
                aria-label={t('sort.label')}
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
      </div>

      {/* 需求列表 */}
      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2">
        {error && (
          <div className="p-2 text-xs text-status-danger bg-status-danger/10 rounded-lg">
            {error}
          </div>
        )}

        {displayRequirements.map(req => (
          <RequirementCard
            key={req.id}
            requirement={req}
            showWorkspace={scope === 'all'}
            disabled={processingIds.has(req.id)}
            onApproveClick={handleApprove}
            onRejectClick={req => setSelectedId(req.id)}
            onDeleteClick={req => setConfirmDialog({
              title: t('confirm.deleteTitle'),
              message: t('confirm.deleteMessage'),
              type: 'danger',
              onConfirm: () => handleDelete(req),
            })}
            onExecuteClick={handleExecute}
            onGeneratePrototypeClick={handleGeneratePrototype}
            onEditClick={req => setSelectedId(req.id)}
            onClick={req => setSelectedId(req.id)}
          />
        ))}

        {/* 空状态 */}
        {displayRequirements.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center py-12 text-text-tertiary">
            <ClipboardList size={48} className="mb-3 opacity-50" />
            <p className="text-sm">
              {statusFilter !== 'all' || filter.search
                ? t('empty.noMatching')
                : t('empty.noRequirements')}
            </p>
            {statusFilter === 'all' && !filter.search && (
              <p className="mt-2 text-xs opacity-70">
                {t('empty.hint')}
              </p>
            )}
          </div>
        )}
      </div>

      {/* 创建需求弹窗 */}
      {showCreateDialog && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('detail.createTitle')}
          className="fixed inset-0 bg-overlay flex items-center justify-center z-50"
        >
          <RequirementForm
            mode="create"
            onSubmit={async (data) => {
              try {
                await createRequirement(data)
                setShowCreateDialog(false)
                toast.success(t('toast.createSuccess'))
              } catch (e) {
                log.error('创建需求失败', e instanceof Error ? e : new Error(String(e)))
                toast.error(t('toast.createFailed'))
              }
            }}
            onCancel={() => setShowCreateDialog(false)}
          />
        </div>
      )}

      {/* AI 生成需求弹窗 */}
      <RequirementGenerateDialog
        open={showGenerateDialog}
        onConfirm={(scope, context) => {
          setShowGenerateDialog(false)
          handleGenerate(scope, context)
        }}
        onCancel={() => setShowGenerateDialog(false)}
      />

      {/* AI 提取需求弹窗（--json-schema 结构化提取，区别于上方 req-generate 协议任务） */}
      <AiExtractDialog<RequirementCreateParams>
        open={showExtractDialog}
        labels={{
          title: t('aiExtract.title'),
          description: t('aiExtract.description'),
          placeholder: t('aiExtract.placeholder'),
          extract: t('aiExtract.extract'),
          extracting: t('aiExtract.extracting'),
          confirm: t('aiExtract.confirm'),
          cancel: t('aiExtract.cancel'),
          empty: t('aiExtract.empty'),
          inputRequired: t('aiExtract.inputRequired'),
        }}
        onExtract={(text) => extractRequirement(text, { workspaceDir: currentWorkspace?.path ?? null })}
        isEmpty={(req) => !req?.title}
        renderPreview={(req) => (
          <div className="space-y-1.5">
            <div className="text-sm font-medium text-text-primary break-words">{req.title}</div>
            {req.description && (
              <div className="text-xs text-text-secondary break-words whitespace-pre-wrap line-clamp-6">
                {req.description}
              </div>
            )}
            <div className="flex items-center gap-2 flex-wrap pt-1">
              {req.priority && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                  {t(`priority.${req.priority}`)}
                </span>
              )}
              {req.tags?.map((tag) => (
                <span key={tag} className="text-xs px-1.5 py-0.5 rounded bg-background-hover text-text-tertiary">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}
        onConfirm={async (req) => {
          await createRequirement(req)
          toast.success(t('aiExtract.success'))
        }}
        onClose={() => setShowExtractDialog(false)}
      />

      {/* 需求详情弹窗 */}
      {selectedRequirement && (
        <RequirementDetailDialog
          requirement={selectedRequirement}
          open={!!selectedRequirement}
          disabled={processingIds.has(selectedRequirement.id)}
          onClose={() => setSelectedId(null)}
          onEditSubmit={async (data) => {
            try {
              await updateRequirement(selectedRequirement.id, data)
              toast.success(t('toast.updateSuccess'))
            } catch (e) {
              log.error('更新需求失败', e instanceof Error ? e : new Error(String(e)))
              toast.error(t('toast.updateFailed'))
            }
          }}
          onDelete={() => setConfirmDialog({
            title: t('confirm.deleteTitle'),
            message: t('confirm.deleteMessage'),
            type: 'danger',
            onConfirm: async () => {
              try {
                await deleteRequirement(selectedRequirement.id)
                setSelectedId(null)
                toast.success(t('toast.deleteSuccess'))
              } catch (e) {
                log.error('删除需求失败', e instanceof Error ? e : new Error(String(e)))
                toast.error(t('toast.deleteFailed'))
              }
            },
          })}
          onApprove={handleApprove}
          onReject={handleReject}
          onExecute={handleExecute}
          onGeneratePrototype={handleGeneratePrototype}
          onReadPrototype={readPrototype}
        />
      )}

      {/* 确认对话框 */}
      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          onConfirm={() => {
            confirmDialog.onConfirm()
            setConfirmDialog(null)
          }}
          onCancel={() => setConfirmDialog(null)}
          type={confirmDialog.type}
        />
      )}
    </div>
  )
}
