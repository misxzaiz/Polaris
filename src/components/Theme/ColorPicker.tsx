/**
 * 颜色选择器
 *
 * 支持 RGB 三元组输入，实时预览色块
 * 点击外部关闭
 */

import * as React from 'react';

interface ColorPickerProps {
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
}

export function ColorPicker({ value, onChange, onClose }: ColorPickerProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [r, g, b] = React.useMemo(() => {
    const parts = value.trim().split(/\s+/).map(Number);
    if (parts.length >= 3 && parts.every((n) => !isNaN(n))) {
      return [parts[0], parts[1], parts[2]];
    }
    return [59, 130, 246];
  }, [value]);

  const [localR, setLocalR] = React.useState(r);
  const [localG, setLocalG] = React.useState(g);
  const [localB, setLocalB] = React.useState(b);

  // 点击外部关闭
  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // 延迟绑定，避免触发当前点击
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
    };
  }, [onClose]);

  const commit = (rVal: number, gVal: number, bVal: number) => {
    setLocalR(rVal); setLocalG(gVal); setLocalB(bVal);
    onChange(`${Math.round(rVal)} ${Math.round(gVal)} ${Math.round(bVal)}`);
  };

  // 预设颜色
  const presets = [
    ['59 130 246', '37 99 235', '239 68 68', '34 197 94', '234 179 8', '168 85 247'],
    ['236 72 153', '14 165 233', '20 184 166', '248 113 113', '251 146 60', '34 211 238'],
    ['0 0 0', '26 26 31', '45 45 53', '82 82 91', '161 161 170', '248 248 248'],
  ];

  return (
    <div ref={ref} className="p-3 rounded-xl bg-background-surface border border-border shadow-lg space-y-3">
      {/* 色块预览 */}
      <div
        className="w-full h-10 rounded-lg border border-border-subtle"
        style={{ background: `rgb(${localR} ${localG} ${localB})` }}
      />

      {/* RGB 输入 */}
      <div className="flex gap-2">
        {[
          { label: 'R', val: localR, set: (v: number) => commit(v, localG, localB), max: 255 },
          { label: 'G', val: localG, set: (v: number) => commit(localR, v, localB), max: 255 },
          { label: 'B', val: localB, set: (v: number) => commit(localR, localG, v), max: 255 },
        ].map(({ label, val, set, max }) => (
          <div key={label} className="flex-1 flex items-center gap-1">
            <span className="text-xs text-text-muted w-3">{label}</span>
            <input
              type="range"
              min={0}
              max={max}
              value={val}
              onChange={(e) => set(Number(e.target.value))}
              className="flex-1 h-1 bg-border rounded-full appearance-none cursor-pointer accent-primary"
            />
            <input
              type="number"
              min={0}
              max={max}
              value={val}
              onChange={(e) => set(Math.max(0, Math.min(max, Number(e.target.value) || 0)))}
              className="w-10 px-1 py-0.5 text-xs bg-background-base border border-border rounded text-text-primary text-center outline-none"
            />
          </div>
        ))}
      </div>

      {/* 预设色板 */}
      <div className="space-y-1">
        <span className="text-[10px] text-text-muted">预设</span>
        {presets.map((row, i) => (
          <div key={i} className="flex gap-1">
            {row.map((preset) => {
              const parts = preset.split(' ').map(Number);
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => commit(parts[0], parts[1], parts[2])}
                  className={`w-6 h-6 rounded-md border transition-transform hover:scale-110 ${
                    value === preset ? 'border-primary scale-110' : 'border-border-subtle'
                  }`}
                  style={{ background: `rgb(${preset})` }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}