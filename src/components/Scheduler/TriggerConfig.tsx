/**
 * 触发配置组件
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TriggerType, IntervalUnit } from '../../types/scheduler';
import { TRIGGER_TYPE_LABELS, INTERVAL_UNIT_LABELS, parseIntervalValue } from '../../types/scheduler';

/** 预设间隔选项 */
const INTERVAL_PRESETS = [
  { label: '每 5 分钟', value: '5m' },
  { label: '每 15 分钟', value: '15m' },
  { label: '每 30 分钟', value: '30m' },
  { label: '每 1 小时', value: '1h' },
  { label: '每 2 小时', value: '2h' },
  { label: '每 6 小时', value: '6h' },
  { label: '每 12 小时', value: '12h' },
  { label: '每天', value: '1d' },
];

export interface TriggerConfigProps {
  /** 触发类型 */
  triggerType: TriggerType;
  /** 触发值 */
  triggerValue: string;
  /** 类型变更回调 */
  onTypeChange: (type: TriggerType) => void;
  /** 值变更回调 */
  onValueChange: (value: string) => void;
}

export function TriggerConfig({
  triggerType,
  triggerValue,
  onTypeChange,
  onValueChange,
}: TriggerConfigProps) {
  const { t } = useTranslation('scheduler');

  // 间隔执行状态
  const [intervalNum, setIntervalNum] = useState(1);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>('h');

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

  // 处理间隔变化
  const handleIntervalChange = (num: number, unit: IntervalUnit) => {
    setIntervalNum(num);
    setIntervalUnit(unit);
    onValueChange(`${num}${unit}`);
  };

  // 应用预设
  const applyPreset = (value: string) => {
    const parsed = parseIntervalValue(value);
    if (parsed) {
      setIntervalNum(parsed.num);
      setIntervalUnit(parsed.unit);
      onValueChange(value);
    }
  };

  return (
    <div className="space-y-3">
      {/* 类型选择和值输入 */}
      <div className="flex gap-2">
        <select
          value={triggerType}
          onChange={(e) => onTypeChange(e.target.value as TriggerType)}
          className="px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
        >
          {Object.entries(TRIGGER_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        {/* 间隔执行 */}
        {triggerType === 'interval' && (
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
              onChange={(e) => handleIntervalChange(intervalNum, e.target.value as IntervalUnit)}
              className="px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              {Object.entries(INTERVAL_UNIT_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Cron 表达式 */}
        {triggerType === 'cron' && (
          <input
            type="text"
            value={triggerValue}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder="0 9 * * 1-5"
            className="flex-1 px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        )}

        {/* 单次执行 */}
        {triggerType === 'once' && (
          <input
            type="datetime-local"
            value={triggerValue}
            onChange={(e) => onValueChange(e.target.value)}
            className="flex-1 px-3 py-2 bg-background-surface border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        )}
      </div>

      {/* 间隔预设快捷选项 */}
      {triggerType === 'interval' && (
        <div className="flex flex-wrap gap-2">
          {INTERVAL_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              onClick={() => applyPreset(preset.value)}
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

      {/* Cron 表达式说明 */}
      {triggerType === 'cron' && (
        <p className="text-xs text-text-muted">
          {t('trigger.cronHelp')}
        </p>
      )}
    </div>
  );
}
