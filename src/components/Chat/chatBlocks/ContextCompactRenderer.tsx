/**
 * 上下文压缩分隔条 - Claude CLI /compact 或 autoCompact 完成后的标记
 *
 * 渲染为聊天流中的居中细分隔条，提示此处之前的上下文已被摘要压缩。
 */

import { useTranslation } from 'react-i18next';
import type { ContextCompactBlock } from '@/types';

function formatTokens(n?: number): string | null {
  if (n === undefined || n === null) return null;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function ContextCompactRenderer({ block }: { block: ContextCompactBlock }) {
  const { t } = useTranslation('chat');

  const pre = formatTokens(block.preTokens);
  const post = formatTokens(block.postTokens);
  const label = block.trigger === 'auto'
    ? t('cliCommand.compactDivider.auto')
    : t('cliCommand.compactDivider.manual');

  return (
    <div className="flex items-center gap-3 my-3 select-none" data-testid="context-compact-divider">
      <div className="flex-1 h-px bg-border" />
      <div className="flex items-center gap-1.5 text-xs text-text-tertiary whitespace-nowrap">
        <span>🗜️</span>
        <span>{label}</span>
        {pre && post && (
          <span className="font-mono">
            {t('cliCommand.compactDivider.tokens', { pre, post })}
          </span>
        )}
      </div>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}
