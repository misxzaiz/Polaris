/**
 * ThemeCustomTab - 自定义主题设置面板
 *
 * 自管理型 Tab：直接读写 themeStore，不经 SettingsPage 的 config props。
 *
 * 编辑模型（草稿 + 即时预览 + 提交）：
 * - 选中一个预设进入编辑：以其为草稿 draft。
 * - 任意改动 → setDraft + previewCustomTheme(draft.theme)（DOM 即时反馈）
 *   → upsertPreset(draft)（themeStore 内部 debounce 落盘）。
 * - 内置预设只读：编辑前提示「另存为副本」。
 *
 * 预设管理：新建 / 复制 / 重命名 / 删除 / 切换 / 导入 / 导出。
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Copy, Pencil, Trash2, Check, Download, Upload, Palette } from 'lucide-react';
import { useThemeStore } from '@/stores/themeStore';
import { useToastStore } from '@/stores';
import { generateUUID } from '@/utils/uuid';
import { ColorPicker } from '../ThemeCustomColorPicker';
import { BackgroundEditor, SizingEditor, EffectsEditor } from '../ThemeCustomEditors';
import {
  THEME_COLOR_GROUPS,
  getBaseThemeColors,
  createEmptyCustomTheme,
  THEME_SCHEMA_VERSION,
  isValidRgbTriple,
} from '@/types/theme';
import type {
  ThemePreset,
  CustomTheme,
  ThemeColorKey,
  BackgroundConfig,
  ThemeSizing,
  ThemeEffects,
  RgbTriple,
} from '@/types/theme';

type EditorSection = 'colors' | 'background' | 'sizing' | 'effects';

export function ThemeCustomTab() {
  const { t } = useTranslation('settings');
  const { success, error: toastError } = useToastStore();

  const themeCustom = useThemeStore((s) => s.themeCustom);
  const setCustomThemeEnabled = useThemeStore((s) => s.setCustomThemeEnabled);
  const setActivePreset = useThemeStore((s) => s.setActivePreset);
  const upsertPreset = useThemeStore((s) => s.upsertPreset);
  const deletePreset = useThemeStore((s) => s.deletePreset);
  const replacePresets = useThemeStore((s) => s.replacePresets);
  const previewCustomTheme = useThemeStore((s) => s.previewCustomTheme);
  const endPreview = useThemeStore((s) => s.endPreview);

  const enabled = themeCustom?.enabled ?? false;
  const presets = themeCustom?.presets ?? [];
  const activePresetId = themeCustom?.activePresetId;

  // 当前正在编辑的预设 id（默认取激活预设）
  const [editingId, setEditingId] = useState<string | undefined>(activePresetId ?? presets[0]?.id);
  const [section, setSection] = useState<EditorSection>('colors');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // 同步：激活预设变化时若当前未在编辑，跟随
  useEffect(() => {
    if (!editingId && activePresetId) setEditingId(activePresetId);
  }, [activePresetId, editingId]);

  const editing = useMemo(
    () => presets.find((p) => p.id === editingId) ?? null,
    [presets, editingId],
  );

  const baseColors = useMemo(
    () => getBaseThemeColors(editing?.theme.baseTheme ?? 'dark'),
    [editing?.theme.baseTheme],
  );

  // 提交草稿：更新预设 + 即时预览
  const commitTheme = useCallback(
    (preset: ThemePreset, nextTheme: CustomTheme) => {
      const updated: ThemePreset = { ...preset, theme: nextTheme, updatedAt: Date.now() };
      upsertPreset(updated);
      if (enabled) previewCustomTheme(nextTheme);
    },
    [upsertPreset, previewCustomTheme, enabled],
  );

  // ============ 颜色编辑 ============
  const handleColorChange = useCallback(
    (key: ThemeColorKey, value: RgbTriple) => {
      if (!editing || editing.builtin) return;
      const colors = { ...editing.theme.colors, [key]: value };
      commitTheme(editing, { ...editing.theme, colors });
    },
    [editing, commitTheme],
  );

  const handleColorReset = useCallback(
    (key: ThemeColorKey) => {
      if (!editing || editing.builtin) return;
      const colors = { ...editing.theme.colors };
      delete colors[key];
      commitTheme(editing, { ...editing.theme, colors });
    },
    [editing, commitTheme],
  );

  const handleResetAll = useCallback(() => {
    if (!editing || editing.builtin) return;
    commitTheme(editing, { ...editing.theme, colors: {} });
  }, [editing, commitTheme]);

  // ============ 背景/尺寸/特效编辑 ============
  const handleBackgroundChange = useCallback(
    (background: BackgroundConfig) => {
      if (!editing || editing.builtin) return;
      commitTheme(editing, { ...editing.theme, background });
    },
    [editing, commitTheme],
  );

  const handleSizingChange = useCallback(
    (sizing: ThemeSizing) => {
      if (!editing || editing.builtin) return;
      commitTheme(editing, { ...editing.theme, sizing });
    },
    [editing, commitTheme],
  );

  const handleEffectsChange = useCallback(
    (effects: ThemeEffects) => {
      if (!editing || editing.builtin) return;
      commitTheme(editing, { ...editing.theme, effects });
    },
    [editing, commitTheme],
  );

  const handleBaseThemeChange = useCallback(
    (baseTheme: 'dark' | 'light') => {
      if (!editing || editing.builtin) return;
      commitTheme(editing, { ...editing.theme, baseTheme });
    },
    [editing, commitTheme],
  );

  // ============ 预设管理 ============
  const handleNewPreset = useCallback(() => {
    const preset: ThemePreset = {
      id: generateUUID(),
      name: t('themeCustom.unnamedPreset'),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      theme: createEmptyCustomTheme('dark'),
    };
    upsertPreset(preset);
    setEditingId(preset.id);
  }, [upsertPreset, t]);

  const handleDuplicate = useCallback(
    (source: ThemePreset) => {
      const preset: ThemePreset = {
        id: generateUUID(),
        name: `${source.name} copy`,
        description: source.description,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        // 深拷贝主题内容，去掉 builtin 标记
        theme: JSON.parse(JSON.stringify(source.theme)),
      };
      upsertPreset(preset);
      setEditingId(preset.id);
    },
    [upsertPreset],
  );

  const handleDelete = useCallback(
    (preset: ThemePreset) => {
      if (preset.builtin) {
        toastError(t('themeCustom.messages.cannotDeleteBuiltin'));
        return;
      }
      if (!window.confirm(t('themeCustom.messages.deleteConfirm'))) return;
      deletePreset(preset.id);
      if (editingId === preset.id) setEditingId(activePresetId);
    },
    [deletePreset, editingId, activePresetId, toastError, t],
  );

  const startRename = useCallback((preset: ThemePreset) => {
    setRenamingId(preset.id);
    setRenameValue(preset.name);
  }, []);

  const commitRename = useCallback(
    (preset: ThemePreset) => {
      const name = renameValue.trim();
      if (name && name !== preset.name) {
        upsertPreset({ ...preset, name, updatedAt: Date.now() });
      }
      setRenamingId(null);
    },
    [renameValue, upsertPreset],
  );

  // ============ 导入/导出 ============
  const handleExport = useCallback(
    (preset: ThemePreset) => {
      const data = JSON.stringify({ ...preset, builtin: undefined }, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `polaris-theme-${preset.name.replace(/\s+/g, '-').toLowerCase()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      success(t('themeCustom.messages.exported'));
    },
    [success, t],
  );

  const handleImport = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        // 兼容两种格式：单个 ThemePreset，或 { presets: [...] }
        const incoming: ThemePreset[] = Array.isArray(parsed?.presets)
          ? parsed.presets
          : [parsed];
        const valid = incoming.filter(
          (p) => p && typeof p === 'object' && p.theme && typeof p.theme === 'object',
        );
        if (!valid.length) throw new Error('no valid preset');
        // 重新分配 id，避免与现有冲突；去掉 builtin 标记
        const normalized = valid.map((p) => ({
          ...p,
          id: generateUUID(),
          builtin: undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          theme: { ...createEmptyCustomTheme(), ...p.theme, version: THEME_SCHEMA_VERSION },
        }));
        const merged = [...presets, ...normalized];
        replacePresets(merged, normalized[0].id);
        setEditingId(normalized[0].id);
        success(t('themeCustom.messages.imported'));
      } catch {
        toastError(t('themeCustom.messages.importFailed'));
      }
    };
    input.click();
  }, [presets, replacePresets, success, toastError, t]);

  // 卸载时结束预览（恢复持久化态）
  useEffect(() => {
    return () => {
      endPreview();
    };
  }, [endPreview]);

  const isReadonly = editing?.builtin ?? false;

  return (
    <div className="space-y-4">
      {/* 说明 + 总开关 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
              <Palette size={15} /> {t('themeCustom.title')}
            </h3>
            <p className="text-xs text-text-secondary mt-1">{t('themeCustom.hint')}</p>
          </div>
          <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
            <span className="text-xs text-text-secondary">{t('themeCustom.enable')}</span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setCustomThemeEnabled(e.target.checked)}
              className="w-4 h-4 accent-primary cursor-pointer"
            />
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-4">
        {/* 预设列表 */}
        <div className="p-3 bg-surface rounded-lg border border-border space-y-2 h-fit">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-primary">{t('themeCustom.presets')}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleImport}
                title={t('themeCustom.import')}
                className="p-1 text-text-tertiary hover:text-text-primary rounded hover:bg-background-hover"
              >
                <Upload size={14} />
              </button>
              <button
                type="button"
                onClick={handleNewPreset}
                title={t('themeCustom.newPreset')}
                className="p-1 text-text-tertiary hover:text-text-primary rounded hover:bg-background-hover"
              >
                <Plus size={15} />
              </button>
            </div>
          </div>

          <div className="space-y-1 max-h-[420px] overflow-y-auto">
            {presets.map((preset) => {
              const isActive = preset.id === activePresetId && enabled;
              const isEditing = preset.id === editingId;
              return (
                <div
                  key={preset.id}
                  onClick={() => setEditingId(preset.id)}
                  className={`group rounded-md px-2 py-1.5 cursor-pointer transition-colors border ${
                    isEditing
                      ? 'bg-primary/10 border-primary/40'
                      : 'border-transparent hover:bg-background-hover'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className="w-3 h-3 rounded-full flex-shrink-0 border border-border"
                      style={{
                        backgroundColor: `rgb(${preset.theme.colors.primary ?? getBaseThemeColors(preset.theme.baseTheme).primary})`,
                      }}
                    />
                    {renamingId === preset.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => commitRename(preset)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(preset);
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="flex-1 min-w-0 bg-background-base border border-primary rounded px-1 py-0.5 text-xs text-text-primary focus:outline-none"
                      />
                    ) : (
                      <span className="flex-1 min-w-0 text-xs text-text-primary truncate">
                        {preset.name}
                      </span>
                    )}
                    {isActive && <Check size={13} className="text-primary flex-shrink-0" />}
                  </div>

                  <div className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {!isActive && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!enabled) setCustomThemeEnabled(true);
                          setActivePreset(preset.id);
                        }}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary hover:bg-primary/25"
                      >
                        {t('themeCustom.activate')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDuplicate(preset);
                      }}
                      title={t('themeCustom.duplicate')}
                      className="p-0.5 text-text-tertiary hover:text-text-primary"
                    >
                      <Copy size={12} />
                    </button>
                    {!preset.builtin && (
                      <>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(preset);
                          }}
                          title={t('themeCustom.rename')}
                          className="p-0.5 text-text-tertiary hover:text-text-primary"
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(preset);
                          }}
                          title={t('themeCustom.delete')}
                          className="p-0.5 text-text-tertiary hover:text-danger"
                        >
                          <Trash2 size={12} />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleExport(preset);
                      }}
                      title={t('themeCustom.export')}
                      className="p-0.5 text-text-tertiary hover:text-text-primary"
                    >
                      <Download size={12} />
                    </button>
                    {preset.builtin && (
                      <span className="text-[10px] px-1 py-0.5 rounded bg-background-active text-text-muted ml-auto">
                        {t('themeCustom.builtin')}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 编辑区 */}
        <div className="p-4 bg-surface rounded-lg border border-border space-y-3">
          {!editing ? (
            <div className="text-center text-text-muted text-sm py-8">—</div>
          ) : (
            <>
              {isReadonly && (
                <div className="flex items-center justify-between gap-2 p-2 rounded-md bg-info/10 border border-info/30">
                  <span className="text-xs text-info">
                    {t('themeCustom.builtin')} · {t('themeCustom.duplicate')}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleDuplicate(editing)}
                    className="text-xs px-2 py-1 rounded bg-primary text-on-primary hover:bg-primary-hover"
                  >
                    {t('themeCustom.duplicate')}
                  </button>
                </div>
              )}

              {/* 基础主题 */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">{t('themeCustom.baseTheme')}</span>
                <div className="inline-flex rounded-lg bg-background-base border border-border-subtle p-0.5">
                  {(['dark', 'light'] as const).map((b) => (
                    <button
                      key={b}
                      type="button"
                      disabled={isReadonly}
                      onClick={() => handleBaseThemeChange(b)}
                      className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                        (editing.theme.baseTheme ?? 'dark') === b
                          ? 'bg-primary text-on-primary'
                          : 'text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {t(b === 'dark' ? 'themeCustom.baseDark' : 'themeCustom.baseLight')}
                    </button>
                  ))}
                </div>
              </div>

              {/* 分区切换 */}
              <div className="flex items-center gap-1 border-b border-border-subtle pb-2">
                {(['colors', 'background', 'sizing', 'effects'] as EditorSection[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSection(s)}
                    className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                      section === s
                        ? 'bg-background-active text-text-primary'
                        : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {t(`themeCustom.section.${s}`)}
                  </button>
                ))}
              </div>

              {/* 分区内容 */}
              {section === 'colors' && (
                <div className="space-y-3">
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={handleResetAll}
                      disabled={isReadonly}
                      className="text-xs text-text-tertiary hover:text-text-primary disabled:opacity-40"
                    >
                      {t('themeCustom.resetAll')}
                    </button>
                  </div>
                  {THEME_COLOR_GROUPS.map((group) => (
                    <div key={group.labelKey} className="space-y-0.5">
                      <div className="text-[11px] font-medium text-text-tertiary uppercase tracking-wide mb-1">
                        {t(group.labelKey)}
                      </div>
                      {group.keys.map((key) => {
                        const overrideVal = editing.theme.colors[key];
                        return (
                          <ColorPicker
                            key={key}
                            label={t(`themeCustom.color.${key}`)}
                            value={overrideVal && isValidRgbTriple(overrideVal) ? overrideVal : undefined}
                            fallback={baseColors[key]}
                            overridden={overrideVal !== undefined}
                            onChange={(v) => handleColorChange(key, v)}
                            onReset={() => handleColorReset(key)}
                            disabled={isReadonly}
                            resetTitle={t('themeCustom.resetColor')}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}

              {section === 'background' && (
                <BackgroundEditor
                  value={editing.theme.background ?? { type: 'none' }}
                  onChange={handleBackgroundChange}
                  disabled={isReadonly}
                />
              )}

              {section === 'sizing' && (
                <SizingEditor
                  value={editing.theme.sizing ?? {}}
                  onChange={handleSizingChange}
                  disabled={isReadonly}
                />
              )}

              {section === 'effects' && (
                <EffectsEditor
                  value={editing.theme.effects ?? {}}
                  onChange={handleEffectsChange}
                  disabled={isReadonly}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
