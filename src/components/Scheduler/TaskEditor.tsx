/**
 * 任务编辑器（精简版）
 */

import { useEffect, useState } from 'react';
import { useToastStore, useWorkspaceStore, useConfigStore } from '../../stores';
import { useTemplateStore } from '../../stores/templateStore';
import type { ScheduledTask, TriggerType, CreateTaskParams, DocumentConfig } from '../../types/scheduler';
import { TriggerTypeLabels, IntervalUnitLabels, parseIntervalValue } from '../../types/scheduler';

/** 解析引擎ID，返回基础引擎和可能的 provider ID */
function parseEngineId(engineId: string): { baseEngine: string; providerId?: string } {
  if (engineId.startsWith('provider-')) {
    return { baseEngine: 'openai', providerId: engineId.replace('provider-', '') };
  }
  return { baseEngine: engineId };
}

/** 预设时间选项 */
interface TimePreset {
  label: string;
  value: string;
}

const INTERVAL_PRESETS: TimePreset[] = [
  { label: '每 5 分钟', value: '5m' },
  { label: '每 15 分钟', value: '15m' },
  { label: '每 30 分钟', value: '30m' },
  { label: '每 1 小时', value: '1h' },
  { label: '每 2 小时', value: '2h' },
  { label: '每 6 小时', value: '6h' },
  { label: '每 12 小时', value: '12h' },
  { label: '每天', value: '1d' },
];

/** 每日多个时间点的快速选项 */
const DAILY_TIME_PRESETS = [
  { label: '早中晚 (8:00, 12:00, 18:00)', hours: [8, 12, 18] },
  { label: '工作时间 (9:00, 14:00, 18:00)', hours: [9, 14, 18] },
  { label: '早晚 (8:00, 20:00)', hours: [8, 20] },
];

/** 每小时指定分钟选项 */
const HOURLY_MINUTE_PRESETS = [
  { label: '整点 (00分)', minute: 0 },
  { label: '15分', minute: 15 },
  { label: '30分', minute: 30 },
  { label: '45分', minute: 45 },
];

export interface TaskEditorProps {
  task?: ScheduledTask;
  onSave: (params: CreateTaskParams) => void;
  onClose: () => void;
  /** 自定义标题 */
  title?: string;
}

