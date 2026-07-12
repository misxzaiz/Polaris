/**
 * 设置页 — 快捷片段管理
 *
 * 用户自建 prompt 模板片段，支持变量注入。
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSnippetStore } from '@/stores/snippetStore';
import { useConfigStore, useToastStore } from '@/stores';
import { useSkillStore } from '@/stores/skillStore';
import { usePluginStore } from '@/stores/pluginStore';
import { listPluginMcpServerStatuses, pluginRegistry } from '@/plugin-system';
import type { PromptSnippet, SnippetVariable, CreateSnippetParams, UpdateSnippetParams } from '@/types/promptSnippet';
import { extractVariables, AUTO_VARIABLES } from '@/types/promptSnippet';
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
  const { skills, loading: skillsLoading, loadSkills } = useSkillStore();
  const config = useConfigStore(state => state.config);
  const updateConfigPatch = useConfigStore(state => state.updateConfigPatch);
  const pluginStates = usePluginStore(state => state.pluginStates);
  const { addToast } = useToastStore();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SnippetFormData>(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [skillPathsText, setSkillPathsText] = useState('');

  useEffect(() => { loadSnippets(); }, [loadSnippets]);
  useEffect(() => {
    setSkillPathsText((config?.skillPaths?.length
      ? config.skillPaths
      : ['.polaris/skills', '.polaris/agents']).join('\n'));
  }, [config?.skillPaths]);

  // 获取 DataRoot 路径用于展示默认提示
  const [dataRootHint, setDataRootHint] = useState('');
  useEffect(() => {
    import('@/services/dataRootService').then(({ getDataRootInfo }) => {
      getDataRootInfo().then(info => setDataRootHint(info.root)).catch(() => {});
    }).catch(() => {});
  }, []);

  const pluginsById = new Map(pluginRegistry.listPlugins().map(plugin => [plugin.id, plugin]));
  const mcpServers = listPluginMcpServerStatuses(pluginStates)
    .filter(server => server.enabled)
    .map(server => {
      const plugin = pluginsById.get(server.pluginId);
      return {
        ...server,
        pluginName: plugin?.name ?? server.pluginId,
      };
    });

  const handleSaveSkillPaths = async () => {
    const skillPaths = [...new Set(skillPathsText
      .split(/\r?\n/)
      .map(path => path.trim())
      .filter(Boolean))];
    try {
      await updateConfigPatch({ skillPaths });
      await loadSkills();
      addToast({ type: 'success', title: 'Skill 路径已保存' });
    } catch (err) {
      addToast({ type: 'error', title: err instanceof Error ? err.message : String(err) });
    }
  };

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
      {/* <div className="border border-border rounded-lg p-4 space-y-4">
        <div>
          <h3 className="text-sm font-medium text-text-primary">斜杠命令来源</h3>
          <p className="text-xs text-text-tertiary mt-1">
            输入 / 可统一搜索快捷片段、Skill 和已启用的 MCP。相对路径按当前工作区解析，每行一个路径。
            {!config?.skillPaths?.length && (
              <span className="ml-1 text-primary">
                当前为默认模式：除下方路径外，还会自动扫描数据存储路径{dataRootHint ? `（${dataRootHint}）` : ''}下的 skills、agents 目录。
              </span>
            )}
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm text-text-secondary">Skill 读取路径</label>
          <textarea
            value={skillPathsText}
            onChange={event => setSkillPathsText(event.target.value)}
            rows={3}
            placeholder={'.polaris/skills\n.polaris/agents\n（留空或只填上方路径，会自动扫描数据存储路径下的 skills、agents）'}
            className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary resize-y"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-text-tertiary">
              支持 &lt;目录&gt;/&lt;name&gt;/SKILL.md 和目录内平铺的 *.md。
            </span>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => void loadSkills()}
                disabled={skillsLoading}
                className="px-3 py-1.5 text-xs border border-border rounded-lg text-text-secondary hover:text-text-primary hover:bg-background-hover disabled:opacity-50"
              >
                刷新
              </button>
              <button
                onClick={() => void handleSaveSkillPaths()}
                className="px-3 py-1.5 text-xs bg-primary text-white rounded-lg hover:bg-primary-hover"
              >
                保存路径
              </button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="border border-border-subtle rounded-lg overflow-hidden">
            <div className="px-3 py-2 text-xs font-medium text-text-secondary bg-background-hover">
              已发现 Skill（{skills.length}）
            </div>
            <div className="max-h-40 overflow-auto">
              {skills.length === 0 ? (
                <div className="px-3 py-3 text-xs text-text-tertiary">未发现 Skill，请检查路径后刷新。</div>
              ) : skills.map(skill => (
                <div key={`${skill.id}:${skill.filePath}`} className="px-3 py-2 border-t border-border-subtle">
                  <div className="font-mono text-xs text-text-primary">/{skill.id}</div>
                  <div className="text-xs text-text-tertiary truncate" title={skill.filePath}>{skill.filePath}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="border border-border-subtle rounded-lg overflow-hidden">
            <div className="px-3 py-2 text-xs font-medium text-text-secondary bg-background-hover">
              已启用 MCP（{mcpServers.length}）
            </div>
            <div className="max-h-40 overflow-auto">
              {mcpServers.length === 0 ? (
                <div className="px-3 py-3 text-xs text-text-tertiary">暂无已启用 MCP。</div>
              ) : mcpServers.map(server => (
                <div key={`${server.pluginId}:${server.id}`} className="px-3 py-2 border-t border-border-subtle">
                  <div className="font-mono text-xs text-text-primary">/{server.id}</div>
                  <div className="text-xs text-text-tertiary">{server.pluginName}</div>
                </div>
              ))}
            </div>
            <div className="px-3 py-2 border-t border-border-subtle text-xs text-text-tertiary">
              MCP 无文件路径，来自插件 Manifest；启用状态在插件管理中维护。
            </div>
          </div>
        </div>
      </div> */}

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
              <div key={idx} className="flex flex-col sm:flex-row sm:items-start gap-2 p-2 bg-surface border border-border-subtle rounded-lg">
                {/* 变量名 */}
                <div className="sm:w-28 sm:shrink-0">
                  <input
                    type="text"
                    value={v.key}
                    onChange={e => updateVariable(idx, 'key', e.target.value)}
                    placeholder={t('variables.keyPlaceholder')}
                    className="w-full bg-background-surface border border-border rounded px-2 py-1 text-xs font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary"
                  />
                </div>
                {/* 标签 */}
                <div className="sm:w-28 sm:shrink-0">
                  <input
                    type="text"
                    value={v.label}
                    onChange={e => updateVariable(idx, 'label', e.target.value)}
                    placeholder={t('variables.labelPlaceholder')}
                    className="w-full bg-background-surface border border-border rounded px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary"
                  />
                </div>
                {/* 类型 + 必填 + 删除 */}
                <div className="flex items-center gap-2">
                  <select
                    value={v.type}
                    onChange={e => updateVariable(idx, 'type', e.target.value)}
                    className="bg-background-surface border border-border rounded px-2 py-1 text-xs text-text-primary focus:outline-none focus:border-primary"
                  >
                    <option value="text">{t('variables.typeText')}</option>
                    <option value="textarea">{t('variables.typeTextarea')}</option>
                  </select>
                  <label className="flex items-center gap-1 shrink-0 py-1">
                    <input
                      type="checkbox"
                      checked={v.required}
                      onChange={e => updateVariable(idx, 'required', e.target.checked)}
                      className="rounded border-border text-primary"
                    />
                    <span className="text-xs text-text-tertiary">{t('variables.required')}</span>
                  </label>
                  <button
                    onClick={() => removeVariable(idx)}
                    className="p-1 text-text-tertiary hover:text-danger transition-colors shrink-0"
                  >
                    <IconTrash size={12} />
                  </button>
                </div>
              </div>
            ))}

            {/* 自动变量说明 */}
            <div className="mt-2 p-2 bg-background-hover rounded-lg">
              <p className="text-xs text-text-tertiary mb-1">{t('variables.autoVars')}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
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
