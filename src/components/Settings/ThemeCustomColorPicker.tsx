/**
 * ColorPicker - 单个颜色变量的编辑器
 *
 * - 左侧色块（原生 input[type=color] 触发系统取色器）
 * - 中间标签
 * - 右侧 hex 文本输入（支持手动输入 #RRGGBB）
 * - 可选「重置」按钮（回到基础主题默认值）
 *
 * 值以 RGB 三元组字符串（"R G B"）传入/传出，与 --c-* 变量一致。
 */

import { memo, useCallback } from 'react';
import { RotateCcw } from 'lucide-react';
import { rgbTripleToHex, hexToRgbTriple, isValidRgbTriple } from '@/types/theme';
import type { RgbTriple } from '@/types/theme';

interface ColorPickerProps {
  label: string;
  /** 当前值（RGB 三元组）；为空表示未覆盖，使用 fallback */
  value?: RgbTriple;
  /** 基础主题默认值（未覆盖时展示 + 重置目标） */
  fallback: RgbTriple;
  /** 是否已被覆盖（用于显示重置按钮） */
  overridden: boolean;
  onChange: (value: RgbTriple) => void;
  onReset: () => void;
  disabled?: boolean;
  resetTitle?: string;
}

export const ColorPicker = memo(function ColorPicker({
  label,
  value,
  fallback,
  overridden,
  onChange,
  onReset,
  disabled,
  resetTitle,
}: ColorPickerProps) {
  const effective = value && isValidRgbTriple(value) ? value : fallback;
  const hex = rgbTripleToHex(effective);

  const handleColorInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const triple = hexToRgbTriple(e.target.value);
      if (triple) onChange(triple);
    },
    [onChange],
  );

  const handleHexInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value.trim();
      const triple = hexToRgbTriple(raw);
      if (triple) onChange(triple);
    },
    [onChange],
  );

  return (
    <div className="flex items-center gap-2 py-1">
      <label className="relative flex-shrink-0 w-7 h-7 rounded-md border border-border overflow-hidden cursor-pointer">
        <span
          className="absolute inset-0"
          style={{ backgroundColor: `rgb(${effective})` }}
        />
        <input
          type="color"
          value={hex}
          onChange={handleColorInput}
          disabled={disabled}
          className="absolute inset-0 opacity-0 cursor-pointer"
          aria-label={label}
        />
      </label>

      <span className="flex-1 text-xs text-text-secondary truncate" title={label}>
        {label}
      </span>

      <input
        type="text"
        value={hex}
        onChange={handleHexInput}
        disabled={disabled}
        spellCheck={false}
        className="w-20 bg-background-base border border-border-subtle rounded px-1.5 py-1 text-xs text-text-primary font-mono focus:outline-none focus:border-primary"
      />

      <button
        type="button"
        onClick={onReset}
        disabled={disabled || !overridden}
        title={resetTitle}
        className={`flex-shrink-0 p-1 rounded transition-colors ${
          overridden
            ? 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
            : 'text-transparent cursor-default'
        }`}
      >
        <RotateCcw size={13} />
      </button>
    </div>
  );
});
