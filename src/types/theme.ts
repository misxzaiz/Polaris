/**
 * 自定义主题类型定义
 *
 * 设计要点：
 * - 颜色以 `R G B` 三元组字符串存储（与 index.css 的 `--c-*` 变量一致），
 *   运行时通过 `documentElement.style.setProperty('--c-xxx', 'R G B')` 注入覆盖内置主题。
 * - 非颜色类（背景图/渐变/圆角档位/字体）通过注入一段全局 `<style>` 实现。
 * - 一份 CustomTheme = 「基于某内置主题(dark/light) 的一组覆盖」，未覆盖项回退内置值。
 * - 所有覆盖项均为可选：只改用户动过的，其余继承基础主题。
 */

/** RGB 三元组字符串，如 "59 130 246" */
export type RgbTriple = string;

/** 可自定义的颜色变量键（对应 index.css 中的 `--c-<key>`） */
export type ThemeColorKey =
  | 'primary' | 'primary-hover'
  | 'primary-50' | 'primary-100' | 'primary-200' | 'primary-300' | 'primary-400'
  | 'primary-500' | 'primary-600' | 'primary-700'
  | 'bg-base' | 'bg-elevated' | 'bg-surface' | 'bg-hover' | 'bg-active' | 'bg-tertiary' | 'bg-secondary'
  | 'border'
  | 'text-primary' | 'text-secondary' | 'text-tertiary' | 'text-muted'
  | 'status-warning' | 'status-success' | 'status-danger' | 'status-info'
  | 'status-done' | 'status-failed' | 'status-neutral'
  | 'priority-low' | 'priority-normal' | 'priority-high' | 'priority-urgent'
  | 'accent-ai' | 'accent-prototype' | 'accent-workspace'
  | 'overlay' | 'on-primary' | 'canvas' | 'tag-bg' | 'shadow';

/** 颜色覆盖表 */
export type ThemeColors = Partial<Record<ThemeColorKey, RgbTriple>>;

/** 背景类型 */
export type BackgroundType = 'none' | 'solid' | 'gradient' | 'image';

/** 渐变色标 */
export interface GradientStop {
  /** RGB 三元组 */
  color: RgbTriple;
  /** 位置百分比 0~100 */
  position: number;
}

/** 背景配置 */
export interface BackgroundConfig {
  type: BackgroundType;
  /** solid: 纯色（RGB 三元组），为空时用 --c-bg-base */
  solidColor?: RgbTriple;
  /** gradient: 线性渐变 */
  gradient?: {
    /** 角度，如 "135deg" */
    direction: string;
    stops: GradientStop[];
  };
  /** image: 背景图 */
  image?: {
    /** 图片 URL 或 data URI */
    url: string;
    size: 'cover' | 'contain' | 'auto';
    position: string;
    repeat: 'no-repeat' | 'repeat';
    /** 背景图不透明度 0~1（值越低越透，界面越清晰） */
    opacity: number;
    /** 模糊半径 px */
    blur: number;
  };
}

/** 圆角档位 */
export type RadiusScale = 'sharp' | 'compact' | 'standard' | 'rounded';

/** 界面字体族 */
export type UiFontFamily = 'system' | 'serif' | 'mono' | 'rounded';

/** 玻璃拟态模糊档位 */
export type BackdropBlurScale = 'none' | 'subtle' | 'medium' | 'strong';

/** 阴影强度档位 */
export type ShadowScale = 'none' | 'subtle' | 'default' | 'strong';

/** 尺寸/排版覆盖 */
export interface ThemeSizing {
  /** 全局圆角档位 */
  radius?: RadiusScale;
  /** 界面字体族 */
  fontFamily?: UiFontFamily;
}

/** 视觉特效覆盖 */
export interface ThemeEffects {
  /** 窗口整体不透明度 0.3~1（复用现有 --window-opacity） */
  windowOpacity?: number;
  /** 玻璃拟态模糊强度 */
  backdropBlur?: BackdropBlurScale;
  /** 阴影强度 */
  shadow?: ShadowScale;
}

/** 完整自定义主题定义（一组基于基础主题的覆盖） */
export interface CustomTheme {
  /** 数据结构版本，用于导入兼容 */
  version: number;
  /** 基础主题：继承 dark 还是 light 的内置变量 */
  baseTheme: 'dark' | 'light';
  /** 颜色覆盖 */
  colors: ThemeColors;
  /** 背景 */
  background?: BackgroundConfig;
  /** 尺寸/排版 */
  sizing?: ThemeSizing;
  /** 特效 */
  effects?: ThemeEffects;
}

