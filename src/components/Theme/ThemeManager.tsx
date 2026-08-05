/**
 * 主题管理器 — 卡片网格列表（方案B风格）
 *
 * 展示所有主题（内置 + 自定义），支持激活、复制、编辑、导入导出、删除
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useThemeStore } from '@/stores/themeStore';
import { BUILT_IN_THEME_IDS } from '@/types/theme';
import type { ThemeDefinition, ThemeId } from '@/types/theme';
import { isBuiltInThemeId } from '@/types/theme';
import { ThemeEditor } from './ThemeEditor';

export function ThemeManager() {
  const { t } = useTranslation('settings');
  const {
    themes,
    activeThemeId,
    setThemeById,
    saveTheme,
    deleteTheme,
    duplicateTheme,
    downloadTheme,
    importTheme,
  } = useThemeStore();

  const [editingTheme, setEditingTheme] = React.useState<ThemeDefinition | null>(null);
  const [importError, setImportError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleImport = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = importTheme(ev.target?.result as string);
      if (result.success) {
        setImportError(null);
        alert(t('settings:theme.importSuccess', '主题导入成功'));
      } else {
        setImportError(result.error ?? '未知错误');
      }
    };
    reader.readAsText(file);
    // 重置 input 以便重复导入同一文件
    e.target.value = '';
  };

  const handleDuplicate = (id: ThemeId) => {
    const dup = duplicateTheme(id);
    if (dup) {
      // 自动进入编辑模式
      setEditingTheme(dup);
    }
  };

  const handleDelete = (id: ThemeId) => {
    if (isBuiltInThemeId(id)) return;
    const theme = themes.find((t) => t.id === id);
    if (!theme) return;
    if (!confirm(t('settings:theme.deleteConfirm', `确定删除主题「${theme.name}」？`))) return;
    deleteTheme(id);
  };

  const handleUse = (id: ThemeId) => {
    // 使用 setThemeById 而非 applyThemeById：
    // 前者额外触发 updateConfigPatch 将 activeThemeId 持久化到后端 config，
    // 否则重启后 loadConfig 会用后端旧 ID 覆盖 localStorage，导致主题回退。
    void setThemeById(id);
  };

  const handleEdit = (theme: ThemeDefinition) => {
    setEditingTheme(theme);
  };

  const handleSave = (theme: ThemeDefinition) => {
    if (theme.builtIn) {
      // 内置主题：以固定 ID 存入自定义主题，第二次编辑时覆盖
      const now = new Date().toISOString();
      const customId = `custom:${theme.id}`;
      const existing = themes.find((t) => t.id === customId);
      const custom = {
        ...theme,
        id: customId,
        name: existing ? theme.name : `${theme.name} (自定义)`,
        builtIn: false,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      saveTheme(custom);
      setEditingTheme(null);
    } else {
      saveTheme(theme);
      setEditingTheme(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-text-primary">
            {t('settings:theme.title', '全部主题')}
          </h3>
          <span className="text-xs text-text-muted">
            {themes.length} {t('settings:theme.count', '个主题')} · {t('settings:theme.using', '使用中')}: {themes.find(t => t.id === activeThemeId)?.name ?? 'Dark'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleImport}
            className="px-3 py-1.5 text-xs rounded-lg border border-dashed border-border text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors"
          >
            {t('settings:theme.import', '导入')}
          </button>
          <button
            type="button"
            onClick={() => {
              const now = new Date().toISOString();
              const newTheme: ThemeDefinition = {
                id: crypto.randomUUID(),
                name: t('settings:theme.untitled', '未命名主题'),
                version: 1,
                builtIn: false,
                createdAt: now,
                updatedAt: now,
                colors: themes.find(t => t.id === activeThemeId)?.colors ?? (themes.find(t => t.id === BUILT_IN_THEME_IDS.DARK)?.colors as any),
                typography: themes.find(t => t.id === activeThemeId)?.typography ?? (themes.find(t => t.id === BUILT_IN_THEME_IDS.DARK)?.typography as any),
                shape: themes.find(t => t.id === activeThemeId)?.shape ?? (themes.find(t => t.id === BUILT_IN_THEME_IDS.DARK)?.shape as any),
                layout: themes.find(t => t.id === activeThemeId)?.layout ?? (themes.find(t => t.id === BUILT_IN_THEME_IDS.DARK)?.layout as any),
              };
              saveTheme(newTheme);
              setEditingTheme(newTheme);
            }}
            className="px-3 py-1.5 text-xs rounded-lg bg-primary text-on-primary hover:bg-primary-600 transition-colors"
          >
            ＋ {t('settings:theme.new', '新建')}
          </button>
        </div>
      </div>

      {/* 导入错误提示 */}
      {importError && (
        <div className="p-3 rounded-lg bg-danger/10 border border-danger/20 text-xs text-danger">
          {t('settings:theme.importError', '导入失败')}: {importError}
        </div>
      )}

      {/* 隐藏的文件输入 */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".polaris-theme,.json"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* 主题卡片网格 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {themes.map((theme) => {
          const isActive = theme.id === activeThemeId;
          const isBuiltIn = theme.builtIn;
          return (
            <div
              key={theme.id}
              className={`relative rounded-xl border overflow-hidden transition-all duration-200 ${
                isActive
                  ? 'border-primary bg-background-surface shadow-glow'
                  : 'border-border bg-surface hover:border-border-strong hover:shadow-soft'
              }`}
            >
              {/* 主题预览条 */}
              <div className="h-24 flex items-center justify-center relative overflow-hidden theme-preview-strip"
                style={{
                  background: `linear-gradient(135deg,
                    rgb(${theme.colors.background.base}) 0%,
                    rgb(${theme.colors.background.elevated}) 50%,
                    rgb(${theme.colors.primary.base}) 100%)`,
                }}
              >
                {/* 三个圆点装饰 */}
                <div className="absolute bottom-3 left-3 flex gap-1.5">
                  <span className="w-2 h-2 rounded-full" style={{ background: `rgb(${theme.colors.primary.base})` }} />
                  <span className="w-2 h-2 rounded-full" style={{ background: `rgb(${theme.colors.accent.ai})` }} />
                  <span className="w-2 h-2 rounded-full" style={{ background: `rgb(${theme.colors.status.success})` }} />
                </div>
                {isActive && (
                  <span className="absolute top-2 right-2 px-2 py-0.5 rounded-full text-[10px] font-medium bg-primary text-on-primary shadow-glow">
                    ● {t('settings:theme.inUse', '使用中')}
                  </span>
                )}
              </div>

              {/* 卡片内容 */}
              <div className="p-3">
                <div className="flex items-start justify-between mb-1">
                  <h4 className="text-sm font-semibold text-text-primary truncate">
                    {theme.name}
                  </h4>
                  {isBuiltIn && (
                    <span className="shrink-0 ml-2 px-1.5 py-0.5 rounded text-[10px] bg-primary/10 text-primary">
                      {t('settings:theme.builtIn', '内置')}
                    </span>
                  )}
                  {!isBuiltIn && (
                    <span className="shrink-0 ml-2 px-1.5 py-0.5 rounded text-[10px] bg-success/10 text-success">
                      {t('settings:theme.custom', '自定义')}
                    </span>
                  )}
                </div>
                {theme.description && (
                  <p className="text-xs text-text-tertiary line-clamp-2 mb-2">
                    {theme.description}
                  </p>
                )}

                {/* 操作按钮 */}
                <div className="flex items-center gap-1 pt-2 border-t border-border-subtle">
                  <button
                    type="button"
                    onClick={() => handleEdit(theme)}
                    className="px-2 py-1 text-[11px] rounded-md text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDuplicate(theme.id)}
                    className="px-2 py-1 text-[11px] rounded-md text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors"
                  >
                    复制
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadTheme(theme.id)}
                    className="px-2 py-1 text-[11px] rounded-md text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors"
                  >
                    导出
                  </button>
                  {!isBuiltIn && (
                    <button
                      type="button"
                      onClick={() => handleDelete(theme.id)}
                      className="px-2 py-1 text-[11px] rounded-md text-danger hover:bg-danger/10 transition-colors"
                    >
                      删除
                    </button>
                  )}
                  {!isActive && (
                    <button
                      type="button"
                      onClick={() => handleUse(theme.id)}
                      className="ml-auto px-2 py-1 text-[11px] rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                    >
                      ✓ 使用
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 主题编辑器模态框 */}
      {editingTheme && (
        <ThemeEditor
          theme={editingTheme}
          onSave={handleSave}
          onClose={() => setEditingTheme(null)}
        />
      )}
    </div>
  );
}