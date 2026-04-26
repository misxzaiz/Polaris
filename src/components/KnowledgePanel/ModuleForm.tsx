/**
 * ModuleForm - 知识模块创建/编辑表单
 *
 * 复用 TodoForm / RequirementForm 的 dialog-card 模式。
 * mode="create" 创建新模块，mode="edit" 编辑已有模块。
 */

import { useState, useEffect, useCallback } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import type { ModuleIndexEntry, DomainDefinition } from '@/services/knowledgeService'
import type { CreateModuleData, UpdateModuleData } from '@/services/tauri/knowledgeIpcService'

interface ModuleFormProps {
  module?: ModuleIndexEntry
  mode: 'create' | 'edit'
  onSubmit: (data: CreateModuleData | UpdateModuleData) => Promise<void>
  onCancel: () => void
}

export function ModuleForm({ module, mode, onSubmit, onCancel }: ModuleFormProps) {
  const { t } = useTranslation('knowledge')
  const domains = useKnowledgeStore(s => s.getDomains())

  const isEditMode = mode === 'edit'

  // Form state
  const [id, setId] = useState(module?.id ?? '')
  const [name, setName] = useState(module?.name ?? '')
  const [domain, setDomain] = useState(module?.domain ?? '')
  const [complexity, setComplexity] = useState(module?.complexity ?? 'medium')
  const [changeFrequency, setChangeFrequency] = useState(module?.changeFrequency ?? 'medium')
  const [dependencies, setDependencies] = useState<string[]>(module?.dependencies ?? [])
  const [saving, setSaving] = useState(false)

  // Sync on module change (edit mode)
  useEffect(() => {
    if (module && isEditMode) {
      setName(module.name)
      setDomain(module.domain ?? '')
      setComplexity(module.complexity)
      setChangeFrequency(module.changeFrequency)
      setDependencies(module.dependencies)
    }
  }, [module, isEditMode])

  // Available modules for dependency selection (exclude self)
  const allModules = useKnowledgeStore(s => s.index?.modules ?? [])
  const availableDeps = allModules.filter(m => m.id !== module?.id)

  // Keyboard shortcuts
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
  }, [onCancel]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = async () => {
    const trimmedId = id.trim()
    const trimmedName = name.trim()

    if (!trimmedName) return
    if (!isEditMode && !trimmedId) return

    setSaving(true)
    try {
      if (isEditMode) {
        const data: UpdateModuleData = {
          id: module!.id,
          name: trimmedName,
          domain: domain || undefined,
          dependencies,
          complexity,
          changeFrequency,
        }
        await onSubmit(data)
      } else {
        const data: CreateModuleData = {
          id: trimmedId,
          name: trimmedName,
          domain: domain || undefined,
          dependencies,
          complexity,
          changeFrequency,
        }
        await onSubmit(data)
      }
    } finally {
      setSaving(false)
    }
  }

  const isValid = isEditMode
    ? name.trim().length > 0
    : id.trim().length > 0 && name.trim().length > 0 && /^[a-z0-9-]+$/.test(id.trim())

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div
        className="bg-background-elevated rounded-lg shadow-xl flex flex-col max-h-[80vh]"
        style={{ width: isEditMode ? '640px' : '480px' }}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border-subtle">
          <h3 className="text-sm font-semibold text-text-primary">
            {isEditMode ? t('form.editTitle') : t('form.createTitle')}
          </h3>
          <button
            onClick={onCancel}
            className="p-1 rounded hover:bg-background-tertiary text-text-tertiary"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* ID (create only) */}
          {!isEditMode && (
            <div>
              <label className="block text-xs text-text-secondary mb-1">
                {t('form.idLabel')} <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={id}
                onChange={e => setId(e.target.value)}
                placeholder={t('form.idPlaceholder')}
                className="w-full px-3 py-1.5 text-xs bg-background-surface border border-border-subtle rounded focus:outline-none focus:border-primary/50"
                autoFocus
              />
              <p className="mt-1 text-xs text-text-tertiary">
                {t('form.idHint')}
              </p>
            </div>
          )}

          {/* Name */}
          <div>
            <label className="block text-xs text-text-secondary mb-1">
              {t('form.nameLabel')} <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('form.namePlaceholder')}
              className="w-full px-3 py-1.5 text-xs bg-background-surface border border-border-subtle rounded focus:outline-none focus:border-primary/50"
              autoFocus={isEditMode}
            />
          </div>

          {/* Domain */}
          <div>
            <label className="block text-xs text-text-secondary mb-1">
              {t('form.domainLabel')}
            </label>
            <select
              value={domain}
              onChange={e => setDomain(e.target.value)}
              className="w-full px-3 py-1.5 text-xs bg-background-surface border border-border-subtle rounded focus:outline-none focus:border-primary/50"
            >
              <option value="">{t('form.noDomain')}</option>
              {domains.map((d: DomainDefinition) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.id})
                </option>
              ))}
            </select>
          </div>

          {/* Complexity + Frequency */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-secondary mb-1">
                {t('form.complexityLabel')}
              </label>
              <select
                value={complexity}
                onChange={e => setComplexity(e.target.value as 'low' | 'medium' | 'high')}
                className="w-full px-3 py-1.5 text-xs bg-background-surface border border-border-subtle rounded focus:outline-none focus:border-primary/50"
              >
                <option value="low">{t('complexityLevel.low')}</option>
                <option value="medium">{t('complexityLevel.medium')}</option>
                <option value="high">{t('complexityLevel.high')}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">
                {t('form.frequencyLabel')}
              </label>
              <select
                value={changeFrequency}
                onChange={e => setChangeFrequency(e.target.value as 'low' | 'medium' | 'high')}
                className="w-full px-3 py-1.5 text-xs bg-background-surface border border-border-subtle rounded focus:outline-none focus:border-primary/50"
              >
                <option value="low">{t('frequencyLevel.low')}</option>
                <option value="medium">{t('frequencyLevel.medium')}</option>
                <option value="high">{t('frequencyLevel.high')}</option>
              </select>
            </div>
          </div>

          {/* Dependencies */}
          <div>
            <label className="block text-xs text-text-secondary mb-1">
              {t('form.dependenciesLabel')}
            </label>
            <div className="flex flex-wrap gap-1 mb-1">
              {dependencies.map(depId => (
                <span
                  key={depId}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-primary/10 text-primary rounded"
                >
                  {allModules.find(m => m.id === depId)?.name ?? depId}
                  <button
                    onClick={() => setDependencies(prev => prev.filter(d => d !== depId))}
                    className="hover:text-red-400"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
            <select
              value=""
              onChange={e => {
                if (e.target.value && !dependencies.includes(e.target.value)) {
                  setDependencies(prev => [...prev, e.target.value])
                }
              }}
              className="w-full px-3 py-1.5 text-xs bg-background-surface border border-border-subtle rounded focus:outline-none focus:border-primary/50"
            >
              <option value="">{t('form.addDependency')}</option>
              {availableDeps
                .filter(m => !dependencies.includes(m.id))
                .map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.id})
                  </option>
                ))}
            </select>
          </div>
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-border-subtle bg-background-surface flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary rounded hover:bg-background-tertiary transition-colors"
          >
            {t('form.cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!isValid || saving}
            className="px-4 py-1.5 text-xs bg-primary text-white rounded hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {saving ? t('form.saving') : (isEditMode ? t('form.update') : t('form.create'))}
          </button>
        </div>
      </div>
    </div>
  )
}
