/**
 * 设置模态框 - 重构版
 * 支持：
 * - 左侧导航分组
 * - 右侧内容区域
 * - 分组保存按钮
 * - Toast 提示
 */

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfigStore, useToastStore } from '../../stores';
import { Button } from '../Common';
import { SettingsSidebar, type SettingsTabId } from './SettingsSidebar';
import { AIEngineTab } from './tabs/AIEngineTab';
import { GeneralTab } from './tabs/GeneralTab';
import { SystemPromptTab } from './tabs/SystemPromptTab';
import { PromptSnippetTab } from './tabs/PromptSnippetTab';
import { WindowTab } from './tabs/WindowTab';
import { TranslateTab } from './tabs/TranslateTab';
import { QQBotTab } from './tabs/QQBotTab';
import { FeishuTab } from './tabs/FeishuTab';
import { SpeechTab } from './tabs/SpeechTab';
import { AdvancedTab } from './tabs/AdvancedTab';
import { AutoModeTab } from './tabs/AutoModeTab';
import { AppUpdateTab } from './tabs/AppUpdateTab';
import { LspTab } from './tabs/LspTab';
import { WebTab } from './tabs/WebTab';
import { PluginTab } from './tabs/PluginTab';
import { createLogger } from '../../utils/logger';
import { applyWebServer, getConfig } from '../../services/tauri/configService';
import { currentMode } from '../../services/transport';
import type { Config, ConfigPatch } from '../../types';

const log = createLogger('SettingsModal');

interface SettingsModalProps {
  onClose: () => void;
  /** 初始显示的标签页 */
  initialTab?: SettingsTabId;
}

// Tab 标题映射 - 使用 i18n key
const TAB_TITLE_KEYS: Record<SettingsTabId, string> = {
  'general': 'nav.general',
  'auto-mode': 'nav.autoMode',
  'plugins': 'nav.plugins',
  'system-prompt': 'nav.systemPrompt',
  'prompt-snippet': 'nav.promptSnippet',
  'window': 'nav.window',
  'ai-engine': 'nav.aiEngine',
  'translate': 'nav.translate',
  'qqbot': 'nav.qqbot',
  'feishu': 'nav.feishu',
  'speech': 'nav.speech',
  'lsp': 'nav.lsp',
  'app-update': 'nav.appUpdate',
  'advanced': 'nav.advanced',
  'web': 'nav.web',
};