/** 用户保存的主题预设 */
export interface ThemePreset {
  id: string;
  name: string;
  description?: string;
  /** 是否内置预设（不可删除/重命名，可另存为副本编辑） */
  builtin?: boolean;
  theme: CustomTheme;
  createdAt: number;
  updatedAt: number;
}

/** 持久化到 config.json 的根字段 */
export interface ThemeCustomConfig {
  /** 是否启用自定义主题（关闭时回退纯 dark/light 内置主题） */
  enabled: boolean;
  /** 当前激活的预设 id */
  activePresetId?: string;
  /** 用户所有预设（含内置） */
  presets: ThemePreset[];
}

/** 当前数据结构版本 */
export const THEME_SCHEMA_VERSION = 1;

/** 圆角档位 → 各级半径值（px） */
export const RADIUS_SCALE_VALUES: Record<RadiusScale, Record<string, string>> = {
  sharp: { sm: '2px', md: '3px', lg: '4px', xl: '5px', '2xl': '7px', '3xl': '9px', full: '9999px' },
  compact: { sm: '3px', md: '4px', lg: '6px', xl: '8px', '2xl': '11px', '3xl': '14px', full: '9999px' },
  standard: { sm: '4px', md: '6px', lg: '8px', xl: '12px', '2xl': '16px', '3xl': '20px', full: '9999px' },
  rounded: { sm: '7px', md: '10px', lg: '14px', xl: '18px', '2xl': '24px', '3xl': '30px', full: '9999px' },
};

/** 界面字体族 → font-family 值 */
export const UI_FONT_FAMILY_VALUES: Record<UiFontFamily, string> = {
  system: `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif`,
  serif: `Georgia, 'Times New Roman', 'Noto Serif SC', 'Songti SC', serif`,
  mono: `'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', Consolas, monospace`,
  rounded: `'Varela Round', 'Quicksand', 'Segoe UI Rounded', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`,
};

/** 玻璃拟态档位 → blur 值 */
export const BACKDROP_BLUR_VALUES: Record<BackdropBlurScale, string> = {
  none: '0px',
  subtle: '6px',
  medium: '12px',
  strong: '20px',
};

/** 阴影档位 → 强度倍率（作用于 --c-shadow 的 alpha 基准） */
export const SHADOW_SCALE_VALUES: Record<ShadowScale, number> = {
  none: 0,
  subtle: 0.6,
  default: 1,
  strong: 1.6,
};

/** 所有可自定义颜色键的有序列表（用于设置面板遍历渲染） */
export const THEME_COLOR_KEYS: ThemeColorKey[] = [
  'primary', 'primary-hover',
  'bg-base', 'bg-elevated', 'bg-surface', 'bg-hover', 'bg-active', 'bg-tertiary', 'bg-secondary',
  'border',
  'text-primary', 'text-secondary', 'text-tertiary', 'text-muted',
  'status-warning', 'status-success', 'status-danger', 'status-info',
  'status-done', 'status-failed', 'status-neutral',
  'priority-low', 'priority-normal', 'priority-high', 'priority-urgent',
  'accent-ai', 'accent-prototype', 'accent-workspace',
  'overlay', 'on-primary', 'canvas', 'tag-bg', 'shadow',
  'primary-50', 'primary-100', 'primary-200', 'primary-300', 'primary-400',
  'primary-500', 'primary-600', 'primary-700',
];

/** 颜色分组（用于设置面板分区展示） */
export interface ThemeColorGroup {
  labelKey: string;
  keys: ThemeColorKey[];
}

export const THEME_COLOR_GROUPS: ThemeColorGroup[] = [
  { labelKey: 'themeCustom.group.primary', keys: ['primary', 'primary-hover'] },
  {
    labelKey: 'themeCustom.group.background',
    keys: ['bg-base', 'bg-elevated', 'bg-surface', 'bg-hover', 'bg-active', 'bg-tertiary', 'bg-secondary'],
  },
  { labelKey: 'themeCustom.group.text', keys: ['text-primary', 'text-secondary', 'text-tertiary', 'text-muted'] },
  { labelKey: 'themeCustom.group.border', keys: ['border'] },
  {
    labelKey: 'themeCustom.group.status',
    keys: ['status-warning', 'status-success', 'status-danger', 'status-info', 'status-done', 'status-failed', 'status-neutral'],
  },
  { labelKey: 'themeCustom.group.priority', keys: ['priority-low', 'priority-normal', 'priority-high', 'priority-urgent'] },
  { labelKey: 'themeCustom.group.accent', keys: ['accent-ai', 'accent-prototype', 'accent-workspace'] },
  { labelKey: 'themeCustom.group.misc', keys: ['overlay', 'on-primary', 'canvas', 'tag-bg', 'shadow'] },
];

