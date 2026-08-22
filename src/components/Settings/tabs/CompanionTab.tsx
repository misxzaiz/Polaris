/**
 * CompanionTab — AI 陪伴设置面板
 *
 * 允许用户编辑：
 * - 启停开关
 * - 人格选择（3 种预设）
 * - 主动频率（maxDailyInteractions）
 * - 冷却时间（cooldownMinutes）
 * - 活跃窗口（activeWindowStart/End）
 * - 静默日（quietDays）
 * - 启用的内容类型
 */

import { useState } from 'react';
import { Bot } from 'lucide-react';
import { useCompanionStore } from '@/stores/companionStore';
import { PRESET_PERSONAS, type CompanionContentType } from '@/services/companion';
import type { CompanionConfig } from '@/services/companion';

const WEEKDAYS = [
  { value: 0, label: '周日' },
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
];

const CONTENT_TYPE_LABELS: Record<CompanionContentType, string> = {
  project_insight: '项目洞察',
  learning_challenge: '学习挑战',
  skill_explore: '技能探索',
  achievement_celebrate: '成就祝贺',
  tip_curiosity: '趣味知识',
  daily_review: '每日回顾',
  learning_followup: '学习跟进',
};

export function CompanionTab() {
  const config = useCompanionStore(s => s.config);
  const enabled = useCompanionStore(s => s.enabled);
  const updateConfig = useCompanionStore(s => s.updateConfig);
  const toggleEnabled = useCompanionStore(s => s.toggleEnabled);
  const [saved, setSaved] = useState(false);

  const handleSave = (patch: Partial<CompanionConfig>) => {
    const ok = updateConfig(patch);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  return (
    <div className="space-y-6">
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h2 className="text-base font-medium mb-4 flex items-center gap-2">
          <Bot size={16} className="text-primary" />
          AI 陪伴设置
        </h2>

        {/* 启停开关 */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-sm font-medium">启用 AI 陪伴</p>
            <p className="text-xs text-text-muted">主动感知上下文，带你学习新技能</p>
          </div>
          <button
            role="switch"
            aria-checked={enabled}
            className={`flex h-5 w-9 items-center rounded-full px-0.5 transition-colors ${
              enabled ? 'bg-primary' : 'bg-background-elevated'
            }`}
            onClick={() => toggleEnabled()}
          >
            <span className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${
              enabled ? 'translate-x-4' : 'translate-x-0'
            }`} />
          </button>
        </div>

        {/* 人格选择 */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">陪伴人格</label>
          <p className="text-xs text-text-muted mb-2">决定主动内容的语气与教学风格</p>
          <select
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={config.personality.name}
            onChange={(e) => {
              const personaKey = Object.entries(PRESET_PERSONAS)
                .find(([, p]) => p.name === e.target.value)?.[0];
              if (personaKey) {
                handleSave({ personality: PRESET_PERSONAS[personaKey] });
              }
            }}
          >
            {Object.entries(PRESET_PERSONAS).map(([key, p]) => (
              <option key={key} value={p.name}>{p.name} ({p.tone}/{p.teachingStyle})</option>
            ))}
          </select>
          <div className="mt-1 text-xs text-text-muted bg-background-elevated rounded p-2">
            {config.personality.systemPrompt.slice(0, 120)}...
          </div>
        </div>

        {/* 频率 */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">每日最大主动次数</label>
            <input
              type="number"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              min={0}
              max={20}
              value={config.maxDailyInteractions}
              onChange={(e) => handleSave({ maxDailyInteractions: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">冷却时间（分钟）</label>
            <input
              type="number"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              min={0}
              max={1440}
              value={config.cooldownMinutes}
              onChange={(e) => handleSave({ cooldownMinutes: Number(e.target.value) })}
            />
          </div>
        </div>

        {/* 活跃窗口 */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">活跃窗口起始</label>
            <input
              type="time"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={config.activeWindowStart}
              onChange={(e) => handleSave({ activeWindowStart: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">活跃窗口结束</label>
            <input
              type="time"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={config.activeWindowEnd}
              onChange={(e) => handleSave({ activeWindowEnd: e.target.value })}
            />
          </div>
        </div>

        {/* 静默日 */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">静默日（不主动）</label>
          <div className="flex flex-wrap gap-2">
            {WEEKDAYS.map((day) => (
              <button
                key={day.value}
                className={`px-2 py-1 rounded text-xs border ${
                  config.quietDays.includes(day.value)
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-text-secondary border-border'
                }`}
                onClick={() => {
                  const next = config.quietDays.includes(day.value)
                    ? config.quietDays.filter(d => d !== day.value)
                    : [...config.quietDays, day.value];
                  handleSave({ quietDays: next });
                }}
              >
                {day.label}
              </button>
            ))}
          </div>
        </div>

        {/* 内容类型 */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">启用的内容类型</label>
          <div className="flex flex-wrap gap-2">
            {config.enabledContentTypes.map((type) => (
              <button
                key={type}
                className={`px-2 py-1 rounded text-xs border ${
                  config.enabledContentTypes.includes(type)
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-text-secondary border-border'
                }`}
                onClick={() => {
                  const next = config.enabledContentTypes.includes(type)
                    ? config.enabledContentTypes.filter(t => t !== type)
                    : [...config.enabledContentTypes, type];
                  handleSave({ enabledContentTypes: next });
                }}
              >
                {CONTENT_TYPE_LABELS[type] ?? type}
              </button>
            ))}
          </div>
        </div>

        {/* 保存提示 */}
        {saved && (
          <p className="text-xs text-primary">✓ 设置已保存</p>
        )}
      </div>
    </div>
  );
}