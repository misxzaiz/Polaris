/**
 * KnowledgePanel - 项目知识面板
 *
 * 展示知识模块索引列表，支持过期状态提示和文档浏览
 * 支持列表视图和依赖关系图视图切换
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  BookOpen,
  RefreshCw,
  FileText,
  Search,
  X,
  LayoutGrid,
  GitBranch,
  Activity,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore } from '@/stores'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { ModuleCard } from './ModuleCard'
import { KnowledgeDependencyGraph } from './KnowledgeDependencyGraph'
import { KnowledgeHealthDashboard } from './KnowledgeHealthDashboard'
import { ModuleDetailDialog } from './ModuleDetailDialog'
import type { ModuleNode } from './KnowledgeDependencyGraph'
import type { ConfidenceLevel } from './constants'

type ViewMode = 'list' | 'graph' | 'health'

export function KnowledgePanel() {
  const { t } = useTranslation('knowledge')
  const currentWorkspace = useWorkspaceStore(state => state.getCurrentWorkspace())
  const {
    index,
    staleModules,
    loading,
    initialized,
    loadIndex,
    loadStaleModules,
    selectedModuleId,
    selectModule,
  } = useKnowledgeStore()

  const [searchQuery, setSearchQuery] = useState('')
  const [showStaleOnly, setShowStaleOnly] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('list')

  // 选中的模块数据
  const selectedModule = selectedModuleId
    ? index?.modules.find(m => m.id === selectedModuleId)
    : undefined

  // 加载知识索引
  useEffect(() => {
    if (!currentWorkspace) return
    if (!initialized) {
      loadIndex(currentWorkspace.path)
    }
  }, [currentWorkspace, initialized, loadIndex])

  // 加载过期模块
  useEffect(() => {
    if (initialized) {
      loadStaleModules()
    }
  }, [initialized, loadStaleModules])

  // 过滤模块
  const filteredModules = index?.modules.filter(m => {
    const matchesSearch = !searchQuery ||
      m.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      m.name.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesStale = !showStaleOnly || staleModules.some(s => s.id === m.id)
    return matchesSearch && matchesStale
  }) ?? []

  const staleModuleIds = new Set(staleModules.map(s => s.id))

  // 转换为图节点数据
  const graphModules = useMemo((): ModuleNode[] => {
    if (!index) return []
    return index.modules.map(m => ({
      id: m.id,
      name: m.name,
      domain: m.domain ?? m.id.split('-')[0] ?? 'unknown',
      complexity: m.complexity as 'low' | 'medium' | 'high',
      dependencies: m.dependencies,
      dependents: m.dependents,
    }))
  }, [index])

  // 处理图节点点击
  const handleNodeClick = useCallback((moduleId: string) => {
    selectModule(selectedModuleId === moduleId ? null : moduleId)
  }, [selectedModuleId, selectModule])

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex-shrink-0 p-3 border-b border-border-subtle">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <BookOpen size={16} className="text-primary" />
            <span className="text-sm font-medium text-text-primary">
              {t('title')}
            </span>
            {staleModules.length > 0 && (
              <span className="px-1.5 py-0.5 text-xs rounded bg-amber-500/20 text-amber-500">
                {staleModules.length} {t('stale')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {/* 视图切换 */}
            <div className="flex items-center border border-border-subtle rounded overflow-hidden">
              <button
                onClick={() => setViewMode('list')}
                className={`p-1 ${viewMode === 'list' ? 'bg-primary text-white' : 'bg-transparent text-text-secondary hover:bg-background-tertiary'}`}
                title={t('viewList', '列表视图')}
              >
                <LayoutGrid size={12} />
              </button>
              <button
                onClick={() => setViewMode('graph')}
                className={`p-1 ${viewMode === 'graph' ? 'bg-primary text-white' : 'bg-transparent text-text-secondary hover:bg-background-tertiary'}`}
                title={t('viewGraph', '依赖关系图')}
              >
                <GitBranch size={12} />
              </button>
              <button
                onClick={() => setViewMode('health')}
                className={`p-1 ${viewMode === 'health' ? 'bg-primary text-white' : 'bg-transparent text-text-secondary hover:bg-background-tertiary'}`}
                title={t('viewHealth', '健康度仪表盘')}
              >
                <Activity size={12} />
              </button>
            </div>
            <button
              onClick={() => {
                if (currentWorkspace) {
                  loadIndex(currentWorkspace.path)
                }
              }}
              disabled={loading}
              className="p-1 rounded hover:bg-background-tertiary disabled:opacity-50"
              title={t('refresh')}
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* 搜索框 */}
        <div className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <input
            type="text"
            placeholder={t('searchPlaceholder')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full pl-7 pr-7 py-1.5 text-xs bg-background-surface border border-border-subtle rounded focus:outline-none focus:border-primary/50"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {/* 过期筛选 */}
        {staleModules.length > 0 && (
          <div className="mt-2 flex items-center gap-2">
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={showStaleOnly}
                onChange={e => setShowStaleOnly(e.target.checked)}
                className="w-3 h-3 rounded border-border-subtle"
              />
              <span className="text-xs text-text-secondary">
                {t('showStaleOnly')}
              </span>
            </label>
          </div>
        )}
      </div>

      {/* 内容区域 */}
      {viewMode === 'health' ? (
        <div className="flex-1 overflow-auto">
          <KnowledgeHealthDashboard
            onConfidenceFilter={(level: ConfidenceLevel) => {
              const moduleWithAssertion = index?.modules.find(m =>
                m.assertions?.some(a => a.confidence === level)
              )
              if (moduleWithAssertion) {
                selectModule(moduleWithAssertion.id)
              }
            }}
          />
        </div>
      ) : viewMode === 'graph' ? (
        <div className="flex-1 overflow-auto p-2">
          <KnowledgeDependencyGraph
            modules={graphModules}
            selectedModuleId={selectedModuleId ?? undefined}
            onNodeClick={handleNodeClick}
            groupByDomain={true}
            minHeight={300}
          />
          {selectedModuleId && (
            <div className="mt-2 p-2 bg-background-surface border border-border-subtle rounded text-xs">
              <div
                className="font-medium text-text-primary mb-1 cursor-pointer hover:text-primary"
                onClick={() => selectModule(selectedModuleId)}
              >
                {index?.modules.find(m => m.id === selectedModuleId)?.name}
                <span className="text-text-tertiary ml-1">#{selectedModuleId}</span>
              </div>
              <div className="text-text-secondary">
                {t('clickToDeselect', '点击节点取消选中')}
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* 模块列表 */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {loading && !index ? (
              <div className="flex items-center justify-center py-8 text-text-tertiary">
                <RefreshCw size={16} className="animate-spin mr-2" />
                <span className="text-xs">{t('loading')}</span>
              </div>
            ) : filteredModules.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-text-tertiary">
                <FileText size={24} className="mb-2 opacity-50" />
                <span className="text-xs">
                  {searchQuery ? t('noResults') : t('noModules')}
                </span>
              </div>
            ) : (
              filteredModules.map(module => (
                <ModuleCard
                  key={module.id}
                  module={module}
                  isStale={staleModuleIds.has(module.id)}
                  staleInfo={staleModules.find(s => s.id === module.id)}
                  onDetailClick={(id) => selectModule(id)}
                />
              ))
            )}
          </div>

          {/* 底部统计 */}
          {index && (
            <div className="flex-shrink-0 p-2 border-t border-border-subtle text-xs text-text-tertiary text-center">
              {t('stats', { total: index.modules.length, stale: staleModules.length })}
            </div>
          )}
        </>
      )}

      {/* 模块详情弹窗 */}
      {selectedModuleId && selectedModule && (
        <ModuleDetailDialog
          module={selectedModule}
          open={!!selectedModuleId}
          onClose={() => selectModule(null)}
        />
      )}
    </div>
  )
}
