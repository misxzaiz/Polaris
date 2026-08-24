/**
 * 主题状态管理（重写：多主题 CRUD Store）
 *
 * 设计要点：
 * - 兼容旧 `applyTheme(t)` / `setTheme(t)` 接口（旧代码仍可调用）
 * - 新接口：`applyThemeById(id)` / `setThemeById(id)`
 * - 主题列表 = 内置主题 + 用户自定义主题
 * - 启动时从 localStorage 读取 activeThemeId
 * - main.tsx 已在 React render 之前同步写 data-theme 防 FOUC
 */

import { create } from 'zustand';
import { createLogger } from '@/utils/logger';
import { BUILT_IN_THEME_IDS } from '@/types/theme';
import type { ThemeDefinition, ThemeId, ThemeExportFile } from '@/types/theme';
import {
  getAllThemes,
  getTheme,
  saveTheme,
  deleteTheme as deleteThemeService,
  getActiveThemeId,
  setActiveThemeId,
  downloadThemeFile,
  importThemeFile,
  exportTheme,
  getUserThemes,
  migrateLegacyConfigTheme,
} from '@/services/themeService';

const log = createLogger('ThemeStore');

/** 旧主题名兼容（用于过渡期） */
type LegacyTheme = 'dark' | 'light' | 'spiderman';

interface ThemeState {
  // ============ 当前状态 ============
  /** 当前激活的主题 ID */
  activeThemeId: ThemeId;
  /** 当前激活的主题定义（缓存） */
  activeTheme: ThemeDefinition | null;
  /** 主题列表（内置 + 用户） */
  themes: ThemeDefinition[];
  /** 用户自定义主题列表 */
  userThemes: ThemeDefinition[];
  /** 是否正在加载 */
  loading: boolean;

  // ============ 旧版兼容方法 ============
  /** 应用主题（仅写 DOM + localStorage + state，不触发服务端写） */
  applyTheme: (theme: LegacyTheme) => void;
  /** 用户主动切换：applyTheme + 服务端持久化 */
  setTheme: (theme: LegacyTheme) => Promise<void>;

  // ============ 新版方法 ============
  /** 通过 ID 应用主题（仅写 DOM + localStorage + state） */
  applyThemeById: (id: ThemeId) => void;
  /** 通过 ID 切换主题（applyThemeById + 服务端持久化） */
  setThemeById: (id: ThemeId) => Promise<void>;
  /** 刷新主题列表 */
  refreshThemes: () => void;

  // ============ CRUD ============
  /** 保存主题（新建或更新） */
  saveTheme: (theme: ThemeDefinition) => void;
  /** 删除用户主题 */
  deleteTheme: (id: ThemeId) => boolean;
  /** 复制主题（基于已有主题创建副本） */
  duplicateTheme: (id: ThemeId) => ThemeDefinition | null;

  // ============ 导入导出 ============
  /** 导出主题 */
  exportTheme: (id: ThemeId) => ThemeExportFile | null;
  /** 下载主题文件 */
  downloadTheme: (id: ThemeId) => boolean;
  /** 导入主题 */
  importTheme: (jsonStr: string) => { success: boolean; error?: string; theme?: ThemeDefinition };

  // ============ 迁移 ============
  /** 从旧 config 字段迁移 */
  migrateFromLegacy: (legacyTheme?: string, legacySpidermanConfig?: Record<string, unknown>) => ThemeId;
}

// ============ DOM 写入 ============

function writeDom(id: ThemeId, theme: ThemeDefinition | null): void {
  if (typeof document === 'undefined') return;

  // 设置 data-theme 属性
  document.documentElement.setAttribute('data-theme', id);

  // 设置 data-theme-immersive 属性（控制沉浸效果 CSS）
  if (theme?.immersive?.enabled) {
    document.documentElement.setAttribute('data-theme-immersive', 'true');
  } else {
    document.documentElement.removeAttribute('data-theme-immersive');
  }

  // 同步更新 favicon
  const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
  if (link) {
    if (id === BUILT_IN_THEME_IDS.SPIDERMAN) {
      link.href = '/spiderman-favicon.svg';
    } else {
      link.href = '/tauri.svg';
    }
  }
}

/**
 * 将 ThemeDefinition 扁平化为 CSS 变量并注入 DOM
 * 这是 themeEngine 的简化版，Phase 1 会替换为完整版
 */