export function SettingsModal({ onClose, initialTab }: SettingsModalProps) {
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');

  const { config, loading, error, updateConfigPatch } = useConfigStore();
  const { success, error: toastError } = useToastStore();

  const [localConfig, setLocalConfig] = useState<Config | null>(config);
  const baseConfigRef = useRef<Config | null>(config);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTabId>(initialTab || 'general');
  const [searchQuery, setSearchQuery] = useState('');
  const [webStatusRefreshKey, setWebStatusRefreshKey] = useState(0);

  // 同步远程配置到本地
  useEffect(() => {
    if (config) {
      setLocalConfig(config);
      baseConfigRef.current = config;
    }
  }, [config]);

  const topLevelKeysByTab: Partial<Record<SettingsTabId, (keyof Config)[]>> = {
    general: ['language'],
    window: ['window'],
    translate: ['baiduTranslate'],
    speech: ['speech', 'tts', 'wakeWord', 'voiceNotification', 'voiceCommands'],
    advanced: ['gitBinPath', 'sessionDir'],
    web: ['web'],
    'ai-engine': ['defaultEngine', 'claudeCode', 'codexCode', 'modelProfiles', 'activeModelProfileId'],
  };

  const hasChanged = (a: unknown, b: unknown) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);

  const buildPatch = (local: Config, keys?: (keyof Config)[]): ConfigPatch => {
    const base = baseConfigRef.current;
    if (!base) return local;

    const targetKeys = keys ?? (Object.keys(local) as (keyof Config)[]);
    return targetKeys.reduce((patch, key) => {
      if (hasChanged(local[key], base[key])) {
        return { ...patch, [key]: local[key] === undefined ? null : local[key] };
      }
      return patch;
    }, {} as ConfigPatch);
  };

  const preserveUnsavedLocalChanges = (
    savedConfig: Config,
    local: Config,
    savedKeys: (keyof Config)[],
  ): Config => {
    const base = baseConfigRef.current;
    if (!base) return savedConfig;

    const savedKeySet = new Set(savedKeys);
    return (Object.keys(local) as (keyof Config)[]).reduce((next, key) => {
      if (!savedKeySet.has(key) && hasChanged(local[key], base[key])) {
        return { ...next, [key]: local[key] };
      }
      return next;
    }, savedConfig);
  };

  const applyWebServerIfNeeded = async (shouldApply: boolean) => {
    if (!shouldApply || currentMode !== 'tauri') return;
    await applyWebServer();
    setWebStatusRefreshKey((key) => key + 1);
  };

  // 保存当前分组配置
  const handleSaveCurrentTab = async () => {
    if (!localConfig) return;

    try {
      setSaving(true);
      const keys = topLevelKeysByTab[activeTab] ?? [];
      const patch = buildPatch(localConfig, keys);
      const savedConfig = Object.keys(patch).length > 0
        ? await updateConfigPatch(patch)
        : await getConfig();
      await applyWebServerIfNeeded(activeTab === 'web');
      if (savedConfig) {
        const nextLocal = preserveUnsavedLocalChanges(savedConfig, localConfig, keys);
        baseConfigRef.current = savedConfig;
        setLocalConfig(nextLocal);
      }
      success(t('messages.saved'), t('messages.configSavedDesc'));
    } catch (err) {
      log.error('Failed to save config:', err instanceof Error ? err : new Error(String(err)));
      toastError(t('messages.saveFailed'), err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // 保存所有配置并关闭
  const handleSaveAndClose = async () => {
    if (!localConfig) return;

    try {
      setSaving(true);
      const patch = buildPatch(localConfig);
      if (Object.keys(patch).length > 0) {
        await updateConfigPatch(patch);
      }
      await applyWebServerIfNeeded(Object.prototype.hasOwnProperty.call(patch, 'web'));
      success(t('messages.saved'), t('messages.configSavedDesc'));
      onClose();
    } catch (err) {
      log.error('保存配置失败', err instanceof Error ? err : new Error(String(err)));
      toastError(t('messages.saveFailed'), err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!localConfig) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-background-elevated rounded-xl p-6 max-w-md w-full mx-4 shadow-soft">
          <div className="text-center">{tCommon('status.loading')}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
      <div className="bg-background-elevated rounded-xl w-full max-w-4xl h-[95vh] sm:h-[85vh] flex flex-col shadow-soft overflow-hidden">
        {/* 顶部标题栏 */}
        <div className="flex items-center justify-between px-3 sm:px-6 py-3 sm:py-4 border-b border-border-subtle">
          <h2 className="text-lg font-semibold text-text-primary">{t('title')}</h2>
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              onClick={onClose}
              disabled={saving}
            >
              {tCommon('actions.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handleSaveAndClose}
              disabled={saving || loading}
            >
              {saving ? tCommon('status.saving') : tCommon('actions.saveAndClose')}
            </Button>
          </div>
        </div>

        {/* 主体内容 */}
        <div className="flex flex-col sm:flex-row flex-1 overflow-hidden">
          {/* 左侧导航 */}
          <SettingsSidebar
            activeTab={activeTab}
            onTabChange={setActiveTab}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
          />

          {/* 右侧内容区域 */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* 错误提示 */}
            {error && (
              <div className="mx-4 mt-4 p-3 bg-danger-faint border border-danger/30 rounded-lg text-danger text-sm">
                {error}
              </div>
            )}

            {/* Tab 内容 */}
            <div className="flex-1 overflow-y-auto p-3 sm:p-6">
              <h3 className="text-base font-medium text-text-primary mb-4">
                {t(TAB_TITLE_KEYS[activeTab])}
              </h3>

              {activeTab === 'auto-mode' && (
                <AutoModeTab />
              )}

              {activeTab === 'plugins' && (
                <PluginTab />
              )}

              {activeTab === 'ai-engine' && (
                <AIEngineTab
                  config={localConfig}
                  onConfigChange={setLocalConfig}
                  loading={loading}
                />
              )}

              {activeTab === 'general' && (
                <GeneralTab
                  config={localConfig}
                  onConfigChange={setLocalConfig}
                  loading={loading}
                />
              )}

              {activeTab === 'system-prompt' && (
                <SystemPromptTab />
              )}

              {activeTab === 'prompt-snippet' && (
                <PromptSnippetTab />
              )}

              {activeTab === 'window' && (
                <WindowTab
                  config={localConfig}
                  onConfigChange={setLocalConfig}
                  loading={loading}
                />
              )}

              {activeTab === 'translate' && (
                <TranslateTab
                  config={localConfig}
                  onConfigChange={setLocalConfig}
                  loading={loading}
                />
              )}

              {activeTab === 'qqbot' && (
                <QQBotTab
                  loading={loading}
                />
              )}

              {activeTab === 'feishu' && (
                <FeishuTab
                  loading={loading}
                />
              )}

              {activeTab === 'speech' && (
                <SpeechTab
                  config={localConfig}
                  onConfigChange={setLocalConfig}
                  loading={loading}
                />
              )}

              {activeTab === 'advanced' && (
                <AdvancedTab
                  config={localConfig}
                  onConfigChange={setLocalConfig}
                  loading={loading}
                />
              )}

              {activeTab === 'lsp' && (
                <LspTab />
              )}

              {activeTab === 'app-update' && (
                <AppUpdateTab />
              )}

              {activeTab === 'web' && (
                <WebTab
                  config={localConfig}
                  onConfigChange={setLocalConfig}
                  loading={loading}
                  statusRefreshKey={webStatusRefreshKey}
                />
              )}
            </div>

            {/* 底部保存按钮 - 支持分组保存 */}
            <div className="px-3 sm:px-6 py-3 sm:py-4 border-t border-border-subtle bg-background-elevated">
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-tertiary">
                  {t('currentGroup', '当前分组：{{name}}', { name: t(TAB_TITLE_KEYS[activeTab]) })}
                </span>
                <Button
                  variant="secondary"
                  onClick={handleSaveCurrentTab}
                  disabled={saving || loading}
                >
                  {saving ? tCommon('status.saving') : t('saveTab', '保存{{name}}', { name: t(TAB_TITLE_KEYS[activeTab]) })}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
