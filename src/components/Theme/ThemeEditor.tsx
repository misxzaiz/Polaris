/**
 * 主题编辑器 — 全屏模态编辑（方案B风格）
 *
 * 支持 7 层完整编辑：
 * - L0 颜色系统
 * - L1 排版（字体族/字号/行高/字重/字间距）
 * - L2 形状（圆角/边框/内边距）
 * - L4 沉浸效果（壁纸/透明度/磨砂/蛛网）
 * - L5 布局（窗口透明度/消息间距/段落间距）
 * - L6 自定义 CSS
 *
 * 内置 ThemePreview 微缩预览，实时反映改动
 * 取消时自动回滚到编辑前的主题
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { ThemeDefinition } from '@/types/theme';
import { applyThemeSync, applyCustomCss, clearCustomCss } from '@/services/themeEngine';
import { validateCustomCss } from '@/utils/cssValidator';
import { ColorPicker } from './ColorPicker';
import { ThemePreview } from './ThemePreview';
import { PRESET_AVATARS, PRESET_BACKGROUNDS } from '@/data/themeAssets';
import { CssEditor } from './CssEditor';

interface ThemeEditorProps {
  theme: ThemeDefinition;
  onSave: (theme: ThemeDefinition) => void;
  onClose: () => void;
}

const FONT_PRESETS = [
  { label: '系统默认', value: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' },
  { label: 'Inter', value: '"Inter", system-ui, sans-serif' },
  { label: 'Roboto', value: '"Roboto", system-ui, sans-serif' },
  { label: '思源黑体', value: '"Noto Sans SC", "Source Han Sans SC", sans-serif' },
  { label: '微软雅黑', value: '"Microsoft YaHei", "PingFang SC", sans-serif' },
];

const MONO_PRESETS = [
  { label: 'JetBrains Mono', value: '"JetBrains Mono", "Fira Code", monospace' },
  { label: 'Fira Code', value: '"Fira Code", "Cascadia Code", monospace' },
  { label: 'SF Mono', value: '"SF Mono", Monaco, Consolas, monospace' },
  { label: 'Cascadia', value: '"Cascadia Code", "Cascadia Mono", monospace' },
];

const EASE_PRESETS = ['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'cubic-bezier(0.4, 0, 0.2, 1)'];

export function ThemeEditor({ theme: initialTheme, onSave, onClose }: ThemeEditorProps) {
  const { t } = useTranslation('settings');
  const [draft, setDraft] = React.useState<ThemeDefinition>(() => JSON.parse(JSON.stringify(initialTheme)));
  const [activeColorSection, setActiveColorSection] = React.useState<string>('primary');
  const [editingColorKey, setEditingColorKey] = React.useState<string | null>(null);
  const [editingColorValue, setEditingColorValue] = React.useState<string>('');
  const [activeTab, setActiveTab] = React.useState<'colors' | 'typography' | 'shape' | 'motion' | 'immersive' | 'layout' | 'css'>('colors');
  const [cssError, setCssError] = React.useState<string | null>(null);

  // 实时预览：每次 draft 变化时同步到 DOM（全应用变化）
  React.useEffect(() => {
    applyThemeSync(draft.id);
    if (draft.customCss) {
      applyCustomCss(draft.customCss);
    } else {
      clearCustomCss();
    }
  }, [draft]);

  // 取消时回滚到初始主题
  const handleClose = React.useCallback(() => {
    applyThemeSync(initialTheme.id);
    if (initialTheme.customCss) {
      applyCustomCss(initialTheme.customCss);
    } else {
      clearCustomCss();
    }
    onClose();
  }, [initialTheme, onClose]);

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

  const updateTypography = (patch: Partial<ThemeDefinition['typography']>) => {
    setDraft((prev) => ({
      ...prev,
      typography: { ...prev.typography, ...patch },
    }));
  };

  const updateShape = (patch: Partial<ThemeDefinition['shape']>) => {
    setDraft((prev) => ({
      ...prev,
      shape: { ...prev.shape, ...patch },
    }));
  };

  const updateMotion = (patch: Partial<ThemeDefinition['motion']>) => {
    setDraft((prev) => ({
      ...prev,
      motion: { ...(prev.motion || {}), ...patch } as ThemeDefinition['motion'],
    }));
  };

  const updateLayout = (patch: Partial<ThemeDefinition['layout']>) => {
    setDraft((prev) => ({
      ...prev,
      layout: { ...prev.layout, ...patch },
    }));
  };

  const updateImmersive = (path: string, value: any) => {
    setDraft((prev) => {
      const immersive = structuredClone(prev.immersive ?? {
        enabled: false,
        wallpaper: { type: 'image', image: '', opacity: 0.5, positionX: 50, positionY: 50, size: 'cover' },
        layerOpacity: { panel: 0.5, surface: 0.5, child: 0.5 },
        effects: { panelBlur: 0, webTexture: 0, blueAccent: 0, hoverOpacity: 0.5 },
      }) as ThemeDefinition['immersive'];
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

  const handleCustomCssChange = (css: string) => {
    const validation = validateCustomCss(css);
    setCssError(validation.valid ? null : validation.errors[0]);
    updateDraft({ customCss: css });
  };

  const colorSections = [
    { key: 'primary', label: 'Primary 主色', shades: ['base', 'hover', '50', '100', '200', '300', '400', '500', '600', '700'] },
    { key: 'background', label: 'Background 背景', shades: ['base', 'elevated', 'surface', 'hover', 'active', 'tertiary', 'secondary'] },
    { key: 'text', label: 'Text 文字', shades: ['primary', 'secondary', 'tertiary', 'muted'] },
    { key: 'border', label: 'Border 边框', shades: ['base'] },
    { key: 'status', label: 'Status 状态', shades: ['warning', 'success', 'danger', 'info', 'done', 'failed', 'neutral'] },
    { key: 'priority', label: 'Priority 优先级', shades: ['low', 'normal', 'high', 'urgent'] },
    { key: 'accent', label: 'Accent 强调色', shades: ['ai', 'prototype', 'workspace'] },
    { key: 'misc', label: 'Misc 杂项', shades: ['overlay', 'onPrimary', 'canvas', 'tagBg', 'shadow'] },
  ];

  const currentSection = colorSections.find((s) => s.key === activeColorSection);

  const tabs = [
    { key: 'colors', label: '颜色' },
    { key: 'typography', label: '排版' },
    { key: 'shape', label: '形状' },
    { key: 'motion', label: '动效' },
    { key: 'immersive', label: '沉浸' },
    { key: 'layout', label: '布局' },
    { key: 'css', label: '自定义CSS' },
  ] as const;

  // 通用滑块组件
  const Slider = ({ label, value, min, max, step = 1, suffix = '', onChange }: {
    label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (v: number) => void;
  }) => (
    <div className="flex items-center gap-3">
      <span className="text-xs text-text-secondary w-24 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 h-1 bg-border rounded-full appearance-none cursor-pointer accent-primary"
      />
      <span className="text-xs text-text-muted w-12 text-right tabular-nums">
        {typeof value === 'number' ? (step < 1 ? value.toFixed(2) : Math.round(value)) : value}{suffix}
      </span>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={(e) => e.target === e.currentTarget && handleClose()}>
      {draft.immersive?.enabled && (
        <div className="fixed inset-0 z-40 pointer-events-none"
          style={{
            background: draft.immersive?.wallpaper?.image ? `url(${draft.immersive.wallpaper.image}) center/cover no-repeat` : undefined,
            opacity: (draft.immersive?.wallpaper?.opacity ?? 0.15) * 100 + '%',
          }}
        />
      )}
      <div className="w-full md:w-[860px] max-h-[88vh] bg-surface rounded-2xl border border-border shadow-2xl flex flex-col overflow-hidden" style={{
        backgroundColor: draft.immersive?.layerOpacity?.surface ? `rgba(30, 30, 30, ${1 - draft.immersive.layerOpacity.surface})` : undefined,
        backdropFilter: draft.immersive?.effects?.panelBlur ? `blur(${draft.immersive.effects.panelBlur}px)` : undefined,
      }}>
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <h2 className="text-base font-semibold text-text-primary">
            {t('settings:theme.editing', '编辑主题')} — {draft.name}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="w-8 h-8 rounded-lg bg-background-hover text-text-secondary hover:text-text-primary hover:bg-background-active transition-colors flex items-center justify-center"
          >
            ✕
          </button>
        </div>

        {/* 主体：桌面左右分栏，手机上下堆叠 */}
        <div className="flex flex-1 overflow-hidden flex-col md:flex-row">
          {/* 左侧：编辑区 */}
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {/* Tab 切换 */}
            <div className="flex gap-1 px-5 pt-3 pb-2 border-b border-border-subtle">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                    activeTab === tab.key
                      ? 'bg-primary text-on-primary'
                      : 'bg-background-hover text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* 编辑内容 */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* 基本信息（始终显示） */}
              <div className="space-y-2">
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

              {/* L0 颜色 */}
              {activeTab === 'colors' && (
                <div className="space-y-3">
                  <div className="flex gap-1.5 flex-wrap">
                    {colorSections.map((s) => (
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
                  {currentSection && (
                    <div className="grid grid-cols-5 gap-2">
                      {currentSection.shades.map((shade) => {
                        const value = (draft.colors as any)[currentSection.key]?.[shade] ?? '';
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
              )}

              {/* L1 排版 */}
              {activeTab === 'typography' && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <h4 className="text-xs font-medium text-text-primary">全局字体</h4>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-text-secondary w-16 shrink-0">无衬线</label>
                      <select
                        value={draft.typography.fontSans}
                        onChange={(e) => updateTypography({ fontSans: e.target.value })}
                        className="flex-1 px-2 py-1.5 text-xs bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary"
                      >
                        {FONT_PRESETS.map((f) => (
                          <option key={f.label} value={f.value}>{f.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-text-secondary w-16 shrink-0">等宽</label>
                      <select
                        value={draft.typography.fontMono}
                        onChange={(e) => updateTypography({ fontMono: e.target.value })}
                        className="flex-1 px-2 py-1.5 text-xs bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary"
                      >
                        {MONO_PRESETS.map((f) => (
                          <option key={f.label} value={f.value}>{f.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <h4 className="text-xs font-medium text-text-primary">聊天排版</h4>
                    <Slider label="正文字号" value={draft.typography.chatFontSize} min={12} max={20} suffix="px" onChange={(v) => updateTypography({ chatFontSize: v })} />
                    <Slider label="行高" value={draft.typography.chatLineHeight} min={1.35} max={1.8} step={0.05} onChange={(v) => updateTypography({ chatLineHeight: v })} />
                    <Slider label="代码字号" value={draft.typography.chatCodeFontSize} min={11} max={18} suffix="px" onChange={(v) => updateTypography({ chatCodeFontSize: v })} />
                    <Slider label="输入框字号" value={draft.typography.chatInputFontSize} min={12} max={20} suffix="px" onChange={(v) => updateTypography({ chatInputFontSize: v })} />
                  </div>

                  <div className="space-y-2">
                    <h4 className="text-xs font-medium text-text-primary">字重与间距</h4>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-text-secondary w-24 shrink-0">常规字重</label>
                      <input
                        type="text"
                        value={draft.typography.fontWeightNormal}
                        onChange={(e) => updateTypography({ fontWeightNormal: e.target.value })}
                        className="flex-1 px-2 py-1.5 text-xs bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-text-secondary w-24 shrink-0">中等字重</label>
                      <input
                        type="text"
                        value={draft.typography.fontWeightMedium}
                        onChange={(e) => updateTypography({ fontWeightMedium: e.target.value })}
                        className="flex-1 px-2 py-1.5 text-xs bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-text-secondary w-24 shrink-0">半粗字重</label>
                      <input
                        type="text"
                        value={draft.typography.fontWeightSemibold}
                        onChange={(e) => updateTypography({ fontWeightSemibold: e.target.value })}
                        className="flex-1 px-2 py-1.5 text-xs bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-text-secondary w-24 shrink-0">字间距</label>
                      <input
                        type="text"
                        value={draft.typography.letterSpacing}
                        onChange={(e) => updateTypography({ letterSpacing: e.target.value })}
                        className="flex-1 px-2 py-1.5 text-xs bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* L2 形状 */}
              {activeTab === 'shape' && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <h4 className="text-xs font-medium text-text-primary">圆角尺度</h4>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-text-secondary w-20 shrink-0">小 (sm)</label>
                      <input
                        type="text"
                        value={draft.shape.radiusSm}
                        onChange={(e) => updateShape({ radiusSm: e.target.value })}
                        className="flex-1 px-2 py-1.5 text-xs bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-text-secondary w-20 shrink-0">中 (md)</label>
                      <input
                        type="text"
                        value={draft.shape.radiusMd}
                        onChange={(e) => updateShape({ radiusMd: e.target.value })}
                        className="flex-1 px-2 py-1.5 text-xs bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-text-secondary w-20 shrink-0">大 (lg)</label>
                      <input
                        type="text"
                        value={draft.shape.radiusLg}
                        onChange={(e) => updateShape({ radiusLg: e.target.value })}
                        className="flex-1 px-2 py-1.5 text-xs bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-text-secondary w-20 shrink-0">超大 (xl)</label>
                      <input
                        type="text"
                        value={draft.shape.radiusXl}
                        onChange={(e) => updateShape({ radiusXl: e.target.value })}
                        className="flex-1 px-2 py-1.5 text-xs bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-text-secondary w-20 shrink-0">气泡圆角</label>
                      <input
                        type="text"
                        value={draft.shape.chatBubbleRadius}
                        onChange={(e) => updateShape({ chatBubbleRadius: e.target.value })}
                        className="flex-1 px-2 py-1.5 text-xs bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <h4 className="text-xs font-medium text-text-primary">边框</h4>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-text-secondary w-20 shrink-0">边框宽度</label>
                      <input
                        type="text"
                        value={draft.shape.borderWidth}
                        onChange={(e) => updateShape({ borderWidth: e.target.value })}
                        className="flex-1 px-2 py-1.5 text-xs bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-text-secondary w-20 shrink-0">边框样式</label>
                      <select
                        value={draft.shape.borderStyle}
                        onChange={(e) => updateShape({ borderStyle: e.target.value })}
                        className="flex-1 px-2 py-1.5 text-xs bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary"
                      >
                        <option value="solid">solid</option>
                        <option value="dashed">dashed</option>
                        <option value="dotted">dotted</option>
                        <option value="none">none</option>
                      </select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <h4 className="text-xs font-medium text-text-primary">气泡内边距</h4>
                    <Slider label="水平内边距" value={parseInt(draft.shape.chatBubblePaddingX) || 16} min={8} max={24} suffix="px"
                      onChange={(v) => updateShape({ chatBubblePaddingX: `${v}px` })} />
                    <Slider label="垂直内边距" value={parseInt(draft.shape.chatBubblePaddingY) || 12} min={4} max={20} suffix="px"
                      onChange={(v) => updateShape({ chatBubblePaddingY: `${v}px` })} />
                  </div>
                </div>
              )}

              {/* L3 动效 */}
              {activeTab === 'motion' && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <h4 className="text-xs font-medium text-text-primary">过渡时长</h4>
                    <Slider label="快" value={parseInt(draft.motion?.transitionFast || '150') || 150} min={50} max={500} step={10} suffix="ms"
                      onChange={(v) => updateMotion({ transitionFast: `${v}ms` })} />
                    <Slider label="中" value={parseInt(draft.motion?.transitionNormal || '250') || 250} min={100} max={800} step={10} suffix="ms"
                      onChange={(v) => updateMotion({ transitionNormal: `${v}ms` })} />
                    <Slider label="慢" value={parseInt(draft.motion?.transitionSlow || '400') || 400} min={200} max={1500} step={50} suffix="ms"
                      onChange={(v) => updateMotion({ transitionSlow: `${v}ms` })} />
                  </div>
                  <div className="space-y-2">
                    <h4 className="text-xs font-medium text-text-primary">缓动函数</h4>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-text-secondary w-20 shrink-0">默认</label>
                      <select
                        value={draft.motion?.easeDefault || 'ease'}
                        onChange={(e) => updateMotion({ easeDefault: e.target.value })}
                        className="flex-1 px-2 py-1.5 text-xs bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary"
                      >
                        {EASE_PRESETS.map((e) => <option key={e} value={e}>{e}</option>)}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-text-secondary w-20 shrink-0">进入</label>
                      <select
                        value={draft.motion?.easeIn || 'ease-in'}
                        onChange={(e) => updateMotion({ easeIn: e.target.value })}
                        className="flex-1 px-2 py-1.5 text-xs bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary"
                      >
                        {EASE_PRESETS.map((e) => <option key={e} value={e}>{e}</option>)}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-text-secondary w-20 shrink-0">退出</label>
                      <select
                        value={draft.motion?.easeOut || 'ease-out'}
                        onChange={(e) => updateMotion({ easeOut: e.target.value })}
                        className="flex-1 px-2 py-1.5 text-xs bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary"
                      >
                        {EASE_PRESETS.map((e) => <option key={e} value={e}>{e}</option>)}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-text-secondary w-20 shrink-0">进出</label>
                      <select
                        value={draft.motion?.easeInOut || 'ease-in-out'}
                        onChange={(e) => updateMotion({ easeInOut: e.target.value })}
                        className="flex-1 px-2 py-1.5 text-xs bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary"
                      >
                        {EASE_PRESETS.map((e) => <option key={e} value={e}>{e}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <h4 className="text-xs font-medium text-text-primary">辅助功能</h4>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={draft.motion?.motionReduce ?? false}
                        onChange={(e) => updateMotion({ motionReduce: e.target.checked })}
                        className="rounded border-border-subtle"
                      />
                      <span className="text-xs text-text-secondary">减弱动画（尊重 prefers-reduced-motion）</span>
                    </label>
                  </div>
                </div>
              )}

              {/* L4 沉浸 */}
              {activeTab === 'immersive' && (
                <div className="space-y-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={draft.immersive?.enabled ?? false}
                      onChange={(e) => {
                        if (e.target.checked) {
                          updateDraft({
                            immersive: {
                              enabled: true,
                              wallpaper: { type: 'image', image: '', opacity: 0.58, positionX: 49, positionY: 49, size: 'cover' },
                              layerOpacity: { panel: 0.62, surface: 0.39, child: 0.43 },
                              effects: { panelBlur: 1, webTexture: 0.35, blueAccent: 0.5, hoverOpacity: 0.41 },
                            },
                          });
                        } else {
                          updateDraft({ immersive: { ...draft.immersive!, enabled: false } });
                        }
                      }}
                      className="w-4 h-4 accent-primary"
                    />
                    <span className="text-sm text-text-secondary">{t('settings:theme.enableImmersive', '开启沉浸效果')}</span>
                  </label>

                  {draft.immersive?.enabled && (
                    <div className="space-y-3 pl-4 border-l-2 border-primary/30">
                      <div className="space-y-2">
                        <h4 className="text-xs font-medium text-text-primary">壁纸</h4>
                        <div className="flex gap-2 flex-wrap">
                          {['image', 'gradient', 'solid', 'none'].map((type) => (
                            <button
                              key={type}
                              type="button"
                              onClick={() => updateImmersive('wallpaper.type', type)}
                              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                                draft.immersive?.wallpaper.type === type ? 'bg-primary text-on-primary' : 'bg-background-hover text-text-secondary'
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
                            placeholder="输入图片 URL"
                            className="w-full px-3 py-2 text-sm bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary"
                          />
                        )}
                        {/* 预设背景网格 */}
                        {draft.immersive?.wallpaper.type === 'image' && (
                          <div className="grid grid-cols-4 gap-1.5">
                            {PRESET_BACKGROUNDS.map((bg) => {
                              const isSelected = draft.immersive?.wallpaper.image === bg.src;
                              return (
                                <button
                                  key={bg.src}
                                  type="button"
                                  title={bg.label}
                                  onClick={() => updateImmersive('wallpaper.image', bg.src)}
                                  className={`aspect-video rounded-lg overflow-hidden border-2 transition-all bg-cover bg-center ${
                                    isSelected ? 'border-primary' : 'border-border-subtle hover:border-border'
                                  }`}
                                  style={{ backgroundImage: `url(${bg.thumbnail || bg.src})` }}
                                >
                                  <span className="absolute bottom-0 left-0 right-0 bg-black/50 text-[9px] text-white px-1 py-0.5 text-center truncate">
                                    {bg.label}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      {/* 头像 */}
                      <div className="space-y-2">
                        <h4 className="text-xs font-medium text-text-primary">AI 头像</h4>
                        <input
                          type="text"
                          value={draft.immersive?.avatar?.url ?? ''}
                          onChange={(e) => updateImmersive('avatar.url', e.target.value || undefined)}
                          placeholder="头像 URL（留空使用默认图标）"
                          className="w-full px-3 py-2 text-sm bg-background-base border border-border rounded-lg text-text-primary outline-none focus:border-primary"
                        />
                        {/* 预设头像网格 */}
                        <div className="grid grid-cols-6 gap-1.5">
                          {PRESET_AVATARS.map((av) => {
                            const isSelected = draft.immersive?.avatar?.url === av.src;
                            return (
                              <button
                                key={av.src}
                                type="button"
                                title={av.label}
                                onClick={() => updateImmersive('avatar.url', av.src)}
                                className={`aspect-square rounded-lg overflow-hidden border-2 transition-all ${
                                  isSelected ? 'border-primary' : 'border-border-subtle hover:border-border'
                                }`}
                              >
                                <img
                                  src={av.src}
                                  alt={av.label}
                                  className="w-full h-full object-cover"
                                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                                />
                              </button>
                            );
                          })}
                        </div>
                        {/* 上传 + 清除 */}
                        <div className="flex items-center gap-2">
                          <label className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs rounded-lg border border-dashed border-primary/50 text-primary cursor-pointer hover:bg-primary/5 transition-colors">
                            上传图片
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                if (file.size > 500 * 1024) {
                                  alert('图片超过 500KB 限制，请选择更小的图片');
                                  return;
                                }
                                const reader = new FileReader();
                                reader.onload = (ev) => {
                                  updateImmersive('avatar.url', ev.target?.result as string);
                                };
                                reader.readAsDataURL(file);
                                e.target.value = '';
                              }}
                            />
                          </label>
                          {draft.immersive?.avatar?.url && (
                            <button
                              type="button"
                              onClick={() => updateImmersive('avatar.url', undefined)}
                              className="px-3 py-1.5 text-xs rounded-lg bg-background-hover text-text-secondary hover:text-danger transition-colors"
                            >
                              清除
                            </button>
                          )}
                        </div>
                      </div>
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
                        const numVal = typeof val === 'number' ? val * (key.toLowerCase().includes('opacity') || key.toLowerCase().includes('webtexture') || key.toLowerCase().includes('blueaccent') ? 100 : 1) : 0;
                        return (
                          <div key={key} className="flex items-center gap-3">
                            <span className="text-xs text-text-secondary w-24 shrink-0">{label}</span>
                            <input
                              type="range"
                              min={min}
                              max={max}
                              value={numVal}
                              onChange={(e) => {
                                const raw = Number(e.target.value);
                                const normalized = key.toLowerCase().includes('opacity') || key.toLowerCase().includes('webtexture') || key.toLowerCase().includes('blueaccent') ? raw / 100 : raw;
                                updateImmersive(key, normalized);
                              }}
                              className="flex-1 h-1 bg-border rounded-full appearance-none cursor-pointer accent-primary"
                            />
                            <span className="text-xs text-text-muted w-12 text-right tabular-nums">
                              {Math.round(numVal)}{suffix}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* L5 布局 */}
              {activeTab === 'layout' && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <h4 className="text-xs font-medium text-text-primary">窗口透明度</h4>
                    <Slider label="大窗模式" value={draft.layout.windowOpacity.normal} min={0} max={100} suffix="%"
                      onChange={(v) => updateLayout({ windowOpacity: { ...draft.layout.windowOpacity, normal: v } })} />
                    <Slider label="小屏模式" value={draft.layout.windowOpacity.compact} min={0} max={100} suffix="%"
                      onChange={(v) => updateLayout({ windowOpacity: { ...draft.layout.windowOpacity, compact: v } })} />
                  </div>
                  <div className="space-y-2">
                    <h4 className="text-xs font-medium text-text-primary">聊天间距</h4>
                    <Slider label="消息间距" value={draft.layout.chatMessageGap} min={4} max={20} suffix="px"
                      onChange={(v) => updateLayout({ chatMessageGap: v })} />
                    <Slider label="块间距" value={draft.layout.chatBlockGap} min={2} max={14} suffix="px"
                      onChange={(v) => updateLayout({ chatBlockGap: v })} />
                    <Slider label="段落间距" value={draft.layout.chatParagraphSpacing} min={0} max={12} suffix="px"
                      onChange={(v) => updateLayout({ chatParagraphSpacing: v })} />
                  </div>
                </div>
              )}

              {/* L6 自定义 CSS */}
              {activeTab === 'css' && (
                <div className="space-y-3">
                  <div>
                    <h4 className="text-xs font-medium text-text-primary mb-1">自定义 CSS</h4>
                    <p className="text-[11px] text-text-muted mb-2">
                      覆盖主题样式，支持任意 CSS。禁止 @import 外部资源、url() 引用 http(s)。
                    </p>
                  </div>
                  {cssError && (
                    <div className="p-2 rounded-lg bg-danger/10 border border-danger/20 text-[11px] text-danger">
                      {cssError}
                    </div>
                  )}
                  <CssEditor
                    value={draft.customCss ?? ''}
                    onChange={(v) => handleCustomCssChange(v)}
                    onValidationError={(err) => setCssError(err)}
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-text-muted">
                      {(draft.customCss ?? '').length} 字符
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCustomCssChange('')}
                      className="px-3 py-1 text-[11px] rounded-lg bg-background-hover text-text-secondary hover:text-text-primary transition-colors"
                    >
                      清空
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 右侧：预览区 — 手机全宽堆叠，桌面固定300px */}
          <div className="w-full md:w-[300px] shrink-0 border-t md:border-t-0 md:border-l border-border-subtle p-4 overflow-y-auto bg-background-base">
            <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">
              实时预览
            </h3>
            <ThemePreview theme={draft} />

            {/* 字体预览 */}
            {activeTab === 'typography' && (
              <div className="mt-4 space-y-2 p-3 rounded-lg bg-background-surface border border-border-subtle">
                <h4 className="text-[10px] text-text-muted uppercase">字体样张</h4>
                <div style={{ fontFamily: draft.typography.fontSans }}>
                  <div className="text-sm font-semibold" style={{ fontWeight: draft.typography.fontWeightSemibold as any }}>
                    Heading 标题
                  </div>
                  <div className="text-xs" style={{ fontWeight: draft.typography.fontWeightNormal as any }}>
                    The quick brown fox jumps over the lazy dog.
                  </div>
                  <div className="text-xs" style={{ fontWeight: draft.typography.fontWeightMedium as any }}>
                    中文字体预览 — 快速棕狐跳过懒狗
                  </div>
                  <div className="text-xs" style={{ fontFamily: draft.typography.fontMono }}>
                    const x = await fetch();
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border-subtle">
          <button
            type="button"
            onClick={handleClose}
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