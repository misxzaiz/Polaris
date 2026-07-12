/**
 * 单个上下文芯片组件
 * 显示文件、Git 提交等上下文的可移除标签
 */

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContextChipWithId } from '@/types/context';
import { getChipLabel, getChipDescription, getChipIcon } from '@/types/context';

interface ContextChipProps {
  chip: ContextChipWithId;
  onRemove: () => void;
}

const iconMap = {
  file: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  ),
  symbol: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
    </svg>
  ),
  commit: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  diff: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l4-4 4 4m0 6l-4 4-4-4" />
    </svg>
  ),
  workspace: (
    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
      <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
    </svg>
  ),
  directory: (
    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
      <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
    </svg>
  ),
};

const colorMap = {
  file: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
  symbol: 'border-purple-500/30 bg-purple-500/10 text-purple-400',
  commit: 'border-orange-500/30 bg-orange-500/10 text-orange-400',
  diff: 'border-green-500/30 bg-green-500/10 text-green-400',
  workspace: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400',
  directory: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400',
};

export const ContextChip = memo(function ContextChip({ chip, onRemove }: ContextChipProps) {
  const { t } = useTranslation('chat');
  const icon = getChipIcon(chip);
  const label = getChipLabel(chip);
  const description = getChipDescription(chip);
  const colorClass = colorMap[icon] ?? colorMap.file;

  return (
    <div
      className={`
        chip-enter inline-flex items-center gap-1.5 px-2 py-1 rounded-full
        border text-xs font-medium transition-all
        hover:shadow-sm group
        ${colorClass}
      `}
      title={description}
    >
      {/* 图标 */}
      <span className="shrink-0 opacity-80">
        {iconMap[icon]}
      </span>

      {/* 标签 */}
      <span className="max-w-[120px] truncate">
        {label}
      </span>

      {/* 移除按钮 */}
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 ml-0.5 opacity-60 hover:opacity-100 transition-opacity"
        aria-label={t('contextChip.remove', { label })}
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
});
