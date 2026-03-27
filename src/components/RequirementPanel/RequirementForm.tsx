/**
 * RequirementForm - 需求创建/编辑表单
 *
 * 参考 TodoForm 模式：自包含弹窗、mode 切换、useState 表单状态
 * 字段：标题、描述、优先级、标签、原型、来源（高级选项）
 */

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { Requirement, RequirementPriority, RequirementSource } from '@/types/requirement'

interface RequirementFormProps {
  /** 编辑时传入现有需求 */
  requirement?: Requirement
  /** 提交回调 */
  onSubmit: (data: {
    title: string
    description: string
    priority: RequirementPriority
    tags: string[]
    hasPrototype: boolean
    generatedBy: RequirementSource
  }) => void
  /** 取消回调 */
  onCancel: () => void
  /** 模式 */
  mode: 'create' | 'edit'
}

export function RequirementForm({ requirement, onSubmit, onCancel, mode }: RequirementFormProps) {
  const { t } = useTranslation('requirement')

  const [title, setTitle] = useState(requirement?.title || '')
  const [description, setDescription] = useState(requirement?.description || '')
  const [priority, setPriority] = useState<RequirementPriority>(requirement?.priority || 'normal')
  const [tags, setTags] = useState<string[]>(requirement?.tags || [])
  const [hasPrototype, setHasPrototype] = useState(requirement?.hasPrototype || false)
  const [generatedBy, setGeneratedBy] = useState<RequirementSource>(requirement?.generatedBy || 'user')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [tagInput, setTagInput] = useState('')

  useEffect(() => {
    if (requirement) {
      setTitle(requirement.title || '')
      setDescription(requirement.description || '')
      setPriority(requirement.priority || 'normal')
      setTags(requirement.tags || [])
      setHasPrototype(requirement.hasPrototype || false)
      setGeneratedBy(requirement.generatedBy || 'user')
    }
  }, [requirement])

  const handleAddTag = () => {
    const tag = tagInput.trim()
    if (tag && !tags.includes(tag)) {
      setTags([...tags, tag])
    }
    setTagInput('')
  }

  const handleRemoveTag = (tag: string) => {
    setTags(tags.filter(t => t !== tag))
  }

  const handleSubmit = () => {
    if (!title.trim()) return
    onSubmit({
      title: title.trim(),
      description: description.trim(),
      priority,
      tags,
      hasPrototype,
      generatedBy,
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel()
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const isEditMode = mode === 'edit'

  return (
    <div
      className="bg-background-elevated rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
      onClick={e => e.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      {/* 头部 */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h2 className="text-base font-medium text-text-primary">
          {isEditMode ? t('detail.editTitle') : t('detail.createTitle')}
        </h2>
        <button
          onClick={onCancel}
          className="p-1 rounded hover:bg-background-hover text-text-secondary hover:text-text-primary transition-all"
          title={t('form.closeTooltip')}
        >
          <X size={18} />
        </button>
      </div>

      {/* 表单内容 */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* 标题 */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">
            {t('form.titleLabel')} *
          </label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder={t('form.titlePlaceholder')}
            className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 text-text-primary placeholder-text-tertiary"
            autoFocus={!isEditMode}
          />
        </div>

        {/* 描述 */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">
            {t('form.descriptionLabel')}
          </label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder={t('form.descriptionPlaceholder')}
            rows={4}
            className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 text-text-primary placeholder-text-tertiary resize-none"
          />
        </div>

        {/* 标签 */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">
            {t('form.tagsLabel')}
          </label>
          {tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mb-2">
              {tags.map(tag => (
                <span
                  key={tag}
                  onClick={() => handleRemoveTag(tag)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-blue-500 bg-blue-500/10 rounded cursor-pointer hover:bg-blue-500/20 transition-colors"
                  title={t('form.clickRemove')}
                >
                  {tag}
                  <X size={10} />
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleAddTag()
                }
              }}
              placeholder={t('form.tagsPlaceholder')}
              className="flex-1 px-3 py-2 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 text-text-primary placeholder-text-tertiary"
            />
            <button
              onClick={handleAddTag}
              disabled={!tagInput.trim()}
              className="px-3 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {t('form.addTag')}
            </button>
          </div>
        </div>

        {/* 高级选项 */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors w-full"
        >
          {showAdvanced ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          <span>{t('form.advancedOptions')}</span>
          <span className="ml-auto text-xs text-text-tertiary">
            {showAdvanced ? t('form.clickCollapse') : t('form.clickExpand')}
          </span>
        </button>

        {showAdvanced && (
          <div className="space-y-4 pt-1">
            {/* 优先级 */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                {t('form.priorityLabel')}
              </label>
              <select
                value={priority}
                onChange={e => setPriority(e.target.value as RequirementPriority)}
                className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 text-text-primary cursor-pointer"
              >
                <option value="low">{t('priority.low')}</option>
                <option value="normal">{t('priority.normal')}</option>
                <option value="high">{t('priority.high')}</option>
                <option value="urgent">{t('priority.urgent')}</option>
              </select>
            </div>

            {/* 生成原型 */}
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={hasPrototype}
                onChange={e => setHasPrototype(e.target.checked)}
                className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
              />
              <div>
                <span className="text-sm text-text-primary">{t('form.prototypeLabel')}</span>
                <p className="text-xs text-text-tertiary">{t('form.prototypeHelp')}</p>
              </div>
            </div>

            {/* 来源（仅创建模式） */}
            {!isEditMode && (
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">
                  {t('form.sourceLabel')}
                </label>
                <select
                  value={generatedBy}
                  onChange={e => setGeneratedBy(e.target.value as RequirementSource)}
                  className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 text-text-primary cursor-pointer"
                >
                  <option value="user">{t('source.user')}</option>
                  <option value="ai">{t('source.ai')}</option>
                </select>
                <p className="mt-1 text-xs text-text-tertiary">{t('form.sourceHelp')}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部按钮 */}
      <div className="px-4 py-3 border-t border-border flex justify-end gap-2 bg-background-surface">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm rounded-lg hover:bg-background-hover text-text-secondary transition-all"
        >
          {t('form.cancel')}
        </button>
        <button
          onClick={handleSubmit}
          disabled={!title.trim()}
          className="px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
        >
          {isEditMode ? t('form.saveButton') : t('form.createButton')}
        </button>
      </div>
    </div>
  )
}
