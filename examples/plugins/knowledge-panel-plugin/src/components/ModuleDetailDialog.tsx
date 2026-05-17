/**
 * ModuleDetailDialog - 知识模块详情弹窗
 *
 * 遵循 RequirementDetailDialog 模式：
 * - fixed inset-0 bg-black/50 z-50 遮罩
 * - 4 Tab 切换：概览 / 断言 / 陷阱 / 依赖
 */

import { useState, useEffect, useCallback } from 'react'
import { X, BookOpen, AlertTriangle, Link2, Pencil, Trash2, Save, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ModuleIndexEntry as KnowledgeModule } from '../services/knowledgeService'
import { useKnowledgeStore } from '../stores/knowledgeStore'
import {
  ProgressiveStreamingMarkdown,
  CodeMirrorEditor,
  useToastStore,
} from '../runtime'
import {
  type ConfidenceLevel,
  CONFIDENCE_CONFIG,
  COMPLEXITY_COLORS,
  FREQUENCY_COLORS,
} from './constants'

type DetailTab = 'overview' | 'assertions' | 'traps' | 'dependencies'

interface ModuleDetailDialogProps {
  module: KnowledgeModule
  open: boolean
  onClose: () => void
  onEdit?: () => void
  onDelete?: () => void
}

/** 陷阱严重度颜色映射 */
const SEVERITY_COLORS: Record<string, string> = {
  low: 'text-green-500 bg-green-500/20',
  medium: 'text-amber-500 bg-amber-500/20',
  high: 'text-red-500 bg-red-500/20',
}

