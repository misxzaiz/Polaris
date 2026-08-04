/**
 * 主题系统类型定义
 *
 * 7 层数据模型（L0-L6），覆盖 ~88 个可自定义维度：
 * - L0 colors（40 变量）：颜色系统
 * - L1 typography（12 变量）：排版系统
 * - L2 shape（10 变量）：形状系统（圆角、边框）
 * - L3 motion（8 变量）：动效系统（P1 可选）
 * - L4 immersive（12 变量）：沉浸效果
 * - L5 layout（5 变量）：界面布局
 * - L6 customCss（1 字段）：用户自定义 CSS，终极逃生舱
 */

/** 主题唯一标识（UUID v4，内置主题用固定 ID） */
export type ThemeId = string;

/** 壁纸类型 */
export type WallpaperType = 'image' | 'gradient' | 'solid' | 'none';

/** 背景缩放模式 */
export type BackgroundSize = 'cover' | 'contain' | string;

// ============ L0 颜色层 ============

/** 颜色值以 RGB 三元组字符串存储（如 "59 130 246"），
 *  与 Tailwind `rgb(var(--c-xxx) / <alpha-value>)` 兼容 */
export interface ThemeColorShades {
  base: string;
  hover: string;
  '50': string;
  '100': string;
  '200': string;
  '300': string;
  '400': string;
  '500': string;
  '600': string;
  '700': string;
}

export interface ThemeColors {
  primary: ThemeColorShades;
  background: {
    base: string;
    elevated: string;
    surface: string;
    hover: string;
    active: string;
    tertiary: string;
    secondary: string;
  };
  border: { base: string };
  text: {
    primary: string;
    secondary: string;
    tertiary: string;
    muted: string;
  };
  status: {
    warning: string;
    success: string;
    danger: string;
    info: string;
    done: string;
    failed: string;
    neutral: string;
  };
  priority: {
    low: string;
    normal: string;
    high: string;
    urgent: string;
  };
  accent: {
    ai: string;
    prototype: string;
    workspace: string;
  };
  misc: {
    overlay: string;
    onPrimary: string;
    canvas: string;
    tagBg: string;
    shadow: string;
  };
}

// ============ L1 排版层 ============

export interface ThemeTypography {
  fontSans: string;
  fontMono: string;
  fontSizeBase: string;
  fontWeightNormal: string;
  fontWeightMedium: string;
  fontWeightSemibold: string;
  letterSpacing: string;
  chatFontSize: number;
  chatLineHeight: number;
  chatCodeFontSize: number;
  chatInputFontSize: number;
}

// ============ L2 形状层 ============

export interface ThemeShape {
  radiusSm: string;
  radiusMd: string;
  radiusLg: string;
  radiusXl: string;
  radiusFull: string;
  chatBubbleRadius: string;
  borderWidth: string;
  borderStyle: string;
  chatBubblePaddingX: string;
  chatBubblePaddingY: string;
}

// ============ L3 动效层（P1 可选） ============

export interface ThemeMotion {
  transitionFast: string;
  transitionNormal: string;
  transitionSlow: string;
  easeDefault: string;
  easeIn: string;
  easeOut: string;
  easeInOut: string;
  motionReduce: boolean;
}

// ============ L4 沉浸层 ============

export interface ThemeImmersiveWallpaper {
  type: WallpaperType;
  image?: string;
  gradient?: string;
  solidColor?: string;
  opacity: number;
  positionX: number;
  positionY: number;
  size: BackgroundSize;
}

export interface ThemeImmersiveLayerOpacity {
  panel: number;
  surface: number;
  child: number;
}

export interface ThemeImmersiveEffects {
  panelBlur: number;
  webTexture: number;
  blueAccent: number;
  hoverOpacity: number;
}

export interface ThemeImmersiveAvatar {
  url: string;
}

export interface ThemeImmersive {
  enabled: boolean;
  wallpaper: ThemeImmersiveWallpaper;
  layerOpacity: ThemeImmersiveLayerOpacity;
  effects: ThemeImmersiveEffects;
  avatar?: ThemeImmersiveAvatar;
}

