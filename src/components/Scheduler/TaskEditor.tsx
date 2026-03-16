/**
 * 任务编辑器 - 统一组件
 *
 * 用于 SchedulerPanel 和 SchedulerTab 的共享任务编辑器
 */

import { useEffect, useState } from 'react';
import { useToastStore } from '../../stores';
import { useProtocolTemplateStore } from '../../stores/protocolTemplateStore';
import type { ScheduledTask, TriggerType, CreateTaskParams, TaskMode } from '../../types/scheduler';
import { TriggerTypeLabels, IntervalUnitLabels, TaskModeLabels, parseIntervalValue } from '../../types/scheduler';
import { ProtocolTemplateCategoryLabels, renderFullTemplate } from '../../types/protocolTemplate';
import type { ProtocolTemplate, TemplateParam } from '../../types/protocolTemplate';
import * as tauri from '../../services/tauri';

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

  // 基础字段
  const [name, setName] = useState(task?.name || '');
  const [mode, setMode] = useState<TaskMode>(task?.mode || 'simple');
  const [triggerType, setTriggerType] = useState<TriggerType>(task?.triggerType || 'interval');
  const [triggerValue, setTriggerValue] = useState(task?.triggerValue || '1h');
  const [engineId, setEngineId] = useState(task?.engineId || 'claude');
  const [prompt, setPrompt] = useState(task?.prompt || '');
  const [workDir, setWorkDir] = useState(task?.workDir || '');

  // 协议模式字段
  const [mission, setMission] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<ProtocolTemplate | null>(null);
  const [templateParamValues, setTemplateParamValues] = useState<Record<string, string>>({});

  // 执行轮次
  const [maxRuns, setMaxRuns] = useState<number | undefined>(task?.maxRuns);
  const [currentRuns] = useState<number>(task?.currentRuns || 0);

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
            setTemplateParamValues(task.templateParamValues);
          } else {
            // 没有保存的参数值，使用默认值
            const initialValues: Record<string, string> = {};
            if (template.templateParams) {
              template.templateParams.forEach((param) => {
                initialValues[param.key] = param.default || '';
              });
            }
            setTemplateParamValues(initialValues);
          }
        }
      }

      // 2. 读取任务目标（从 task.md 中解析，仅当没有使用 fullTemplate 时）
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

    onSave({
      name,
      triggerType,
      triggerValue,
      engineId,
      prompt,
      workDir: workDir || undefined,
      mode,
      mission: mode === 'protocol' ? finalMission : undefined,
      maxRuns: maxRuns || undefined,
      runInTerminal,
      enabled: task?.enabled ?? true,
      // 保存模板信息，用于编辑时回显
      templateId: mode === 'protocol' ? selectedTemplate?.id : undefined,
      templateParamValues: mode === 'protocol' && selectedTemplate?.fullTemplate
        ? templateParamValues
        : undefined,
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
                    <span className="text-xs text-gray-500">{selectedTemplate.name}</span>
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

          {/* AI 引擎 */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">AI 引擎</label>
            <select
              value={engineId}
              onChange={(e) => setEngineId(e.target.value)}
              className="w-full px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
            >
              <option value="claude">Claude Code</option>
              <option value="iflow">IFlow</option>
              <option value="codex">Codex</option>
              <option value="openai">OpenAI</option>
            </select>
          </div>

          {/* 工作目录 */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">
              工作目录 {mode === 'protocol' && <span className="text-red-400">*</span>}
            </label>
            <input
              type="text"
              value={workDir}
              onChange={(e) => setWorkDir(e.target.value)}
              className="w-full px-3 py-2 bg-[#1a1a2e] border border-[#2a2a4a] rounded text-white focus:outline-none focus:border-blue-500"
              placeholder={mode === 'protocol' ? '协议模式必须指定工作目录' : '留空使用默认目录'}
            />
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
