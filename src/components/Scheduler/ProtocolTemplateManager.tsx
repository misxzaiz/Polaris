/**
 * 协议模板管理组件
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSchedulerStore, useToastStore } from '../../stores';
import type {
  ProtocolTemplate,
  CreateProtocolTemplateParams,
  TemplateParam,
  TaskCategory,
  TemplateParamType,
} from '../../types/scheduler';
import { TASK_CATEGORY_LABELS } from '../../types/scheduler';

export interface ProtocolTemplateManagerProps {
  /** 关闭回调 */
  onClose: () => void;
}

/** 参数类型选项 */
const PARAM_TYPE_OPTIONS: { value: TemplateParamType; label: string }[] = [
  { value: 'text', label: '文本' },
  { value: 'textarea', label: '多行文本' },
  { value: 'select', label: '下拉选择' },
  { value: 'number', label: '数字' },
  { value: 'date', label: '日期' },
];

/** 创建空参数 */
function createEmptyParam(): TemplateParam {
  return {
    key: '',
    label: '',
    type: 'text',
    required: false,
  };
}

export function ProtocolTemplateManager({ onClose }: ProtocolTemplateManagerProps) {
  const { t } = useTranslation('scheduler');
  const toast = useToastStore();
  const {
    protocolTemplates,
    protocolTemplatesLoading,
    loadProtocolTemplates,
    createProtocolTemplate,
    updateProtocolTemplate,
    deleteProtocolTemplate,
    toggleProtocolTemplate,
  } = useSchedulerStore();

  // 编辑器状态
  const [editingTemplate, setEditingTemplate] = useState<ProtocolTemplate | null>(null);
  const [showEditor, setShowEditor] = useState(false);

  // 表单状态
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formCategory, setFormCategory] = useState<TaskCategory>('custom');
  const [formMissionTemplate, setFormMissionTemplate] = useState('');
  const [formExecutionRules, setFormExecutionRules] = useState('');
  const [formMemoryRules, setFormMemoryRules] = useState('');
  const [formPromptTemplate, setFormPromptTemplate] = useState('');
  const [formParams, setFormParams] = useState<TemplateParam[]>([]);
  const [formEnabled, setFormEnabled] = useState(true);

  // 确认对话框
  const [deleteConfirm, setDeleteConfirm] = useState<ProtocolTemplate | null>(null);

  // 加载模板
  useEffect(() => {
    loadProtocolTemplates();
  }, [loadProtocolTemplates]);

  // 重置表单
  const resetForm = () => {
    setFormName('');
    setFormDescription('');
    setFormCategory('custom');
    setFormMissionTemplate('');
    setFormExecutionRules('');
    setFormMemoryRules('');
    setFormPromptTemplate('');
    setFormParams([]);
    setFormEnabled(true);
  };

  // 打开新建编辑器
  const handleNew = () => {
    setEditingTemplate(null);
    resetForm();
    setShowEditor(true);
  };

  // 打开编辑
  const handleEdit = (template: ProtocolTemplate) => {
    // 内置模板不可编辑
    if (template.builtin) {
      toast.warning(t('protocolTemplate.cannotEditBuiltin'));
      return;
    }
    setEditingTemplate(template);
    setFormName(template.name);
    setFormDescription(template.description || '');
    setFormCategory(template.category);
    setFormMissionTemplate(template.protocolConfig.missionTemplate);
    setFormExecutionRules(template.protocolConfig.executionRules || '');
    setFormMemoryRules(template.protocolConfig.memoryRules || '');
    setFormPromptTemplate(template.promptTemplate || '');
    setFormParams([...template.params]);
    setFormEnabled(template.enabled);
    setShowEditor(true);
  };

  // 保存模板
  const handleSave = async () => {
    if (!formName.trim()) {
      toast.warning(t('protocolTemplate.nameRequired'));
      return;
    }

    if (!formMissionTemplate.trim()) {
      toast.warning(t('protocolTemplate.missionTemplateRequired'));
      return;
    }

    // 验证参数
    for (const param of formParams) {
      if (!param.key.trim()) {
        toast.warning(t('protocolTemplate.paramKeyRequired'));
        return;
      }
      if (!param.label.trim()) {
        toast.warning(t('protocolTemplate.paramLabelRequired'));
        return;
      }
    }

    const params: CreateProtocolTemplateParams = {
      name: formName.trim(),
      description: formDescription.trim() || undefined,
      category: formCategory,
      protocolConfig: {
        missionTemplate: formMissionTemplate.trim(),
        executionRules: formExecutionRules.trim() || undefined,
        memoryRules: formMemoryRules.trim() || undefined,
      },
      promptTemplate: formPromptTemplate.trim() || undefined,
      params: formParams,
      enabled: formEnabled,
    };

    try {
      if (editingTemplate) {
        await updateProtocolTemplate(editingTemplate.id, params);
        toast.success(t('protocolTemplate.updateSuccess'));
      } else {
        await createProtocolTemplate(params);
        toast.success(t('protocolTemplate.createSuccess'));
      }
      setShowEditor(false);
    } catch (e) {
      toast.error(editingTemplate ? t('toast.updateFailed') : t('toast.createFailed'), e instanceof Error ? e.message : '');
    }
  };

  // 删除模板
  const handleDelete = async (template: ProtocolTemplate) => {
    if (template.builtin) {
      toast.warning(t('protocolTemplate.cannotDeleteBuiltin'));
      return;
    }

    try {
      await deleteProtocolTemplate(template.id);
      toast.success(t('protocolTemplate.deleteSuccess'));
      setDeleteConfirm(null);
    } catch (e) {
      toast.error(t('toast.deleteFailed'), e instanceof Error ? e.message : '');
    }
  };

  // 添加参数
  const handleAddParam = () => {
    setFormParams([...formParams, createEmptyParam()]);
  };

  // 更新参数
  const handleUpdateParam = (index: number, updates: Partial<TemplateParam>) => {
    const newParams = [...formParams];
    newParams[index] = { ...newParams[index], ...updates };
    setFormParams(newParams);
  };

  // 删除参数
  const handleRemoveParam = (index: number) => {
    const newParams = formParams.filter((_, i) => i !== index);
    setFormParams(newParams);
  };

  // 添加选项（select 类型）
  const handleAddOption = (paramIndex: number) => {
    const newParams = [...formParams];
    const param = newParams[paramIndex];
    if (!param.options) {
      param.options = [];
    }
    param.options.push({ value: '', label: '' });
    setFormParams(newParams);
  };

  // 更新选项
  const handleUpdateOption = (paramIndex: number, optionIndex: number, field: 'value' | 'label', value: string) => {
    const newParams = [...formParams];
    const param = newParams[paramIndex];
    if (param.options && param.options[optionIndex]) {
      param.options[optionIndex][field] = value;
    }
    setFormParams(newParams);
  };

  // 删除选项
  const handleRemoveOption = (paramIndex: number, optionIndex: number) => {
    const newParams = [...formParams];
    const param = newParams[paramIndex];
    if (param.options) {
      param.options = param.options.filter((_, i) => i !== optionIndex);
    }
    setFormParams(newParams);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background-elevated rounded-xl w-[900px] max-h-[85vh] overflow-hidden border border-border-subtle shadow-2xl flex flex-col">
        {/* 头部 */}
        <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">{t('protocolTemplate.title')}</h2>
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
          {protocolTemplatesLoading ? (
            <div className="text-center text-text-muted py-8">{t('loading')}</div>
          ) : protocolTemplates.length === 0 ? (
            <div className="text-center text-text-muted py-8">
              <p>{t('protocolTemplate.noTemplates')}</p>
              <p className="mt-2 text-sm">{t('protocolTemplate.createFirst')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {protocolTemplates.map((template) => (
                <div
                  key={template.id}
                  className={`p-4 bg-background-surface border border-border-subtle rounded-lg ${
                    !template.enabled ? 'opacity-60' : ''
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-medium text-text-primary">{template.name}</h3>
                        <span
                          className={`px-2 py-0.5 text-xs rounded ${
                            template.builtin
                              ? 'bg-primary-faint text-primary'
                              : 'bg-background-hover text-text-muted'
                          }`}
                        >
                          {template.builtin ? t('protocolTemplate.builtin') : t('protocolTemplate.custom')}
                        </span>
                        <span className="px-2 py-0.5 text-xs bg-background-hover text-text-muted rounded">
                          {TASK_CATEGORY_LABELS[template.category]}
                        </span>
                        {!template.enabled && (
                          <span className="px-2 py-0.5 text-xs bg-danger-faint text-danger rounded">
                            {t('template.disabled')}
                          </span>
                        )}
                      </div>
                      {template.description && (
                        <p className="mt-1 text-sm text-text-secondary">{template.description}</p>
                      )}
                      <div className="mt-2 text-xs text-text-muted">
                        <span className="font-medium">{t('protocolTemplate.params')}:</span>{' '}
                        {template.params.length > 0
                          ? template.params.map((p) => p.label).join(', ')
                          : t('protocolTemplate.noParams')}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 ml-4">
                      {!template.builtin && (
                        <>
                          <button
                            onClick={() => toggleProtocolTemplate(template.id, !template.enabled)}
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
                        </>
                      )}
                      {template.builtin && (
                        <span className="text-xs text-text-muted italic">
                          {t('protocolTemplate.builtinReadOnly')}
                        </span>
                      )}
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
            <div className="bg-background-elevated rounded-xl w-[800px] max-h-[90vh] overflow-hidden border border-border-subtle shadow-2xl flex flex-col">
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
                {/* 基本信息 */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">
                      {t('protocolTemplate.name')} <span className="text-danger">*</span>
                    </label>
                    <input
                      type="text"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder={t('protocolTemplate.namePlaceholder')}
                      className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">
                      {t('protocolTemplate.category')}
                    </label>
                    <select
                      value={formCategory}
                      onChange={(e) => setFormCategory(e.target.value as TaskCategory)}
                      className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                    >
                      {Object.entries(TASK_CATEGORY_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* 描述 */}
                <div>
                  <label className="block text-sm text-text-secondary mb-1">
                    {t('protocolTemplate.description')}
                  </label>
                  <input
                    type="text"
                    value={formDescription}
                    onChange={(e) => setFormDescription(e.target.value)}
                    placeholder={t('protocolTemplate.descriptionPlaceholder')}
                    className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>

                {/* 任务目标模板 */}
                <div>
                  <label className="block text-sm text-text-secondary mb-1">
                    {t('protocolTemplate.missionTemplate')} <span className="text-danger">*</span>
                  </label>
                  <textarea
                    value={formMissionTemplate}
                    onChange={(e) => setFormMissionTemplate(e.target.value)}
                    rows={3}
                    placeholder={t('protocolTemplate.missionTemplatePlaceholder')}
                    className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary resize-none font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <p className="mt-1 text-xs text-text-muted">
                    使用 {`{paramName}`} 作为参数占位符，如 {`{featureName}`}
                  </p>
                </div>

                {/* 执行规则 */}
                <div>
                  <label className="block text-sm text-text-secondary mb-1">
                    {t('protocolTemplate.executionRules')}
                  </label>
                  <textarea
                    value={formExecutionRules}
                    onChange={(e) => setFormExecutionRules(e.target.value)}
                    rows={2}
                    placeholder={t('protocolTemplate.executionRulesPlaceholder')}
                    className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary resize-none font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>

                {/* 记忆规则 */}
                <div>
                  <label className="block text-sm text-text-secondary mb-1">
                    {t('protocolTemplate.memoryRules')}
                  </label>
                  <textarea
                    value={formMemoryRules}
                    onChange={(e) => setFormMemoryRules(e.target.value)}
                    rows={2}
                    placeholder={t('protocolTemplate.memoryRulesPlaceholder')}
                    className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary resize-none font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>

                {/* 提示词模板 */}
                <div>
                  <label className="block text-sm text-text-secondary mb-1">
                    {t('protocolTemplate.promptTemplate')}
                  </label>
                  <textarea
                    value={formPromptTemplate}
                    onChange={(e) => setFormPromptTemplate(e.target.value)}
                    rows={2}
                    placeholder={t('protocolTemplate.promptTemplatePlaceholder')}
                    className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary resize-none font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>

                {/* 参数定义 */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm text-text-secondary">
                      {t('protocolTemplate.params')}
                    </label>
                    <button
                      type="button"
                      onClick={handleAddParam}
                      className="px-2 py-1 text-xs bg-primary-faint text-primary hover:bg-primary/20 rounded transition-colors"
                    >
                      + {t('protocolTemplate.addParam')}
                    </button>
                  </div>

                  {formParams.length === 0 ? (
                    <p className="text-sm text-text-muted italic">{t('protocolTemplate.noParams')}</p>
                  ) : (
                    <div className="space-y-3">
                      {formParams.map((param, index) => (
                        <div key={index} className="p-3 bg-background-base border border-border-subtle rounded-lg">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-sm font-medium text-text-primary">
                              {param.label || t('protocolTemplate.paramKey')}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleRemoveParam(index)}
                              className="text-danger hover:text-danger-hover text-sm"
                            >
                              {t('protocolTemplate.removeParam')}
                            </button>
                          </div>

                          <div className="grid grid-cols-2 gap-2 mb-2">
                            <div>
                              <label className="block text-xs text-text-muted mb-1">
                                {t('protocolTemplate.paramKey')}
                              </label>
                              <input
                                type="text"
                                value={param.key}
                                onChange={(e) => handleUpdateParam(index, { key: e.target.value })}
                                placeholder={t('protocolTemplate.paramKeyPlaceholder')}
                                className="w-full px-2 py-1.5 text-sm bg-background-surface border border-border-subtle rounded text-text-primary focus:outline-none focus:ring-1 focus:ring-primary/50"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-text-muted mb-1">
                                {t('protocolTemplate.paramLabel')}
                              </label>
                              <input
                                type="text"
                                value={param.label}
                                onChange={(e) => handleUpdateParam(index, { label: e.target.value })}
                                placeholder={t('protocolTemplate.paramLabelPlaceholder')}
                                className="w-full px-2 py-1.5 text-sm bg-background-surface border border-border-subtle rounded text-text-primary focus:outline-none focus:ring-1 focus:ring-primary/50"
                              />
                            </div>
                          </div>

                          <div className="grid grid-cols-3 gap-2 mb-2">
                            <div>
                              <label className="block text-xs text-text-muted mb-1">
                                {t('protocolTemplate.paramType')}
                              </label>
                              <select
                                value={param.type}
                                onChange={(e) => handleUpdateParam(index, { type: e.target.value as TemplateParamType })}
                                className="w-full px-2 py-1.5 text-sm bg-background-surface border border-border-subtle rounded text-text-primary focus:outline-none focus:ring-1 focus:ring-primary/50"
                              >
                                {PARAM_TYPE_OPTIONS.map((opt) => (
                                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="block text-xs text-text-muted mb-1">
                                {t('protocolTemplate.paramDefaultValue')}
                              </label>
                              <input
                                type="text"
                                value={param.defaultValue || ''}
                                onChange={(e) => handleUpdateParam(index, { defaultValue: e.target.value })}
                                className="w-full px-2 py-1.5 text-sm bg-background-surface border border-border-subtle rounded text-text-primary focus:outline-none focus:ring-1 focus:ring-primary/50"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-text-muted mb-1">
                                {t('protocolTemplate.paramPlaceholder')}
                              </label>
                              <input
                                type="text"
                                value={param.placeholder || ''}
                                onChange={(e) => handleUpdateParam(index, { placeholder: e.target.value })}
                                className="w-full px-2 py-1.5 text-sm bg-background-surface border border-border-subtle rounded text-text-primary focus:outline-none focus:ring-1 focus:ring-primary/50"
                              />
                            </div>
                          </div>

                          <div className="flex items-center gap-2 mb-2">
                            <input
                              type="checkbox"
                              id={`required-${index}`}
                              checked={param.required}
                              onChange={(e) => handleUpdateParam(index, { required: e.target.checked })}
                              className="rounded border-border-subtle"
                            />
                            <label htmlFor={`required-${index}`} className="text-xs text-text-secondary">
                              {t('protocolTemplate.paramRequired')}
                            </label>
                          </div>

                          {/* 选项（select 类型） */}
                          {param.type === 'select' && (
                            <div className="mt-2 pt-2 border-t border-border-subtle">
                              <div className="flex items-center justify-between mb-2">
                                <label className="text-xs text-text-muted">
                                  {t('protocolTemplate.paramOptions')}
                                </label>
                                <button
                                  type="button"
                                  onClick={() => handleAddOption(index)}
                                  className="text-xs text-primary hover:text-primary-hover"
                                >
                                  + 添加选项
                                </button>
                              </div>
                              {param.options && param.options.length > 0 && (
                                <div className="space-y-1">
                                  {param.options.map((opt, optIndex) => (
                                    <div key={optIndex} className="flex items-center gap-2">
                                      <input
                                        type="text"
                                        value={opt.value}
                                        onChange={(e) => handleUpdateOption(index, optIndex, 'value', e.target.value)}
                                        placeholder="值"
                                        className="flex-1 px-2 py-1 text-xs bg-background-surface border border-border-subtle rounded text-text-primary focus:outline-none focus:ring-1 focus:ring-primary/50"
                                      />
                                      <input
                                        type="text"
                                        value={opt.label}
                                        onChange={(e) => handleUpdateOption(index, optIndex, 'label', e.target.value)}
                                        placeholder="标签"
                                        className="flex-1 px-2 py-1 text-xs bg-background-surface border border-border-subtle rounded text-text-primary focus:outline-none focus:ring-1 focus:ring-primary/50"
                                      />
                                      <button
                                        type="button"
                                        onClick={() => handleRemoveOption(index, optIndex)}
                                        className="text-danger hover:text-danger-hover text-xs"
                                      >
                                        ✕
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

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
              <h3 className="text-lg font-semibold text-text-primary mb-2">{t('protocolTemplate.deleteConfirm')}</h3>
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