function flattenAndInject(theme: ThemeDefinition): void {
  if (typeof document === 'undefined') return;

  const el = document.documentElement;
  const c = theme.colors;

  // L0 颜色变量
  const colorMap: Record<string, string> = {
    '--c-primary': c.primary.base,
    '--c-primary-hover': c.primary.hover,
    '--c-primary-50': c.primary['50'],
    '--c-primary-100': c.primary['100'],
    '--c-primary-200': c.primary['200'],
    '--c-primary-300': c.primary['300'],
    '--c-primary-400': c.primary['400'],
    '--c-primary-500': c.primary['500'],
    '--c-primary-600': c.primary['600'],
    '--c-primary-700': c.primary['700'],
    '--c-bg-base': c.background.base,
    '--c-bg-elevated': c.background.elevated,
    '--c-bg-surface': c.background.surface,
    '--c-bg-hover': c.background.hover,
    '--c-bg-active': c.background.active,
    '--c-bg-tertiary': c.background.tertiary,
    '--c-bg-secondary': c.background.secondary,
    '--c-border': c.border.base,
    '--c-text-primary': c.text.primary,
    '--c-text-secondary': c.text.secondary,
    '--c-text-tertiary': c.text.tertiary,
    '--c-text-muted': c.text.muted,
    '--c-status-warning': c.status.warning,
    '--c-status-success': c.status.success,
    '--c-status-danger': c.status.danger,
    '--c-status-info': c.status.info,
    '--c-status-done': c.status.done,
    '--c-status-failed': c.status.failed,
    '--c-status-neutral': c.status.neutral,
    '--c-priority-low': c.priority.low,
    '--c-priority-normal': c.priority.normal,
    '--c-priority-high': c.priority.high,
    '--c-priority-urgent': c.priority.urgent,
    '--c-accent-ai': c.accent.ai,
    '--c-accent-prototype': c.accent.prototype,
    '--c-accent-workspace': c.accent.workspace,
    '--c-overlay': c.misc.overlay,
    '--c-on-primary': c.misc.onPrimary,
    '--c-canvas': c.misc.canvas,
    '--c-tag-bg': c.misc.tagBg,
    '--c-shadow': c.misc.shadow,
  };

  for (const [key, value] of Object.entries(colorMap)) {
    el.style.setProperty(key, value);
  }

  // 沉浸效果变量（兼容旧 --spiderman-* 名）
  if (theme.immersive?.enabled) {
    const im = theme.immersive;
    const vars: Record<string, string> = {
      '--spiderman-bg-image': `url('${im.wallpaper.image || ''}')`,
      '--spiderman-bg-overlay': String(1 - im.wallpaper.opacity),
      '--spiderman-bg-position': `${im.wallpaper.positionX}% ${im.wallpaper.positionY}%`,
      '--spiderman-bg-size': im.wallpaper.size,
      '--spiderman-panel-opacity': String(im.layerOpacity.panel),
      '--spiderman-panel-blur': im.effects.panelBlur > 0 ? `blur(${im.effects.panelBlur}px)` : 'none',
      '--spiderman-surface-opacity': String(im.layerOpacity.surface),
      '--spiderman-chat-tool-opacity': String(im.layerOpacity.child),
      '--spiderman-hover-opacity': String(im.effects.hoverOpacity),
      '--spiderman-web-opacity': String(im.effects.webTexture),
      '--spiderman-blue-accent': String(im.effects.blueAccent),
    };

    if (im.avatar?.url) {
      vars['--spiderman-avatar-url'] = `url('${im.avatar.url}')`;
    }

    // 新命名（兼容过渡）
    vars['--theme-bg-image'] = vars['--spiderman-bg-image'];
    vars['--theme-bg-overlay'] = vars['--spiderman-bg-overlay'];
    vars['--theme-panel-opacity'] = vars['--spiderman-panel-opacity'];
    vars['--theme-panel-blur'] = vars['--spiderman-panel-blur'];

    for (const [key, value] of Object.entries(vars)) {
      el.style.setProperty(key, value);
    }
  } else {
    // 非沉浸主题：清除沉浸变量
    const immersiveVars = [
      '--spiderman-bg-image', '--spiderman-bg-overlay', '--spiderman-bg-position', '--spiderman-bg-size',
      '--spiderman-panel-opacity', '--spiderman-panel-blur', '--spiderman-surface-opacity',
      '--spiderman-chat-tool-opacity', '--spiderman-hover-opacity', '--spiderman-web-opacity',
      '--spiderman-blue-accent', '--spiderman-avatar-url',
      '--theme-bg-image', '--theme-bg-overlay', '--theme-panel-opacity', '--theme-panel-blur',
    ];
    for (const v of immersiveVars) {
      el.style.removeProperty(v);
    }
  }
}

// ============ 初始化 ============

const initialActiveId = getActiveThemeId();
const initialTheme = getTheme(initialActiveId);

