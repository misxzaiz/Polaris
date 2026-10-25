/**
 * 主题持久化服务
 *
 * 双层存储（2026-10-25 Phase 3 跨端对账）：
 * - localStorage：本端同步缓存（首屏防 FOUC 链路依赖同步读，不可异步化）
 * - DataRoot（经 cap.kv 落 <DataRoot>/stores/kv.db）：跨端权威镜像
 *   （此前主题仅存 localStorage，APK/桌面互不可见——AI 经 APK 创建的主题
 *   在桌面端重启即回退 Dark）。合并语义：按 id 并集 + updatedAt 新者胜；
 *   同步时机 = 启动对账 + 写入即推送（防抖），实时广播不做（低频可接受）。
 *
 * 所有用户主题在读取/写入边界经 mergeThemes 以 Dark 兜底归一，防止残缺主题
 * 在渲染层/注入层裸解构（如 colors.primary.base）导致半切换或崩溃。
 */

import { createLogger } from '@/utils/logger';
import type { ThemeDefinition, ThemeId, ThemeExportFile } from '@/types/theme';
import { CURRENT_FORMAT_VERSION, isBuiltInThemeId, BUILT_IN_THEME_IDS } from '@/types/theme';
import { BUILT_IN_THEMES } from '@/data/builtInThemes';
import { mergeThemes } from '@/services/themeMerger';
import { invoke } from '@/services/transport';

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
      themes.push(normalizeUserTheme(theme));
    }
  }

  return themes;
}

/** 归一化用户主题：以 Dark 兜底补全缺失维度（mergeThemes 幂等，可重复调用） */
function normalizeUserTheme(theme: ThemeDefinition): ThemeDefinition {
  const merged = mergeThemes(theme);
  return {
    ...merged,
    id: theme.id,
    name: theme.name,
    builtIn: false,
    createdAt: theme.createdAt,
    updatedAt: theme.updatedAt,
  };
}

/** 获取单个主题定义（内置 + 用户） */
export function getTheme(id: ThemeId): ThemeDefinition | undefined {
  // 先查内置
  const builtIn = getBuiltInTheme(id);
  if (builtIn) return builtIn;

  // 再查用户（读取点归一，防残缺主题裸解构）
  const user = readFromStorage<ThemeDefinition | null>(THEME_PREFIX + id, null);
  return user ? normalizeUserTheme(user) : undefined;
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
  schedulePushToRemote();
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

  schedulePushToRemote();
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

// ============ 跨端同步（DataRoot 权威 + localStorage 本端缓存） ============

const KV_TARGET = 'cap.kv';
const THEMES_KV_KEY = 'ui-themes:v1';

interface RemoteThemeCollection {
  version: number;
  updatedAt: string;
  themes: ThemeDefinition[];
}

interface KvDispatchResponse {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

async function dispatchKv(action: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await invoke<KvDispatchResponse>('router_dispatch', {
    req: { target: KV_TARGET, payload: { action, ...extra } },
  });
  if (!res.ok) throw new Error(res.error || `cap.kv ${action} 失败`);
  return res.result ?? {};
}

/** 全量写回本端缓存（同步对账用）：重建索引 + 清除已删除主题的残留键 */
function writeLocalUserThemes(themes: ThemeDefinition[]): void {
  const old = readFromStorage<ThemeIndex>(THEMES_INDEX_KEY, { version: 1, themes: [] });
  const newIds = new Set(themes.map((t) => t.id));
  for (const entry of old.themes) {
    if (!newIds.has(entry.id)) removeFromStorage(THEME_PREFIX + entry.id);
  }
  for (const theme of themes) {
    writeToStorage(THEME_PREFIX + theme.id, theme);
  }
  writeToStorage(THEMES_INDEX_KEY, {
    version: 1,
    themes: themes.map((t) => ({ id: t.id, name: t.name, builtIn: false })),
  });
}

/** 推送本端用户主题集合到 DataRoot（写入即推送，防抖合并短时多次写） */
async function pushThemesToRemote(): Promise<void> {
  const collection: RemoteThemeCollection = {
    version: 1,
    updatedAt: new Date().toISOString(),
    themes: getUserThemes(),
  };
  await dispatchKv('set', { key: THEMES_KV_KEY, value: collection });
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePushToRemote(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushThemesToRemote().catch((e) => {
      log.warn('主题集合推送 DataRoot 失败（下次写入/对账重试）', { error: String(e) });
    });
  }, 500);
}

/**
 * 与 DataRoot 对账：按 id 并集、单主题 updatedAt 新者胜（LWW）。
 * 本端独有主题会被推送到远端（迁移场景：localStorage 存量 → DataRoot）。
 * @returns 本端列表是否发生变化（调用方据此 refreshThemes）
 */
export async function syncThemesWithRemote(): Promise<boolean> {
  const raw = (await dispatchKv('get', { key: THEMES_KV_KEY })) as {
    value?: RemoteThemeCollection | null;
  };
  const remoteThemes = (raw?.value?.themes ?? []).map(normalizeUserTheme);
  const localThemes = getUserThemes();

  const byId = new Map<string, ThemeDefinition>();
  for (const theme of [...remoteThemes, ...localThemes]) {
    const existing = byId.get(theme.id);
    if (!existing || (theme.updatedAt ?? '') > (existing.updatedAt ?? '')) {
      byId.set(theme.id, theme);
    }
  }
  const merged = [...byId.values()];

  const localById = new Map(localThemes.map((t) => [t.id, t]));
  const localChanged = merged.some((t) => {
    const l = localById.get(t.id);
    return !l || l.updatedAt !== t.updatedAt;
  });
  const remoteById = new Map(remoteThemes.map((t) => [t.id, t]));
  const remoteChanged = merged.some((t) => {
    const r = remoteById.get(t.id);
    return !r || r.updatedAt !== t.updatedAt;
  });

  if (localChanged) writeLocalUserThemes(merged);
  if (remoteChanged) await pushThemesToRemote();
  return localChanged;
}
