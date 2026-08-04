/**
 * 三个内置主题的完整 ThemeDefinition 常量
 *
 * 内置主题与用户自定义主题在数据结构上完全一致，
 * 仅 builtIn: true 标志位不同。
 */

import type { ThemeDefinition } from '@/types/theme';
import { BUILT_IN_THEME_IDS, DEFAULT_TYPOGRAPHY, DEFAULT_SHAPE, DEFAULT_MOTION, DEFAULT_LAYOUT } from '@/types/theme';

const NOW = '2026-08-04T00:00:00.000Z';

// ============ Dark 主题 ============

export const DARK_THEME: ThemeDefinition = {
  id: BUILT_IN_THEME_IDS.DARK,
  name: 'Dark',
  description: '默认暗色主题 · 蓝灰色系 · 高对比度 · 适合长时间使用',
  version: 1,
  builtIn: true,
  createdAt: NOW,
  updatedAt: NOW,

  colors: {
    primary: {
      base: '59 130 246',
      hover: '37 99 235',
      '50': '239 246 255',
      '100': '219 234 254',
      '200': '191 219 254',
      '300': '147 197 253',
      '400': '96 165 250',
      '500': '59 130 246',
      '600': '37 99 235',
      '700': '29 78 216',
    },
    background: {
      base: '0 0 0',
      elevated: '26 26 31',
      surface: '37 37 43',
      hover: '45 45 53',
      active: '53 53 61',
      tertiary: '33 38 45',
      secondary: '22 27 34',
    },
    border: { base: '255 255 255' },
    text: {
      primary: '248 248 248',
      secondary: '180 180 184',
      tertiary: '142 142 147',
      muted: '109 109 112',
    },
    status: {
      warning: '251 191 36',
      success: '52 211 153',
      danger: '248 113 113',
      info: '96 165 250',
      done: '16 185 129',
      failed: '239 68 68',
      neutral: '156 163 175',
    },
    priority: {
      low: '156 163 175',
      normal: '96 165 250',
      high: '251 146 60',
      urgent: '248 113 113',
    },
    accent: {
      ai: '167 139 250',
      prototype: '34 211 238',
      workspace: '251 191 36',
    },
    misc: {
      overlay: '0 0 0',
      onPrimary: '255 255 255',
      canvas: '255 255 255',
      tagBg: '255 255 255',
      shadow: '0 0 0',
    },
  },

  typography: DEFAULT_TYPOGRAPHY,
  shape: DEFAULT_SHAPE,
  motion: DEFAULT_MOTION,

  layout: DEFAULT_LAYOUT,
};

// ============ Light 主题 ============

export const LIGHT_THEME: ThemeDefinition = {
  id: BUILT_IN_THEME_IDS.LIGHT,
  name: 'Light',
  description: '浅色主题 · 适合明亮环境 · 文字清晰锐利',
  version: 1,
  builtIn: true,
  createdAt: NOW,
  updatedAt: NOW,

  colors: {
    primary: {
      base: '37 99 235',
      hover: '29 78 216',
      '50': '239 246 255',
      '100': '219 234 254',
      '200': '191 219 254',
      '300': '147 197 253',
      '400': '96 165 250',
      '500': '37 99 235',
      '600': '29 78 216',
      '700': '1 69 196',
    },
    background: {
      base: '250 250 252',
      elevated: '255 255 255',
      surface: '241 245 249',
      hover: '226 232 240',
      active: '203 213 225',
      tertiary: '232 236 241',
      secondary: '248 250 252',
    },
    border: { base: '15 23 42' },
    text: {
      primary: '15 23 42',
      secondary: '51 65 85',
      tertiary: '100 116 139',
      muted: '148 163 184',
    },
    status: {
      warning: '217 119 6',
      success: '22 163 74',
      danger: '220 38 38',
      info: '37 99 235',
      done: '5 150 105',
      failed: '185 28 28',
      neutral: '107 114 128',
    },
    priority: {
      low: '107 114 128',
      normal: '37 99 235',
      high: '234 88 12',
      urgent: '220 38 38',
    },
    accent: {
      ai: '124 58 237',
      prototype: '14 165 233',
      workspace: '217 119 6',
    },
    misc: {
      overlay: '15 23 42',
      onPrimary: '255 255 255',
      canvas: '255 255 255',
      tagBg: '15 23 42',
      shadow: '15 23 42',
    },
  },

  typography: { ...DEFAULT_TYPOGRAPHY },
  shape: { ...DEFAULT_SHAPE },
  motion: { ...DEFAULT_MOTION },

  layout: { ...DEFAULT_LAYOUT },
};

