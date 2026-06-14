/**
 * 通用设置 Tab
 * 包含语言、主题等全局外观偏好
 * 以及应用数据存储路径管理
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Config } from '@/types';
import { getDataRootInfo, formatBytes } from '@/services/tauri/dataRootService';
import { migrateDataRoot } from '@/services/tauri/dataRootService';
import { useToastStore } from '@/stores';
import { currentMode } from '@/services/transport';
import { createLogger } from '@/utils/logger';

const log = createLogger('GeneralTab');

interface GeneralTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

type MigrateMode = 'move' | 'copy';

export function GeneralTab({ config, onConfigChange, loading }: GeneralTabProps) {
  const { t } = useTranslation('settings');
  const { success, error: toastError } = useToastStore();

  const currentTheme = config.theme ?? 'dark';

  // ─── Data Root state ───────────────────────────────────────────────────
  const [dataRootInfo, setDataRootInfo] = useState<ReturnType<typeof getDataRootInfo> | null>(null);
  const [pendingNewRoot, setPendingNewRoot] = useState<string | null>(null);
  const [migrateMode, setMigrateMode] = useState<MigrateMode>('move');
  const [migrating, setMigrating] = useState(false);

  useEffect(() => {
    if (currentMode !== 'tauri') return;
    getDataRootInfo()
      .then(info => setDataRootInfo(info))
      .catch(e => log.error('Failed to get data root info:', e));
  }, []);

  const copyPath = async (path?: string) => {
    const target = path ?? dataRootInfo?.configRoot;
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target);
      success(t('storage.copy'), t('storage.currentRoot'));
    } catch (e) {
      log.error('Clipboard copy failed:', e);
    }
  };

  const openInExplorer = async (path?: string) => {
    const target = path ?? dataRootInfo?.configRoot;
    if (!target) return;
    try {
      const { openPath } = await import('@tauri-apps/plugin-opener');
      await openPath(target);
    } catch (e) {
      log.error('openPath failed:', e);
    }
  };

  const handlePickDirectory = async () => {
    if (currentMode !== 'tauri') return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('storage.changeRoot'),
      });
      if (selected && !Array.isArray(selected)) {
        setPendingNewRoot(selected);
      }
    } catch (error) {
      log.error('选择文件夹失败', error instanceof Error ? error : new Error(String(error)));
    }
  };

  const handleMigrate = async () => {
    if (!pendingNewRoot || !dataRootInfo) {
      toastError(t('storage.migrateFailed'), '请选择目标路径');
      return;
    }
    try {
      setMigrating(true);
      const report = await migrateDataRoot({
        newRoot: pendingNewRoot,
        mode: migrateMode,
      });
      success(t('storage.migrateSuccess'), t('storage.migrateSuccessRestart'));
      setPendingNewRoot(null);
      // Refresh info
      const updated = await getDataRootInfo();
      setDataRootInfo(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('迁移失败', err instanceof Error ? err : new Error(msg));
      toastError(t('storage.migrateFailed'), msg);
    } finally {
      setMigrating(false);
    }
  };

  const handleOpenLegacy = async () => {
    if (!dataRootInfo?.legacyPath) return;
    try {
      const { openPath } = await import('@tauri-apps/plugin-opener');
      await openPath(dataRootInfo.legacyPath);
    } catch (e) {
      log.error('openPath failed:', e);
    }
  };

  return (
    <div className="space-y-6">
      {/* 语言设置 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">{t('language.title')}</h3>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-text-primary">{t('language.current')}</div>
            <div className="text-xs text-text-secondary">{t('language.hint')}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onConfigChange({ ...config, language: 'zh-CN' })}
              disabled={loading}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                (config.language || 'zh-CN') === 'zh-CN'
                  ? 'bg-primary text-on-primary'
                  : 'bg-background-surface border border-border text-text-secondary hover:text-text-primary'
              } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              中文
            </button>
            <button
              type="button"
              onClick={() => onConfigChange({ ...config, language: 'en-US' })}
              disabled={loading}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                config.language === 'en-US'
                  ? 'bg-primary text-on-primary'
                  : 'bg-background-surface border border-border text-text-secondary hover:text-text-primary'
              } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              English
            </button>
          </div>
        </div>
      </div>

      {/* 外观主题 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">{t('appearance.title')}</h3>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-text-primary">{t('appearance.current')}</div>
            <div className="text-xs text-text-secondary">{t('appearance.hint')}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onConfigChange({ ...config, theme: 'dark' })}
              disabled={loading}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                currentTheme === 'dark'
                  ? 'bg-primary text-on-primary'
                  : 'bg-background-surface border border-border text-text-secondary hover:text-text-primary'
              } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {t('appearance.dark')}
            </button>
            <button
              type="button"
              onClick={() => onConfigChange({ ...config, theme: 'light' })}
              disabled={loading}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors inline-flex items-center gap-1.5 ${
                currentTheme === 'light'
                  ? 'bg-primary text-on-primary'
                  : 'bg-background-surface border border-border text-text-secondary hover:text-text-primary'
              } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
              title={t('appearance.experimental')}
            >
              {t('appearance.light')}
              <span className="text-[10px] px-1 py-0.5 rounded bg-accent-workspace/15 text-accent-workspace leading-none">
                β
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* 数据存储位置 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">{t('storage.title')}</h3>

        {/* 当前路径 */}
        {dataRootInfo && (
          <div className="mb-3">
            <label className="block text-xs text-text-secondary mb-2">
              {t('storage.currentRoot')}
            </label>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={dataRootInfo.configRoot}
                className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
              />
              <button
                type="button"
                onClick={() => copyPath()}
                className="px-3 py-2 text-xs bg-background-surface border border-border rounded-lg text-text-secondary hover:text-text-primary transition-colors"
              >
                {t('storage.copy')}
              </button>
              <button
                type="button"
                onClick={() => openInExplorer()}
                className="px-3 py-2 text-xs bg-background-surface border border-border rounded-lg text-text-secondary hover:text-text-primary transition-colors"
              >
                {t('storage.openInExplorer')}
              </button>
            </div>
            <p className="mt-1 text-xs text-text-tertiary">
              {dataRootInfo.isCustom ? t('storage.custom') : t('storage.default')} · {formatBytes(dataRootInfo.totalBytes)}
            </p>
          </div>
        )}

        {/* 自定义路径变更 */}
        <div className="mb-3">
          <label className="block text-xs text-text-secondary mb-2">
            {t('storage.changeRoot')}
          </label>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={pendingNewRoot ?? t('storage.notSelected')}
              placeholder={t('storage.notSelected')}
              className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            />
            <button
              type="button"
              onClick={handlePickDirectory}
              className="px-3 py-2 text-xs bg-background-surface border border-border rounded-lg text-text-secondary hover:text-text-primary transition-colors"
            >
              {t('storage.browse')}
            </button>
          </div>
          <p className="mt-1 text-xs text-text-tertiary">
            {t('storage.changeRootHint')}
          </p>
        </div>

        {/* 迁移模式 + 触发 */}
        {pendingNewRoot && (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-text-primary cursor-pointer">
                <input
                  type="radio"
                  name="migrate-mode"
                  checked={migrateMode === 'move'}
                  onChange={() => setMigrateMode('move')}
                  disabled={migrating}
                />
                {t('storage.modeMove')}
              </label>
              <label className="flex items-center gap-1.5 text-xs text-text-primary cursor-pointer">
                <input
                  type="radio"
                  name="migrate-mode"
                  checked={migrateMode === 'copy'}
                  onChange={() => setMigrateMode('copy')}
                  disabled={migrating}
                />
                {t('storage.modeCopy')}
              </label>
            </div>
            <button
              type="button"
              onClick={handleMigrate}
              disabled={migrating}
              className={`px-4 py-2 text-xs rounded-lg transition-colors ${
                migrating
                  ? 'bg-primary/50 text-on-primary cursor-wait'
                  : 'bg-primary text-on-primary hover:opacity-90'
              }`}
            >
              {migrating ? t('storage.migrating') : t('storage.startMigrate')}
            </button>
          </div>
        )}

        {/* 旧版数据检测提示 */}
        {dataRootInfo?.legacyPresent && dataRootInfo.legacyPath && (
          <div className="mt-3 p-3 bg-amber-faint border border-amber/30 rounded">
            <p className="text-xs text-text-primary">
              {t('storage.legacyDetected', { path: dataRootInfo.legacyPath })}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={handleOpenLegacy}
                className="px-3 py-1.5 text-xs bg-amber/10 text-amber rounded-lg border border-amber/30 hover:opacity-90 transition-colors"
              >
                {t('storage.openInExplorer')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