/**
 * 内置 dark 主题的完整颜色值（镜像 index.css :root）。
 * 作为「基础主题」的默认值来源：新建预设 / 重置某项时回填。
 */
export const BUILTIN_DARK_COLORS: Record<ThemeColorKey, RgbTriple> = {
  'primary': '59 130 246',
  'primary-hover': '37 99 235',
  'primary-50': '239 246 255',
  'primary-100': '219 234 254',
  'primary-200': '191 219 254',
  'primary-300': '147 197 253',
  'primary-400': '96 165 250',
  'primary-500': '59 130 246',
  'primary-600': '37 99 235',
  'primary-700': '29 78 216',
  'bg-base': '15 15 17',
  'bg-elevated': '26 26 31',
  'bg-surface': '37 37 43',
  'bg-hover': '45 45 53',
  'bg-active': '53 53 61',
  'bg-tertiary': '33 38 45',
  'bg-secondary': '22 27 34',
  'border': '255 255 255',
  'text-primary': '248 248 248',
  'text-secondary': '180 180 184',
  'text-tertiary': '142 142 147',
  'text-muted': '109 109 112',
  'status-warning': '251 191 36',
  'status-success': '52 211 153',
  'status-danger': '248 113 113',
  'status-info': '96 165 250',
  'status-done': '16 185 129',
  'status-failed': '239 68 68',
  'status-neutral': '156 163 175',
  'priority-low': '156 163 175',
  'priority-normal': '96 165 250',
  'priority-high': '251 146 60',
  'priority-urgent': '248 113 113',
  'accent-ai': '167 139 250',
  'accent-prototype': '34 211 238',
  'accent-workspace': '251 191 36',
  'overlay': '0 0 0',
  'on-primary': '255 255 255',
  'canvas': '255 255 255',
  'tag-bg': '255 255 255',
  'shadow': '0 0 0',
};

/**
 * 内置 light 主题的完整颜色值（镜像 index.css :root[data-theme="light"]，
 * 未在 light 覆盖的项回退到 dark 值）。
 */
export const BUILTIN_LIGHT_COLORS: Record<ThemeColorKey, RgbTriple> = {
  ...BUILTIN_DARK_COLORS,
  'primary': '37 99 235',
  'primary-hover': '29 78 216',
  'bg-base': '250 250 252',
  'bg-elevated': '255 255 255',
  'bg-surface': '241 245 249',
  'bg-hover': '226 232 240',
  'bg-active': '203 213 225',
  'bg-tertiary': '232 236 241',
  'bg-secondary': '248 250 252',
  'border': '15 23 42',
  'text-primary': '15 23 42',
  'text-secondary': '51 65 85',
  'text-tertiary': '100 116 139',
  'text-muted': '148 163 184',
  'status-warning': '217 119 6',
  'status-success': '22 163 74',
  'status-danger': '220 38 38',
  'status-info': '37 99 235',
  'status-done': '5 150 105',
  'status-failed': '185 28 28',
  'status-neutral': '107 114 128',
  'priority-low': '107 114 128',
  'priority-normal': '37 99 235',
  'priority-high': '234 88 12',
  'priority-urgent': '220 38 38',
  'accent-ai': '124 58 237',
  'accent-prototype': '14 165 233',
  'accent-workspace': '217 119 6',
  'overlay': '15 23 42',
  'shadow': '15 23 42',
  'tag-bg': '15 23 42',
};

/** 取某基础主题的完整默认颜色 */
export function getBaseThemeColors(base: 'dark' | 'light'): Record<ThemeColorKey, RgbTriple> {
  return base === 'light' ? BUILTIN_LIGHT_COLORS : BUILTIN_DARK_COLORS;
}

/** 创建一个空白自定义主题（基于指定基础主题，无任何覆盖） */
export function createEmptyCustomTheme(base: 'dark' | 'light' = 'dark'): CustomTheme {
  return {
    version: THEME_SCHEMA_VERSION,
    baseTheme: base,
    colors: {},
    background: { type: 'none' },
    sizing: { radius: 'standard', fontFamily: 'system' },
    effects: { windowOpacity: 1, backdropBlur: 'none', shadow: 'default' },
  };
}

/** 校验 RGB 三元组字符串合法性 */
export function isValidRgbTriple(value: string): boolean {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 3) return false;
  return parts.every((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

/** #RRGGBB → "R G B" */
export function hexToRgbTriple(hex: string): RgbTriple | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const int = parseInt(m[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `${r} ${g} ${b}`;
}

/** "R G B" → #RRGGBB */
export function rgbTripleToHex(triple: RgbTriple): string {
  const parts = triple.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return '#000000';
  return '#' + parts.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
}
