/**
 * ThemeCustomEditors - 自定义主题的背景/尺寸/特效编辑子组件
 *
 * 均为受控组件：接收当前值 + onChange，无内部持久化。
 */

import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { rgbTripleToHex, hexToRgbTriple } from '@/types/theme';
import type {
  BackgroundConfig,
  BackgroundType,
  ThemeSizing,
  ThemeEffects,
  RadiusScale,
  UiFontFamily,
  BackdropBlurScale,
  ShadowScale,
  GradientStop,
} from '@/types/theme';

/** 通用分段选择器 */
function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex rounded-lg bg-background-base border border-border-subtle p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(opt.value)}
          className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
            value === opt.value
              ? 'bg-primary text-on-primary'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** 行容器 */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-xs text-text-secondary">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

// ============ 背景编辑器 ============

export const BackgroundEditor = memo(function BackgroundEditor({
  value,
  onChange,
  disabled,
}: {
  value: BackgroundConfig;
  onChange: (v: BackgroundConfig) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('settings');

  const setType = useCallback(
    (type: BackgroundType) => onChange({ ...value, type }),
    [value, onChange],
  );

  const updateGradientStop = (index: number, patch: Partial<GradientStop>) => {
    const gradient = value.gradient ?? { direction: '135deg', stops: [] };
    const stops = gradient.stops.map((s, i) => (i === index ? { ...s, ...patch } : s));
    onChange({ ...value, gradient: { ...gradient, stops } });
  };

  const addGradientStop = () => {
    const gradient = value.gradient ?? { direction: '135deg', stops: [] };
    const stops = [...gradient.stops, { color: '59 130 246', position: 100 }];
    onChange({ ...value, gradient: { ...gradient, stops } });
  };

  const removeGradientStop = (index: number) => {
    const gradient = value.gradient ?? { direction: '135deg', stops: [] };
    const stops = gradient.stops.filter((_, i) => i !== index);
    onChange({ ...value, gradient: { ...gradient, stops } });
  };

  return (
    <div className="space-y-2">
      <Row label={t('themeCustom.background.type')}>
        <SegmentedControl<BackgroundType>
          value={value.type}
          onChange={setType}
          disabled={disabled}
          options={[
            { value: 'none', label: t('themeCustom.background.none') },
            { value: 'solid', label: t('themeCustom.background.solid') },
            { value: 'gradient', label: t('themeCustom.background.gradient') },
            { value: 'image', label: t('themeCustom.background.image') },
          ]}
        />
      </Row>

      {value.type === 'solid' && (
        <Row label={t('themeCustom.background.solidColor')}>
          <input
            type="color"
            value={rgbTripleToHex(value.solidColor ?? '15 15 17')}
            disabled={disabled}
            onChange={(e) => {
              const triple = hexToRgbTriple(e.target.value);
              if (triple) onChange({ ...value, solidColor: triple });
            }}
            className="w-8 h-7 rounded border border-border cursor-pointer bg-transparent"
          />
        </Row>
      )}

      {value.type === 'gradient' && (
        <div className="space-y-2 pl-1">
          <Row label={t('themeCustom.background.gradientDirection')}>
            <input
              type="text"
              value={value.gradient?.direction ?? '135deg'}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...value,
                  gradient: {
                    direction: e.target.value,
                    stops: value.gradient?.stops ?? [],
                  },
                })
              }
              className="w-20 bg-background-base border border-border-subtle rounded px-1.5 py-1 text-xs text-text-primary font-mono focus:outline-none focus:border-primary"
            />
          </Row>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary">{t('themeCustom.background.gradientStops')}</span>
              <button
                type="button"
                onClick={addGradientStop}
                disabled={disabled}
                className="flex items-center gap-1 text-xs text-primary hover:text-primary-hover"
              >
                <Plus size={12} /> {t('themeCustom.background.addStop')}
              </button>
            </div>
            {(value.gradient?.stops ?? []).map((stop, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="color"
                  value={rgbTripleToHex(stop.color)}
                  disabled={disabled}
                  onChange={(e) => {
                    const triple = hexToRgbTriple(e.target.value);
                    if (triple) updateGradientStop(i, { color: triple });
                  }}
                  className="w-7 h-7 rounded border border-border cursor-pointer bg-transparent"
                />
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={stop.position}
                  disabled={disabled}
                  onChange={(e) => updateGradientStop(i, { position: Number(e.target.value) })}
                  className="flex-1 accent-primary"
                />
                <span className="w-9 text-xs text-text-tertiary text-right">{stop.position}%</span>
                <button
                  type="button"
                  onClick={() => removeGradientStop(i)}
                  disabled={disabled}
                  className="p-1 text-text-tertiary hover:text-danger"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {value.type === 'image' && (
        <div className="space-y-2 pl-1">
          <div className="space-y-1">
            <span className="text-xs text-text-secondary">{t('themeCustom.background.imageUrl')}</span>
            <input
              type="text"
              value={value.image?.url ?? ''}
              disabled={disabled}
              placeholder={t('themeCustom.background.imageUrlPlaceholder')}
              onChange={(e) =>
                onChange({
                  ...value,
                  image: {
                    url: e.target.value,
                    size: value.image?.size ?? 'cover',
                    position: value.image?.position ?? 'center center',
                    repeat: value.image?.repeat ?? 'no-repeat',
                    opacity: value.image?.opacity ?? 1,
                    blur: value.image?.blur ?? 0,
                  },
                })
              }
              className="w-full bg-background-base border border-border-subtle rounded px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:border-primary"
            />
          </div>
          <Row label={t('themeCustom.background.size')}>
            <SegmentedControl
              value={value.image?.size ?? 'cover'}
              disabled={disabled}
              onChange={(size) =>
                value.image && onChange({ ...value, image: { ...value.image, size } })
              }
              options={[
                { value: 'cover', label: t('themeCustom.background.sizeCover') },
                { value: 'contain', label: t('themeCustom.background.sizeContain') },
                { value: 'auto', label: t('themeCustom.background.sizeAuto') },
              ]}
            />
          </Row>
          <Row label={t('themeCustom.background.opacity')}>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round((value.image?.opacity ?? 1) * 100)}
              disabled={disabled}
              onChange={(e) =>
                value.image &&
                onChange({ ...value, image: { ...value.image, opacity: Number(e.target.value) / 100 } })
              }
              className="w-32 accent-primary"
            />
            <span className="w-9 text-xs text-text-tertiary text-right">
              {Math.round((value.image?.opacity ?? 1) * 100)}%
            </span>
          </Row>
          <Row label={t('themeCustom.background.blur')}>
            <input
              type="range"
              min={0}
              max={40}
              value={value.image?.blur ?? 0}
              disabled={disabled}
              onChange={(e) =>
                value.image &&
                onChange({ ...value, image: { ...value.image, blur: Number(e.target.value) } })
              }
              className="w-32 accent-primary"
            />
            <span className="w-9 text-xs text-text-tertiary text-right">{value.image?.blur ?? 0}px</span>
          </Row>
        </div>
      )}
    </div>
  );
});

// ============ 尺寸/字体编辑器 ============

export const SizingEditor = memo(function SizingEditor({
  value,
  onChange,
  disabled,
}: {
  value: ThemeSizing;
  onChange: (v: ThemeSizing) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('settings');
  return (
    <div className="space-y-1">
      <Row label={t('themeCustom.sizing.radius')}>
        <SegmentedControl<RadiusScale>
          value={value.radius ?? 'standard'}
          disabled={disabled}
          onChange={(radius) => onChange({ ...value, radius })}
          options={[
            { value: 'sharp', label: t('themeCustom.sizing.radiusSharp') },
            { value: 'compact', label: t('themeCustom.sizing.radiusCompact') },
            { value: 'standard', label: t('themeCustom.sizing.radiusStandard') },
            { value: 'rounded', label: t('themeCustom.sizing.radiusRounded') },
          ]}
        />
      </Row>
      <Row label={t('themeCustom.sizing.fontFamily')}>
        <SegmentedControl<UiFontFamily>
          value={value.fontFamily ?? 'system'}
          disabled={disabled}
          onChange={(fontFamily) => onChange({ ...value, fontFamily })}
          options={[
            { value: 'system', label: t('themeCustom.sizing.fontSystem') },
            { value: 'serif', label: t('themeCustom.sizing.fontSerif') },
            { value: 'mono', label: t('themeCustom.sizing.fontMono') },
            { value: 'rounded', label: t('themeCustom.sizing.fontRounded') },
          ]}
        />
      </Row>
    </div>
  );
});

// ============ 特效编辑器 ============

export const EffectsEditor = memo(function EffectsEditor({
  value,
  onChange,
  disabled,
}: {
  value: ThemeEffects;
  onChange: (v: ThemeEffects) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('settings');
  return (
    <div className="space-y-1">
      <Row label={t('themeCustom.effects.windowOpacity')}>
        <input
          type="range"
          min={30}
          max={100}
          value={Math.round((value.windowOpacity ?? 1) * 100)}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, windowOpacity: Number(e.target.value) / 100 })}
          className="w-32 accent-primary"
        />
        <span className="w-9 text-xs text-text-tertiary text-right">
          {Math.round((value.windowOpacity ?? 1) * 100)}%
        </span>
      </Row>
      <Row label={t('themeCustom.effects.backdropBlur')}>
        <SegmentedControl<BackdropBlurScale>
          value={value.backdropBlur ?? 'none'}
          disabled={disabled}
          onChange={(backdropBlur) => onChange({ ...value, backdropBlur })}
          options={[
            { value: 'none', label: t('themeCustom.effects.blurNone') },
            { value: 'subtle', label: t('themeCustom.effects.blurSubtle') },
            { value: 'medium', label: t('themeCustom.effects.blurMedium') },
            { value: 'strong', label: t('themeCustom.effects.blurStrong') },
          ]}
        />
      </Row>
      <Row label={t('themeCustom.effects.shadow')}>
        <SegmentedControl<ShadowScale>
          value={value.shadow ?? 'default'}
          disabled={disabled}
          onChange={(shadow) => onChange({ ...value, shadow })}
          options={[
            { value: 'none', label: t('themeCustom.effects.shadowNone') },
            { value: 'subtle', label: t('themeCustom.effects.shadowSubtle') },
            { value: 'default', label: t('themeCustom.effects.shadowDefault') },
            { value: 'strong', label: t('themeCustom.effects.shadowStrong') },
          ]}
        />
      </Row>
    </div>
  );
});
