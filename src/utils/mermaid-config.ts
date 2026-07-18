/**
 * Mermaid.js 配置文件
 * 提供 dark / light 双主题，对接 useThemeStore 自动切换
 */

import type { MermaidConfig } from 'mermaid';

/**
 * 暗色主题配置 - 匹配项目 Tailwind 色系
 */
export const mermaidDarkTheme: Partial<MermaidConfig> = {
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Courier New", monospace',
  themeVariables: {
    // === 主色调 ===
    primaryColor: '#3B82F6',
    primaryTextColor: '#F8F8F8',
    primaryBorderColor: '#2563EB',

    // === 线条颜色 ===
    lineColor: '#B4B4B8',
    secondaryColor: '#25252B',
    tertiaryColor: '#0F0F11',

    // === 背景色 ===
    background: '#0F0F11',
    mainBkg: '#25252B',
    nodeBorder: 'rgba(255, 255, 255, 0.15)',

    // === 聚类/分组 ===
    clusterBkg: '#1A1A1F',
    clusterBorder: 'rgba(255, 255, 255, 0.15)',

    // === 文字颜色 ===
    titleColor: '#F8F8F8',
    edgeLabelBackground: '#25252B',

    // === 时序图 ===
    actorBkg: '#25252B',
    actorBorder: 'rgba(255, 255, 255, 0.15)',
    actorTextColor: '#F8F8F8',
    actorLineColor: '#3B82F6',
    signalColor: '#F8F8F8',
    signalTextColor: '#F8F8F8',
    labelBoxBkgColor: '#25252B',
    labelBoxBorderColor: 'rgba(255, 255, 255, 0.15)',
    labelTextColor: '#F8F8F8',
    loopTextColor: '#F8F8F8',
    boxBorderColor: 'rgba(255, 255, 255, 0.15)',
    boxBkgColor: '#25252B',

    // === 注释框 ===
    noteBorderColor: 'rgba(255, 255, 255, 0.15)',
    noteBkgColor: '#1A1A1F',
    noteTextColor: '#B4B4B8',

    // === 激活框 ===
    activationBorderColor: '#3B82F6',
    activationBkgColor: '#25252B',

    // === 序号 ===
    sequenceNumberColor: '#F8F8F8',

    // === 类图 ===
    classText: '#F8F8F8',
    classBorderColor: 'rgba(255, 255, 255, 0.15)',

    // === 状态图 ===
    stroke: '#3B82F6',
    fill: '#25252B',

    // === ER图 ===
    entityBackgroundColor: '#25252B',
    entityBorderColor: 'rgba(255, 255, 255, 0.15)',

    // === 甘特图 ===
    sectionBkgColor: '#1A1A1F',
    altSectionBkgColor: '#25252B',
    gridColor: 'rgba(255, 255, 255, 0.08)',

    // === 旅程图 ===
    backgroundSize: '100%, 100%',
    journeyBkgColor: '#25252B',

    // === 思维导图 ===
    pie1: '#3B82F6',
    pie2: '#34D399',
    pie3: '#FBBF24',
    pie4: '#F87171',
    pie5: '#60A5FA',
    pie6: '#93C5FD',
    pie7: '#C4B5FD',
    pie8: '#F9A8D4',
    pie9: '#FCD34D',
    pie10: '#A7F3D0',
    pie11: '#7DD3FC',
    pie12: '#FCA5A5',

    // === 颜色变量 ===
    color0: '#3B82F6',
    color1: '#34D399',
    color2: '#FBBF24',
    color3: '#F87171',
    color4: '#60A5FA',
    color5: '#93C5FD',
    color6: '#C4B5FD',
    color7: '#F9A8D4',
    color8: '#FCD34D',
    color9: '#A7F3D0',
    color10: '#7DD3FC',
    color11: '#FCA5A5',
    color12: '#E9D5FF',
  },

  flowchart: {
    useMaxWidth: true,
    htmlLabels: true,
    curve: 'basis',
  },

  sequence: {
    useMaxWidth: true,
    diagramMarginX: 20,
    diagramMarginY: 20,
    actorMargin: 50,
    width: 150,
    height: 65,
    boxMargin: 10,
    messageMargin: 35,
    mirrorActors: false,
    bottomMarginAdj: 1,
    rightAngles: false,
    showSequenceNumbers: false,
  },
};

