/**
 * 窗口设置 Tab
 * 包含大窗/小窗独立透明度设置
 */

import { useTranslation } from 'react-i18next';
import type { Config, WindowSettings } from '@/types';

interface WindowTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

export function WindowTab({ config, onConfigChange, loading }: WindowTabProps) {
  const { t } = useTranslation('settings');

  // 获取窗口设置，默认值
  const windowSettings: WindowSettings = config.window || {
    normalOpacity: 100,
    compactOpacity: 100,
  };

  // 处理大窗透明度变化
  const handleNormalOpacityChange = (value: number) => {
    onConfigChange({
      ...config,
      window: { ...windowSettings, normalOpacity: value },
    });
  };

  // 处理小窗透明度变化
  const handleCompactOpacityChange = (value: number) => {
    onConfigChange({
      ...config,
      window: { ...windowSettings, compactOpacity: value },
    });
  };

  // 透明度滑块组件
  const OpacitySlider = ({
    label,
    hint,
    value,
    onChange,
  }: {
    label: string;
    hint: string;
    value: number;
    onChange: (value: number) => void;
  }) => (
    <div className="flex items-center justify-between">
      <div className="flex-1 mr-4">
        <div className="text-sm text-text-primary">{label}</div>
        <div className="text-xs text-text-secondary">{hint}</div>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min="0"
          max="100"
          step="5"
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
          disabled={loading}
          className="w-24 h-1.5 bg-border rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
        />
        <span className="text-xs text-text-secondary w-10 text-right">
          {value}%
        </span>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* 窗口透明度设置 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">
          {t('window.opacityTitle')}
        </h3>

        {/* 大窗模式透明度 */}
        <div className="mb-4">
          <OpacitySlider
            label={t('window.normalOpacity')}
            hint={t('window.normalOpacityHint')}
            value={windowSettings.normalOpacity}
            onChange={handleNormalOpacityChange}
          />
        </div>

        {/* 小屏模式透明度 */}
        <OpacitySlider
          label={t('window.compactOpacity')}
          hint={t('window.compactOpacityHint')}
          value={windowSettings.compactOpacity}
          onChange={handleCompactOpacityChange}
        />
      </div>
    </div>
  );
}
