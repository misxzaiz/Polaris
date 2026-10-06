/**
 * cap.ui.theme — 主题/设计系统(AI 改设计 token)
 *
 * 动作: get/set/patch/presets/apply/export/import
 * 操作 UIState.theme (colors/spacing/typography/shadows/radii)
 */

import type { Capability, Value } from '../../contracts.ts';
import { getUiState, setUiState, DEFAULT_THEME, type ThemeTokens } from './state.ts';

const PRESETS: Record<string, ThemeTokens> = {
  dark: DEFAULT_THEME,
  light: {
    ...DEFAULT_THEME,
    colors: {
      bg: '#ffffff', bgElevated: '#f6f8fa', bgInput: '#ffffff',
      border: '#d0d7de', text: '#1f2328', textMuted: '#656d76',
      primary: '#0969da', success: '#1a7f37', warning: '#9a6700',
      danger: '#cf222e', accent: '#0969da',
    },
  },
  midnight: {
    ...DEFAULT_THEME,
    colors: {
      bg: '#0a0e27', bgElevated: '#151935', bgInput: '#0a0e27',
      border: '#1f2547', text: '#a5b4fc', textMuted: '#6b7280',
      primary: '#8b5cf6', success: '#10b981', warning: '#f59e0b',
      danger: '#ef4444', accent: '#a5b4fc',
    },
  },
  forest: {
    ...DEFAULT_THEME,
    colors: {
      bg: '#0f1f0f', bgElevated: '#1a2e1a', bgInput: '#0f1f0f',
      border: '#2d4a2d', text: '#d4e8d4', textMuted: '#7a8c7a',
      primary: '#4ade80', success: '#22c55e', warning: '#fbbf24',
      danger: '#ef4444', accent: '#86efac',
    },
  },
};

export const uiThemeCap: Capability = {
  id: 'cap.ui.theme',
  description: 'Theme/design system. Actions: get/set/patch/presets/apply/export/import.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set', 'patch', 'presets', 'apply', 'export', 'import'] },
      category: { type: 'string', description: 'For get: colors/spacing/typography/shadows/radii' },
      tokens: { type: 'object', description: 'For set/patch: {colors: {...}, spacing: {...}}' },
      preset: { type: 'string', description: 'For apply: dark/light/midnight/forest' },
      theme: { type: 'object', description: 'For import: full ThemeTokens' },
    },
    required: ['action'],
  },
  async invoke(params: Value) {
    const p = params as {
      action: 'get' | 'set' | 'patch' | 'presets' | 'apply' | 'export' | 'import';
      category?: string; tokens?: Partial<ThemeTokens>; preset?: string; theme?: ThemeTokens;
    };
    const state = getUiState();
    switch (p.action) {
      case 'get':
        if (p.category) {
          return { ok: true, category: p.category, tokens: (state.theme as unknown as Record<string, unknown>)[p.category] };
        }
        return { ok: true, theme: state.theme };
      case 'set':
        if (!p.tokens) throw new Error('tokens required for set');
        setUiState({ ...state, theme: { ...DEFAULT_THEME, ...p.tokens } as ThemeTokens });
        return { ok: true, applied: 'set' };
      case 'patch':
        if (!p.tokens) throw new Error('tokens required for patch');
        {
          const newTheme = { ...state.theme };
          for (const [cat, vals] of Object.entries(p.tokens)) {
            if (vals && typeof vals === 'object') {
              (newTheme as Record<string, Record<string, string>>)[cat] = {
                ...(newTheme as Record<string, Record<string, string>>)[cat],
                ...(vals as Record<string, string>),
              };
            }
          }
          setUiState({ ...state, theme: newTheme });
          return { ok: true, applied: 'patch', categories: Object.keys(p.tokens) };
        }
      case 'presets':
        return { ok: true, presets: Object.keys(PRESETS) };
      case 'apply': {
        if (!p.preset) throw new Error('preset required for apply');
        const theme = PRESETS[p.preset];
        if (!theme) return { ok: false, error: `unknown preset: ${p.preset}, available: ${Object.keys(PRESETS).join(', ')}` };
        setUiState({ ...state, theme });
        return { ok: true, applied: p.preset };
      }
      case 'export':
        return { ok: true, theme: state.theme };
      case 'import':
        if (!p.theme) throw new Error('theme required for import');
        setUiState({ ...state, theme: { ...DEFAULT_THEME, ...p.theme } });
        return { ok: true, imported: true };
      default:
        throw new Error(`unknown action: ${(p as { action: string }).action}`);
    }
  },
};
