/**
 * 模板管理组件
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSchedulerStore, useToastStore } from '@/stores';
import type { PromptTemplate, CreateTemplateParams } from '@/types/scheduler';
import { TEMPLATE_VARIABLES } from '@/types/scheduler';

export interface TemplateManagerProps {
  /** 关闭回调 */
  onClose: () => void;
}

export function TemplateManager({ onClose }: TemplateManagerProps) {
  const { t } = useTranslation('scheduler');
  const toast = useToastStore();
  const {
    templates,
    templatesLoading,
    loadTemplates,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    toggleTemplate,
  } = useSchedulerStore();

  // 编辑器状态
  const [editingTemplate, setEditingTemplate] = useState<PromptTemplate | null>(null);
  const [showEditor, setShowEditor] = useState(false);

  // 表单状态
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formContent, setFormContent] = useState('');
  const [formEnabled, setFormEnabled] = useState(true);

  // 确认对话框
  const [deleteConfirm, setDeleteConfirm] = useState<PromptTemplate | null>(null);

  // 加载模板
  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  // 打开新建编辑器
  const handleNew = () => {
    setEditingTemplate(null);
    setFormName('');
    setFormDescription('');
    setFormContent('');
    setFormEnabled(true);
    setShowEditor(true);
  };

  // 打开编辑
  const handleEdit = (template: PromptTemplate) => {
    setEditingTemplate(template);
    setFormName(template.name);
    setFormDescription(template.description || '');
    setFormContent(template.content);
    setFormEnabled(template.enabled);
    setShowEditor(true);
  };

  // 保存模板
  const handleSave = async () => {
    if (!formName.trim()) {
      toast.warning(t('template.nameRequired'));
      return;
    }

    if (!formContent.trim()) {
      toast.warning(t('template.contentRequired'));
      return;
    }

    const params: CreateTemplateParams = {
      name: formName.trim(),
      description: formDescription.trim() || undefined,
      content: formContent.trim(),
      enabled: formEnabled,
    };

    try {
      if (editingTemplate) {
        await updateTemplate({
          ...editingTemplate,
          ...params,
        });
        toast.success(t('template.updateSuccess'));
      } else {
        await createTemplate(params);
        toast.success(t('template.createSuccess'));
      }
      setShowEditor(false);
    } catch (e) {
      toast.error(editingTemplate ? t('toast.updateFailed') : t('toast.createFailed'), e instanceof Error ? e.message : '');
    }
  };

  // 删除模板
  const handleDelete = async (template: PromptTemplate) => {
    try {
      await deleteTemplate(template.id);
      toast.success(t('template.deleteSuccess'));
      setDeleteConfirm(null);
    } catch (e) {
      toast.error(t('toast.deleteFailed'), e instanceof Error ? e.message : '');
    }
  };

  // 插入变量
  const insertVariable = (variable: string) => {
    setFormContent((prev) => prev + variable);
  };

  // 预览模板
  const getPreview = () => {
    if (!formContent.trim()) return null;
    const now = new Date();
    return formContent
      .replace(/\{\{prompt\}\}/g, t('editor.promptPreviewPlaceholder'))
      .replace(/\{\{taskName\}\}/g, t('editor.taskNamePlaceholder'))
      .replace(/\{\{date\}\}/g, now.toISOString().split('T')[0])
      .replace(/\{\{time\}\}/g, now.toTimeString().slice(0, 5))
      .replace(/\{\{datetime\}\}/g, `${now.toISOString().split('T')[0]} ${now.toTimeString().slice(0, 5)}`)
      .replace(/\{\{weekday\}\}/g, ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()]);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background-elevated rounded-xl w-[750px] max-h-[85vh] overflow-hidden border border-border-subtle shadow-2xl flex flex-col">
        {/* 头部 */}
        <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">{t('template.title')}</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleNew}
              className="px-3 py-1.5 bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors text-sm"
            >
              + {t('template.newTemplate')}
            </button>
            <button
              onClick={onClose}
              className="text-text-muted hover:text-text-primary transition-colors"
            >
              ✕
            </button>
          </div>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-5">
          {templatesLoading ? (
            <div className="text-center text-text-muted py-8">{t('loading')}</div>
          ) : templates.length === 0 ? (
            <div className="text-center text-text-muted py-8">
              <p>{t('template.noTemplates')}</p>
              <p className="mt-2 text-sm">{t('template.createFirst')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {templates.map((template) => (
                <div
                  key={template.id}
                  className={`p-4 bg-background-surface border border-border-subtle rounded-lg ${
                    !template.enabled ? 'opacity-60' : ''
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-text-primary truncate">{template.name}</h3>
                        <span
                          className={`px-2 py-0.5 text-xs rounded ${
                            template.enabled
                              ? 'bg-success-faint text-success'
                              : 'bg-background-hover text-text-muted'
                          }`}
                        >
                          {template.enabled ? t('template.enabled') : t('template.disabled')}
                        </span>
                      </div>
                      {template.description && (
                        <p className="mt-1 text-sm text-text-secondary truncate">{template.description}</p>
                      )}
                      <pre className="mt-2 text-xs text-text-muted whitespace-pre-wrap font-mono max-h-20 overflow-y-auto">
                        {template.content}
                      </pre>
                    </div>
                    <div className="flex items-center gap-2 ml-4">
                      <button
                        onClick={() => toggleTemplate(template.id, !template.enabled)}
                        className={`px-2 py-1 text-xs rounded transition-colors ${
                          template.enabled
                            ? 'bg-warning-faint text-warning hover:bg-warning/20'
                            : 'bg-success-faint text-success hover:bg-success/20'
                        }`}
                      >
                        {template.enabled ? t('card.disable') : t('card.enable')}
                      </button>
                      <button
                        onClick={() => handleEdit(template)}
                        className="px-2 py-1 text-xs bg-background-hover text-text-secondary hover:bg-background-active rounded transition-colors"
                      >
                        {t('card.edit')}
                      </button>
                      <button
                        onClick={() => setDeleteConfirm(template)}
                        className="px-2 py-1 text-xs bg-danger-faint text-danger hover:bg-danger/20 rounded transition-colors"
                      >
                        {t('card.delete')}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 模板编辑器弹窗 */}
        {showEditor && (
          <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
            <div className="bg-background-elevated rounded-xl w-[650px] max-h-[80vh] overflow-hidden border border-border-subtle shadow-2xl flex flex-col">
              {/* 编辑器头部 */}
              <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between">
                <h3 className="text-lg font-semibold text-text-primary">
                  {editingTemplate ? t('template.editTemplate') : t('template.newTemplate')}
                </h3>
                <button
                  onClick={() => setShowEditor(false)}
                  className="text-text-muted hover:text-text-primary transition-colors"
                >
                  ✕
                </button>
              </div>

              {/* 编辑器内容 */}
              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                {/* 名称 */}
                <div>
                  <label className="block text-sm text-text-secondary mb-1">
                    {t('template.name')} <span className="text-danger">*</span>
                  </label>
                  <input
                    type="text"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder={t('template.namePlaceholder')}
                    className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>

                {/* 描述 */}
                <div>
                  <label className="block text-sm text-text-secondary mb-1">
                    {t('template.description')}
                  </label>
                  <input
                    type="text"
                    value={formDescription}
                    onChange={(e) => setFormDescription(e.target.value)}
                    placeholder={t('template.descriptionPlaceholder')}
                    className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>

                {/* 变量插入 */}
                <div>
                  <label className="block text-sm text-text-secondary mb-1">
                    {t('template.insertVar')}
                  </label>
                  <div className="flex flex-wrap gap-1">
                    {TEMPLATE_VARIABLES.map((v) => (
                      <button
                        key={v.key}
                        type="button"
                        onClick={() => insertVariable(v.key)}
                        className="px-2 py-1 text-xs bg-primary-faint text-primary hover:bg-primary/20 rounded transition-colors"
                        title={v.description}
                      >
                        {v.key}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 内容 */}
                <div>
                  <label className="block text-sm text-text-secondary mb-1">
                    {t('template.content')} <span className="text-danger">*</span>
                  </label>
                  <textarea
                    value={formContent}
                    onChange={(e) => setFormContent(e.target.value)}
                    rows={6}
                    placeholder={t('template.contentPlaceholder')}
                    className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary resize-none font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>

                {/* 预览 */}
                {formContent.trim() && (
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">
                      {t('template.preview')}
                    </label>
                    <div className="p-3 bg-background-surface border border-border-subtle rounded-lg text-sm text-text-secondary whitespace-pre-wrap font-mono max-h-40 overflow-y-auto">
                      {getPreview()}
                    </div>
                  </div>
                )}

                {/* 启用状态 */}
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="template-enabled"
                    checked={formEnabled}
                    onChange={(e) => setFormEnabled(e.target.checked)}
                    className="rounded border-border-subtle"
                  />
                  <label htmlFor="template-enabled" className="text-sm text-text-secondary">
                    {t('template.enabled')}
                  </label>
                </div>
              </div>

              {/* 编辑器底部 */}
              <div className="px-5 py-4 border-t border-border-subtle flex justify-end gap-2">
                <button
                  onClick={() => setShowEditor(false)}
                  className="px-4 py-2 bg-background-hover text-text-secondary hover:bg-background-active rounded-lg transition-colors"
                >
                  {t('editor.cancel')}
                </button>
                <button
                  onClick={handleSave}
                  className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors"
                >
                  {t('editor.save')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 删除确认 */}
        {deleteConfirm && (
          <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
            <div className="bg-background-elevated rounded-xl p-5 border border-border-subtle shadow-2xl max-w-sm">
              <h3 className="text-lg font-semibold text-text-primary mb-2">{t('template.deleteConfirm')}</h3>
              <p className="text-sm text-text-secondary mb-4">{deleteConfirm.name}</p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setDeleteConfirm(null)}
                  className="px-4 py-2 bg-background-hover text-text-secondary hover:bg-background-active rounded-lg transition-colors"
                >
                  {t('editor.cancel')}
                </button>
                <button
                  onClick={() => handleDelete(deleteConfirm)}
                  className="px-4 py-2 bg-danger hover:bg-danger-hover text-white rounded-lg transition-colors"
                >
                  {t('card.delete')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