/**
 * 亮色主题配置 - 与 Polaris light 主题视觉一致
 */
export const mermaidLightTheme: Partial<MermaidConfig> = {
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'loose',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Courier New", monospace',
  themeVariables: {
    // === 主色调 ===
    primaryColor: '#2563EB',
    primaryTextColor: '#0F172A',
    primaryBorderColor: '#1D4ED8',

    // === 线条颜色 ===
    lineColor: '#64748B',
    secondaryColor: '#F1F5F9',
    tertiaryColor: '#FFFFFF',

    // === 背景色 ===
    background: '#FAFAFC',
    mainBkg: '#F1F5F9',
    nodeBorder: '#E2E8F0',

    // === 聚类/分组 ===
    clusterBkg: '#FFFFFF',
    clusterBorder: '#E2E8F0',

    // === 文字颜色 ===
    titleColor: '#0F172A',
    edgeLabelBackground: '#F1F5F9',

    // === 时序图 ===
    actorBkg: '#FFFFFF',
    actorBorder: '#E2E8F0',
    actorTextColor: '#0F172A',
    actorLineColor: '#2563EB',
    signalColor: '#0F172A',
    signalTextColor: '#0F172A',
    labelBoxBkgColor: '#FFFFFF',
    labelBoxBorderColor: '#E2E8F0',
    labelTextColor: '#0F172A',
    loopTextColor: '#0F172A',
    boxBorderColor: '#E2E8F0',
    boxBkgColor: '#FFFFFF',

    // === 注释框 ===
    noteBorderColor: '#E2E8F0',
    noteBkgColor: '#FEF3C7',
    noteTextColor: '#92400E',

    // === 激活框 ===
    activationBorderColor: '#2563EB',
    activationBkgColor: '#F1F5F9',

    // === 序号 ===
    sequenceNumberColor: '#0F172A',

    // === 类图 ===
    classText: '#0F172A',
    classBorderColor: '#E2E8F0',

    // === 状态图 ===
    stroke: '#2563EB',
    fill: '#F1F5F9',

    // === ER图 ===
    entityBackgroundColor: '#FFFFFF',
    entityBorderColor: '#E2E8F0',

    // === 甘特图 ===
    sectionBkgColor: '#FFFFFF',
    altSectionBkgColor: '#F1F5F9',
    gridColor: '#E2E8F0',

    // === 旅程图 ===
    backgroundSize: '100%, 100%',
    journeyBkgColor: '#FFFFFF',

    // === 思维导图 / 颜色变量 ===
    pie1: '#2563EB',
    pie2: '#16A34A',
    pie3: '#D97706',
    pie4: '#DC2626',
    pie5: '#3B82F6',
    pie6: '#60A5FA',
    pie7: '#A855F7',
    pie8: '#EC4899',
    pie9: '#FACC15',
    pie10: '#34D399',
    pie11: '#0EA5E9',
    pie12: '#F87171',
    color0: '#2563EB',
    color1: '#16A34A',
    color2: '#D97706',
    color3: '#DC2626',
    color4: '#3B82F6',
    color5: '#60A5FA',
    color6: '#A855F7',
    color7: '#EC4899',
    color8: '#FACC15',
    color9: '#34D399',
    color10: '#0EA5E9',
    color11: '#F87171',
    color12: '#7C3AED',
  },

  flowchart: {
    useMaxWidth: true,
    htmlLabels: true,
    curve: 'basis',
  },

  sequence: {
    useMaxWidth: true,
    diagramMarginX: 20,
    diagramMarginY: 20,
    actorMargin: 50,
    width: 150,
    height: 65,
    boxMargin: 10,
    messageMargin: 35,
    mirrorActors: false,
    bottomMarginAdj: 1,
    rightAngles: false,
    showSequenceNumbers: false,
  },
};

