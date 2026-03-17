/**
 * 任务编辑器 - 统一组件
 *
 * 用于 SchedulerPanel 和 SchedulerTab 的共享任务编辑器
 */

import { useEffect, useState } from 'react';
import { useToastStore, useWorkspaceStore, useConfigStore } from '../../stores';
import { useProtocolTemplateStore } from '../../stores/protocolTemplateStore';
import type { ScheduledTask, TriggerType, CreateTaskParams, TaskMode } from '../../types/scheduler';
import { TriggerTypeLabels, IntervalUnitLabels, TaskModeLabels, parseIntervalValue } from '../../types/scheduler';
import { ProtocolTemplateCategoryLabels, renderFullTemplate } from '../../types/protocolTemplate';
import type { ProtocolTemplate, TemplateParam } from '../../types/protocolTemplate';
import * as tauri from '../../services/tauri';

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

/** 协议模板选择器组件 */
function ProtocolTemplateSelector({
  onTemplateSelect,
  disabled,
}: {
  onTemplateSelect: (template: ProtocolTemplate) => void;
  disabled?: boolean;
}) {
  const { getAllTemplates } = useProtocolTemplateStore();
  const templates = getAllTemplates();
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [showTemplates, setShowTemplates] = useState(false);

  const filteredTemplates = selectedCategory === 'all'
    ? templates
    : templates.filter((t) => t.category === selectedCategory);

  const categories = ['all', 'development', 'optimization', 'fix', 'custom'];

  if (disabled) {
    return null;
  }

  return (
    <div className="bg-[#1a1a2e] rounded-lg border border-[#2a2a4a] overflow-hidden">
      <button
        onClick={() => setShowTemplates(!showTemplates)}
        className="w-full px-3 py-2 flex items-center justify-between text-sm text-gray-300 hover:text-white transition-colors"
      >
        <span>选择模板快速创建</span>
        <span className={`transform transition-transform ${showTemplates ? 'rotate-180' : ''}`}>▼</span>
      </button>

      {showTemplates && (
        <div className="border-t border-[#2a2a4a]">
          {/* 类别筛选 */}
          <div className="flex flex-wrap gap-1 p-2 bg-[#12122a]">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  selectedCategory === cat
                    ? 'bg-blue-600 text-white'
                    : 'bg-[#2a2a4a] text-gray-400 hover:bg-[#3a3a5a]'
                }`}
              >
                {cat === 'all' ? '全部' : ProtocolTemplateCategoryLabels[cat as keyof typeof ProtocolTemplateCategoryLabels]}
              </button>
            ))}
          </div>

          {/* 模板列表 */}
          <div className="max-h-48 overflow-y-auto">
            {filteredTemplates.map((template) => (
              <button
                key={template.id}
                onClick={() => {
                  onTemplateSelect(template);
                  setShowTemplates(false);
                }}
                className="w-full px-3 py-2 text-left hover:bg-[#2a2a4a] transition-colors border-b border-[#2a2a4a] last:border-b-0"
              >
                <div className="flex items-center gap-2">
                  <span className="text-white text-sm">{template.name}</span>
                  {template.builtin ? (
                    <span className="text-xs px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded">内置</span>
                  ) : (
                    <span className="text-xs px-1.5 py-0.5 bg-green-500/20 text-green-400 rounded">自定义</span>
                  )}
                  {template.fullTemplate && (
                    <span className="text-xs px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded">完整模板</span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-0.5 truncate">{template.description}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 模板参数输入组件 */
function TemplateParamInput({
  param,
  value,
  onChange,
  disabled,
}: {
  param: TemplateParam;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const label = (
    <label className="block text-sm text-gray-400 mb-1">
      {param.label}
      {param.required && <span className="text-red-400 ml-1">*</span>}
    </label>
  );

  if (param.type === 'textarea') {
    return (
      <div>
        {label}
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          disabled={disabled}
          placeholder={param.placeholder}
          className="w-full px-3 py-2 bg-[#12122a] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500 resize-none font-mono text-sm disabled:opacity-50"
        />
      </div>
    );
  }

  if (param.type === 'select' && param.options) {
    return (
      <div>
        {label}
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="w-full px-3 py-2 bg-[#12122a] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
        >
          <option value="">请选择...</option>
          {param.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  // 默认 text 类型
  return (
    <div>
      {label}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={param.placeholder}
        className="w-full px-3 py-2 bg-[#12122a] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
      />
    </div>
  );
}

export interface TaskEditorProps {
  task?: ScheduledTask;
  onSave: (params: CreateTaskParams) => void;
  onClose: () => void;
  /** 是否显示完整模式（包含协议模式等高级选项） */
  fullMode?: boolean;
  /** 自定义标题 */
  title?: string;
}

export function TaskEditor({
  task,
  onSave,
  onClose,
  fullMode = true,
  title,
}: TaskEditorProps) {
  const toast = useToastStore();
  const { getCurrentWorkspace, workspaces } = useWorkspaceStore();
  const { config } = useConfigStore();
  
  // 获取 OpenAI Providers 列表
  const openaiProviders = config?.openaiProviders || [];

  // 获取当前工作区路径作为默认工作目录，备选使用配置中的工作目录
  const currentWorkspace = getCurrentWorkspace();
  const defaultWorkDir = currentWorkspace?.path || config?.workDir || '';

  // 基础字段
  const [name, setName] = useState(task?.name || '');
  const [mode, setMode] = useState<TaskMode>(task?.mode || 'simple');
  const [triggerType, setTriggerType] = useState<TriggerType>(task?.triggerType || 'interval');
  const [triggerValue, setTriggerValue] = useState(task?.triggerValue || '1h');
  const [engineId, setEngineId] = useState(task?.engineId || 'claude');
  const [prompt, setPrompt] = useState(task?.prompt || '');
  // 新建任务时自动填充当前工作区路径，编辑任务保持原值
  const [workDir, setWorkDir] = useState(task?.workDir || defaultWorkDir);
  // 分组字段（可选）
  const [group, setGroup] = useState(task?.group || '');

  // 协议模式字段
  const [mission, setMission] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<ProtocolTemplate | null>(null);
  const [templateParamValues, setTemplateParamValues] = useState<Record<string, string>>({});

  // 执行轮次
  const [maxRuns, setMaxRuns] = useState<number | undefined>(task?.maxRuns);
  const [currentRuns] = useState<number>(task?.currentRuns || 0);

  // 重试配置
  const [maxRetries, setMaxRetries] = useState<number | undefined>(task?.maxRetries);
  const [retryIntervalNum, setRetryIntervalNum] = useState<number>(() => {
    if (task?.retryInterval) {
      const match = task.retryInterval.match(/^(\d+)/);
      return match ? parseInt(match[1], 10) : 5;
    }
    return 5;
  });
  const [retryIntervalUnit, setRetryIntervalUnit] = useState<'s' | 'm' | 'h'>(() => {
    if (task?.retryInterval) {
      const match = task.retryInterval.match(/[smhd]$/);
      return (match?.[0] as 's' | 'm' | 'h') || 'm';
    }
    return 'm';
  });
  const [showRetryConfig, setShowRetryConfig] = useState(!!task?.maxRetries);

  // 任务完成通知
  const [notifyOnComplete, setNotifyOnComplete] = useState<boolean>(task?.notifyOnComplete ?? true);

  // 用户补充内容（一次性提示词）
  const [userSupplement, setUserSupplement] = useState<string>(task?.userSupplement || '');

  // 执行超时配置
  const [timeoutMinutes, setTimeoutMinutes] = useState<number | undefined>(task?.timeoutMinutes);
  const [showTimeoutConfig, setShowTimeoutConfig] = useState(!!task?.timeoutMinutes);

  // 在终端中执行
  const [runInTerminal] = useState<boolean>(task?.runInTerminal || false);

  // 间隔时间选择
  const [intervalNum, setIntervalNum] = useState(1);
  const [intervalUnit, setIntervalUnit] = useState<'s' | 'm' | 'h' | 'd'>('h');

  // 高级时间设置
  const [showAdvancedTime, setShowAdvancedTime] = useState(false);
  const [, setDailyHours] = useState<number[]>([]);
  const [, setHourlyMinute] = useState<number>(0);

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

  // 初始化协议模式数据 - 从协议文档中读取任务目标，并回显模板信息
  useEffect(() => {
    if (task?.mode === 'protocol') {
      // 1. 回显模板信息
      if (task.templateId) {
        const { getTemplate } = useProtocolTemplateStore.getState();
        const template = getTemplate(task.templateId);
        if (template) {
          setSelectedTemplate(template);
          // 回显模板参数值
          if (task.templateParamValues) {
            // 如果模板参数中有 userSupplement，同步到独立字段
            const paramValues = { ...task.templateParamValues };
            if (paramValues.userSupplement !== undefined) {
              // 从模板参数中恢复 userSupplement
              setUserSupplement(paramValues.userSupplement);
            }
            setTemplateParamValues(paramValues);
          } else {
            // 没有保存的参数值，使用默认值
            const initialValues: Record<string, string> = {};
            if (template.templateParams) {
              template.templateParams.forEach((param) => {
                // userSupplement 参数使用独立字段的值（如果有的话）
                if (param.key === 'userSupplement' && task.userSupplement) {
                  initialValues[param.key] = task.userSupplement;
                } else {
                  initialValues[param.key] = param.default || '';
                }
              });
            }
            setTemplateParamValues(initialValues);
          }
        }
      }
      
      // 2. 初始化 mission 字段（从任务数据中）
      if (task.mission) {
        setMission(task.mission);
      }

      // 3. 读取任务目标（从 task.md 中解析，仅当没有使用 fullTemplate 时）
      if (task.taskPath && task.workDir && !task.templateId) {
        tauri.schedulerReadProtocolFile(task.workDir, task.taskPath, 'task')
          .then((content) => {
            // 解析任务目标部分
            const missionMatch = content.match(/## 任务目标\s*\n([\s\S]*?)(?=\n##|$)/);
            if (missionMatch && missionMatch[1]) {
              const extractedMission = missionMatch[1].trim();
              setMission(extractedMission);
            }
          })
          .catch((e) => {
            console.error('读取协议文档失败:', e);
          });
      }
    }
  }, [task]);

  // 处理间隔时间变化
  const handleIntervalChange = (num: number, unit: 's' | 'm' | 'h' | 'd') => {
    setIntervalNum(num);
    setIntervalUnit(unit);
    setTriggerValue(`${num}${unit}`);
  };

  // 生成每日多个时间点的 cron 表达式
  const generateDailyCron = (hours: number[]): string => {
    // 格式: 分 时 日 月 周
    // 例如: "0 8,12,18 * * *" 表示每天 8:00, 12:00, 18:00
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

    // 简单模式需要提示词
    if (mode === 'simple' && !prompt.trim()) {
      toast.warning('请填写提示词');
      return;
    }

    // 协议模式需要工作目录和任务目标
    if (mode === 'protocol') {
      if (!workDir.trim()) {
        toast.warning('协议模式需要指定工作目录');
        return;
      }

      // 如果使用 fullTemplate 模式
      if (selectedTemplate?.fullTemplate) {
        // 检查必填参数
        const missingParams = selectedTemplate.templateParams
          ?.filter((p) => p.required && !templateParamValues[p.key]?.trim())
          .map((p) => p.label);
        if (missingParams && missingParams.length > 0) {
          toast.warning(`请填写: ${missingParams.join(', ')}`);
          return;
        }
      } else if (!mission.trim() && !task?.taskPath) {
        // 传统模式检查 mission
        toast.warning('协议模式需要填写任务目标');
        return;
      }
    }

    // 计算 mission：如果是 fullTemplate 模式，渲染完整模板
    let finalMission = mission;
    if (mode === 'protocol' && selectedTemplate?.fullTemplate) {
      finalMission = renderFullTemplate(selectedTemplate.fullTemplate, templateParamValues);
    }

    // 如果模板有 userSupplement 参数，同步独立字段的值
    const finalTemplateParamValues = mode === 'protocol' && selectedTemplate
      ? {
          ...templateParamValues,
          // 同步独立的 userSupplement 字段到模板参数
          ...(selectedTemplate.templateParams?.some(p => p.key === 'userSupplement') && userSupplement.trim()
            ? { userSupplement: userSupplement.trim() }
            : {}),
        }
      : undefined;

    onSave({
      name,
      triggerType,
      triggerValue,
      engineId,
      prompt,
      workDir: workDir || undefined,
      mode,
      group: group || undefined,
      mission: mode === 'protocol' ? finalMission : undefined,
      maxRuns: maxRuns || undefined,
      runInTerminal,
      enabled: task?.enabled ?? true,
      // 保存模板信息，用于编辑时回显 - 始终保存（如果选择了模板）
      templateId: mode === 'protocol' ? selectedTemplate?.id : undefined,
      // 始终保存模板参数值（如果选择了模板且有参数）
      templateParamValues: finalTemplateParamValues && Object.keys(finalTemplateParamValues).length > 0
        ? finalTemplateParamValues
        : undefined,
      // 重试配置
      maxRetries: maxRetries && maxRetries > 0 ? maxRetries : undefined,
      retryInterval: maxRetries && maxRetries > 0 ? `${retryIntervalNum}${retryIntervalUnit}` : undefined,
      // 通知配置
      notifyOnComplete,
      // 超时配置
      timeoutMinutes: timeoutMinutes && timeoutMinutes > 0 ? timeoutMinutes : undefined,
      // 用户补充内容（一次性提示词）
      userSupplement: userSupplement.trim() || undefined,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[#16162a] rounded-lg w-[650px] max-h-[85vh] overflow-y-auto border border-[#2a2a4a]">
        {/* 头部 */}
        <div className="p-4 border-b border-[#2a2a4a] flex items-center justify-between sticky top-0 bg-[#16162a]">
          <h2 className="text-lg font-medium text-white">
            {title || (task ? '编辑任务' : '新建任务')}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">
            ✕
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* 任务名称 */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">
              任务名称 <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
              placeholder="例如：每日日报生成"
            />
          </div>

          {/* 分组（可选） */}
          {fullMode && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">
                分组 <span className="text-gray-600">(可选)</span>
              </label>
              <input
                type="text"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                className="w-full px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
                placeholder="例如：项目A、代码审查、日常维护..."
              />
              <p className="mt-1 text-xs text-gray-500">
                分组可以帮助你更好地管理任务，相同分组的任务会显示在一起
              </p>
            </div>
          )}

          {/* 任务模式（仅完整模式显示） */}
          {fullMode && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">任务模式</label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === 'simple'}
                    onChange={() => setMode('simple')}
                    className="w-4 h-4"
                  />
                  <span className="text-white">{TaskModeLabels.simple}</span>
                  <span className="text-xs text-gray-500">直接执行提示词</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === 'protocol'}
                    onChange={() => setMode('protocol')}
                    className="w-4 h-4"
                  />
                  <span className="text-white">{TaskModeLabels.protocol}</span>
                  <span className="text-xs text-gray-500">自动生成协议文档</span>
                </label>
              </div>
            </div>
          )}

          {/* 简单模式：提示词 */}
          {mode === 'simple' && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">
                提示词 <span className="text-red-400">*</span>
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={5}
                className="w-full px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500 resize-none"
                placeholder="输入 AI 要执行的提示词..."
              />
            </div>
          )}

          {/* 用户补充内容（简单模式和协议模式都可填写） */}
          {(mode === 'simple' || mode === 'protocol') && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">
                用户补充 <span className="text-gray-600">(可选，一次性提示词)</span>
              </label>
              <textarea
                value={userSupplement}
                onChange={(e) => setUserSupplement(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500 resize-none text-sm"
                placeholder="可选：补充说明、特殊要求或临时调整..."
              />
              <p className="mt-1 text-xs text-gray-500">
                在任务执行时会将此内容追加到提示词中，适合添加临时指令或补充说明
              </p>
            </div>
          )}

          {/* 协议模式：任务目标和工作目录 */}
          {mode === 'protocol' && fullMode && (
            <>
              {/* 模板选择 */}
              <ProtocolTemplateSelector
                onTemplateSelect={(template) => {
                  // 设置选中的模板
                  setSelectedTemplate(template);
                  
                  // 初始化模板参数值（使用默认值）
                  const initialValues: Record<string, string> = {};
                  if (template.templateParams) {
                    template.templateParams.forEach((param) => {
                      initialValues[param.key] = param.default || '';
                    });
                  }
                  setTemplateParamValues(initialValues);
                  
                  // 如果模板有 fullTemplate，使用它；否则使用 missionTemplate
                  if (template.fullTemplate) {
                    // fullTemplate 模式：参数将动态填充
                    setMission('');
                  } else {
                    // 传统模式：使用 missionTemplate
                    setMission(template.missionTemplate);
                  }
                  
                  // 应用默认触发设置
                  if (template.defaultTriggerType) {
                    setTriggerType(template.defaultTriggerType);
                  }
                  if (template.defaultTriggerValue) {
                    setTriggerValue(template.defaultTriggerValue);
                    if (template.defaultTriggerType === 'interval') {
                      const parsed = parseIntervalValue(template.defaultTriggerValue);
                      if (parsed) {
                        setIntervalNum(parsed.num);
                        setIntervalUnit(parsed.unit);
                      }
                    }
                  }
                  if (template.defaultEngineId) {
                    setEngineId(template.defaultEngineId);
                  }
                }}
                disabled={!!task?.taskPath}
              />

              {/* 动态模板参数输入 */}
              {selectedTemplate?.templateParams && selectedTemplate.templateParams.length > 0 && (
                <div className="space-y-3 p-3 bg-[#1a1a2e] rounded-lg border border-[#2a2a4a]">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-400">模板参数</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">{selectedTemplate.name}</span>
                      {!task?.taskPath && (
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedTemplate(null);
                            setTemplateParamValues({});
                            setMission('');
                          }}
                          className="text-xs text-red-400 hover:text-red-300 transition-colors"
                          title="清除模板，返回手动输入模式"
                        >
                          ✕ 清除
                        </button>
                      )}
                    </div>
                  </div>
                  {selectedTemplate.templateParams.map((param) => (
                    <TemplateParamInput
                      key={param.key}
                      param={param}
                      value={templateParamValues[param.key] || ''}
                      onChange={(value) =>
                        setTemplateParamValues((prev) => ({
                          ...prev,
                          [param.key]: value,
                        }))
                      }
                      disabled={!!task?.taskPath}
                    />
                  ))}
                </div>
              )}

              {/* 传统任务目标输入框：仅当没有使用 fullTemplate 模式时显示 */}
              {!(selectedTemplate?.fullTemplate && selectedTemplate?.templateParams?.length) && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1">
                    任务目标 <span className="text-red-400">*</span>
                  </label>
                  <textarea
                    value={mission}
                    onChange={(e) => setMission(e.target.value)}
                    rows={5}
                    className="w-full px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500 resize-none font-mono text-sm"
                    placeholder="描述任务目标，例如：帮我持续优化 ERP 查询性能&#10;&#10;支持占位符：{dateTime} - 当前时间"
                    disabled={!!task?.taskPath} // 已创建的任务不允许修改目标
                  />
                  {task?.taskPath && (
                    <p className="mt-1 text-xs text-gray-500">
                      已创建的任务目标不可修改，可在文档管理中查看
                    </p>
                  )}
                </div>
              )}
              <div className="p-3 bg-purple-500/10 rounded border border-purple-500/20">
                <p className="text-sm text-purple-400">
                  创建后将自动生成协议文档，包含任务目标、执行规则、记忆系统等。
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  支持占位符：{'{dateTime}'} - 当前日期时间
                </p>
                <p className="text-xs text-gray-500">
                  路径: {workDir || '[工作目录]'}/.polaris/tasks/[时间戳]/
                </p>
              </div>
            </>
          )}

          {/* 触发类型 */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">触发方式</label>
            <div className="space-y-2">
              {/* 触发类型选择 */}
              <div className="flex gap-2">
                <select
                  value={triggerType}
                  onChange={(e) => setTriggerType(e.target.value as TriggerType)}
                  className="px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
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
                      className="w-24 px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
                    />
                    <select
                      value={intervalUnit}
                      onChange={(e) => handleIntervalChange(intervalNum, e.target.value as 's' | 'm' | 'h' | 'd')}
                      className="px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
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
                    className="flex-1 px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500 font-mono"
                    placeholder="0 9 * * 1-5"
                  />
                ) : (
                  <input
                    type="datetime-local"
                    value={triggerValue}
                    onChange={(e) => setTriggerValue(e.target.value)}
                    className="flex-1 px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
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
                      className={`px-2 py-1 text-xs rounded transition-colors ${
                        triggerValue === preset.value
                          ? 'bg-blue-600 text-white'
                          : 'bg-[#2a2a4a] text-gray-400 hover:bg-[#3a3a5a]'
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
                    className="text-xs text-blue-400 hover:text-blue-300"
                  >
                    {showAdvancedTime ? '隐藏高级选项' : '显示高级时间选项'}
                  </button>

                  {showAdvancedTime && (
                    <div className="p-3 bg-[#1a1a2e] rounded border border-[#2a2a4a] space-y-3">
                      {/* 每日多个时间点 */}
                      <div>
                        <p className="text-xs text-gray-400 mb-2">每日多个时间点:</p>
                        <div className="flex flex-wrap gap-1">
                          {DAILY_TIME_PRESETS.map((preset) => (
                            <button
                              key={preset.label}
                              onClick={() => applyDailyPreset(preset.hours)}
                              className="px-2 py-1 text-xs bg-[#2a2a4a] text-gray-300 hover:bg-[#3a3a5a] rounded"
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* 每小时指定分钟 */}
                      <div>
                        <p className="text-xs text-gray-400 mb-2">每小时指定分钟:</p>
                        <div className="flex flex-wrap gap-1">
                          {HOURLY_MINUTE_PRESETS.map((preset) => (
                            <button
                              key={preset.label}
                              onClick={() => applyHourlyPreset(preset.minute)}
                              className="px-2 py-1 text-xs bg-[#2a2a4a] text-gray-300 hover:bg-[#3a3a5a] rounded"
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* 当前表达式说明 */}
                      <div className="text-xs text-gray-500">
                        当前表达式: <code className="text-blue-400">{triggerValue}</code>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Cron 表达式说明 */}
              {triggerType === 'cron' && !showAdvancedTime && (
                <p className="text-xs text-gray-500">
                  示例: "0 9 * * 1-5" 表示工作日早9点，格式为：分 时 日 月 周
                </p>
              )}
            </div>
          </div>

          {/* 执行轮次（可选） */}
          {fullMode && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">
                执行轮次限制 <span className="text-gray-600">(可选)</span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={maxRuns || ''}
                  onChange={(e) => setMaxRuns(e.target.value ? parseInt(e.target.value) : undefined)}
                  min={1}
                  placeholder="不限"
                  className="w-24 px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
                />
                <span className="text-gray-400 text-sm">次后自动禁用</span>
                {task && currentRuns > 0 && (
                  <span className="text-xs text-gray-500">
                    (已执行 {currentRuns} 次)
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-gray-500">
                留空表示不限制执行次数
              </p>
            </div>
          )}

          {/* 失败重试配置 */}
          {fullMode && (
            <div>
              <button
                type="button"
                onClick={() => setShowRetryConfig(!showRetryConfig)}
                className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
              >
                <span className={`transform transition-transform ${showRetryConfig ? 'rotate-90' : ''}`}>▶</span>
                <span>失败重试配置</span>
                {maxRetries && maxRetries > 0 && (
                  <span className="text-xs px-1.5 py-0.5 bg-green-500/20 text-green-400 rounded">
                    已启用 (最多 {maxRetries} 次)
                  </span>
                )}
              </button>
              
              {showRetryConfig && (
                <div className="mt-2 p-3 bg-[#1a1a2e] rounded border border-[#2a2a4a] space-y-3">
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!maxRetries && maxRetries > 0}
                        onChange={(e) => setMaxRetries(e.target.checked ? 3 : undefined)}
                        className="w-4 h-4"
                      />
                      <span className="text-white text-sm">启用自动重试</span>
                    </label>
                  </div>
                  
                  {maxRetries && maxRetries > 0 && (
                    <>
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-400 w-20">最大重试次数</label>
                        <input
                          type="number"
                          value={maxRetries}
                          onChange={(e) => setMaxRetries(Math.max(1, parseInt(e.target.value) || 1))}
                          min={1}
                          max={10}
                          className="w-20 px-2 py-1 bg-[#12122a] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500 text-sm"
                        />
                        <span className="text-gray-500 text-xs">次</span>
                      </div>
                      
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-400 w-20">重试间隔</label>
                        <input
                          type="number"
                          value={retryIntervalNum}
                          onChange={(e) => setRetryIntervalNum(Math.max(1, parseInt(e.target.value) || 1))}
                          min={1}
                          className="w-20 px-2 py-1 bg-[#12122a] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500 text-sm"
                        />
                        <select
                          value={retryIntervalUnit}
                          onChange={(e) => setRetryIntervalUnit(e.target.value as 's' | 'm' | 'h')}
                          className="px-2 py-1 bg-[#12122a] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500 text-sm"
                        >
                          {Object.entries(IntervalUnitLabels).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </div>
                      
                      <p className="text-xs text-gray-500">
                        任务执行失败后，将等待指定时间后自动重试，最多重试 {maxRetries} 次
                      </p>
                      
                      {task && task.retryCount > 0 && (
                        <p className="text-xs text-yellow-500">
                          当前已重试 {task.retryCount} 次
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 执行超时配置 */}
          {fullMode && (
            <div>
              <button
                type="button"
                onClick={() => setShowTimeoutConfig(!showTimeoutConfig)}
                className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
              >
                <span className={`transform transition-transform ${showTimeoutConfig ? 'rotate-90' : ''}`}>▶</span>
                <span>执行超时配置</span>
                {timeoutMinutes && timeoutMinutes > 0 && (
                  <span className="text-xs px-1.5 py-0.5 bg-yellow-500/20 text-yellow-400 rounded">
                    已启用 ({timeoutMinutes} 分钟)
                  </span>
                )}
              </button>
              
              {showTimeoutConfig && (
                <div className="mt-2 p-3 bg-[#1a1a2e] rounded border border-[#2a2a4a] space-y-3">
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!timeoutMinutes && timeoutMinutes > 0}
                        onChange={(e) => setTimeoutMinutes(e.target.checked ? 30 : undefined)}
                        className="w-4 h-4"
                      />
                      <span className="text-white text-sm">启用执行超时</span>
                    </label>
                  </div>
                  
                  {timeoutMinutes && timeoutMinutes > 0 && (
                    <>
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-400 w-20">超时时间</label>
                        <input
                          type="number"
                          value={timeoutMinutes}
                          onChange={(e) => setTimeoutMinutes(Math.max(1, parseInt(e.target.value) || 1))}
                          min={1}
                          max={1440}
                          className="w-20 px-2 py-1 bg-[#12122a] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500 text-sm"
                        />
                        <span className="text-gray-500 text-xs">分钟</span>
                      </div>
                      
                      <p className="text-xs text-gray-500">
                        任务执行超过设定时间后将自动终止，防止长时间占用资源
                      </p>
                      
                      {timeoutMinutes >= 60 && (
                        <p className="text-xs text-blue-400">
                          当前设置为 {Math.floor(timeoutMinutes / 60)} 小时 {timeoutMinutes % 60} 分钟
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 任务完成通知 */}
          {fullMode && (
            <div className="flex items-center gap-3 p-3 bg-[#1a1a2e] rounded border border-[#2a2a4a]">
              <input
                type="checkbox"
                id="notifyOnComplete"
                checked={notifyOnComplete}
                onChange={(e) => setNotifyOnComplete(e.target.checked)}
                className="w-4 h-4"
              />
              <label htmlFor="notifyOnComplete" className="text-sm text-gray-300 cursor-pointer">
                任务完成后发送桌面通知
              </label>
              <span className="text-xs text-gray-500">
                （无论成功或失败都会通知）
              </span>
            </div>
          )}

          {/* AI 引擎 */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">AI 引擎</label>
            <div className="space-y-2">
              <select
                value={parseEngineId(engineId).baseEngine}
                onChange={(e) => {
                  const baseEngine = e.target.value;
                  if (baseEngine === 'openai') {
                    // 选择 OpenAI 时，默认选择第一个启用的 provider
                    const enabledProviders = openaiProviders.filter(p => p.enabled);
                    if (enabledProviders.length > 0) {
                      setEngineId(`provider-${enabledProviders[0].id}`);
                    } else {
                      setEngineId('openai'); // 没有配置 provider 时保持原值
                    }
                  } else {
                    setEngineId(baseEngine);
                  }
                }}
                className="w-full px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
              >
                <option value="claude">Claude Code</option>
                <option value="iflow">IFlow</option>
                <option value="codex">Codex</option>
                <option value="openai">OpenAI Provider</option>
              </select>
              
              {/* OpenAI Provider 二级选择 */}
              {parseEngineId(engineId).baseEngine === 'openai' && (
                <div className="pl-2 border-l-2 border-[#2a2a4a]">
                  <label className="block text-xs text-gray-500 mb-1">选择 Provider</label>
                  {openaiProviders.filter(p => p.enabled).length > 0 ? (
                    <>
                      <select
                        value={parseEngineId(engineId).providerId || ''}
                        onChange={(e) => setEngineId(`provider-${e.target.value}`)}
                        className="w-full px-3 py-2 bg-[#12122a] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500 text-sm"
                      >
                        {openaiProviders.filter(p => p.enabled).map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.name} ({provider.model})
                          </option>
                        ))}
                      </select>
                      {/* 显示选中 Provider 的详情 */}
                      {(() => {
                        const selectedProvider = openaiProviders.find(
                          p => p.id === parseEngineId(engineId).providerId
                        );
                        if (selectedProvider) {
                          return (
                            <div className="mt-2 p-2 bg-[#0a0a1a] rounded text-xs text-gray-400 space-y-1">
                              <div>模型: <span className="text-blue-400">{selectedProvider.model}</span></div>
                              <div>API: <span className="text-gray-500 truncate">{selectedProvider.apiBase}</span></div>
                              {selectedProvider.supportsTools && (
                                <span className="inline-block px-1 py-0.5 bg-green-500/20 text-green-400 rounded text-xs">
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
                    <p className="text-xs text-yellow-500">
                      未配置 OpenAI Provider，请在设置中添加
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* 工作目录 */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">
              工作目录 {mode === 'protocol' && <span className="text-red-400">*</span>}
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
                      className={`px-2 py-1 text-xs rounded transition-colors ${
                        workDir === ws.path
                          ? 'bg-blue-600 text-white'
                          : 'bg-[#2a2a4a] text-gray-400 hover:bg-[#3a3a5a]'
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
                className="w-full px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
                placeholder={mode === 'protocol' ? '协议模式必须指定工作目录' : '留空使用默认目录'}
              />
            </div>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="p-4 border-t border-[#2a2a4a] flex justify-end gap-2 sticky bottom-0 bg-[#16162a]">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-600/20 text-gray-300 hover:bg-gray-600/30 rounded transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

export default TaskEditor;
