/**
 * .gitignore 管理组件
 *
 * 显示和编辑 .gitignore 文件，支持添加模板规则
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Loader2, Inbox, Save, Plus, X, FilePlus } from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useToastStore } from '@/stores/toastStore'
import { logger } from '@/utils/logger'
import type { GitIgnoreTemplate } from '@/types/git'

export function GitignoreTab() {
  const { t } = useTranslation('git')
  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [exists, setExists] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 模板状态
  const [templates, setTemplates] = useState<GitIgnoreTemplate[]>([])
  const [showTemplates, setShowTemplates] = useState(false)

  const getGitignore = useGitStore((s) => s.getGitignore)
  const saveGitignore = useGitStore((s) => s.saveGitignore)
  const addToGitignore = useGitStore((s) => s.addToGitignore)
  const getGitignoreTemplates = useGitStore((s) => s.getGitignoreTemplates)
  const currentWorkspace = useWorkspaceStore((s) => {
    const { workspaces, currentWorkspaceId } = s
    return workspaces.find(w => w.id === currentWorkspaceId) || null
  })
  const toast = useToastStore()

  const loadGitignore = useCallback(async () => {
    if (!currentWorkspace) return

    setIsLoading(true)
    setError(null)
    try {
      const result = await getGitignore(currentWorkspace.path)
      setContent(result.content)
      setOriginalContent(result.content)
      setExists(result.exists)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
    } finally {
      setIsLoading(false)
    }
  }, [currentWorkspace, getGitignore])

  const loadTemplates = useCallback(async () => {
    try {
      const result = await getGitignoreTemplates()
      setTemplates(result)
    } catch (err) {
      logger.error('[GitignoreTab] Failed to load templates:', err)
    }
  }, [getGitignoreTemplates])

  useEffect(() => {
    loadGitignore()
    loadTemplates()
  }, [loadGitignore, loadTemplates])

  // 检查是否有修改
  const hasChanges = content !== originalContent

  // 保存 .gitignore
  const handleSave = async () => {
    if (!currentWorkspace) return

    setIsSaving(true)
    try {
      await saveGitignore(currentWorkspace.path, content)
      setOriginalContent(content)
      setExists(true)
      toast.success(t('gitignore.saveSuccess'))
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      toast.error(t('errors.saveFailed'), errorMsg)
    } finally {
      setIsSaving(false)
    }
  }

  // 添加模板规则
  const handleAddTemplate = async (template: GitIgnoreTemplate) => {
    if (!currentWorkspace) return

    try {
      await addToGitignore(currentWorkspace.path, template.rules)
      toast.success(t('gitignore.templateAdded', { name: template.name }))
      await loadGitignore()
      setShowTemplates(false)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      toast.error(t('errors.addTemplateFailed'), errorMsg)
    }
  }

  // 添加单个规则
  const handleAddRule = async (rule: string) => {
    if (!currentWorkspace || !rule.trim()) return

    try {
      await addToGitignore(currentWorkspace.path, [rule.trim()])
      toast.success(t('gitignore.ruleAdded'))
      await loadGitignore()
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      toast.error(t('errors.addRuleFailed'), errorMsg)
    }
  }

  // 快速添加常用规则输入框
  const [newRule, setNewRule] = useState('')

  const handleAddNewRule = () => {
    if (newRule.trim()) {
      handleAddRule(newRule.trim())
      setNewRule('')
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-2 border-b border-border-subtle flex items-center justify-between shrink-0">
        <span className="text-sm font-medium text-text-primary">{t('gitignore.title')}</span>
        <div className="flex items-center gap-2">
          {hasChanges && (
            <span className="text-xs text-warning">{t('gitignore.unsaved')}</span>
          )}
          <button
            onClick={() => setShowTemplates(true)}
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors"
            title={t('gitignore.addTemplate')}
          >
            <FilePlus size={14} />
          </button>
          <button
            onClick={loadGitignore}
            disabled={isLoading}
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors disabled:opacity-50"
            title={t('refresh', { ns: 'common' })}
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-danger bg-danger/10 border-b border-danger/20 shrink-0">
          {error}
        </div>
      )}

      {/* 快速添加规则 */}
      <div className="px-4 py-2 border-b border-border-subtle flex items-center gap-2 shrink-0">
        <input
          type="text"
          value={newRule}
          onChange={(e) => setNewRule(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAddNewRule()}
          placeholder={t('gitignore.quickAddPlaceholder')}
          className="flex-1 px-2 py-1 text-sm bg-background border border-border-subtle rounded focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-tertiary"
        />
        <button
          onClick={handleAddNewRule}
          disabled={!newRule.trim()}
          className="p-1.5 text-text-tertiary hover:text-primary hover:bg-primary/10 rounded transition-colors disabled:opacity-50"
          title={t('gitignore.addRule')}
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-text-tertiary" />
          </div>
        ) : !exists && !content ? (
          <div className="flex-1 flex flex-col items-center justify-center text-text-tertiary">
            <Inbox size={24} className="mb-2 opacity-50" />
            <span className="text-sm">{t('gitignore.notFound')}</span>
            <button
              onClick={() => setShowTemplates(true)}
              className="mt-3 text-xs text-primary hover:underline"
            >
              {t('gitignore.createFromTemplate')}
            </button>
          </div>
        ) : (
          <>
            {/* 编辑器 */}
            <div className="flex-1 overflow-hidden">
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="w-full h-full p-4 text-sm font-mono bg-background text-text-primary resize-none focus:outline-none"
                placeholder={t('gitignore.editorPlaceholder')}
                spellCheck={false}
              />
            </div>

            {/* 保存按钮 */}
            {hasChanges && (
              <div className="px-4 py-2 border-t border-border-subtle flex justify-end shrink-0">
                <button
                  onClick={handleSave}
                  disabled={isSaving}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-white rounded hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {isSaving ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Save size={14} />
                  )}
                  <span>{t('gitignore.save')}</span>
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* 模板选择弹窗 */}
      {showTemplates && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background-surface border border-border-subtle rounded-lg shadow-lg w-[480px] max-w-[90vw] max-h-[80vh] flex flex-col">
            <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between shrink-0">
              <span className="text-sm font-medium text-text-primary">{t('gitignore.addTemplate')}</span>
              <button
                onClick={() => setShowTemplates(false)}
                className="p-1 text-text-tertiary hover:text-text-primary rounded transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0 p-4">
              <div className="space-y-3">
                {templates.map((template) => (
                  <div
                    key={template.name}
                    className="border border-border-subtle rounded-lg p-3 hover:border-primary/50 hover:bg-primary/5 transition-colors cursor-pointer"
                    onClick={() => handleAddTemplate(template)}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-text-primary">{template.name}</span>
                      <Plus size={14} className="text-text-tertiary" />
                    </div>
                    <p className="text-xs text-text-tertiary mb-2">{template.description}</p>
                    <div className="flex flex-wrap gap-1">
                      {template.rules.slice(0, 4).map((rule, i) => (
                        <code key={i} className="text-[10px] px-1.5 py-0.5 bg-background rounded text-text-tertiary">
                          {rule}
                        </code>
                      ))}
                      {template.rules.length > 4 && (
                        <span className="text-[10px] text-text-tertiary">
                          +{template.rules.length - 4} {t('gitignore.more')}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="px-4 py-3 border-t border-border-subtle flex justify-end shrink-0">
              <button
                onClick={() => setShowTemplates(false)}
                className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
              >
                {t('cancel', { ns: 'common' })}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