export function TaskEditor({
  task,
  onSave,
  onClose,
  title,
}: TaskEditorProps) {
  const toast = useToastStore();
  const { getCurrentWorkspace, workspaces } = useWorkspaceStore();
  const { config } = useConfigStore();

  // 获取 OpenAI Providers 列表
  const openaiProviders = config?.openaiProviders || [];

  // 获取当前工作区路径作为默认工作目录
  const currentWorkspace = getCurrentWorkspace();
  const defaultWorkDir = currentWorkspace?.path || config?.workDir || '';

  // 基础字段
  const [name, setName] = useState(task?.name || '');
  const [triggerType, setTriggerType] = useState<TriggerType>(task?.triggerType || 'interval');
  const [triggerValue, setTriggerValue] = useState(task?.triggerValue || '1h');
  const [engineId, setEngineId] = useState(task?.engineId || 'claude');
  const [prompt, setPrompt] = useState(task?.prompt || '');
  const [workDir, setWorkDir] = useState(task?.workDir || defaultWorkDir);
  const [description, setDescription] = useState(task?.description || '');

  // 间隔时间选择
  const [intervalNum, setIntervalNum] = useState(1);
  const [intervalUnit, setIntervalUnit] = useState<'s' | 'm' | 'h' | 'd'>('h');

  // 高级时间设置
  const [showAdvancedTime, setShowAdvancedTime] = useState(false);
  const [, setDailyHours] = useState<number[]>([]);
  const [, setHourlyMinute] = useState<number>(0);

  // 文档配置
  const [documentEnabled, setDocumentEnabled] = useState(task?.documentConfig?.enabled ?? false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | undefined>(task?.documentConfig?.templateId);
  const [customVariables] = useState<Record<string, string>>(task?.documentConfig?.customVariables ?? {});

  // 模板 store
  const { templates, loadTemplates } = useTemplateStore();

  // 加载模板列表
  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  // 初始化间隔值
  useEffect(() => {
    if (triggerType === 'interval') {
      const parsed = parseIntervalValue(triggerValue);
      if (parsed) {
        setIntervalNum(parsed.num);
        setIntervalUnit(parsed.unit);
      }
    }
  }, [triggerType, triggerValue]);

  // 处理间隔时间变化
  const handleIntervalChange = (num: number, unit: 's' | 'm' | 'h' | 'd') => {
    setIntervalNum(num);
    setIntervalUnit(unit);
    setTriggerValue(`${num}${unit}`);
  };

  // 生成每日多个时间点的 cron 表达式
  const generateDailyCron = (hours: number[]): string => {
    const hoursStr = hours.sort((a, b) => a - b).join(',');
    return `0 ${hoursStr} * * *`;
  };

  // 生成每小时指定分钟的 cron 表达式
  const generateHourlyCron = (minute: number): string => {
    return `${minute} * * * *`;
  };

  // 应用每日时间预设
  const applyDailyPreset = (hours: number[]) => {
    setDailyHours(hours);
    setTriggerType('cron');
    setTriggerValue(generateDailyCron(hours));
    setShowAdvancedTime(false);
  };

  // 应用每小时分钟预设
  const applyHourlyPreset = (minute: number) => {
    setHourlyMinute(minute);
    setTriggerType('cron');
    setTriggerValue(generateHourlyCron(minute));
    setShowAdvancedTime(false);
  };

  // 保存任务
  const handleSave = () => {
    if (!name.trim()) {
      toast.warning('请填写任务名称');
      return;
    }

    if (!prompt.trim()) {
      toast.warning('请填写提示词');
      return;
    }

    // 构建文档配置
    const documentConfig: DocumentConfig | undefined = documentEnabled
      ? {
          enabled: true,
          templateId: selectedTemplateId,
          primaryDocument: 'task',
          customVariables,
        }
      : undefined;

    onSave({
      name,
      triggerType,
      triggerValue,
      engineId,
      prompt,
      workDir: workDir || undefined,
      description: description || undefined,
      enabled: task?.enabled ?? true,
      documentConfig,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background-elevated rounded-xl w-[650px] max-h-[85vh] overflow-y-auto border border-border-subtle shadow-soft">
        {/* 头部 */}
        <div className="p-4 border-b border-border-subtle flex items-center justify-between sticky top-0 bg-background-elevated">
          <h2 className="text-lg font-medium text-text-primary">
            {title || (task ? '编辑任务' : '新建任务')}
          </h2>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary text-xl transition-colors">
            ✕
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* 任务名称 */}
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              任务名称 <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
              placeholder="例如：每日日报生成"
            />
          </div>

          {/* 任务描述 */}
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              描述 <span className="text-text-muted">(可选)</span>
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
              placeholder="任务描述..."
            />
          </div>

          {/* 提示词 */}
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              提示词 <span className="text-danger">*</span>
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
              placeholder="输入 AI 要执行的提示词..."
            />
          </div>

          {/* 触发类型 */}
          <div>
            <label className="block text-sm text-text-secondary mb-1">触发方式</label>
            <div className="space-y-2">
              {/* 触发类型选择 */}
              <div className="flex gap-2">
                <select
                  value={triggerType}
                  onChange={(e) => setTriggerType(e.target.value as TriggerType)}
                  className="px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                >
                  {Object.entries(TriggerTypeLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>

                {/* 间隔执行 */}
                {triggerType === 'interval' ? (
                  <div className="flex gap-2 flex-1">
                    <input
                      type="number"
                      value={intervalNum}
                      onChange={(e) => handleIntervalChange(parseInt(e.target.value) || 1, intervalUnit)}
                      min={1}
                      className="w-24 px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                    <select
                      value={intervalUnit}
                      onChange={(e) => handleIntervalChange(intervalNum, e.target.value as 's' | 'm' | 'h' | 'd')}
                      className="px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                    >
                      {Object.entries(IntervalUnitLabels).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : triggerType === 'cron' ? (
                  <input
                    type="text"
                    value={triggerValue}
                    onChange={(e) => setTriggerValue(e.target.value)}
                    className="flex-1 px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono"
                    placeholder="0 9 * * 1-5"
                  />
                ) : (
                  <input
                    type="datetime-local"
                    value={triggerValue}
                    onChange={(e) => setTriggerValue(e.target.value)}
                    className="flex-1 px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                )}
              </div>

              {/* 间隔预设快捷选择 */}
              {triggerType === 'interval' && (
                <div className="flex flex-wrap gap-1">
                  {INTERVAL_PRESETS.map((preset) => (
                    <button
                      key={preset.value}
                      onClick={() => {
                        const parsed = parseIntervalValue(preset.value);
                        if (parsed) {
                          setIntervalNum(parsed.num);
                          setIntervalUnit(parsed.unit);
                          setTriggerValue(preset.value);
                        }
                      }}
                      className={`px-2 py-1 text-xs rounded-lg transition-colors ${
                        triggerValue === preset.value
                          ? 'bg-primary text-white'
                          : 'bg-background-hover text-text-secondary hover:bg-background-active'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              )}

              {/* Cron 高级时间选择 */}
              {triggerType === 'cron' && (
                <div className="space-y-2">
                  <button
                    onClick={() => setShowAdvancedTime(!showAdvancedTime)}
                    className="text-xs text-primary hover:text-primary-hover transition-colors"
                  >
                    {showAdvancedTime ? '隐藏高级选项' : '显示高级时间选项'}
                  </button>

                  {showAdvancedTime && (
                    <div className="p-3 bg-background-surface rounded-lg border border-border-subtle space-y-3">
                      {/* 每日多个时间点 */}
                      <div>
                        <p className="text-xs text-text-secondary mb-2">每日多个时间点:</p>
                        <div className="flex flex-wrap gap-1">
                          {DAILY_TIME_PRESETS.map((preset) => (
                            <button
                              key={preset.label}
                              onClick={() => applyDailyPreset(preset.hours)}
                              className="px-2 py-1 text-xs bg-background-hover text-text-secondary hover:bg-background-active rounded-lg transition-colors"
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* 每小时指定分钟 */}
                      <div>
                        <p className="text-xs text-text-secondary mb-2">每小时指定分钟:</p>
                        <div className="flex flex-wrap gap-1">
                          {HOURLY_MINUTE_PRESETS.map((preset) => (
                            <button
                              key={preset.label}
                              onClick={() => applyHourlyPreset(preset.minute)}
                              className="px-2 py-1 text-xs bg-background-hover text-text-secondary hover:bg-background-active rounded-lg transition-colors"
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* 当前表达式说明 */}
                      <div className="text-xs text-text-muted">
                        当前表达式: <code className="text-primary">{triggerValue}</code>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Cron 表达式说明 */}
              {triggerType === 'cron' && !showAdvancedTime && (
                <p className="text-xs text-text-muted">
                  示例: "0 9 * * 1-5" 表示工作日早9点，格式为：分 时 日 月 周
                </p>
              )}
            </div>
          </div>

          {/* AI 引擎 */}
          <div>
            <label className="block text-sm text-text-secondary mb-1">AI 引擎</label>
            <div className="space-y-2">
              {/* 检测失效的 Provider */}
              {(() => {
                const { baseEngine, providerId } = parseEngineId(engineId);
                if (baseEngine === 'openai' && providerId) {
                  const providerExists = openaiProviders.some(p => p.id === providerId && p.enabled);
                  if (!providerExists) {
                    return (
                      <div className="p-2 bg-warning-faint border border-warning/30 rounded-lg text-xs text-warning mb-2">
                        ⚠️ 当前任务的 Provider 已失效或被禁用，请重新选择引擎
                      </div>
                    );
                  }
                }
                return null;
              })()}
              <select
                value={parseEngineId(engineId).baseEngine}
                onChange={(e) => {
                  const baseEngine = e.target.value;
                  if (baseEngine === 'openai') {
                    const enabledProviders = openaiProviders.filter(p => p.enabled);
                    if (enabledProviders.length > 0) {
                      setEngineId(`provider-${enabledProviders[0].id}`);
                    }
                  } else {
                    setEngineId(baseEngine);
                  }
                }}
                className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                <option value="claude">Claude Code</option>
                <option value="iflow">IFlow</option>
                <option value="codex">Codex</option>
                <option value="openai" disabled={openaiProviders.filter(p => p.enabled).length === 0}>
                  OpenAI Provider {openaiProviders.filter(p => p.enabled).length === 0 ? '(未配置)' : ''}
                </option>
              </select>

              {/* OpenAI Provider 二级选择 */}
              {parseEngineId(engineId).baseEngine === 'openai' && (
                <div className="pl-2 border-l-2 border-border-subtle">
                  <label className="block text-xs text-text-muted mb-1">选择 Provider</label>
                  {openaiProviders.filter(p => p.enabled).length > 0 ? (
                    <>
                      <select
                        value={parseEngineId(engineId).providerId || ''}
                        onChange={(e) => setEngineId(`provider-${e.target.value}`)}
                        className="w-full px-3 py-2 bg-background-base border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
                      >
                        {openaiProviders.filter(p => p.enabled).map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.name} ({provider.model})
                          </option>
                        ))}
                      </select>
                      {(() => {
                        const selectedProvider = openaiProviders.find(
                          p => p.id === parseEngineId(engineId).providerId
                        );
                        if (selectedProvider) {
                          return (
                            <div className="mt-2 p-2 bg-background-base rounded-lg text-xs text-text-secondary space-y-1">
                              <div>模型: <span className="text-primary">{selectedProvider.model}</span></div>
                              <div>API: <span className="text-text-muted truncate">{selectedProvider.apiBase}</span></div>
                              {selectedProvider.supportsTools && (
                                <span className="inline-block px-1 py-0.5 bg-success-faint text-success rounded text-xs">
                                  支持工具调用
                                </span>
                              )}
                            </div>
                          );
                        }
                        return null;
                      })()}
                    </>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-xs text-warning">
                        未配置 OpenAI Provider
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          window.dispatchEvent(new CustomEvent('navigate-to-settings', {
                            detail: { tab: 'openai-providers' }
                          }));
                          onClose();
                        }}
                        className="px-3 py-1.5 text-xs bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors"
                      >
                        去配置 →
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
              工作目录 <span className="text-text-muted">(可选)</span>
            </label>
            <div className="space-y-2">
              {/* 工作区快捷选择 */}
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
              {/* 手动输入 */}
              <input
                type="text"
                value={workDir}
                onChange={(e) => setWorkDir(e.target.value)}
                className="w-full px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="留空使用默认目录"
              />
            </div>
          </div>

          {/* 文档配置 */}
          <div className="border-t border-border-subtle pt-4">
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-text-secondary">
                文档模式
              </label>
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
                  <label className="block text-xs text-text-muted mb-1">选择模板</label>
                  <select
                    value={selectedTemplateId || ''}
                    onChange={(e) => setSelectedTemplateId(e.target.value || undefined)}
                    className="w-full px-3 py-2 bg-background-base border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  >
                    <option value="">不使用模板</option>
                    <optgroup label="内置模板">
                      {templates.filter(t => t.builtin).map(t => (
                        <option key={t.id} value={t.id}>
                          {t.icon ? `${t.icon} ` : ''}{t.name}
                        </option>
                      ))}
                    </optgroup>
                    {templates.some(t => !t.builtin) && (
                      <optgroup label="自定义模板">
                        {templates.filter(t => !t.builtin).map(t => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>

                {/* 模板详情 */}
                {selectedTemplateId && (
                  <div className="text-xs text-text-muted">
                    {(() => {
                      const tpl = templates.find(t => t.id === selectedTemplateId);
                      if (!tpl) return null;
                      return (
                        <div className="space-y-1">
                          {tpl.description && <p>{tpl.description}</p>}
                          <p>文档: {tpl.documents.map(d => d.filename).join(', ')}</p>
                          {tpl.variables.length > 0 && (
                            <p>变量: {tpl.variables.map(v => `{{${v.name}}}`).join(' ')}</p>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}

                <p className="text-xs text-text-muted">
                  启用文档模式后，AI 将在多次执行中保持上下文记忆。
                </p>
              </div>
            )}
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="p-4 border-t border-border-subtle flex justify-end gap-2 sticky bottom-0 bg-background-elevated">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-background-hover text-text-secondary hover:bg-background-active rounded-lg transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

export default TaskEditor;
