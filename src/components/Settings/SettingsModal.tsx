/**
 * 设置模态框 - 重构版
 * 支持：
 * - 左侧导航分组
 * - 右侧内容区域
 * - 分组保存按钮
 * - Toast 提示
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfigStore, useToastStore } from '../../stores';
import { Button } from '../Common';
import { SettingsSidebar, type SettingsTabId } from './SettingsSidebar';
import { AIEngineTab } from './tabs/AIEngineTab';
import { OpenAIProvidersTab } from './OpenAIProvidersTab';
import { TranslateTab } from './tabs/TranslateTab';
import { QQBotTab } from './tabs/QQBotTab';
import { FloatingWindowTab } from './tabs/FloatingWindowTab';
import { AdvancedTab } from './tabs/AdvancedTab';
import type { Config } from '../../types';

interface SettingsModalProps {
  onClose: () => void;
}

// Tab 标题映射
const TAB_TITLES: Record<SettingsTabId, string> = {
  'ai-engine': 'AI 引擎',
  'openai-providers': 'OpenAI Providers',
  'translate': '翻译',
  'qqbot': 'QQ Bot',
  'floating-window': '悬浮窗',
  'advanced': '高级',
};

export function SettingsModal({ onClose }: SettingsModalProps) {
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');

  const { config, loading, error, updateConfig } = useConfigStore();
  const { success, error: toastError } = useToastStore();

  const [localConfig, setLocalConfig] = useState<Config | null>(config);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTabId>('ai-engine');
  const [searchQuery, setSearchQuery] = useState('');

  // 同步远程配置到本地
  useEffect(() => {
    if (config) {
      setLocalConfig(config);
    }
  }, [config]);

  // 保存当前分组配置
  const handleSaveCurrentTab = async () => {
    if (!localConfig) return;

    try {
      setSaving(true);
      await updateConfig(localConfig);
      success(t('messages.saved'), t('messages.configSavedDesc'));
    } catch (err) {
      console.error('Failed to save config:', err);
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
      await updateConfig(localConfig);
      success(t('messages.saved'), t('messages.configSavedDesc'));
      onClose();
    } catch (err) {
      console.error('Failed to save config:', err);
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-background-elevated rounded-xl w-full max-w-4xl h-[85vh] flex flex-col shadow-soft overflow-hidden">
        {/* 顶部标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
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
        <div className="flex flex-1 overflow-hidden">
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
            <div className="flex-1 overflow-y-auto p-6">
              <h3 className="text-base font-medium text-text-primary mb-4">
                {TAB_TITLES[activeTab]}
              </h3>

              {activeTab === 'ai-engine' && (
                <AIEngineTab
                  config={localConfig}
                  onConfigChange={setLocalConfig}
                  loading={loading}
                />
              )}

              {activeTab === 'openai-providers' && (
                <OpenAIProvidersTab
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
                  config={localConfig}
                  onConfigChange={setLocalConfig}
                  loading={loading}
                />
              )}

              {activeTab === 'floating-window' && (
                <FloatingWindowTab
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
            </div>

            {/* 底部保存按钮 - 支持分组保存 */}
            <div className="px-6 py-4 border-t border-border-subtle bg-background-elevated">
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-tertiary">
                  当前分组：{TAB_TITLES[activeTab]}
                </span>
                <Button
                  variant="secondary"
                  onClick={handleSaveCurrentTab}
                  disabled={saving || loading}
                >
                  {saving ? tCommon('status.saving') : `保存${TAB_TITLES[activeTab]}`}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
