/**
 * 主题持久化服务
 *
 * 管理主题的存储与读取。当前使用 localStorage 作为持久化存储，
 * API 设计为可后续切换到 DataRoot 文件系统（DataRoot/themes/）：
 * - 替换 STORAGE_KEY 为目标路径
 * - 将 readFromStorage/writeToStorage 改为 invoke 文件操作
 */

import { createLogger } from '@/utils/logger';
import type { ThemeDefinition, ThemeId, ThemeExportFile } from '@/types/theme';
import { CURRENT_FORMAT_VERSION, isBuiltInThemeId, BUILT_IN_THEME_IDS } from '@/types/theme';
import { BUILT_IN_THEMES, getBuiltInThemeByShortName } from '@/data/builtInThemes';

const log = createLogger('ThemeService');

// ============ localStorage 键名 ============

const THEMES_INDEX_KEY = 'polaris:themes:index';
const THEME_PREFIX = 'polaris:theme:';
const ACTIVE_THEME_KEY = 'polaris:activeThemeId';

// ============ 索引结构 ============

interface ThemeIndexEntry {
  id: ThemeId;
  name: string;
  builtIn: boolean;
}

interface ThemeIndex {
  version: number;
  themes: ThemeIndexEntry[];
}

// ============ 内部读写 ============

function readFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeToStorage<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    log.warn('Failed to write to localStorage', { key, error: String(e) });
  }
}

function removeFromStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch { /* ignore */ }
}

// ============ 内置主题相关 ============

/** 获取所有内置主题 */
export function getAllBuiltInThemes(): ThemeDefinition[] {
  return [...BUILT_IN_THEMES];
}

/** 从内置主题或 localStorage 获取主题定义 */
export function getBuiltInTheme(id: ThemeId): ThemeDefinition | undefined {
  return BUILT_IN_THEMES.find((t) => t.id === id);
}

// ============ 用户主题 CRUD ============

/** 获取所有主题（内置 + 用户） */
export function getAllThemes(): ThemeDefinition[] {
  const builtIn = getAllBuiltInThemes();
  const userThemes = getUserThemes();
  return [...builtIn, ...userThemes];
}

/** 获取所有用户自定义主题 */
export function getUserThemes(): ThemeDefinition[] {
  const index = readFromStorage<ThemeIndex>(THEMES_INDEX_KEY, { version: 1, themes: [] });
  const themes: ThemeDefinition[] = [];

  for (const entry of index.themes) {
    if (entry.builtIn) continue; // 内置主题不从 localStorage 读取
    const theme = readFromStorage<ThemeDefinition | null>(THEME_PREFIX + entry.id, null);
    if (theme) {
      themes.push(theme);
    }
  }

  return themes;
}

/** 获取单个主题定义（内置 + 用户） */
export function getTheme(id: ThemeId): ThemeDefinition | undefined {
  // 先查内置
  const builtIn = getBuiltInTheme(id);
  if (builtIn) return builtIn;

  // 再查用户
  return readFromStorage<ThemeDefinition | null>(THEME_PREFIX + id, null) ?? undefined;
}

/** 保存主题（新建或更新） */
export function saveTheme(theme: ThemeDefinition): void {
  if (theme.builtIn) {
    log.warn('Cannot save built-in theme', { id: theme.id, name: theme.name });
    return;
  }

  // 写入主题数据
  writeToStorage(THEME_PREFIX + theme.id, theme);

  // 更新索引
  const index = readFromStorage<ThemeIndex>(THEMES_INDEX_KEY, { version: 1, themes: [] });
  const existing = index.themes.findIndex((e) => e.id === theme.id);
  const entry: ThemeIndexEntry = { id: theme.id, name: theme.name, builtIn: false };

  if (existing >= 0) {
    index.themes[existing] = entry;
  } else {
    index.themes.push(entry);
  }

  writeToStorage(THEMES_INDEX_KEY, index);
}

/** 删除用户主题 */
export function deleteTheme(id: ThemeId): boolean {
  if (isBuiltInThemeId(id)) {
    log.warn('Cannot delete built-in theme', { id });
    return false;
  }

  // 删除数据
  removeFromStorage(THEME_PREFIX + id);

  // 更新索引
  const index = readFromStorage<ThemeIndex>(THEMES_INDEX_KEY, { version: 1, themes: [] });
  index.themes = index.themes.filter((e) => e.id !== id);
  writeToStorage(THEMES_INDEX_KEY, index);

  return true;
}

// ============ 激活主题管理 ============

