/**
 * 主题编辑器 — 全屏模态编辑（方案B风格）
 *
 * 支持编辑：基本信息、颜色系统、沉浸效果、壁纸
 * 实时预览 + 保存
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { ThemeDefinition } from '@/types/theme';
import { applyThemeSync } from '@/services/themeEngine';
import { ColorPicker } from './ColorPicker';

interface ThemeEditorProps {
  theme: ThemeDefinition;
  onSave: (theme: ThemeDefinition) => void;
  onClose: () => void;
}

export function ThemeEditor({ theme: initialTheme, onSave, onClose }: ThemeEditorProps) {
  const { t } = useTranslation('settings');
  const [draft, setDraft] = React.useState<ThemeDefinition>(() => JSON.parse(JSON.stringify(initialTheme)));
  const [activeColorSection, setActiveColorSection] = React.useState<string>('primary');
  const [editingColorKey, setEditingColorKey] = React.useState<string | null>(null);
  const [editingColorValue, setEditingColorValue] = React.useState<string>('');

  // 实时预览：每次 draft 变化时同步到 DOM
  React.useEffect(() => {
    applyThemeSync(draft.id);
  }, [draft]);

  const updateDraft = (patch: Partial<ThemeDefinition>) => {
    setDraft((prev) => ({ ...prev, ...patch, updatedAt: new Date().toISOString() }));
  };

  const updateColor = (category: string, shade: string, value: string) => {
    setDraft((prev) => ({
      ...prev,
      colors: {
        ...prev.colors,
        [category]: {
          ...(prev.colors as any)[category],
          [shade]: value,
        },
      },
    }));
  };

  const updateImmersive = (path: string, value: any) => {
    setDraft((prev) => {
      const immersive = { ...prev.immersive, enabled: prev.immersive?.enabled ?? false };
      // 简单路径解析：wallpaper.opacity → immersive.wallpaper.opacity
      const parts = path.split('.');
      let obj: any = immersive;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]]) obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = value;
      return { ...prev, immersive };
    });
  };

  const openColorPicker = (category: string, shade: string, currentValue: string) => {
    setEditingColorKey(`${category}.${shade}`);
    setEditingColorValue(currentValue);
  };

  const sections = [
    { key: 'primary', label: 'Primary 主色', shades: ['base', 'hover', '50', '100', '200', '300', '400', '500', '600', '700'] },
    { key: 'background', label: 'Background 背景', shades: ['base', 'elevated', 'surface', 'hover', 'active', 'tertiary', 'secondary'] },
    { key: 'text', label: 'Text 文字', shades: ['primary', 'secondary', 'tertiary', 'muted'] },
    { key: 'border', label: 'Border 边框', shades: ['base'] },
    { key: 'status', label: 'Status 状态', shades: ['warning', 'success', 'danger', 'info', 'done', 'failed', 'neutral'] },
    { key: 'priority', label: 'Priority 优先级', shades: ['low', 'normal', 'high', 'urgent'] },
    { key: 'accent', label: 'Accent 强调色', shades: ['ai', 'prototype', 'workspace'] },
    { key: 'misc', label: 'Misc 杂项', shades: ['overlay', 'onPrimary', 'canvas', 'tagBg', 'shadow'] },
  ];

  const currentSection = sections.find((s) => s.key === activeColorSection);

  // 将 RGB 三元组转换为 hex 用于色块显示
  const rgbToHex = (rgb: string): string => {
    const parts = rgb.trim().split(/\s+/).map(Number);
    if (parts.length < 3 || parts.some(isNaN)) return `#${rgb}`;
    return '#' + parts.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-[740px] max-h-[85vh] bg-surface rounded-2xl border border-border shadow-2xl flex flex-col overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <h2 className="text-base font-semibold text-text-primary">
            {t('settings:theme.editing', '编辑主题')} — {draft.name}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-background-hover text-text-secondary hover:text-text-primary hover:bg-background-active transition-colors flex items-center justify-center"
          >
            ✕
          </button>
        </div>

        {/* 主体 */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* 基本信息 */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">{t('settings:theme.basicInfo', '基本信息')}</h3>
            <div className="flex gap-3">
              <input
                type="text"
                value={draft.name}
                onChange={(e) => updateDraft({ name: e.target.value.slice(0, 32) })}
                placeholder={t('settings:theme.namePlaceholder', '主题名称')}
                className="flex-1 px-3 py-2 text-sm bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary transition-colors"
              />
              <input
                type="text"
                value={draft.description ?? ''}
                onChange={(e) => updateDraft({ description: e.target.value })}
                placeholder={t('settings:theme.descPlaceholder', '主题描述（可选）')}
                className="flex-[2] px-3 py-2 text-sm bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary transition-colors"
              />
            </div>
          </div>

          {/* 颜色系统 */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">{t('settings:theme.colors', '颜色系统')}</h3>

            {/* 色组选择器 */}
            <div className="flex gap-1.5 flex-wrap">
              {sections.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setActiveColorSection(s.key)}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                    activeColorSection === s.key
                      ? 'bg-primary text-on-primary'
                      : 'bg-background-hover text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {/* 色块网格 */}
            {currentSection && (
              <div className="grid grid-cols-5 gap-2">
                {currentSection.shades.map((shade) => {
                  const value = (draft.colors as any)[currentSection.key]?.[shade] ?? '';
                  const hex = rgbToHex(value);
                  return (
                    <div
                      key={shade}
                      className="flex flex-col items-center gap-1 cursor-pointer group"
                      onClick={() => openColorPicker(currentSection.key, shade, value)}
                    >
                      <div
                        className="w-full aspect-video rounded-lg border border-border-subtle group-hover:border-primary transition-colors"
                        style={{ background: value ? `rgb(${value})` : '#333' }}
                      />
                      <span className="text-[10px] text-text-muted truncate w-full text-center">{shade}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* 颜色选择器弹窗 */}
            {editingColorKey && (
              <ColorPicker
                value={editingColorValue}
                onChange={(newVal) => {
                  const [cat, shade] = editingColorKey.split('.');
                  updateColor(cat, shade, newVal);
                  setEditingColorValue(newVal);
                }}
                onClose={() => setEditingColorKey(null)}
              />
            )}
          </div>

          {/* 沉浸效果 */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">{t('settings:theme.immersive', '沉浸效果')}</h3>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.immersive?.enabled ?? false}
                onChange={(e) => {
                  if (e.target.checked) {
                    updateDraft({
                      immersive: {
                        enabled: true,
                        wallpaper: { type: 'image', image: '', opacity: 0.8, positionX: 50, positionY: 50, size: 'cover' },
                        layerOpacity: { panel: 0.55, surface: 0.50, child: 0.55 },
                        effects: { panelBlur: 8, webTexture: 0.15, blueAccent: 0.5, hoverOpacity: 0.5 },
                      },
                    });
                  } else {
                    updateDraft({ immersive: { ...draft.immersive!, enabled: false } });
                  }
                }}
                className="w-4 h-4 accent-primary"
              />
              <span className="text-sm text-text-secondary">{t('settings:theme.enableImmersive', '开启沉浸效果（背景壁纸、面板透明、磨砂）')}</span>
            </label>

            {draft.immersive?.enabled && (
              <div className="space-y-3 pl-4 border-l-2 border-primary/30">
                {/* 壁纸 */}
                <div className="space-y-2">
                  <h4 className="text-xs font-medium text-text-primary">{t('settings:theme.wallpaper', '壁纸')}</h4>
                  <div className="flex gap-2 flex-wrap">
                    {['image', 'gradient', 'solid', 'none'].map((type) => (
                      <button
                        key={type}
                        type="button"
                        onClick={() => updateImmersive('wallpaper.type', type)}
                        className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                          draft.immersive?.wallpaper.type === type
                            ? 'bg-primary text-on-primary'
                            : 'bg-background-hover text-text-secondary'
                        }`}
                      >
                        {type === 'image' ? '图片' : type === 'gradient' ? '渐变' : type === 'solid' ? '纯色' : '无'}
                      </button>
                    ))}
                  </div>
                  {draft.immersive?.wallpaper.type === 'image' && (
                    <input
                      type="text"
                      value={draft.immersive?.wallpaper.image ?? ''}
                      onChange={(e) => updateImmersive('wallpaper.image', e.target.value)}
                      placeholder={t('settings:theme.imageUrlPlaceholder', '输入图片 URL 或上传')}
                      className="w-full px-3 py-2 text-sm bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary"
                    />
                  )}
                </div>

                {/* 滑动条 */}
                {[
                  { key: 'wallpaper.opacity', label: '背景可见度', min: 0, max: 100, suffix: '%' },
                  { key: 'layerOpacity.panel', label: '面板透明度', min: 0, max: 100, suffix: '%' },
                  { key: 'layerOpacity.surface', label: '内容透明度', min: 0, max: 100, suffix: '%' },
                  { key: 'layerOpacity.child', label: '工具面板透明度', min: 0, max: 100, suffix: '%' },
                  { key: 'effects.panelBlur', label: '面板磨砂', min: 0, max: 32, suffix: 'px' },
                  { key: 'effects.webTexture', label: '蛛网纹理', min: 0, max: 35, suffix: '%' },
                  { key: 'effects.blueAccent', label: '蓝色强调', min: 0, max: 100, suffix: '%' },
                  { key: 'effects.hoverOpacity', label: '悬停透明度', min: 0, max: 100, suffix: '%' },
                ].map(({ key, label, min, max, suffix }) => {
                  const parts = key.split('.');
                  let val: any = draft.immersive;
                  for (const p of parts) { val = val?.[p]; }
                  const numVal = typeof val === 'number' ? val * (key.includes('opacity') || key.includes('webTexture') || key.includes('blueAccent') ? 100 : 1) : 0;
                  return (
                    <div key={key} className="flex items-center gap-3">
                      <span className="text-xs text-text-secondary w-20 shrink-0">{label}</span>
                      <input
                        type="range"
                        min={min}
                        max={max}
                        value={numVal}
                        onChange={(e) => {
                          const raw = Number(e.target.value);
                          const normalized = key.includes('opacity') || key.includes('webTexture') || key.includes('blueAccent') ? raw / 100 : raw;
                          updateImmersive(key, normalized);
                        }}
                        className="flex-1 h-1 bg-border rounded-full appearance-none cursor-pointer accent-primary"
                      />
                      <span className="text-xs text-text-muted w-10 text-right tabular-nums">
                        {Math.round(numVal)}{suffix}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border-subtle">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs rounded-lg bg-background-hover text-text-secondary hover:text-text-primary transition-colors"
          >
            {t('common:cancel', '取消')}
          </button>
          <button
            type="button"
            onClick={() => {
              const reset = JSON.parse(JSON.stringify(initialTheme));
              setDraft(reset);
            }}
            className="px-4 py-2 text-xs rounded-lg bg-background-hover text-text-secondary hover:text-text-primary transition-colors"
          >
            {t('settings:theme.reset', '重置')}
          </button>
          <button
            type="button"
            onClick={() => onSave(draft)}
            className="px-4 py-2 text-xs rounded-lg bg-primary text-on-primary hover:bg-primary-600 transition-colors"
          >
            {t('settings:theme.save', '保存主题')}
          </button>
        </div>
      </div>
    </div>
  );
}