/**
 * 任务编辑器组件
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ScheduledTask, CreateTaskParams, TriggerType, DocumentConfig } from '../../types/scheduler';
import { TriggerConfig } from './TriggerConfig';
import { useToastStore, useWorkspaceStore, useConfigStore } from '../../stores';
import { useTemplateStore } from '../../stores/templateStore';

export interface TaskEditorProps {
  /** 编辑的任务（可选，不传则为新建） */
  task?: ScheduledTask;
  /** 保存回调 */
  onSave: (params: CreateTaskParams) => void;
  /** 关闭回调 */
  onClose: () => void;
  /** 弹窗标题 */
  title?: string;
}

/** 解析引擎 ID */
function parseEngineId(engineId: string): { baseEngine: string; providerId?: string } {
  if (engineId.startsWith('provider-')) {
    return { baseEngine: 'openai', providerId: engineId.replace('provider-', '') };
  }
  return { baseEngine: engineId };
}

export function TaskEditor({ task, onSave, onClose, title }: TaskEditorProps) {
  const { t } = useTranslation('scheduler');
  const toast = useToastStore();
  const { getCurrentWorkspace, workspaces } = useWorkspaceStore();
  const { config } = useConfigStore();
  const { templates, loadTemplates } = useTemplateStore();

  // OpenAI Providers
  const openaiProviders = config?.openaiProviders || [];

  // 默认工作目录
  const currentWorkspace = getCurrentWorkspace();
  const defaultWorkDir = currentWorkspace?.path || config?.workDir || '';

  // 基本字段
  const [name, setName] = useState(task?.name || '');
  const [description, setDescription] = useState(task?.description || '');
  const [prompt, setPrompt] = useState(task?.prompt || '');
  const [workDir, setWorkDir] = useState(task?.workDir || defaultWorkDir);

  // 触发配置
  const [triggerType, setTriggerType] = useState<TriggerType>(task?.triggerType || 'interval');
  const [triggerValue, setTriggerValue] = useState(task?.triggerValue || '1h');

  // 引擎配置
  const [engineId, setEngineId] = useState(task?.engineId || 'claude-code');

  // 文档配置
  const [documentEnabled, setDocumentEnabled] = useState(task?.documentConfig?.enabled ?? false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | undefined>(
    task?.documentConfig?.templateId
  );

  // 加载模板
  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  // 验证并保存
  const handleSave = () => {
    if (!name.trim()) {
      toast.warning(t('editor.nameRequired'));
      return;
    }

    if (!prompt.trim()) {
      toast.warning(t('editor.promptRequired'));
      return;
    }

    // 构建文档配置
    const documentConfig: DocumentConfig | undefined = documentEnabled
      ? {
          enabled: true,
          templateId: selectedTemplateId,
          primaryDocument: 'task',
          customVariables: {},
        }
      : undefined;

    onSave({
      name: name.trim(),
      description: description.trim() || undefined,
      prompt: prompt.trim(),
      triggerType,
      triggerValue,
      engineId,
      workDir: workDir.trim() || undefined,
      enabled: task?.enabled ?? true,
      documentConfig,
    });
  };

  // 基础引擎选择
  const { baseEngine, providerId } = parseEngineId(engineId);

  const handleBaseEngineChange = (newBaseEngine: string) => {
    if (newBaseEngine === 'openai') {
      const enabledProviders = openaiProviders.filter((p) => p.enabled);
      if (enabledProviders.length > 0) {
        setEngineId(`provider-${enabledProviders[0].id}`);
      }
    } else {
      setEngineId(newBaseEngine);
    }
  };

  const handleProviderChange = (newProviderId: string) => {
    setEngineId(`provider-${newProviderId}`);
  };

  // 检测失效的 Provider
  const selectedProvider = openaiProviders.find((p) => p.id === providerId);
  const providerInvalid = baseEngine === 'openai' && providerId && (!selectedProvider || !selectedProvider.enabled);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background-elevated rounded-xl w-[650px] max-h-[85vh] overflow-hidden border border-border-subtle shadow-2xl flex flex-col">
        {/* 头部 */}
        <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">
            {title || (task ? t('editor.editTask') : t('editor.newTask'))}
          </h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary transition-colors"
          >
            ✕
          </button>
        </div>

        {/* 表单内容 */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* 任务名称 */}
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              {t('editor.name')} <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('editor.namePlaceholder')}
              className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          {/* 任务描述 */}
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              {t('editor.description')}
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('editor.descriptionPlaceholder')}
              className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          {/* 触发配置 */}
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              {t('editor.trigger')}
            </label>
            <TriggerConfig
              triggerType={triggerType}
              triggerValue={triggerValue}
              onTypeChange={setTriggerType}
              onValueChange={setTriggerValue}
            />
          </div>

          {/* AI 引擎 */}
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              {t('editor.engine')}
            </label>
            <div className="space-y-2">
              {/* Provider 失效警告 */}
              {providerInvalid && (
                <div className="p-2 bg-warning-faint border border-warning/30 rounded-lg text-xs text-warning">
                  {t('editor.providerInvalid')}
                </div>
              )}

              <select
                value={baseEngine}
                onChange={(e) => handleBaseEngineChange(e.target.value)}
                className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                <option value="claude-code">Claude Code</option>
                <option value="iflow">IFlow</option>
                <option value="codex">Codex</option>
                <option value="openai" disabled={openaiProviders.filter((p) => p.enabled).length === 0}>
                  OpenAI Provider {openaiProviders.filter((p) => p.enabled).length === 0 ? `(${t('editor.noProvider')})` : ''}
                </option>
              </select>

              {/* OpenAI Provider 二级选择 */}
              {baseEngine === 'openai' && (
                <div className="pl-3 border-l-2 border-border-subtle">
                  <label className="block text-xs text-text-muted mb-1">
                    {t('editor.selectProvider')}
                  </label>
                  {openaiProviders.filter((p) => p.enabled).length > 0 ? (
                    <>
                      <select
                        value={providerId || ''}
                        onChange={(e) => handleProviderChange(e.target.value)}
                        className="w-full px-3 py-2 bg-background-base border border-border-subtle rounded-lg text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                      >
                        {openaiProviders
                          .filter((p) => p.enabled)
                          .map((provider) => (
                            <option key={provider.id} value={provider.id}>
                              {provider.name} ({provider.model})
                            </option>
                          ))}
                      </select>
                      {selectedProvider && (
                        <div className="mt-2 p-2 bg-background-base rounded-lg text-xs text-text-secondary space-y-1">
                          <div>
                            {t('editor.model')}: <span className="text-primary">{selectedProvider.model}</span>
                          </div>
                          <div>
                            API: <span className="text-text-muted">{selectedProvider.apiBase}</span>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-xs text-warning">{t('editor.noProviderConfigured')}</p>
                      <button
                        type="button"
                        onClick={() => {
                          window.dispatchEvent(
                            new CustomEvent('navigate-to-settings', {
                              detail: { tab: 'openai-providers' },
                            })
                          );
                          onClose();
                        }}
                        className="px-3 py-1.5 text-xs bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors"
                      >
                        {t('editor.goConfig')} →
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* 工作目录 */}
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              {t('editor.workDir')}
            </label>
            <div className="space-y-2">
              {workspaces.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {workspaces.map((ws) => (
                    <button
                      key={ws.id}
                      type="button"
                      onClick={() => setWorkDir(ws.path)}
                      className={`px-2 py-1 text-xs rounded-lg transition-colors ${
                        workDir === ws.path
                          ? 'bg-primary text-white'
                          : 'bg-background-hover text-text-secondary hover:bg-background-active'
                      }`}
                    >
                      {ws.name}
                    </button>
                  ))}
                </div>
              )}
              <input
                type="text"
                value={workDir}
                onChange={(e) => setWorkDir(e.target.value)}
                placeholder={t('editor.workDirPlaceholder')}
                className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
          </div>

          {/* 提示词 */}
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              {t('editor.prompt')} <span className="text-danger">*</span>
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              placeholder={t('editor.promptPlaceholder')}
              className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          {/* 文档配置 */}
          <div className="border-t border-border-subtle pt-4">
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-text-secondary">{t('editor.documentMode')}</label>
              <button
                type="button"
                onClick={() => setDocumentEnabled(!documentEnabled)}
                className={`relative w-10 h-5 rounded-full transition-colors ${
                  documentEnabled ? 'bg-primary' : 'bg-background-hover'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    documentEnabled ? 'translate-x-5' : ''
                  }`}
                />
              </button>
            </div>

            {documentEnabled && (
              <div className="space-y-3 p-3 bg-background-surface rounded-lg border border-border-subtle">
                <div>
                  <label className="block text-xs text-text-muted mb-1">
                    {t('editor.selectTemplate')}
                  </label>
                  <select
                    value={selectedTemplateId || ''}
                    onChange={(e) => setSelectedTemplateId(e.target.value || undefined)}
                    className="w-full px-3 py-2 bg-background-base border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  >
                    <option value="">{t('editor.noTemplate')}</option>
                    <optgroup label={t('editor.builtinTemplates')}>
                      {templates
                        .filter((t) => t.builtin)
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.icon ? `${t.icon} ` : ''}
                            {t.name}
                          </option>
                        ))}
                    </optgroup>
                    {templates.some((t) => !t.builtin) && (
                      <optgroup label={t('editor.customTemplates')}>
                        {templates
                          .filter((t) => !t.builtin)
                          .map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                      </optgroup>
                    )}
                  </select>
                </div>
                <p className="text-xs text-text-muted">{t('editor.documentModeHelp')}</p>
              </div>
            )}
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="px-5 py-4 border-t border-border-subtle flex justify-end gap-2">
          <button
            onClick={onClose}
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
  );
}
