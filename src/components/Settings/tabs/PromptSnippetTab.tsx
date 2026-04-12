/**
 * 设置页 — 快捷片段管理
 *
 * 用户自建 prompt 模板片段，支持变量注入。
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSnippetStore } from '../../../stores/snippetStore';
import { useToastStore } from '../../../stores';
import type { PromptSnippet, SnippetVariable, CreateSnippetParams, UpdateSnippetParams } from '../../../types/promptSnippet';
import { extractVariables, AUTO_VARIABLES } from '../../../types/promptSnippet';
import { IconPlus, IconEdit, IconTrash } from '../../Common/Icons';

interface SnippetFormData {
  name: string;
  description: string;
  content: string;
  variables: SnippetVariable[];
  enabled: boolean;
}

const EMPTY_FORM: SnippetFormData = {
  name: '',
  description: '',
  content: '',
  variables: [],
  enabled: true,
};

export function PromptSnippetTab() {
  const { t } = useTranslation('promptSnippet');
  const { snippets, loadSnippets, createSnippet, updateSnippet, deleteSnippet } = useSnippetStore();
  const { addToast } = useToastStore();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SnippetFormData>(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => { loadSnippets(); }, [loadSnippets]);

  const handleCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const handleEdit = (snippet: PromptSnippet) => {
    setEditingId(snippet.id);
    setForm({
      name: snippet.name,
      description: snippet.description ?? '',
      content: snippet.content,
      variables: [...snippet.variables],
      enabled: snippet.enabled,
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.content.trim()) return;
    try {
      if (editingId) {
        const params: UpdateSnippetParams = {
          name: form.name,
          description: form.description || undefined,
          content: form.content,
          variables: form.variables,
          enabled: form.enabled,
        };
        await updateSnippet(editingId, params);
        addToast({ type: 'success', title: t('toast.updated', { name: form.name }) });
      } else {
        const params: CreateSnippetParams = {
          name: form.name,
          description: form.description || undefined,
          content: form.content,
          variables: form.variables,
          enabled: form.enabled,
        };
        await createSnippet(params);
        addToast({ type: 'success', title: t('toast.created', { name: form.name }) });
      }
      setShowForm(false);
      setForm(EMPTY_FORM);
      setEditingId(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast({ type: 'error', title: msg });
    }
  };

  const handleDelete = async (snippet: PromptSnippet) => {
    if (!confirm(t('deleteConfirm', { name: snippet.name }))) return;
    await deleteSnippet(snippet.id);
    addToast({ type: 'success', title: t('toast.deleted') });
  };

  const handleCancel = () => {
    setShowForm(false);
    setForm(EMPTY_FORM);
    setEditingId(null);
  };

  // 变量操作
  const addVariable = () => {
    setForm(prev => ({
      ...prev,
      variables: [...prev.variables, { key: '', label: '', type: 'text', required: false }],
    }));
  };

  const updateVariable = (index: number, field: keyof SnippetVariable, value: string | boolean) => {
    setForm(prev => {
      const vars = [...prev.variables];
      vars[index] = { ...vars[index], [field]: value };
      return { ...prev, variables: vars };
    });
  };

  const removeVariable = (index: number) => {
    setForm(prev => ({ ...prev, variables: prev.variables.filter((_, i) => i !== index) }));
  };

  // 从模板内容自动提取变量
  const extractFromContent = useCallback(() => {
    const keys = extractVariables(form.content);
    const existing = new Set(form.variables.map(v => v.key));
    const newVars: SnippetVariable[] = keys
      .filter(k => !existing.has(k))
      .map(key => ({ key, label: key, type: 'text' as const, required: false }));
    if (newVars.length > 0) {
      setForm(prev => ({ ...prev, variables: [...prev.variables, ...newVars] }));
    }
  }, [form.content, form.variables]);

  return (
    <div className="space-y-4">
      {/* 标题 + 新建按钮 */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-text-primary">{t('title')}</h3>
          <p className="text-xs text-text-tertiary mt-1">{t('description')}</p>
        </div>
        <button
          onClick={handleCreate}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors"
        >
          <IconPlus size={14} />
          {t('create')}
        </button>
      </div>

      {/* 片段列表 */}
      {!showForm && (
        <div className="border border-border rounded-lg overflow-hidden">
          {snippets.length === 0 ? (
            <div className="p-6 text-center text-sm text-text-tertiary">{t('empty')}</div>
          ) : (
            snippets.map(snippet => (
              <div
                key={snippet.id}
                className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle last:border-b-0 hover:bg-background-hover transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-text-primary">/{snippet.name}</span>
                    {snippet.description && (
                      <span className="text-xs text-text-tertiary truncate">{snippet.description}</span>
                    )}
                  </div>
                  <div className="text-xs text-text-tertiary mt-0.5">
                    {snippet.variables.length > 0
                      ? snippet.variables.map(v => `{{${v.key}}}`).join(' · ')
                      : '—'}
                  </div>
                </div>

                {/* 启用状态 */}
                <label className="flex items-center gap-1.5 cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={snippet.enabled}
                    onChange={e => updateSnippet(snippet.id, { enabled: e.target.checked })}
                    className="rounded border-border text-primary focus:ring-primary"
                  />
                </label>

                {/* 操作按钮 */}
                <button
                  onClick={() => handleEdit(snippet)}
                  className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
                  title={t('edit')}
                >
                  <IconEdit size={14} />
                </button>
                <button
                  onClick={() => handleDelete(snippet)}
                  className="p-1 text-text-tertiary hover:text-danger transition-colors"
                  title={t('delete')}
                >
                  <IconTrash size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* 新建/编辑表单 */}
      {showForm && (
        <div className="border border-border rounded-lg p-4 space-y-4">
          {/* 名称 */}
          <div className="space-y-1">
            <label className="text-sm text-text-secondary">{t('form.name')}</label>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
              placeholder={t('form.namePlaceholder')}
              className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary"
            />
            <p className="text-xs text-text-tertiary">{t('form.nameHint')}</p>
          </div>

          {/* 描述 */}
          <div className="space-y-1">
            <label className="text-sm text-text-secondary">{t('form.description')}</label>
            <input
              type="text"
              value={form.description}
              onChange={e => setForm(prev => ({ ...prev, description: e.target.value }))}
              placeholder={t('form.descriptionPlaceholder')}
              className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary"
            />
          </div>

          {/* 模板内容 */}
          <div className="space-y-1">
            <label className="text-sm text-text-secondary">{t('form.content')}</label>
            <textarea
              value={form.content}
              onChange={e => setForm(prev => ({ ...prev, content: e.target.value }))}
              placeholder={t('form.contentPlaceholder')}
              className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary resize-none font-mono"
              rows={5}
            />
            <p className="text-xs text-text-tertiary">{t('form.contentHint')}</p>
          </div>

          {/* 变量定义 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm text-text-secondary">{t('variables.title')}</label>
              <div className="flex gap-2">
                <button
                  onClick={extractFromContent}
                  className="text-xs text-primary hover:text-primary-hover transition-colors"
                >
                  {t('variables.extractFromContent')}
                </button>
                <button
                  onClick={addVariable}
                  className="text-xs text-primary hover:text-primary-hover transition-colors"
                >
                  + {t('variables.add')}
                </button>
              </div>
            </div>

            {form.variables.map((v, idx) => (
              <div key={idx} className="flex items-start gap-2 p-2 bg-surface border border-border-subtle rounded-lg">
                {/* 变量名 */}
                <div className="w-28 shrink-0">
                  <input
                    type="text"
                    value={v.key}
                    onChange={e => updateVariable(idx, 'key', e.target.value)}
                    placeholder={t('variables.keyPlaceholder')}
                    className="w-full bg-background-surface border border-border rounded px-2 py-1 text-xs font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary"
                  />
                </div>
                {/* 标签 */}
                <div className="w-28 shrink-0">
                  <input
                    type="text"
                    value={v.label}
                    onChange={e => updateVariable(idx, 'label', e.target.value)}
                    placeholder={t('variables.labelPlaceholder')}
                    className="w-full bg-background-surface border border-border rounded px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary"
                  />
                </div>
                {/* 类型 */}
                <select
                  value={v.type}
                  onChange={e => updateVariable(idx, 'type', e.target.value)}
                  className="bg-background-surface border border-border rounded px-2 py-1 text-xs text-text-primary focus:outline-none focus:border-primary"
                >
                  <option value="text">{t('variables.typeText')}</option>
                  <option value="textarea">{t('variables.typeTextarea')}</option>
                </select>
                {/* 必填 */}
                <label className="flex items-center gap-1 shrink-0 py-1">
                  <input
                    type="checkbox"
                    checked={v.required}
                    onChange={e => updateVariable(idx, 'required', e.target.checked)}
                    className="rounded border-border text-primary"
                  />
                  <span className="text-xs text-text-tertiary">{t('variables.required')}</span>
                </label>
                {/* 删除 */}
                <button
                  onClick={() => removeVariable(idx)}
                  className="p-1 text-text-tertiary hover:text-danger transition-colors shrink-0"
                >
                  <IconTrash size={12} />
                </button>
              </div>
            ))}

            {/* 自动变量说明 */}
            <div className="mt-2 p-2 bg-background-hover rounded-lg">
              <p className="text-xs text-text-tertiary mb-1">{t('variables.autoVars')}</p>
              <div className="grid grid-cols-2 gap-1">
                {AUTO_VARIABLES.map(v => (
                  <span key={v.key} className="text-xs text-text-tertiary font-mono">
                    {`{{${v.key}}}`} — {v.label}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* 操作按钮 */}
          <div className="flex gap-2 justify-end pt-2">
            <button
              onClick={handleCancel}
              className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
            >
              {t('cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={!form.name.trim() || !form.content.trim()}
              className="px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('save')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