/**
 * 读取 CSS 变量的实际颜色并转 hex（Mermaid themeVariables 需要真实颜色值，
 * 会内部派生阴影，不接受 CSS 变量引用）。
 */
function cssVarHex(varName: string): string | null {
  if (typeof document === 'undefined') return null;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return '#' + parts.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
}

/**
 * 用当前生效的 --c-* 变量覆盖 Mermaid 主色/背景/文字/线条，
 * 使自定义主题的配色也作用于图表。未能读取的变量保持基础主题值。
 */
function applyCustomThemeToMermaid(base: Partial<MermaidConfig>): Partial<MermaidConfig> {
  const primary = cssVarHex('--c-primary');
  const primaryHover = cssVarHex('--c-primary-hover');
  const textPrimary = cssVarHex('--c-text-primary');
  const bgBase = cssVarHex('--c-bg-base');
  const bgSurface = cssVarHex('--c-bg-surface');
  const bgElevated = cssVarHex('--c-bg-elevated');
  const textSecondary = cssVarHex('--c-text-secondary');

  const overrides: Record<string, string> = {};
  if (primary) {
    overrides.primaryColor = primary;
    overrides.actorLineColor = primary;
    overrides.activationBorderColor = primary;
    overrides.stroke = primary;
    overrides.color0 = primary;
    overrides.pie1 = primary;
  }
  if (primaryHover) overrides.primaryBorderColor = primaryHover;
  if (textPrimary) {
    overrides.primaryTextColor = textPrimary;
    overrides.titleColor = textPrimary;
    overrides.actorTextColor = textPrimary;
    overrides.signalColor = textPrimary;
    overrides.signalTextColor = textPrimary;
    overrides.labelTextColor = textPrimary;
    overrides.loopTextColor = textPrimary;
    overrides.classText = textPrimary;
    overrides.sequenceNumberColor = textPrimary;
  }
  if (bgBase) {
    overrides.background = bgBase;
    overrides.tertiaryColor = bgBase;
  }
  if (bgSurface) {
    overrides.mainBkg = bgSurface;
    overrides.secondaryColor = bgSurface;
    overrides.actorBkg = bgSurface;
    overrides.labelBoxBkgColor = bgSurface;
    overrides.boxBkgColor = bgSurface;
    overrides.activationBkgColor = bgSurface;
    overrides.entityBackgroundColor = bgSurface;
    overrides.fill = bgSurface;
    overrides.edgeLabelBackground = bgSurface;
    overrides.altSectionBkgColor = bgSurface;
    overrides.journeyBkgColor = bgSurface;
  }
  if (bgElevated) {
    overrides.clusterBkg = bgElevated;
    overrides.noteBkgColor = bgElevated;
    overrides.sectionBkgColor = bgElevated;
  }
  if (textSecondary) overrides.lineColor = textSecondary;

  if (Object.keys(overrides).length === 0) return base;
  return {
    ...base,
    themeVariables: { ...base.themeVariables, ...overrides },
  };
}

/**
 * 获取当前主题的 Mermaid 配置
 *
 * 在 React 组件中使用：
 * ```tsx
 * import { useThemeStore } from '@/stores/themeStore';
 * const theme = useThemeStore(state => state.theme);
 * const config = getMermaidConfig(theme);
 * ```
 *
 * 在非 React 上下文中使用：
 * ```ts
 * import { useThemeStore } from '@/stores/themeStore';
 * const config = getMermaidConfig(useThemeStore.getState().theme);
 * ```
 */
export function getMermaidConfig(theme: 'dark' | 'light' = 'dark'): Partial<MermaidConfig> {
  const base = theme === 'dark' ? mermaidDarkTheme : mermaidLightTheme;
  return applyCustomThemeToMermaid(base);
}