/** 获取当前激活的主题 ID */
export function getActiveThemeId(): ThemeId {
  const stored = readFromStorage<string | null>(ACTIVE_THEME_KEY, null);
  if (stored && getTheme(stored)) return stored;
  return BUILT_IN_THEME_IDS.DARK;
}

/** 设置当前激活的主题 ID */
export function setActiveThemeId(id: ThemeId): void {
  writeToStorage(ACTIVE_THEME_KEY, id);
}

// ============ 导入导出 ============

/** 导出主题为 .polaris-theme 格式 */
export function exportTheme(id: ThemeId): ThemeExportFile | null {
  const theme = getTheme(id);
  if (!theme) return null;

  const { id: _id, builtIn: _builtIn, createdAt: _createdAt, updatedAt: _updatedAt, ...exportData } = theme;

  return {
    formatVersion: CURRENT_FORMAT_VERSION,
    type: 'polaris-theme',
    exportedAt: new Date().toISOString(),
    theme: exportData,
  };
}

/** 生成导出文件的下载链接 */
export function downloadThemeFile(id: ThemeId): boolean {
  const data = exportTheme(id);
  if (!data) return false;

  const theme = getTheme(id)!;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${theme.name.replace(/[^a-zA-Z0-9一-龥_-]/g, '_')}.polaris-theme`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return true;
}

/** 导入主题文件 */
export function importThemeFile(jsonStr: string): { success: boolean; error?: string; theme?: ThemeDefinition } {
  try {
    const data = JSON.parse(jsonStr) as ThemeExportFile;

    // 验证格式
    if (!data || data.type !== 'polaris-theme') {
      return { success: false, error: '不是有效的主题文件（type !== "polaris-theme"）' };
    }

    if (typeof data.formatVersion !== 'number' || data.formatVersion < 1) {
      return { success: false, error: '不支持的格式版本' };
    }

    if (data.formatVersion > CURRENT_FORMAT_VERSION) {
      return { success: false, error: `主题格式版本过高（${data.formatVersion}），请更新应用` };
    }

    if (!data.theme || !data.theme.name || !data.theme.colors) {
      return { success: false, error: '主题数据不完整（缺少 name 或 colors）' };
    }

    // 生成新主题
    const now = new Date().toISOString();
    const newId = crypto.randomUUID();

    // 处理名称冲突
    let name = data.theme.name.trim();
    if (name.length > 32) name = name.slice(0, 32);

    const allThemes = getAllThemes();
    const nameExists = allThemes.some((t) => t.name === name);
    if (nameExists) {
      name = `${name} (2)`;
    }

    const theme: ThemeDefinition = {
      id: newId,
      name,
      description: data.theme.description,
      author: data.theme.author,
      version: 1,
      builtIn: false,
      createdAt: now,
      updatedAt: now,
      colors: data.theme.colors as any,
      typography: data.theme.typography as any,
      shape: data.theme.shape as any,
      motion: data.theme.motion,
      layout: data.theme.layout as any,
      immersive: data.theme.immersive,
      customCss: data.theme.customCss,
    };

    saveTheme(theme);
    return { success: true, theme };
  } catch (e) {
    return { success: false, error: `文件解析失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

// ============ 旧配置迁移 ============

/** 从旧 config.theme 字段迁移到 activeThemeId */
export function migrateLegacyConfigTheme(legacyTheme?: string, legacySpidermanConfig?: Record<string, unknown>): ThemeId {
  // 如果 legacyTheme 是 uuid 格式（已经是新格式），直接返回
  if (legacyTheme && legacyTheme.includes('-')) {
    return legacyTheme;
  }

  // 从短名称查找
  if (legacyTheme) {
    const builtIn = getBuiltInThemeByShortName(legacyTheme);
    if (builtIn) return builtIn.id;
  }

  // 如果旧 spidermanTheme 存在，尝试迁移到自定义主题
  if (legacySpidermanConfig && Object.keys(legacySpidermanConfig).length > 0) {
    // 创建基于 spiderman 的自定义主题
    const spiderman = getBuiltInTheme(BUILT_IN_THEME_IDS.SPIDERMAN);
    if (spiderman) {
      const now = new Date().toISOString();
      const customTheme: ThemeDefinition = {
        ...spiderman,
        id: crypto.randomUUID(),
        name: 'Spider-Man (Custom)',
        builtIn: false,
        createdAt: now,
        updatedAt: now,
      };
      saveTheme(customTheme);
      return customTheme.id;
    }
  }

  return BUILT_IN_THEME_IDS.DARK;
}