/**
 * TodoForm - 待办表单组件
 *
 * 用于创建和编辑待办,样式完全一致
 * 支持可折叠的高级选项
 * 包含所有字段:内容、描述、优先级、截止日期、工时、子任务
 */

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, Clock, Plus, Trash2, Globe } from 'lucide-react'
import type { TodoItem, TodoPriority, TodoSubtask } from '@/types'

interface TodoFormProps {
  // 待办数据(创建时为空对象,编辑时传入现有待办)
  todo?: Partial<TodoItem>
  // 提交回调
  onSubmit: (data: {
    content: string
    description?: string
    priority: TodoPriority
    dueDate?: string
    estimatedHours?: number
    subtasks?: TodoSubtask[]
    isGlobal?: boolean
  }) => void
  // 取消回调
  onCancel: () => void
  // 模式
  mode: 'create' | 'edit'
  // 标签相关回调(仅创建模式)
  tags?: string[]
  onAddTag?: (tag: string) => void
  onRemoveTag?: (tag: string) => void
}

export function TodoForm({ todo, onSubmit, onCancel, mode, tags, onAddTag, onRemoveTag }: TodoFormProps) {
  const { t } = useTranslation('todo')

  const [content, setContent] = useState(todo?.content || '')
  const [description, setDescription] = useState(todo?.description || '')
  const [priority, setPriority] = useState<TodoPriority>(todo?.priority || 'normal')
  const [dueDate, setDueDate] = useState(todo?.dueDate || '')
  const [estimatedHours, setEstimatedHours] = useState(todo?.estimatedHours || 0)
  const [subtasks, setSubtasks] = useState<TodoSubtask[]>(todo?.subtasks || [])
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [tagInput, setTagInput] = useState('')
  const [isGlobal, setIsGlobal] = useState(false)

  useEffect(() => {
    if (todo) {
      setContent(todo.content || '')
      setDescription(todo.description || '')
      setPriority(todo.priority || 'normal')
      setDueDate(todo.dueDate || '')
      setEstimatedHours(todo.estimatedHours || 0)
      setSubtasks(todo.subtasks || [])
      setIsGlobal(!todo.workspacePath)
    }
  }, [todo])

  const completedSubtasks = subtasks.filter((st) => st.completed).length
  const subtaskProgress = subtasks.length > 0 ? (completedSubtasks / subtasks.length) * 100 : 0

  const handleAddSubtask = () => {
    if (!newSubtaskTitle.trim()) return

    const newSubtask: TodoSubtask = {
      id: crypto.randomUUID(),
      title: newSubtaskTitle.trim(),
      completed: false,
      createdAt: new Date().toISOString(),
    }

    setSubtasks([...subtasks, newSubtask])
    setNewSubtaskTitle('')
  }

  const handleToggleSubtask = (subtaskId: string) => {
    setSubtasks(
      subtasks.map((st) =>
        st.id === subtaskId ? { ...st, completed: !st.completed } : st
      )
    )
  }

  const handleDeleteSubtask = (subtaskId: string) => {
    setSubtasks(subtasks.filter((st) => st.id !== subtaskId))
  }

  const handleUpdateSubtaskTitle = (subtaskId: string, newTitle: string) => {
    setSubtasks(
      subtasks.map((st) => (st.id === subtaskId ? { ...st, title: newTitle } : st))
    )
  }

  const handleAddTag = () => {
    const tag = tagInput.trim().toLowerCase()
    if (tag && onAddTag) {
      onAddTag(tag)
      setTagInput('')
    }
  }
  const handleTagInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAddTag()
    }
  }

  // 提交表单
  const handleSubmit = () => {
    if (!content.trim()) return

    onSubmit({
      content: content.trim(),
      description: description.trim() || undefined,
      priority,
      dueDate: dueDate || undefined,
      estimatedHours: estimatedHours || undefined,
      subtasks: subtasks.length > 0 ? subtasks : undefined,
      isGlobal,
    })
  }

  // 键盘事件
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
      className={`bg-background-elevated rounded-lg shadow-xl w-full ${isEditMode ? 'max-w-2xl' : 'max-w-md'} max-h-[90vh] overflow-hidden flex flex-col`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <h2 className="text-lg font-semibold text-text-primary">
          {isEditMode ? t('form.editTitle') : t('form.createTitle')}
        </h2>
        <button
          onClick={onCancel}
          className="p-1 rounded hover:bg-background-hover text-text-secondary hover:text-text-primary transition-all"
          title={t('form.closeTooltip')}
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
        <div>
          <label className="block text-sm font-medium text-text-primary mb-2">{t('form.contentLabel')} *</label>
          <input
            type="text"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t('form.contentPlaceholder')}
            className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-sm"
            autoFocus={!isEditMode}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-text-primary mb-2">{t('form.detailDescLabel')}</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('form.detailDescPlaceholder')}
            rows={3}
            className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-sm resize-none"
          />
        </div>

        {/* 全局待办选项（仅创建模式） */}
        {mode === 'create' && (
          <div className="flex items-center gap-2 p-3 bg-blue-500/10 rounded-lg">
            <input
              type="checkbox"
              id="isGlobal"
              checked={isGlobal}
              onChange={(e) => setIsGlobal(e.target.checked)}
              className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
            />
            <Globe size={16} className="text-blue-500" />
            <label htmlFor="isGlobal" className="text-sm text-text-primary cursor-pointer">
              {t('form.isGlobalLabel', '创建为全局待办')}
            </label>
            <span className="text-xs text-text-tertiary ml-auto">
              {isGlobal ? t('form.globalHint', '全局可见') : t('form.workspaceHint', '仅当前工作区')}
            </span>
          </div>
        )}

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
          <div className="space-y-5 pt-2">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-text-primary mb-2">{t('form.priorityLabel')}</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as TodoPriority)}
                  className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-sm bg-background-elevated"
                >
                  <option value="low">○ {t('priority.low')}</option>
                  <option value="normal">● {t('priority.normal')}</option>
                  <option value="high">◆ {t('priority.high')}</option>
                  <option value="urgent">▲ {t('priority.urgent')}</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-text-primary mb-2">{t('form.dueDateLabel')}</label>
                <input
                  type="date"
                  value={dueDate ? new Date(dueDate).toISOString().split('T')[0] : ''}
                  onChange={(e) => setDueDate(e.target.value ? new Date(e.target.value).toISOString() : '')}
                  className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-2">
                <Clock size={14} className="inline mr-1" />
                {t('form.estimatedHoursLabel')}
              </label>
              <input
                type="number"
                value={estimatedHours}
                onChange={(e) => setEstimatedHours(parseFloat(e.target.value) || 0)}
                min="0"
                step="0.5"
                placeholder={t('form.estimatedHoursPlaceholder')}
                className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-sm"
              />
            </div>

            {mode === 'create' && tags && (
              <div>
                <label className="block text-sm font-medium text-text-primary mb-2">{t('form.tagsLabel')}</label>
                <div className="space-y-2">
                  {tags && tags.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {tags.map((tag) => (
                        <span
                          key={tag}
                          onClick={() => {
                            if (mode === 'create' && onRemoveTag) {
                              onRemoveTag(tag)
                            }
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-blue-500 bg-blue-500/10 rounded cursor-pointer hover:bg-blue-500/20 transition-colors"
                          title={mode === 'create' ? t('form.clickRemove') : tag}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyDown={handleTagInputKeyDown}
                      placeholder={t('form.addTagPlaceholder')}
                      className="flex-1 px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-sm"
                    />
                    <button
                      onClick={handleAddTag}
                      disabled={!tagInput.trim()}
                      className="px-3 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-500/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all text-sm"
                    >
                      {t('form.addTagButton')}
                    </button>
                  </div>

                  <div className="text-xs text-text-tertiary">
                    {t('form.commonTags')}
                  </div>
                </div>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-3">
                <label className="block text-sm font-medium text-text-primary">
                  {t('form.subtaskProgress', { completed: completedSubtasks, total: subtasks.length })}
                </label>
                {subtasks.length > 0 && (
                  <div className="flex items-center gap-2 text-xs text-text-secondary">
                    <div className="w-24 bg-background-tertiary rounded-full h-1.5">
                      <div
                        className="bg-primary h-1.5 rounded-full"
                        style={{ width: `${subtaskProgress}%` }}
                      />
                    </div>
                    <span>{Math.round(subtaskProgress)}%</span>
                  </div>
                )}
              </div>

              {subtasks.length > 0 && (
                <div className="space-y-2 mb-3">
                  {subtasks.map((subtask) => (
                    <div
                      key={subtask.id}
                      className="flex items-center gap-2 p-2 bg-background-surface rounded border border-border-subtle group"
                    >
                      <input
                        type="checkbox"
                        checked={subtask.completed}
                        onChange={() => handleToggleSubtask(subtask.id)}
                        className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                      />
                      <input
                        type="text"
                        value={subtask.title}
                        onChange={(e) => handleUpdateSubtaskTitle(subtask.id, e.target.value)}
                        className={`flex-1 text-sm bg-transparent border-none focus:outline-none focus:ring-0 ${
                          subtask.completed ? 'line-through text-text-tertiary' : 'text-text-primary'
                        }`}
                      />
                      <button
                        onClick={() => handleDeleteSubtask(subtask.id)}
                        className="p-1 text-text-tertiary hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                        title={t('form.deleteSubtask')}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <input
                  type="text"
                  value={newSubtaskTitle}
                  onChange={(e) => setNewSubtaskTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleAddSubtask()
                    }
                  }}
                  placeholder={t('form.addSubtaskPlaceholder')}
                  className="flex-1 px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-sm"
                />
                <button
                  onClick={handleAddSubtask}
                  disabled={!newSubtaskTitle.trim()}
                  className="px-3 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all text-sm flex items-center gap-1"
                >
                  <Plus size={16} />
                  {t('form.addTagButton')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="px-6 py-4 border-t border-border flex justify-end gap-2 bg-background-surface">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm rounded-lg hover:bg-background-hover text-text-secondary transition-all"
        >
          {t('form.cancel')}
        </button>
        <button
          onClick={handleSubmit}
          disabled={!content.trim()}
          className="px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
        >
          {isEditMode ? t('form.saveButton') : t('form.createButton')}
        </button>
      </div>
    </div>
  )
}
