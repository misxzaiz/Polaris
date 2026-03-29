/**
 * 模板选择器组件
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useTemplateStore } from '../../../stores/templateStore';
import type { TaskTemplate, TemplateVariable } from '../../../types/taskTemplate';

interface TemplateSelectorProps {
  /** 已选择的模板 ID */
  selectedId?: string;
  /** 选择回调 */
  onSelect: (template: TaskTemplate | null) => void;
  /** 是否禁用 */
  disabled?: boolean;
}

export function TemplateSelector({
  selectedId,
  onSelect,
  disabled = false,
}: TemplateSelectorProps) {
  const { t } = useTranslation();
  const { templates, loading, loadTemplates, getTemplate } = useTemplateStore();
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  const selectedTemplate = selectedId ? getTemplate(selectedId) : undefined;

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-text-tertiary">
        <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        {t('template.loading', '加载模板...')}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* 选择器按钮 */}
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`
          w-full flex items-center justify-between gap-2 px-3 py-2
          bg-background-surface border border-border rounded-lg
          text-left text-sm
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-primary cursor-pointer'}
          ${isOpen ? 'border-primary ring-1 ring-primary/50' : ''}
        `}
      >
        <div className="flex items-center gap-2">
          {selectedTemplate?.icon && <span>{selectedTemplate.icon}</span>}
          <span className={selectedTemplate ? 'text-text-primary' : 'text-text-tertiary'}>
            {selectedTemplate?.name ?? t('template.selectTemplate', '选择模板...')}
          </span>
        </div>
        <svg
          className={`w-4 h-4 text-text-tertiary transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* 下拉菜单 */}
      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-background-elevated border border-border rounded-lg shadow-lg overflow-hidden">
          {/* 无模板选项 */}
          <button
            type="button"
            onClick={() => {
              onSelect(null);
              setIsOpen(false);
            }}
            className={`
              w-full flex items-center gap-2 px-3 py-2 text-sm text-left
              hover:bg-background-hover
              ${!selectedId ? 'bg-primary/10 text-primary' : 'text-text-primary'}
            `}
          >
            <span className="w-5 text-center">—</span>
            {t('template.noTemplate', '不使用模板')}
          </button>

          {/* 分隔线 */}
          <div className="border-t border-border" />

          {/* 内置模板 */}
          <div className="py-1">
            <div className="px-3 py-1 text-xs text-text-muted font-medium">
              {t('template.builtin', '内置模板')}
            </div>
            {templates
              .filter(t => t.builtin)
              .map(template => (
                <TemplateOption
                  key={template.id}
                  template={template}
                  isSelected={selectedId === template.id}
                  onClick={() => {
                    onSelect(template);
                    setIsOpen(false);
                  }}
                />
              ))}
          </div>

          {/* 自定义模板 */}
          {templates.some(t => !t.builtin) && (
            <>
              <div className="border-t border-border" />
              <div className="py-1">
                <div className="px-3 py-1 text-xs text-text-muted font-medium">
                  {t('template.custom', '自定义模板')}
                </div>
                {templates
                  .filter(t => !t.builtin)
                  .map(template => (
                    <TemplateOption
                      key={template.id}
                      template={template}
                      isSelected={selectedId === template.id}
                      onClick={() => {
                        onSelect(template);
                        setIsOpen(false);
                      }}
                    />
                  ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* 模板详情 */}
      {selectedTemplate && (
        <TemplateDetail template={selectedTemplate} />
      )}
    </div>
  );
}

/** 模板选项 */
function TemplateOption({
  template,
  isSelected,
  onClick,
}: {
  template: TaskTemplate;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        w-full flex items-center gap-2 px-3 py-2 text-sm text-left
        hover:bg-background-hover
        ${isSelected ? 'bg-primary/10 text-primary' : 'text-text-primary'}
      `}
    >
      <span className="w-5 text-center">{template.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="truncate">{template.name}</div>
        {template.description && (
          <div className="text-xs text-text-tertiary truncate">{template.description}</div>
        )}
      </div>
    </button>
  );
}

/** 模板详情 */
function TemplateDetail({ template }: { template: TaskTemplate }) {
  const { t } = useTranslation();

  return (
    <div className="p-3 bg-background-surface border border-border rounded-lg space-y-3">
      {/* 描述 */}
      {template.description && (
        <p className="text-sm text-text-secondary">{template.description}</p>
      )}

      {/* 标签 */}
      {template.tags && template.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {template.tags.map(tag => (
            <span
              key={tag}
              className="px-2 py-0.5 text-xs bg-primary/10 text-primary rounded"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* 变量 */}
      {template.variables.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-text-muted font-medium">
            {t('template.variables', '模板变量')}
          </div>
          <div className="space-y-1">
            {template.variables.map(variable => (
              <VariableItem key={variable.id} variable={variable} />
            ))}
          </div>
        </div>
      )}

      {/* 文档 */}
      <div className="space-y-2">
        <div className="text-xs text-text-muted font-medium">
          {t('template.documents', '文档文件')}
        </div>
        <div className="flex flex-wrap gap-1">
          {template.documents.map(doc => (
            <span
              key={doc.filename}
              className={`
                px-2 py-0.5 text-xs rounded
                ${doc.isPrimary
                  ? 'bg-primary/10 text-primary'
                  : 'bg-background-hover text-text-secondary'
                }
              `}
            >
              {doc.filename}
              {doc.isPrimary && ` (${t('template.primary', '主文档')})`}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 变量项 */
function VariableItem({ variable }: { variable: TemplateVariable }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="font-mono text-primary">{'{{'}{variable.name}{'}}'}</span>
      <span className="text-text-tertiary">({variable.type})</span>
      {variable.required && (
        <span className="text-danger">*</span>
      )}
      {variable.defaultValue && (
        <span className="text-text-muted">
          = {variable.defaultValue}
        </span>
      )}
    </div>
  );
}

export default TemplateSelector;