// ============ Spider-Man 主题 ============

export const SPIDERMAN_THEME: ThemeDefinition = {
  id: BUILT_IN_THEME_IDS.SPIDERMAN,
  name: 'Spider-Man',
  description: '沉浸式主题 · 红色主色调 · 动态壁纸 · 面板透明磨砂',
  version: 1,
  builtIn: true,
  createdAt: NOW,
  updatedAt: NOW,

  colors: {
    primary: {
      base: '220 38 38',
      hover: '185 28 28',
      '50': '254 226 226',
      '100': '254 202 202',
      '200': '252 165 165',
      '300': '248 113 113',
      '400': '239 68 68',
      '500': '220 38 38',
      '600': '185 28 28',
      '700': '153 27 27',
    },
    background: {
      base: '0 0 0',
      elevated: '8 8 10',
      surface: '14 14 18',
      hover: '20 20 24',
      active: '26 26 30',
      tertiary: '16 18 22',
      secondary: '10 12 16',
    },
    border: { base: '220 38 38' },
    text: {
      primary: '248 248 248',
      secondary: '180 180 184',
      tertiary: '142 142 147',
      muted: '109 109 112',
    },
    status: {
      warning: '251 191 36',
      success: '52 211 153',
      danger: '248 113 113',
      info: '59 130 246',
      done: '16 185 129',
      failed: '239 68 68',
      neutral: '156 163 175',
    },
    priority: {
      low: '156 163 175',
      normal: '59 130 246',
      high: '251 146 60',
      urgent: '248 113 113',
    },
    accent: {
      ai: '59 130 246',
      prototype: '34 211 238',
      workspace: '59 130 246',
    },
    misc: {
      overlay: '0 0 0',
      onPrimary: '255 255 255',
      canvas: '255 255 255',
      tagBg: '255 255 255',
      shadow: '0 0 0',
    },
  },

  typography: { ...DEFAULT_TYPOGRAPHY },
  shape: { ...DEFAULT_SHAPE },
  motion: { ...DEFAULT_MOTION },

  layout: { ...DEFAULT_LAYOUT },

  // 沉浸效果
  immersive: {
    enabled: true,
    wallpaper: {
      type: 'image',
      image: '/spiderman/09fca96a312390d96dcad588fd3ef02a.jpg',
      opacity: 0.58,
      positionX: 49,
      positionY: 49,
      size: 'cover',
    },
    layerOpacity: {
      panel: 0.62,
      surface: 0.39,
      child: 0.43,
    },
    effects: {
      panelBlur: 1,
      webTexture: 0.35,
      blueAccent: 0.5,
      hoverOpacity: 0.41,
    },
    avatar: {
      url: '/spiderman/09fca96a312390d96dcad588fd3ef02a.jpg',
    },
  },
};

// ============ 内置主题列表 ============

export const BUILT_IN_THEMES: ThemeDefinition[] = [
  DARK_THEME,
  LIGHT_THEME,
  SPIDERMAN_THEME,
];

/** 根据 ID 查找内置主题 */
export function getBuiltInTheme(id: string): ThemeDefinition | undefined {
  return BUILT_IN_THEMES.find((t) => t.id === id);
}

/** 根据短名称查找内置主题（兼容旧 config.theme 字段） */
export function getBuiltInThemeByShortName(name: string): ThemeDefinition | undefined {
  const map: Record<string, string> = {
    dark: BUILT_IN_THEME_IDS.DARK,
    light: BUILT_IN_THEME_IDS.LIGHT,
    spiderman: BUILT_IN_THEME_IDS.SPIDERMAN,
  };
  const id = map[name];
  return id ? getBuiltInTheme(id) : undefined;
}