// 如果初始主题是 spiderman，确保沉浸变量已同步
if (initialTheme?.immersive?.enabled && typeof window !== 'undefined') {
  requestAnimationFrame(() => flattenAndInject(initialTheme));
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  // 初始状态
  activeThemeId: initialActiveId,
  activeTheme: initialTheme ?? null,
  themes: getAllThemes(),
  userThemes: getUserThemes(),
  loading: false,

  // ============ 旧版兼容方法 ============

  applyTheme: (legacyTheme: LegacyTheme) => {
    const idMap: Record<string, string> = {
      dark: BUILT_IN_THEME_IDS.DARK,
      light: BUILT_IN_THEME_IDS.LIGHT,
      spiderman: BUILT_IN_THEME_IDS.SPIDERMAN,
    };
    const id = idMap[legacyTheme] ?? BUILT_IN_THEME_IDS.DARK;
    get().applyThemeById(id);
  },

  setTheme: async (legacyTheme: LegacyTheme) => {
    const idMap: Record<string, string> = {
      dark: BUILT_IN_THEME_IDS.DARK,
      light: BUILT_IN_THEME_IDS.LIGHT,
      spiderman: BUILT_IN_THEME_IDS.SPIDERMAN,
    };
    const id = idMap[legacyTheme] ?? BUILT_IN_THEME_IDS.DARK;
    await get().setThemeById(id);
  },

  // ============ 新版方法 ============

  applyThemeById: (id: ThemeId) => {
    const state = get();
    if (state.activeThemeId === id) {
      // 已激活，补一次 DOM 同步 + CSS 变量注入（确保变量完整，避免启动时
      // bootstrapTheme 回退到 Dark 后 loadConfig 只调 writeDom 不重新注入）
      writeDom(id, state.activeTheme);
      if (state.activeTheme) {
        flattenAndInject(state.activeTheme);
      }
      return;
    }

    const theme = getTheme(id);
    if (!theme) {
      log.warn('Theme not found, falling back to dark', { id });
      const fallback = getTheme(BUILT_IN_THEME_IDS.DARK);
      if (fallback) {
        writeDom(BUILT_IN_THEME_IDS.DARK, fallback);
        flattenAndInject(fallback);
        setActiveThemeId(BUILT_IN_THEME_IDS.DARK);
        set({ activeThemeId: BUILT_IN_THEME_IDS.DARK, activeTheme: fallback });
      }
      return;
    }

    writeDom(id, theme);
    flattenAndInject(theme);
    setActiveThemeId(id);
    set({ activeThemeId: id, activeTheme: theme });
  },

  setThemeById: async (id: ThemeId) => {
    get().applyThemeById(id);
    // 服务端持久化
    try {
      const { useConfigStore } = await import('./configStore');
      await useConfigStore.getState().updateConfigPatch({ activeThemeId: id } as any);
    } catch (e) {
      log.error('Failed to persist theme to server config', e instanceof Error ? e : new Error(String(e)));
    }
  },

  refreshThemes: () => {
    set({
      themes: getAllThemes(),
      userThemes: getUserThemes(),
    });
  },

  // ============ CRUD ============

  saveTheme: (theme: ThemeDefinition) => {
    saveTheme(theme);
    get().refreshThemes();
  },

  deleteTheme: (id: ThemeId) => {
    const result = deleteThemeService(id);
    if (result) {
      const state = get();
      // 如果删除的是当前激活的主题，回退到 dark
      if (state.activeThemeId === id) {
        get().applyThemeById(BUILT_IN_THEME_IDS.DARK);
      }
      get().refreshThemes();
    }
    return result;
  },

  duplicateTheme: (id: ThemeId) => {
    const original = getTheme(id);
    if (!original) return null;

    const now = new Date().toISOString();
    const newTheme: ThemeDefinition = {
      ...original,
      id: crypto.randomUUID(),
      name: `${original.name} (副本)`,
      builtIn: false,
      createdAt: now,
      updatedAt: now,
    };

    saveTheme(newTheme);
    get().refreshThemes();
    return newTheme;
  },

  // ============ 导入导出 ============

  exportTheme: (id: ThemeId) => {
    return exportTheme(id);
  },

  downloadTheme: (id: ThemeId) => {
    return downloadThemeFile(id);
  },

  importTheme: (jsonStr: string) => {
    const result = importThemeFile(jsonStr);
    if (result.success) {
      get().refreshThemes();
    }
    return result;
  },

  // ============ 迁移 ============

  migrateFromLegacy: (legacyTheme?: string, legacySpidermanConfig?: Record<string, unknown>) => {
    const id = migrateLegacyConfigTheme(legacyTheme, legacySpidermanConfig);
    set({ activeThemeId: id, activeTheme: getTheme(id) ?? null });
    return id;
  },
}));