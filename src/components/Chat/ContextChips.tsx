/**
 * 上下文芯片容器组件
 * 显示和管理 AI 对话中的各种上下文引用（文件、Git 提交等）
 */

import { memo } from 'react';
import { ContextChip } from './ContextChip';
import type { ContextChipWithId } from '@/types/context';

export interface ContextChipsProps {
  chips: ContextChipWithId[];
  onRemove: (chip: ContextChipWithId) => void;
}

export const ContextChips = memo(function ContextChips({ chips, onRemove }: ContextChipsProps) {
  if (chips.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-1 animate-in fade-in slide-in-from-top-2 duration-200">
      {chips.map(chip => (
        <ContextChip key={chip.id} chip={chip} onRemove={() => onRemove(chip)} />
      ))}
    </div>
  );
});
