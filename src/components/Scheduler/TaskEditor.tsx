/**
 * 任务编辑器组件
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ScheduledTask, CreateTaskParams, TriggerType, TaskMode, TaskCategory, ProtocolTemplate } from '../../types/scheduler';
import { TEMPLATE_VARIABLES, TASK_MODE_LABELS, TASK_CATEGORY_LABELS } from '../../types/scheduler';
import { TriggerConfig } from './TriggerConfig';
import { ProtocolTemplateSelector, TemplateParamsForm } from './ProtocolTemplateSelector';
import { useToastStore, useWorkspaceStore, useConfigStore, useSchedulerStore } from '../../stores';

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

export function TaskEditor({ task, onSave, onClose, title }: TaskEditorProps) {
  const { t } = useTranslation('scheduler');
  const toast = useToastStore();
  const { getCurrentWorkspace, workspaces } = useWorkspaceStore();
  const { config } = useConfigStore();
  const { templates, loadTemplates } = useSchedulerStore();

  // 默认工作目录
  const currentWorkspace = getCurrentWorkspace();
  const defaultWorkDir = currentWorkspace?.path || config?.workDir || '';

  // 基本字段
  const [name, setName] = useState(task?.name || '');
  const [description, setDescription] = useState(task?.description || '');
  const [prompt, setPrompt] = useState(task?.prompt || '');
  const [workDir, setWorkDir] = useState(task?.workDir || defaultWorkDir);

  // 任务模式与分类
  const [mode, setMode] = useState<TaskMode>(task?.mode || 'simple');
  const [category, setCategory] = useState<TaskCategory>(task?.category || 'custom');

  // 触发配置
  const [triggerType, setTriggerType] = useState<TriggerType>(task?.triggerType || 'interval');
  const [triggerValue, setTriggerValue] = useState(task?.triggerValue || '1h');

  // 引擎配置
  const [engineId, setEngineId] = useState(task?.engineId || 'claude-code');

  // 模板配置
  const [templateId, setTemplateId] = useState<string | null>(task?.templateId || null);

  // 协议模板配置
  const [protocolTemplateId, setProtocolTemplateId] = useState<string | null>(null);
  const [selectedProtocolTemplate, setSelectedProtocolTemplate] = useState<ProtocolTemplate | null>(null);
  const [templateParams, setTemplateParams] = useState<Record<string, string>>({});

  // 协议模式字段
  const [mission, setMission] = useState(task?.mission || '');
  const [group, setGroup] = useState(task?.group || '');

  // 执行控制
  const [maxRuns, setMaxRuns] = useState<number | undefined>(task?.maxRuns);
  const [maxRetries, setMaxRetries] = useState<number | undefined>(task?.maxRetries);
  const [retryInterval, setRetryInterval] = useState(task?.retryInterval || '');
  const [timeoutMinutes, setTimeoutMinutes] = useState<number | undefined>(task?.timeoutMinutes);

  // 加载模板
  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  // 加载协议模板
  const { loadProtocolTemplates } = useSchedulerStore();
  useEffect(() => {
    loadProtocolTemplates();
  }, [loadProtocolTemplates]);

  // 获取选中的模板
  const selectedTemplate = templates.find((t) => t.id === templateId);

  // 生成预览
  const getPreview = () => {
    if (!selectedTemplate) return null;
    const now = new Date();
    const previewPrompt = prompt || t('editor.promptPreviewPlaceholder');
    return selectedTemplate.content
      .replace(/\{\{prompt\}\}/g, previewPrompt)
      .replace(/\{\{taskName\}\}/g, name || t('editor.taskNamePlaceholder'))
      .replace(/\{\{date\}\}/g, now.toISOString().split('T')[0])
      .replace(/\{\{time\}\}/g, now.toTimeString().slice(0, 5))
      .replace(/\{\{datetime\}\}/g, `${now.toISOString().split('T')[0]} ${now.toTimeString().slice(0, 5)}`)
      .replace(/\{\{weekday\}\}/g, ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()]);
  };

  // 验证并保存
  const handleSave = () => {
    if (!name.trim()) {
      toast.warning(t('editor.nameRequired'));
      return;
    }

    // 协议模式下 mission 必填
    if (mode === 'protocol' && !mission.trim()) {
      toast.warning(t('editor.missionRequired'));
      return;
    }

    // 简单模式下 prompt 必填
    if (mode === 'simple' && !prompt.trim()) {
      toast.warning(t('editor.promptRequired'));
      return;
    }

    // 处理协议模板参数
    const finalTemplateId = mode === 'protocol' ? protocolTemplateId : templateId;
    const finalTemplateParams = mode === 'protocol' ? templateParams : undefined;

    onSave({
      name: name.trim(),
      description: description.trim() || undefined,
      prompt: prompt.trim(),
      triggerType,
      triggerValue,
      engineId,
      workDir: workDir.trim() || undefined,
      enabled: task?.enabled ?? true,
      // 任务模式
      mode,
      category,
      templateId: finalTemplateId || undefined,
      templateParams: finalTemplateParams,
      // 协议模式
      mission: mode === 'protocol' ? mission.trim() : undefined,
      // 执行控制
      maxRuns: maxRuns || undefined,
      maxRetries: maxRetries || undefined,
      retryInterval: retryInterval.trim() || undefined,
      timeoutMinutes: timeoutMinutes || undefined,
      // 其他
      group: group.trim() || undefined,
    });
  };

  // 基础引擎选择
  const handleEngineChange = (newEngineId: string) => {
    setEngineId(newEngineId);
  };

  // 启用的模板列表
  const enabledTemplates = templates.filter((t) => t.enabled);

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

          {/* 任务模式与分类 */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-text-secondary mb-1">
                {t('editor.mode')}
              </label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as TaskMode)}
                className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {Object.entries(TASK_MODE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-text-secondary mb-1">
                {t('editor.category')}
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as TaskCategory)}
                className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {Object.entries(TASK_CATEGORY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* 协议模式配置 */}
          {mode === 'protocol' && (
            <div className="space-y-4 p-4 bg-background-surface rounded-lg border border-border-subtle">
              <h4 className="text-sm font-medium text-text-primary">{t('editor.protocolConfig')}</h4>

              {/* 协议模板选择 */}
              <div>
                <label className="block text-sm text-text-secondary mb-1">
                  {t('editor.protocolTemplate')}
                </label>
                <ProtocolTemplateSelector
                  value={protocolTemplateId || undefined}
                  onChange={(id, template) => {
                    setProtocolTemplateId(id);
                    setSelectedProtocolTemplate(template);
                    // 重置参数值
                    if (template) {
                      const defaults: Record<string, string> = {};
                      template.params.forEach((p) => {
                        if (p.defaultValue) {
                          defaults[p.key] = p.defaultValue;
                        }
                      });
                      setTemplateParams(defaults);
                    } else {
                      setTemplateParams({});
                    }
                  }}
                  category={category}
                />
              </div>

              {/* 模板参数配置 */}
              {selectedProtocolTemplate && selectedProtocolTemplate.params.length > 0 && (
                <div>
                  <label className="block text-sm text-text-secondary mb-1">
                    {t('editor.templateParams')}
                  </label>
                  <TemplateParamsForm
                    params={selectedProtocolTemplate.params}
                    values={templateParams}
                    onChange={setTemplateParams}
                  />
                </div>
              )}

              {/* 任务目标 */}
              <div>
                <label className="block text-sm text-text-secondary mb-1">
                  {t('editor.mission')} <span className="text-danger">*</span>
                </label>
                <textarea
                  value={mission}
                  onChange={(e) => setMission(e.target.value)}
                  rows={2}
                  placeholder={t('editor.missionPlaceholder')}
                  className="w-full px-3 py-2 bg-background-base border border-border-subtle rounded-lg text-text-primary resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>

              {/* 分组 */}
              <div>
                <label className="block text-sm text-text-secondary mb-1">
                  {t('editor.group')}
                </label>
                <input
                  type="text"
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                  placeholder={t('editor.groupPlaceholder')}
                  className="w-full px-3 py-2 bg-background-base border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>

              {/* 执行控制 */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-text-secondary mb-1">
                    {t('editor.maxRuns')}
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={maxRuns ?? ''}
                    onChange={(e) => setMaxRuns(e.target.value ? parseInt(e.target.value, 10) : undefined)}
                    placeholder={t('editor.maxRunsPlaceholder')}
                    className="w-full px-3 py-2 bg-background-base border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                <div>
                  <label className="block text-sm text-text-secondary mb-1">
                    {t('editor.maxRetries')}
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={maxRetries ?? ''}
                    onChange={(e) => setMaxRetries(e.target.value ? parseInt(e.target.value, 10) : undefined)}
                    placeholder={t('editor.maxRetriesPlaceholder')}
                    className="w-full px-3 py-2 bg-background-base border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-text-secondary mb-1">
                    {t('editor.retryInterval')}
                  </label>
                  <input
                    type="text"
                    value={retryInterval}
                    onChange={(e) => setRetryInterval(e.target.value)}
                    placeholder={t('editor.retryIntervalPlaceholder')}
                    className="w-full px-3 py-2 bg-background-base border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                <div>
                  <label className="block text-sm text-text-secondary mb-1">
                    {t('editor.timeoutMinutes')}
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={timeoutMinutes ?? ''}
                    onChange={(e) => setTimeoutMinutes(e.target.value ? parseInt(e.target.value, 10) : undefined)}
                    placeholder={t('editor.timeoutMinutesPlaceholder')}
                    className="w-full px-3 py-2 bg-background-base border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
              </div>
            </div>
          )}

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
            <select
              value={engineId}
              onChange={(e) => handleEngineChange(e.target.value)}
              className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="claude-code">Claude Code</option>
            </select>
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

          {/* 提示词模板 */}
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              {t('editor.promptTemplate')}
            </label>
            <select
              value={templateId || ''}
              onChange={(e) => setTemplateId(e.target.value || null)}
              className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="">{t('editor.noTemplate')}</option>
              {enabledTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            {selectedTemplate && (
              <div className="mt-2 text-xs text-text-muted">
                {selectedTemplate.description && (
                  <p className="mb-1">{selectedTemplate.description}</p>
                )}
                <p>{t('editor.templateVariables')}: {TEMPLATE_VARIABLES.map((v) => v.key).join(', ')}</p>
              </div>
            )}
          </div>

          {/* 提示词 */}
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              {mode === 'simple' ? (
                <>
                  {t('editor.prompt')} <span className="text-danger">*</span>
                </>
              ) : (
                t('editor.prompt')
              )}
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              placeholder={mode === 'protocol' ? t('editor.promptPlaceholderProtocol') : t('editor.promptPlaceholder')}
              className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            {mode === 'protocol' && (
              <p className="mt-1 text-xs text-text-muted">{t('editor.promptHintProtocol')}</p>
            )}
          </div>

          {/* 模板预览 */}
          {selectedTemplate && (
            <div>
              <label className="block text-sm text-text-secondary mb-1">
                {t('editor.templatePreview')}
              </label>
              <div className="p-3 bg-background-surface border border-border-subtle rounded-lg text-sm text-text-secondary whitespace-pre-wrap font-mono max-h-40 overflow-y-auto">
                {getPreview()}
              </div>
            </div>
          )}
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
