/**
 * 内置主题预设
 *
 * 提供开箱即用的设计师配色，作为自定义主题的起点。
 * 内置预设 builtin=true，不可删除/重命名，但可「另存为副本」后自由编辑。
 *
 * 注意：这些预设的 createdAt/updatedAt 固定为 0（内置，无需真实时间戳），
 * 避免依赖 Date.now() 且保证跨会话稳定。
 */

import type { ThemePreset } from '@/types/theme';
import { THEME_SCHEMA_VERSION } from '@/types/theme';

export const BUILTIN_PRESET_IDS = {
  midnight: 'builtin-midnight',
  ocean: 'builtin-ocean',
  forest: 'builtin-forest',
  sunset: 'builtin-sunset',
  paper: 'builtin-paper',
} as const;

export const BUILTIN_THEME_PRESETS: ThemePreset[] = [
  {
    id: BUILTIN_PRESET_IDS.midnight,
    name: 'Midnight',
    description: '深邃午夜蓝',
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
    theme: {
      version: THEME_SCHEMA_VERSION,
      baseTheme: 'dark',
      colors: {
        'primary': '99 102 241',
        'primary-hover': '79 70 229',
        'bg-base': '12 14 24',
        'bg-elevated': '20 24 38',
        'bg-surface': '28 33 51',
        'bg-hover': '36 42 64',
        'bg-active': '44 51 77',
        'accent-ai': '129 140 248',
      },
      background: { type: 'none' },
      sizing: { radius: 'standard', fontFamily: 'system' },
      effects: { windowOpacity: 1, backdropBlur: 'none', shadow: 'default' },
    },
  },
  {
    id: BUILTIN_PRESET_IDS.ocean,
    name: 'Ocean',
    description: '深海青蓝渐变',
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
    theme: {
      version: THEME_SCHEMA_VERSION,
      baseTheme: 'dark',
      colors: {
        'primary': '20 184 166',
        'primary-hover': '13 148 136',
        'bg-base': '8 20 27',
        'bg-elevated': '13 30 40',
        'bg-surface': '18 42 55',
        'accent-ai': '45 212 191',
        'accent-prototype': '34 211 238',
      },
      background: {
        type: 'gradient',
        gradient: {
          direction: '160deg',
          stops: [
            { color: '8 20 27', position: 0 },
            { color: '15 44 58', position: 100 },
          ],
        },
      },
      sizing: { radius: 'rounded', fontFamily: 'system' },
      effects: { windowOpacity: 1, backdropBlur: 'subtle', shadow: 'default' },
    },
  },
  {
    id: BUILTIN_PRESET_IDS.forest,
    name: 'Forest',
    description: '静谧森林绿',
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
    theme: {
      version: THEME_SCHEMA_VERSION,
      baseTheme: 'dark',
      colors: {
        'primary': '34 197 94',
        'primary-hover': '22 163 74',
        'bg-base': '10 20 14',
        'bg-elevated': '16 30 21',
        'bg-surface': '22 42 30',
        'accent-ai': '74 222 128',
        'accent-workspace': '132 204 22',
      },
      background: { type: 'none' },
      sizing: { radius: 'standard', fontFamily: 'system' },
      effects: { windowOpacity: 1, backdropBlur: 'none', shadow: 'subtle' },
    },
  },
  {
    id: BUILTIN_PRESET_IDS.sunset,
    name: 'Sunset',
    description: '暖阳落日橙',
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
    theme: {
      version: THEME_SCHEMA_VERSION,
      baseTheme: 'dark',
      colors: {
        'primary': '249 115 22',
        'primary-hover': '234 88 12',
        'bg-base': '23 15 12',
        'bg-elevated': '35 22 17',
        'bg-surface': '48 30 22',
        'accent-ai': '251 146 60',
        'accent-workspace': '251 191 36',
      },
      background: {
        type: 'gradient',
        gradient: {
          direction: '135deg',
          stops: [
            { color: '23 15 12', position: 0 },
            { color: '48 26 20', position: 60 },
            { color: '61 33 20', position: 100 },
          ],
        },
      },
      sizing: { radius: 'rounded', fontFamily: 'rounded' },
      effects: { windowOpacity: 1, backdropBlur: 'medium', shadow: 'strong' },
    },
  },
  {
    id: BUILTIN_PRESET_IDS.paper,
    name: 'Paper',
    description: '柔和浅色纸张',
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
    theme: {
      version: THEME_SCHEMA_VERSION,
      baseTheme: 'light',
      colors: {
        'primary': '124 58 237',
        'primary-hover': '109 40 217',
        'bg-base': '250 249 246',
        'bg-elevated': '255 255 255',
        'bg-surface': '244 242 237',
        'accent-ai': '139 92 246',
      },
      background: { type: 'none' },
      sizing: { radius: 'rounded', fontFamily: 'serif' },
      effects: { windowOpacity: 1, backdropBlur: 'none', shadow: 'subtle' },
    },
  },
];
