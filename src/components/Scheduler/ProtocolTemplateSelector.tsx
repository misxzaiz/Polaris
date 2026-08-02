/**
 * 协议模板选择器组件
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProtocolTemplate, TaskCategory, TemplateParam } from '@/types/scheduler';
import { TASK_CATEGORY_LABELS } from '@/types/scheduler';
import { useSchedulerStore } from '@/stores';

export interface ProtocolTemplateSelectorProps {
  /** 当前选中的模板 ID */
  value?: string;
  /** 模板变更回调 */
  onChange: (templateId: string | null, template: ProtocolTemplate | null) => void;
  /** 任务分类筛选 */
  category?: TaskCategory;
  /** 是否禁用 */
  disabled?: boolean;
}

export function ProtocolTemplateSelector({
  value,
  onChange,
  category,
  disabled,
}: ProtocolTemplateSelectorProps) {
  const { t } = useTranslation('scheduler');
  const { protocolTemplates, protocolTemplatesLoading, loadProtocolTemplates } = useSchedulerStore();

  // 加载模板
  useEffect(() => {
    loadProtocolTemplates();
  }, [loadProtocolTemplates]);

  // 筛选后的模板列表
  const filteredTemplates = category
    ? protocolTemplates.filter((t) => t.category === category)
    : protocolTemplates;

  // 启用的模板列表
  const enabledTemplates = filteredTemplates.filter((t) => t.enabled);

  // 当前选中的模板
  const selectedTemplate = value
    ? protocolTemplates.find((t) => t.id === value)
    : null;

  // 处理选择变更
  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newId = e.target.value || null;
    const newTemplate = newId
      ? protocolTemplates.find((t) => t.id === newId) || null
      : null;
    onChange(newId, newTemplate);
  };

  if (protocolTemplatesLoading) {
    return (
      <div className="text-sm text-text-muted">
        {t('protocolTemplate.loading')}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <select
        value={value || ''}
        onChange={handleChange}
        disabled={disabled}
        className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
      >
        <option value="">{t('protocolTemplate.noTemplate')}</option>
        {Object.entries(TASK_CATEGORY_LABELS).map(([cat, label]) => {
          const catTemplates = enabledTemplates.filter((t) => t.category === cat);
          if (catTemplates.length === 0) return null;
          return (
            <optgroup key={cat} label={label}>
              {catTemplates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                  {template.builtin ? ` (${t('protocolTemplate.builtin')})` : ''}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>

      {/* 模板描述 */}
      {selectedTemplate && (
        <div className="p-3 bg-background-surface border border-border-subtle rounded-lg text-sm">
          <div className="flex items-center gap-2 mb-2">
            <span className="font-medium text-text-primary">{selectedTemplate.name}</span>
            {selectedTemplate.builtin && (
              <span className="px-1.5 py-0.5 text-xs bg-primary/10 text-primary rounded">
                {t('protocolTemplate.builtin')}
              </span>
            )}
            <span className="px-1.5 py-0.5 text-xs bg-background-hover text-text-muted rounded">
              {TASK_CATEGORY_LABELS[selectedTemplate.category]}
            </span>
          </div>
          {selectedTemplate.description && (
            <p className="text-text-secondary mb-2">{selectedTemplate.description}</p>
          )}
          {selectedTemplate.params.length > 0 && (
            <div className="text-text-muted">
              <span className="font-medium">{t('protocolTemplate.params')}:</span>{' '}
              {selectedTemplate.params.map((p) => p.label).join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 模板参数配置表单组件
 */
export interface TemplateParamsFormProps {
  /** 参数定义列表 */
  params: TemplateParam[];
  /** 当前参数值 */
  values: Record<string, string>;
  /** 参数值变更回调 */
  onChange: (values: Record<string, string>) => void;
  /** 是否禁用 */
  disabled?: boolean;
}

export function TemplateParamsForm({
  params,
  values,
  onChange,
  disabled,
}: TemplateParamsFormProps) {
  const { t } = useTranslation('scheduler');

  // 如果没有参数，显示提示
  if (params.length === 0) {
    return (
      <div className="text-sm text-text-muted italic">
        {t('protocolTemplate.noParams')}
      </div>
    );
  }

  // 处理参数变更
  const handleChange = (key: string, value: string) => {
    onChange({ ...values, [key]: value });
  };

  return (
    <div className="space-y-3">
      {params.map((param) => (
        <div key={param.key}>
          <label className="block text-sm text-text-secondary mb-1">
            {param.label}
            {param.required && <span className="text-danger ml-1">*</span>}
          </label>
          {renderParamInput(param, values[param.key], (val) => handleChange(param.key, val), t, disabled)}
          {param.placeholder && (
            <p className="text-xs text-text-muted mt-1">{param.placeholder}</p>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * 渲染参数输入控件
 */
function renderParamInput(
  param: TemplateParam,
  value: string,
  onChange: (value: string) => void,
  t: (key: string) => string,
  disabled?: boolean
): React.ReactNode {
  const baseClass = 'w-full px-3 py-2 bg-background-base border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50';

  switch (param.type) {
    case 'textarea':
      return (
        <textarea
          value={value || param.defaultValue || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={param.placeholder}
          disabled={disabled}
          rows={3}
          className={`${baseClass} resize-none`}
        />
      );

    case 'select':
      return (
        <select
          value={value || param.defaultValue || ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={baseClass}
        >
          <option value="">{t('protocolTemplate.selectPlaceholder')}</option>
          {param.options?.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );

    case 'number':
      return (
        <input
          type="number"
          value={value || param.defaultValue || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={param.placeholder}
          disabled={disabled}
          className={baseClass}
        />
      );

    case 'date':
      return (
        <input
          type="date"
          value={value || param.defaultValue || ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={baseClass}
        />
      );

    case 'text':
    default:
      return (
        <input
          type="text"
          value={value || param.defaultValue || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={param.placeholder}
          disabled={disabled}
          className={baseClass}
        />
      );
  }
}