export function ModuleDetailDialog({ module, open, onClose, onEdit, onDelete }: ModuleDetailDialogProps) {
  const { t } = useTranslation('knowledge')
  const toast = useToastStore()
  const [activeTab, setActiveTab] = useState<DetailTab>('overview')
  const [editingDoc, setEditingDoc] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)

  const { index, moduleDocuments, docLoading, loadModuleDocument, saveModuleDocument } = useKnowledgeStore()

  // 打开弹窗时加载文档
  useEffect(() => {
    if (open) {
      setActiveTab('overview')
      setEditingDoc(false)
      setEditContent('')
      loadModuleDocument(module.id)
    }
  }, [open, module.id, loadModuleDocument])

  // Escape 键处理：编辑中退出编辑模式，否则关闭弹窗
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editingDoc) {
          e.preventDefault()
          setEditingDoc(false)
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, editingDoc])

  // Ctrl/Cmd+S 保存 — 必须在 early return 之前定义（hooks 顺序规则）
  const handleEditorSave = useCallback(async () => {
    if (!open) return
    setSaving(true)
    try {
      await saveModuleDocument(module.id, editContent)
      setEditingDoc(false)
      toast.success(t('detail.docSaveSuccess'))
    } catch {
      toast.error(t('detail.docSaveFailed'))
    } finally {
      setSaving(false)
    }
  }, [open, module.id, editContent, saveModuleDocument, toast, t]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null

  const docContent = moduleDocuments.get(module.id)
  const domains = index?.domains ?? []
  const moduleDomain = domains.find(d => d.id === module.domain)

  // 进入编辑模式
  const handleStartEditDoc = () => {
    setEditContent(docContent ?? '')
    setEditingDoc(true)
  }

  // 保存文档
  const handleSaveDoc = async () => {
    setSaving(true)
    try {
      await saveModuleDocument(module.id, editContent)
      setEditingDoc(false)
      toast.success(t('detail.docSaveSuccess'))
    } catch {
      toast.error(t('detail.docSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const tabs: { key: DetailTab; label: string }[] = [
    { key: 'overview', label: t('detail.tabOverview') },
    { key: 'assertions', label: `${t('detail.tabAssertions')} (${module.assertions?.length ?? 0})` },
    { key: 'traps', label: `${t('detail.tabTraps')} (${module.traps?.length ?? 0})` },
    { key: 'dependencies', label: t('detail.tabDependencies') },
  ]

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('detail.title')}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-background-elevated rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <BookOpen size={16} className="text-primary flex-shrink-0" />
            <h2 className="text-base font-medium text-text-primary truncate">
              {module.name}
            </h2>
            <span className="text-xs text-text-tertiary flex-shrink-0">#{module.id}</span>
            {module.domain && (
              <span className="px-1.5 py-0.5 text-xs bg-background-tertiary rounded flex-shrink-0">
                {moduleDomain?.name ?? module.domain}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {onEdit && (
              <button
                onClick={onEdit}
                className="p-1 rounded hover:bg-background-hover text-text-secondary hover:text-primary transition-all"
                title={t('form.editTitle')}
              >
                <Pencil size={16} />
              </button>
            )}
            {onDelete && (
              <button
                onClick={onDelete}
                className="p-1 rounded hover:bg-background-hover text-text-secondary hover:text-red-400 transition-all"
                title={t('confirm.deleteTitle')}
              >
                <Trash2 size={16} />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-background-hover text-text-secondary hover:text-text-primary transition-all"
              aria-label={t('detail.close')}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Tab bar */}
        <div className="px-4 py-2 border-b border-border-subtle flex-shrink-0">
          <div className="flex items-center gap-1 bg-background-base rounded-lg p-1">
            {tabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-3 py-1 text-xs rounded-md transition-all ${
                  activeTab === tab.key
                    ? 'bg-primary text-white shadow-sm'
                    : 'text-text-tertiary hover:text-text-secondary hover:bg-background-hover'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {activeTab === 'overview' && renderOverviewTab()}
          {activeTab === 'assertions' && renderAssertionsTab()}
          {activeTab === 'traps' && renderTrapsTab()}
          {activeTab === 'dependencies' && renderDependenciesTab()}
        </div>
      </div>
    </div>
  )

  // ── Overview Tab ────────────────────────────────────────────

  function renderOverviewTab() {
    return (
      <>
        {/* Key-value 信息行 */}
        <div className="space-y-2">
          {module.domain && (
            <div className="flex items-start gap-2 text-xs">
              <span className="w-16 shrink-0 text-text-secondary">{t('detail.domain')}</span>
              <span className="text-text-primary">
                {moduleDomain?.description ?? moduleDomain?.name ?? module.domain}
              </span>
            </div>
          )}
          <div className="flex items-start gap-2 text-xs">
            <span className="w-16 shrink-0 text-text-secondary">{t('complexity')}</span>
            <span className={`font-medium ${COMPLEXITY_COLORS[module.complexity] || ''}`}>
              {t(`complexityLevel.${module.complexity}`)}
            </span>
          </div>
          <div className="flex items-start gap-2 text-xs">
            <span className="w-16 shrink-0 text-text-secondary">{t('changeFrequency')}</span>
            <span className={`font-medium ${FREQUENCY_COLORS[module.changeFrequency] || ''}`}>
              {t(`frequencyLevel.${module.changeFrequency}`)}
            </span>
          </div>
          {module.scope && (
            <div className="flex items-start gap-2 text-xs">
              <span className="w-16 shrink-0 text-text-secondary">{t('detail.scope')}</span>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap gap-1">
                  {module.scope.include.map(p => (
                    <span key={p} className="px-1 py-0.5 bg-background-tertiary rounded font-mono text-[11px]">
                      {p}
                    </span>
                  ))}
                </div>
                {module.scope.exclude && module.scope.exclude.length > 0 && (
                  <div className="mt-1 text-text-tertiary text-[11px]">
                    {t('detail.scopeExclude')}: {module.scope.exclude.join(', ')}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 模块文档 */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-text-secondary">
              {t('detail.document')}
            </span>
            {!editingDoc && docContent !== undefined && (
              <button
                onClick={handleStartEditDoc}
                className="flex items-center gap-1 px-2 py-0.5 text-xs text-primary hover:bg-primary/10 rounded transition-colors"
              >
                <Pencil size={10} />
                {t('detail.editDoc')}
              </button>
            )}
          </div>

          {editingDoc ? (
            <div className="border border-border-subtle rounded overflow-hidden">
              {/* 编辑器工具栏 */}
              <div className="flex items-center justify-between px-2 py-1 bg-background-surface border-b border-border-subtle">
                <span className="text-xs text-text-tertiary">{t('detail.editingDoc')}</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setEditingDoc(false)}
                    className="flex items-center gap-1 px-2 py-0.5 text-xs text-text-secondary hover:text-text-primary rounded hover:bg-background-hover"
                  >
                    <RotateCcw size={10} />
                    {t('detail.cancelEdit')}
                  </button>
                  <button
                    onClick={handleSaveDoc}
                    disabled={saving}
                    className="flex items-center gap-1 px-2 py-0.5 text-xs bg-primary text-white rounded hover:bg-primary/90 disabled:opacity-50"
                  >
                    <Save size={10} />
                    {saving ? t('detail.saving') : t('detail.saveDoc')}
                  </button>
                </div>
              </div>
              {/* CodeMirror 编辑器 */}
              <div style={{ height: '400px' }}>
                <CodeMirrorEditor
                  value={editContent}
                  language="markdown"
                  onChange={(v) => setEditContent(v)}
                  onSave={handleEditorSave}
                  readOnly={false}
                  lineNumbers={false}
                  wrapEnabled={true}
                  filePath={`knowledge://${module.id}/doc.md`}
                />
              </div>
            </div>
          ) : docLoading ? (
            <div className="text-xs text-text-tertiary">{t('detail.documentLoading')}</div>
          ) : docContent ? (
            <div className="prose prose-sm prose-invert max-w-none text-sm text-text-secondary">
              <ProgressiveStreamingMarkdown content={docContent} completed={true} />
            </div>
          ) : (
            <div className="text-xs text-text-tertiary">{t('detail.documentEmpty')}</div>
          )}
        </div>
      </>
    )
  }

  // ── Assertions Tab ──────────────────────────────────────────

  function renderAssertionsTab() {
    const assertions = module.assertions ?? []

    if (assertions.length === 0) {
      return (
        <div className="text-xs text-text-tertiary py-4 text-center">
          {t('detail.noAssertions')}
        </div>
      )
    }

    return (
      <div className="space-y-2">
        {assertions.map(assertion => {
          const conf = CONFIDENCE_CONFIG[assertion.confidence as ConfidenceLevel]
          return (
            <div key={assertion.id} className="p-2 rounded border border-border-subtle bg-background-surface">
              <div className="flex items-start gap-2">
                {conf && (
                  <span className={`px-1.5 py-0.5 text-xs rounded flex-shrink-0 ${conf.bgColor}/20 ${conf.color}`}>
                    {t(conf.labelKey)}
                  </span>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-text-primary break-words">{assertion.claim}</div>
                  {assertion.anchor && (
                    <div className="mt-1 text-[11px] text-text-tertiary flex items-center gap-1">
                      <Link2 size={10} />
                      <span className="text-primary hover:underline cursor-pointer font-mono">
                        {assertion.anchor.file}
                        {assertion.anchor.symbol ? `::${assertion.anchor.symbol}` : ''}
                        {assertion.anchor.line ? `:${assertion.anchor.line}` : ''}
                      </span>
                    </div>
                  )}
                  {assertion.expect && (
                    <div className="mt-1 text-[11px] text-text-tertiary">
                      {t('detail.expectation')}: <code className="font-mono">{JSON.stringify(assertion.expect)}</code>
                    </div>
                  )}
                  {assertion.trap && (
                    <div className="mt-1 flex items-center gap-1 text-[11px] text-amber-500">
                      <AlertTriangle size={10} />
                      {t('detail.trapMarker')}
                    </div>
                  )}
                  <div className="mt-1 text-[11px] text-text-tertiary">
                    {t('detail.source')}: {assertion.source}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  // ── Traps Tab ───────────────────────────────────────────────

  function renderTrapsTab() {
    const traps = module.traps ?? []

    if (traps.length === 0) {
      return (
        <div className="text-xs text-text-tertiary py-4 text-center">
          {t('detail.noTraps')}
        </div>
      )
    }

    return (
      <div className="space-y-2">
        {traps.map(trap => (
          <div key={trap.id} className="p-2 rounded border border-border-subtle bg-background-surface">
            <div className="flex items-start gap-2">
              {trap.severity && (
                <span className={`px-1.5 py-0.5 text-xs rounded flex-shrink-0 ${SEVERITY_COLORS[trap.severity] ?? ''}`}>
                  {t(`severity.${trap.severity}`)}
                </span>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-xs text-text-primary break-words">{trap.description}</div>
                {trap.location && (
                  <div className="mt-1 text-[11px] text-text-tertiary">{trap.location}</div>
                )}
                {trap.files && trap.files.length > 0 && (
                  <div className="mt-1 text-[11px] text-text-tertiary">
                    <span>{t('detail.relatedFiles')}:</span>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {trap.files.map(f => (
                        <span key={f} className="text-primary hover:underline cursor-pointer font-mono">{f}</span>
                      ))}
                    </div>
                  </div>
                )}
                {trap.source && (
                  <div className="mt-1 text-[11px] text-text-tertiary">
                    {t('detail.source')}: {trap.source}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    )
  }

  // ── Dependencies Tab ────────────────────────────────────────

  function renderDependenciesTab() {
    return (
      <div className="space-y-4">
        <div>
          <div className="text-xs font-medium text-text-secondary mb-2">{t('detail.upstream')}</div>
          {module.dependencies.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {module.dependencies.map(depId => {
                const depModule = index?.modules.find(m => m.id === depId)
                return (
                  <span key={depId} className="px-2 py-1 text-xs bg-background-surface border border-border-subtle rounded">
                    {depModule?.name ?? depId}
                    <span className="text-text-tertiary ml-1">#{depId}</span>
                  </span>
                )
              })}
            </div>
          ) : (
            <div className="text-xs text-text-tertiary">{t('detail.noDependencies')}</div>
          )}
        </div>
        <div>
          <div className="text-xs font-medium text-text-secondary mb-2">{t('detail.downstream')}</div>
          {module.dependents.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {module.dependents.map(depId => {
                const depModule = index?.modules.find(m => m.id === depId)
                return (
                  <span key={depId} className="px-2 py-1 text-xs bg-background-surface border border-border-subtle rounded">
                    {depModule?.name ?? depId}
                    <span className="text-text-tertiary ml-1">#{depId}</span>
                  </span>
                )
              })}
            </div>
          ) : (
            <div className="text-xs text-text-tertiary">{t('detail.noDependents')}</div>
          )}
        </div>
      </div>
    )
  }
}
