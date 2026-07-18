/**
 * 主题状态管理
 *
 * 设计要点：
 * - `applyTheme(t)`：仅写 DOM (data-theme attribute) + localStorage + 内部 state，不触发服务端写。
 *   供 configStore 在 loadConfig/updateConfig 等同步流程中使用，避免循环更新。
 * - `setTheme(t)`：applyTheme + 服务端持久化（updateConfigPatch）。
 *   供 UI 主动切换（设置面板、ThemeSwitcher 按钮）调用。
 * - 启动时从 localStorage 读取初值；main.tsx 已在 React render 之前同步写 data-theme 防 FOUC。
 *
 * 自定义主题（Custom Theme）：
 * - `themeCustom` 持有完整预设集合（单一数据源），落盘时整体回写（后端 patch 为顶层浅合并）。
 * - `applyActiveCustomTheme()`：把当前激活预设应用到 DOM（颜色 setProperty + 装饰 <style>）。
 * - `previewCustomTheme(theme)`：仅应用到 DOM 不落盘，用于设置面板实时预览。
 * - 落盘走 debounce，避免拖动 ColorPicker 时高频写 config.json。
 */

import { create } from 'zustand';
import { createLogger } from '@/utils/logger';
import type { CustomTheme, ThemeCustomConfig, ThemePreset } from '@/types/theme';
import { applyCustomThemeToDom, clearCustomThemeFromDom } from '@/utils/customThemeRuntime';
import { BUILTIN_THEME_PRESETS } from './builtinThemePresets';

const log = createLogger('ThemeStore');

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'theme';
/** 自定义主题 localStorage 缓存 key（供 main.tsx FOUC 脚本读取） */
export const CUSTOM_THEME_STORAGE_KEY = 'theme-custom-active';
const DEFAULT_THEME: Theme = 'dark';

/** 落盘 debounce 延迟 */
const PERSIST_DEBOUNCE_MS = 400;

interface ThemeState {
  /** 当前主题 */
  theme: Theme;
  /** 自定义主题配置（预设集合 + 激活态） */
  themeCustom: ThemeCustomConfig | null;
  /** 应用主题：写 DOM + localStorage + 内部 state；不触发服务端写 */
  applyTheme: (theme: Theme) => void;
  /** 用户主动切换：applyTheme + 服务端持久化 */
  setTheme: (theme: Theme) => Promise<void>;

  // === 自定义主题 ===
  /** 从后端 config 同步自定义主题配置（不落盘），并应用激活预设 */
  hydrateThemeCustom: (config: ThemeCustomConfig | null | undefined) => void;
  /** 把当前激活预设应用到 DOM */
  applyActiveCustomTheme: () => void;
  /** 仅应用到 DOM 不落盘（设置面板实时预览用） */
  previewCustomTheme: (theme: CustomTheme) => void;
  /** 结束预览：恢复到当前激活预设的持久化状态 */
  endPreview: () => void;
  /** 启用/停用自定义主题 */
  setCustomThemeEnabled: (enabled: boolean) => void;
  /** 切换激活预设 */
  setActivePreset: (presetId: string) => void;
  /** 新增/更新预设（存在则更新，否则追加） */
  upsertPreset: (preset: ThemePreset) => void;
  /** 删除预设 */
  deletePreset: (presetId: string) => void;
  /** 覆盖整个预设列表（导入用） */
  replacePresets: (presets: ThemePreset[], activePresetId?: string) => void;
}

function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'light' ? 'light' : 'dark';
}

function writeDom(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
}

function writeStorage(theme: Theme): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch (e) {
    log.warn('Failed to persist theme to localStorage', { error: e instanceof Error ? e.message : String(e) });
  }
}

/** 找到当前激活预设 */
function getActivePreset(cfg: ThemeCustomConfig | null): ThemePreset | null {
  if (!cfg || !cfg.presets.length) return null;
  const id = cfg.activePresetId;
  return cfg.presets.find((p) => p.id === id) ?? cfg.presets[0] ?? null;
}

