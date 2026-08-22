/**
 * CompanionCard — 单条主动内容卡片
 *
 * 展示：标题 / 正文 / 动作按钮 / 证据
 * 交互：接受、推迟、忽略
 * 所有文案通过 i18n 翻译。
 */

import { memo } from 'react';
import { Check, Clock, X, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CompanionCardEntry } from '@/stores/companionStore';
import { useCompanionStore } from '@/stores/companionStore';
import { CONTENT_TYPE_ICONS } from './contentTypes';

interface CompanionCardProps {
  entry: CompanionCardEntry;
  t: ReturnType<typeof useTranslation<'common'>>['t'];
}

function CompanionCardImpl({ entry, t }: CompanionCardProps) {
  const respondToCard = useCompanionStore(s => s.respondToCard);
  const dismissCard = useCompanionStore(s => s.dismissCard);
  const { content, userAction } = entry;
  const TypeIcon = CONTENT_TYPE_ICONS[content.type] ?? Sparkles;
  const typeLabel = t(`companion.${content.type}`, { defaultValue: content.type });

  return (
    <div
      data-companion-card
      className="companion-card relative rounded-lg border border-border bg-background-surface p-3 shadow-sm transition-shadow hover:shadow-md"
    >
      <div className="mb-2 flex items-center gap-2">
        <TypeIcon size={14} className="text-primary" />
        <span className="text-xs text-text-muted">{typeLabel}</span>
        <span className="ml-auto text-xs text-text-subtle">
          {new Date(content.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      <h4 className="mb-1 text-sm font-medium text-text-primary">{content.title}</h4>

      <p className="mb-2 whitespace-pre-wrap text-xs leading-relaxed text-text-secondary">{content.body}</p>

      {content.evidence && content.evidence.length > 0 && (
        <ul className="mb-2 list-disc pl-4 text-xs text-text-muted">
          {content.evidence.slice(0, 3).map((ev, i) => (
            <li key={i} className="truncate">{ev}</li>
          ))}
        </ul>
      )}

      {userAction && (
        <div className="mb-1 text-xs text-text-subtle">
          {userAction === 'accepted' && '✓ ' + t('actions.accepted', { defaultValue: '已接受' })}
          {userAction === 'completed' && '✓ ' + t('actions.completed', { defaultValue: '已完成' })}
          {userAction === 'deferred' && '⏰ ' + t('actions.deferred', { defaultValue: '已推迟' })}
          {userAction === 'dismissed' && '— ' + t('actions.dismissed', { defaultValue: '已忽略' })}
          {userAction === 'declined_forever' && '— ' + t('actions.declined', { defaultValue: '不再接收' })}
        </div>
      )}

      {!userAction && (
        <div className="mt-2 flex gap-1.5">
          {content.action && (
            <button
              className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground hover:opacity-90"
              onClick={() => respondToCard(content.id, 'accepted')}
              aria-label={content.action.label}
            >
              <Check size={12} />
              {content.action.label}
            </button>
          )}
          <button
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-background-elevated"
            onClick={() => respondToCard(content.id, 'deferred')}
            aria-label={t('actions.defer', { defaultValue: '推迟' })}
          >
            <Clock size={12} />
            {t('actions.defer', { defaultValue: '推迟' })}
          </button>
          <button
            className="ml-auto flex items-center rounded-md p-1 text-text-subtle hover:bg-background-elevated"
            onClick={() => dismissCard(content.id)}
            aria-label={t('actions.dismiss', { defaultValue: '忽略' })}
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

export const CompanionCard = memo(CompanionCardImpl);