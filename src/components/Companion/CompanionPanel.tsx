/**
 * CompanionPanel — AI 主动陪伴助手主面板
 *
 * 展示：启停开关、待处理卡片队列、历史记录折叠区、空状态提示、手动触发按钮
 * 所有文案通过 i18n 翻译。
 */

import { useState, useCallback } from 'react';
import { Sparkles, RefreshCw, Trash2, ChevronDown, ChevronRight, Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCompanionStore } from '@/stores/companionStore';
import { CompanionCard } from './CompanionCard';

export function CompanionPanel() {
  const { t } = useTranslation('common');
  const enabled = useCompanionStore(s => s.enabled);
  const pending = useCompanionStore(s => s.pending);
  const history = useCompanionStore(s => s.history);
  const isGenerating = useCompanionStore(s => s.isGenerating);
  const lastError = useCompanionStore(s => s.lastError);
  const toggleEnabled = useCompanionStore(s => s.toggleEnabled);
  const evaluateTrigger = useCompanionStore(s => s.evaluateTrigger);
  const clearPending = useCompanionStore(s => s.clearPending);

  const [showHistory, setShowHistory] = useState(false);

  const handleManualTrigger = useCallback(() => {
    const today = new Date();
    today.setHours(14, 0, 0, 0);
    void evaluateTrigger({
      now: today.getTime(),
      hasEnoughContext: true,
      cooldownMinutes: 0,
      activeWindowStart: '00:00',
      activeWindowEnd: '23:59',
      todayTriggerCount: 0,
      lastTriggerAt: 0,
    });
  }, [evaluateTrigger]);

  return (
    <div data-companion-panel className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Bot size={16} className="text-primary" />
        <span className="text-sm font-medium text-text-primary">
          {t('labels.companion', { defaultValue: 'AI 陪伴' })}
        </span>

        <button
          role="switch"
          aria-checked={enabled}
          className={`ml-auto flex h-5 w-9 items-center rounded-full px-0.5 transition-colors ${
            enabled ? 'bg-primary' : 'bg-background-elevated'
          }`}
          onClick={() => toggleEnabled()}
          aria-label={t('actions.toggleCompanion', { defaultValue: '启停 AI 陪伴' })}
        >
          <span
            className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${
              enabled ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {/* 操作栏 */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <button
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-text-secondary hover:bg-background-elevated disabled:opacity-50"
          onClick={handleManualTrigger}
          disabled={!enabled || isGenerating}
          aria-label={t('actions.tryTrigger', { defaultValue: '试一次' })}
        >
          <RefreshCw size={12} className={isGenerating ? 'animate-spin' : ''} />
          {t('actions.tryTrigger', { defaultValue: '试一次' })}
        </button>
        {pending.length > 0 && (
          <button
            className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-text-subtle hover:bg-background-elevated"
            onClick={clearPending}
            aria-label={t('actions.clear', { defaultValue: '清空' })}
          >
            <Trash2 size={12} />
            {t('actions.clear', { defaultValue: '清空' })}
          </button>
        )}
      </div>

      {/* 错误提示 */}
      {lastError && (
        <div className="mx-2 mt-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-warning">
          {lastError}
        </div>
      )}

      {/* 内容列表 */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {pending.length === 0 && !isGenerating && (
          <EmptyState enabled={enabled} t={t} />
        )}

        {pending.length === 0 && isGenerating && (
          <div className="flex items-center justify-center py-8 text-xs text-text-muted">
            <Sparkles size={14} className="mr-1 animate-pulse" />
            {t('messages.companionThinking', { defaultValue: '正在为你准备…' })}
          </div>
        )}

        <div className="flex flex-col gap-2">
          {pending.map(entry => (
            <CompanionCard key={entry.content.id} entry={entry} t={t} />
          ))}
        </div>
      </div>

      {/* 历史记录 */}
      {history.length > 0 && (
        <div className="border-t border-border">
          <button
            className="flex w-full items-center gap-1 px-3 py-1.5 text-xs text-text-subtle hover:bg-background-elevated"
            onClick={() => setShowHistory(v => !v)}
            aria-label={t('actions.toggleHistory', { defaultValue: '展开历史' })}
          >
            {showHistory ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {t('labels.history', { defaultValue: '历史' })}（{history.length}）
          </button>
          {showHistory && (
            <div className="max-h-40 overflow-y-auto px-2 pb-2">
              <div className="flex flex-col gap-2 opacity-70">
                {history.slice(0, 10).map(entry => (
                  <CompanionCard key={entry.content.id} entry={entry} t={t} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 空状态 */
function EmptyState({ enabled, t }: { enabled: boolean; t: ReturnType<typeof useTranslation<'common'>>['t'] }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Sparkles size={32} className="mb-2 text-text-subtle opacity-50" />
      <p className="text-sm text-text-secondary">
        {enabled
          ? t('messages.companionIdle', { defaultValue: 'AI 陪伴待命中，会根据你的工作节奏主动来找你。' })
          : t('messages.companionDisabled', { defaultValue: 'AI 陪伴已关闭，打开开关后会主动来找你。' })}
      </p>
    </div>
  );
}