/** 写 localStorage 缓存（供 FOUC）+ 应用/清除 DOM */
function syncCustomThemeToDom(cfg: ThemeCustomConfig | null): void {
  const active = cfg?.enabled ? getActivePreset(cfg) : null;
  if (active) {
    applyCustomThemeToDom(active.theme);
    try {
      window.localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, JSON.stringify(active.theme));
    } catch { /* ignore */ }
  } else {
    clearCustomThemeFromDom();
    try {
      window.localStorage.removeItem(CUSTOM_THEME_STORAGE_KEY);
    } catch { /* ignore */ }
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** debounce 落盘：整体回写 themeCustom（顶层浅合并要求传完整对象） */
function schedulePersist(cfg: ThemeCustomConfig): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      const { useConfigStore } = await import('./configStore');
      await useConfigStore.getState().updateConfigPatch({ themeCustom: cfg });
    } catch (e) {
      log.error('Failed to persist themeCustom', e instanceof Error ? e : new Error(String(e)));
    }
  }, PERSIST_DEBOUNCE_MS);
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: readInitialTheme(),
  themeCustom: null,

  applyTheme: (theme) => {
    if (get().theme === theme) {
      // 状态一致时仍补一次 DOM，保证 data-theme attr 与变量同步
      writeDom(theme);
      return;
    }
    writeDom(theme);
    writeStorage(theme);
    set({ theme });
  },

  setTheme: async (theme) => {
    writeDom(theme);
    writeStorage(theme);
    set({ theme });
    try {
      // 动态引入 configStore 避免循环依赖
      const { useConfigStore } = await import('./configStore');
      await useConfigStore.getState().updateConfigPatch({ theme });
    } catch (e) {
      log.error(
        'Failed to persist theme to server config',
        e instanceof Error ? e : new Error(String(e))
      );
    }
  },

  // === 自定义主题 ===

  hydrateThemeCustom: (config) => {
    // 合并内置预设：确保内置预设始终可用（缺失则补齐），同时保留用户自定义预设。
    // 首次使用（config 为 null）时用内置预设初始化，但 enabled=false —— 默认不改变观感，
    // 用户在设置面板主动开启后才生效。
    let cfg: ThemeCustomConfig;
    if (!config) {
      cfg = {
        enabled: false,
        activePresetId: undefined,
        presets: [...BUILTIN_THEME_PRESETS],
      };
    } else {
      const existingIds = new Set(config.presets.map((p) => p.id));
      const missingBuiltins = BUILTIN_THEME_PRESETS.filter((p) => !existingIds.has(p.id));
      cfg = {
        ...config,
        // 内置预设放前面，用户预设在后
        presets: [...missingBuiltins, ...config.presets],
      };
    }
    set({ themeCustom: cfg });
    syncCustomThemeToDom(cfg);
  },

  applyActiveCustomTheme: () => {
    syncCustomThemeToDom(get().themeCustom);
  },

  previewCustomTheme: (theme) => {
    applyCustomThemeToDom(theme);
  },

  endPreview: () => {
    syncCustomThemeToDom(get().themeCustom);
  },

  setCustomThemeEnabled: (enabled) => {
    const current = get().themeCustom ?? { enabled: false, presets: [] as ThemePreset[] };
    const next: ThemeCustomConfig = { ...current, enabled };
    set({ themeCustom: next });
    syncCustomThemeToDom(next);
    schedulePersist(next);
  },

  setActivePreset: (presetId) => {
    const current = get().themeCustom;
    if (!current) return;
    const next: ThemeCustomConfig = { ...current, activePresetId: presetId };
    set({ themeCustom: next });
    syncCustomThemeToDom(next);
    schedulePersist(next);
  },

  upsertPreset: (preset) => {
    const current = get().themeCustom ?? { enabled: true, presets: [] as ThemePreset[] };
    const idx = current.presets.findIndex((p) => p.id === preset.id);
    const presets = idx >= 0
      ? current.presets.map((p) => (p.id === preset.id ? preset : p))
      : [...current.presets, preset];
    const next: ThemeCustomConfig = {
      ...current,
      presets,
      // 新增/更新后自动激活它
      activePresetId: preset.id,
      enabled: true,
    };
    set({ themeCustom: next });
    syncCustomThemeToDom(next);
    schedulePersist(next);
  },

  deletePreset: (presetId) => {
    const current = get().themeCustom;
    if (!current) return;
    const presets = current.presets.filter((p) => p.id !== presetId);
    // 若删掉的是激活预设，回退到第一个
    const activePresetId = current.activePresetId === presetId
      ? presets[0]?.id
      : current.activePresetId;
    const next: ThemeCustomConfig = { ...current, presets, activePresetId };
    set({ themeCustom: next });
    syncCustomThemeToDom(next);
    schedulePersist(next);
  },

  replacePresets: (presets, activePresetId) => {
    const current = get().themeCustom ?? { enabled: true, presets: [] as ThemePreset[] };
    const next: ThemeCustomConfig = {
      enabled: true,
      presets,
      activePresetId: activePresetId ?? presets[0]?.id ?? current.activePresetId,
    };
    set({ themeCustom: next });
    syncCustomThemeToDom(next);
    schedulePersist(next);
  },
}));
