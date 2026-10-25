/**
 * 主题管理器 — 卡片网格列表
 *
 * 手动新建/编辑/复制/导入已移除（2026-10-25 主题瘦身）：主题的创建与调整
 * 经 AI 对话完成（cap.ui.theme，见 ThemeTab 指南）；导出/删除保留作备份与
 * 清理出口。挂载时与 DataRoot 对账（跨端主题合并）。
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useThemeStore } from '@/stores/themeStore';
import type { ThemeId } from '@/types/theme';
import { isBuiltInThemeId } from '@/types/theme';

export function ThemeManager() {
  const { t } = useTranslation('settings');
  const {
    themes,
    activeThemeId,
    setThemeById,
    deleteTheme,
    downloadTheme,
  } = useThemeStore();

  // 打开设置时与 DataRoot 对账：拉取其他端（含 AI 经 APK 创建）的主题
  React.useEffect(() => {
    void useThemeStore.getState().syncFromRemote();
  }, []);

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
      </div>

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
    </div>
  );
}