// ============ L5 布局层 ============

export interface ThemeLayoutWindowOpacity {
  normal: number;
  compact: number;
}

export interface ThemeLayout {
  windowOpacity: ThemeLayoutWindowOpacity;
  chatMessageGap: number;
  chatBlockGap: number;
  chatParagraphSpacing: number;
}

// ============ 完整主题定义 ============

/** 主题定义 — 内置与用户主题共用此结构 */
export interface ThemeDefinition {
  // 元数据
  id: ThemeId;
  name: string;
  description?: string;
  author?: string;
  version: number;
  builtIn: boolean;
  extends?: ThemeId | null;
  minAppVersion?: string;
  createdAt: string;
  updatedAt: string;

  // L0 颜色层
  colors: ThemeColors;

  // L1 排版层
  typography: ThemeTypography;

  // L2 形状层
  shape: ThemeShape;

  // L3 动效层（P1 可选，不提供时使用 dark 默认值）
  motion?: ThemeMotion;

  // L4 沉浸层
  immersive?: ThemeImmersive;

  // L5 布局层
  layout: ThemeLayout;

  // L6 用户 CSS 层（终极逃生舱）
  customCss?: string;
}

// ============ 导出格式 ============

/** 导出文件格式（.polaris-theme） */
export interface ThemeExportFile {
  formatVersion: number;
  type: 'polaris-theme';
  exportedAt: string;
  minAppVersion?: string;
  theme: ThemeDefinitionExport;
}

/** 导出时移除内部字段 */
export type ThemeDefinitionExport = Omit<ThemeDefinition, 'id' | 'builtIn' | 'createdAt' | 'updatedAt'>;

// ============ 内置主题 ID 常量 ============

export const BUILT_IN_THEME_IDS = {
  DARK: '00000000-0000-0000-0000-000000000001',
  LIGHT: '00000000-0000-0000-0000-000000000002',
  SPIDERMAN: '00000000-0000-0000-0000-000000000003',
} as const;

/** 检查是否为内置主题 ID */
export function isBuiltInThemeId(id: ThemeId): boolean {
  return Object.values(BUILT_IN_THEME_IDS).includes(id as any);
}

/** 当前数据格式版本 */
export const CURRENT_FORMAT_VERSION = 1;

// ============ 默认值常量 ============

export const DEFAULT_TYPOGRAPHY: ThemeTypography = {
  fontSans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontMono: '"JetBrains Mono", "Fira Code", "Cascadia Code", "SF Mono", Consolas, monospace',
  fontSizeBase: '14px',
  fontWeightNormal: '400',
  fontWeightMedium: '500',
  fontWeightSemibold: '600',
  letterSpacing: 'normal',
  chatFontSize: 14,
  chatLineHeight: 1.55,
  chatCodeFontSize: 13,
  chatInputFontSize: 14,
};

export const DEFAULT_SHAPE: ThemeShape = {
  radiusSm: '4px',
  radiusMd: '8px',
  radiusLg: '12px',
  radiusXl: '16px',
  radiusFull: '9999px',
  chatBubbleRadius: '16px',
  borderWidth: '1px',
  borderStyle: 'solid',
  chatBubblePaddingX: '16px',
  chatBubblePaddingY: '12px',
};

export const DEFAULT_MOTION: ThemeMotion = {
  transitionFast: '0.15s',
  transitionNormal: '0.3s',
  transitionSlow: '0.5s',
  easeDefault: 'ease',
  easeIn: 'ease-in',
  easeOut: 'ease-out',
  easeInOut: 'ease-in-out',
  motionReduce: false,
};

export const DEFAULT_LAYOUT: ThemeLayout = {
  windowOpacity: { normal: 100, compact: 100 },
  chatMessageGap: 10,
  chatBlockGap: 6,
  chatParagraphSpacing: 4,
};