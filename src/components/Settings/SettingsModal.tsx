import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfigStore } from '../../stores';
import { Button, ClaudePathSelector } from '../Common';
// import { LanguageSwitcher } from '../Common';
import type { Config, EngineId, FloatingWindowMode, Language } from '../../types';

interface SettingsModalProps {
  onClose: () => void;
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null)

  // 固定的传统引擎选项
  const FIXED_ENGINE_OPTIONS: { id: EngineId; name: string; description: string }[] = [
    {
      id: 'claude-code',
      name: 'Claude Code',
      description: t('engines.claudeCode.description'),
    },
    {
      id: 'iflow',
      name: 'IFlow',
      description: t('engines.iflow.description'),
    },
    {
      id: 'codex',
      name: 'Codex',
      description: t('engines.codex.description', 'OpenAI Codex CLI'),
    },
  ];

  const FLOATING_MODE_OPTIONS: { id: FloatingWindowMode; name: string; description: string }[] = [
    {
      id: 'auto',
      name: t('floatingWindow.modes.auto'),
      description: t('floatingWindow.modes.autoDesc'),
    },
    {
      id: 'manual',
      name: t('floatingWindow.modes.manual'),
      description: t('floatingWindow.modes.manualDesc'),
    },
  ];

  const { config, loading, error, updateConfig } = useConfigStore();
  const [localConfig, setLocalConfig] = useState<Config | null>(config);

  useEffect(() => {
    if (config) {
      setLocalConfig(config);
    }
  }, [config]);

  const handleSave = async () => {
    if (!localConfig) return;

    try {
      await updateConfig(localConfig);
      onClose();
    } catch (error) {
      console.error('Failed to save config:', error);
    }
  };

  const handleEngineChange = (engineId: EngineId) => {
    if (!localConfig) return;
    setLocalConfig({ ...localConfig, defaultEngine: engineId });
  };

  const handleLanguageChange = (language: Language) => {
    if (!localConfig) return;
    setLocalConfig({ ...localConfig, language });
  };

  const handleClaudeCmdChange = (cmd: string) => {
    if (!localConfig) return;
    setLocalConfig({
      ...localConfig,
      claudeCode: { ...localConfig.claudeCode, cliPath: cmd }
    });
  };

  const handleIFlowCmdChange = (cmd: string) => {
    if (!localConfig) return;
    setLocalConfig({
      ...localConfig,
      iflow: { ...localConfig.iflow, cliPath: cmd }
    });
  };

  const handleCodexCmdChange = (cmd: string) => {
    if (!localConfig) return;
    setLocalConfig({
      ...localConfig,
      codex: { ...localConfig.codex, cliPath: cmd }
    });
  };

  const handleFloatingWindowEnabledChange = (enabled: boolean) => {
    if (!localConfig) return;
    setLocalConfig({
      ...localConfig,
      floatingWindow: { ...localConfig.floatingWindow, enabled }
    });
  };

  const handleFloatingWindowModeChange = (mode: FloatingWindowMode) => {
    if (!localConfig) return;
    setLocalConfig({
      ...localConfig,
      floatingWindow: { ...localConfig.floatingWindow, mode }
    });
  };

  const handleFloatingWindowExpandOnHoverChange = (expandOnHover: boolean) => {
    if (!localConfig) return;
    setLocalConfig({
      ...localConfig,
      floatingWindow: { ...localConfig.floatingWindow, expandOnHover }
    });
  };

  const handleFloatingWindowCollapseDelayChange = (collapseDelay: number) => {
    if (!localConfig) return;
    setLocalConfig({
      ...localConfig,
      floatingWindow: { ...localConfig.floatingWindow, collapseDelay }
    });
  };

  const handleAddProvider = () => {
    if (!localConfig) return;
    const newProvider: import('../../types/config').OpenAIProvider = {
      id: `provider-${Date.now()}`,
      name: 'New Provider',
      api_key: '',
      api_base: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      temperature: 0.7,
      max_tokens: 8192,
      enabled: true,
    };
    setLocalConfig({
      ...localConfig,
      openaiProviders: [...localConfig.openaiProviders, newProvider],
    });
    // 自动展开新 Provider 的编辑
    setEditingProviderId(newProvider.id);
  };

  const handleUpdateProvider = (providerId: string, updates: Partial<import('../../types/config').OpenAIProvider>) => {
    if (!localConfig) return;
    const updatedProviders = localConfig.openaiProviders.map(p =>
      p.id === providerId ? { ...p, ...updates } : p
    );
    setLocalConfig({
      ...localConfig,
      openaiProviders: updatedProviders,
    });
  };

  const handleRemoveProvider = (providerId: string) => {
    if (!localConfig) return;
    const updatedProviders = localConfig.openaiProviders.filter(p => p.id !== providerId);

    // 如果删除的是当前选中的 Provider，清空选中状态
    if (localConfig.activeProviderId === providerId) {
      setLocalConfig({
        ...localConfig,
        openaiProviders: updatedProviders,
        activeProviderId: undefined,
      });
    } else {
      setLocalConfig({
        ...localConfig,
        openaiProviders: updatedProviders,
      });
    }

    // 如果删除的是当前引擎，切换到默认引擎
    if (localConfig.defaultEngine === `provider-${providerId}`) {
      handleEngineChange('claude-code');
    }
  };

  const handleBaiduTranslateAppIdChange = (appId: string) => {
    if (!localConfig) return;
    setLocalConfig({
      ...localConfig,
      baiduTranslate: { ...localConfig.baiduTranslate, appId, secretKey: localConfig.baiduTranslate?.secretKey || '' }
    });
  };

  const handleBaiduTranslateSecretKeyChange = (secretKey: string) => {
    if (!localConfig) return;
    setLocalConfig({
      ...localConfig,
      baiduTranslate: { ...localConfig.baiduTranslate, appId: localConfig.baiduTranslate?.appId || '', secretKey }
    });
  };

  // 钉钉配置处理函数
  const handleDingTalkEnabledChange = (enabled: boolean) => {
    if (!localConfig) return;
    setLocalConfig({
      ...localConfig,
      dingtalk: { ...localConfig.dingtalk, enabled }
    });
  };

  const handleDingTalkAppKeyChange = (appKey: string) => {
    if (!localConfig) return;
    setLocalConfig({
      ...localConfig,
      dingtalk: { ...localConfig.dingtalk, appKey }
    });
  };

  const handleDingTalkAppSecretChange = (appSecret: string) => {
    if (!localConfig) return;
    setLocalConfig({
      ...localConfig,
      dingtalk: { ...localConfig.dingtalk, appSecret }
    });
  };

  const handleDingTalkTestConversationIdChange = (testConversationId: string) => {
    if (!localConfig) return;
    setLocalConfig({
      ...localConfig,
      dingtalk: { ...localConfig.dingtalk, testConversationId }
    });
  };

  const handleDingTalkWebhookPortChange = (webhookPort: number) => {
    if (!localConfig) return;
    setLocalConfig({
      ...localConfig,
      dingtalk: { ...localConfig.dingtalk, webhookPort }
    });
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background-elevated rounded-xl p-6 max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto shadow-soft">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-text-primary">{t('title')}</h2>
          <button
            onClick={onClose}
            className="text-text-tertiary hover:text-text-primary transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-danger-faint border border-danger/30 rounded-lg text-danger text-sm">
            {error}
          </div>
        )}

        <div className="mb-6">
          <label className="block text-sm font-medium text-text-secondary mb-3">
            {t('aiEngine')}
          </label>
          <div className="space-y-2">
            {/* 固定的传统引擎 */}
            {FIXED_ENGINE_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => handleEngineChange(option.id)}
                className={`w-full text-left p-4 rounded-lg border-2 transition-all ${
                  localConfig.defaultEngine === option.id
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-surface hover:border-primary/30'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-text-primary">{option.name}</div>
                    <div className="text-sm text-text-secondary mt-1">{option.description}</div>
                  </div>
                  <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                    localConfig.defaultEngine === option.id
                      ? 'border-primary bg-primary'
                      : 'border-border'
                  }`}>
                    {localConfig.defaultEngine === option.id && (
                      <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    )}
                  </div>
                </div>
              </button>
            ))}

            {/* 动态的 OpenAI Providers */}
            {localConfig.openaiProviders?.map((provider) => (
              <div
                key={provider.id}
                className={`border-2 rounded-lg transition-all ${
                  localConfig.defaultEngine === `provider-${provider.id}`
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-surface'
                }`}
              >
                {/* 引擎选择行 */}
                <div className="flex items-center justify-between p-4">
                  <button
                    type="button"
                    onClick={() => handleEngineChange(`provider-${provider.id}` as any)}
                    className="flex-1 text-left flex items-center gap-3"
                  >
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                      localConfig.defaultEngine === `provider-${provider.id}`
                        ? 'border-primary bg-primary'
                        : 'border-border'
                    }`}>
                      {localConfig.defaultEngine === `provider-${provider.id}` && (
                        <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      )}
                    </div>
                    <div>
                      <div className="font-medium text-text-primary flex items-center gap-2">
                        {provider.name}
                        {!provider.enabled && (
                          <span className="px-2 py-0.5 text-xs bg-disabled text-text-muted rounded">已禁用</span>
                        )}
                      </div>
                      <div className="text-sm text-text-secondary">
                        {provider.model} • {provider.api_base}
                      </div>
                    </div>
                  </button>

                  {/* 操作按钮 */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setEditingProviderId(provider.id)}
                      className="p-2 text-text-tertiary hover:text-primary transition-colors"
                      title="配置"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.996h1.945c.132-1.856 1.724-2.937 2.924-2.937.912 0 1.532.789 2.323 1.506 1.506l.44.44c.578.578.627 1.332.836 2.062.402.73.568 1.438 1.485 1.438 2.344 0 .492-.05.842-.136 1.047-.426.205-.284.402-.688.402-1.187 0-.857.345-1.638.863-2.218.518-.58.578-.974-1.146-1.102-1.738-.207-.832.712-1.728 1.228-2.738 1.228-.646 0-1.31-.09-1.876-.253-.566-.164-1.033-.493-1.393-.329-.329-.584-.57-.778-.868-.194-.298-.445-.55-.757-.841-.313-.293-.548-.552-.746-.848-.198-.296-.372-.555-.521-.772-.149-.217-.288-.437-.415-.67-.127-.232-.237-.492-.327-.776-.09-.285-.153-.605-.153-.927 0-.363.09-.694.27-.99.45-.296.63-.715 1.228-.715 2.206 0 .317.032.636.094.942.063.313.127.628.206.937.08.31.09.652.206.937.08.31.09.652.127.937.206.31.09.628.206.937.08.31.09.652.127.937.206z" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleRemoveProvider(provider.id)}
                      className="p-2 text-text-tertiary hover:text-error transition-colors"
                      title="删除"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 011-1h2a1 1 0 011 1v3a1 1 0 001 1h1a1 1 0 001-1V7a1 1 0 011-1h2a1 1 0 011 1v3a1 1 0 001 1h1a1 1 0 011-1V7a1 1 0 011-1h2a1 1 0 011 1v3a1 1 0 001 1h1a1 1 0 011-1V7a1 1 0 011-1h2a1 1 0 011 1v3a1 1 0 001 1h1a1 1 0 011-1V7a1 1 0 011-1h2a1 1 0 011 1v3a1 1 0 001 1h1a1 1 0 011-1V7a1 1 0 011-1h2a1 1 0 011 1v3a1 1 0 001 1h1a1 1 0 011-1V7a1 1 0 011-1h2a1 1 0 011 1v3a1 1 0 001 1h1a1 1 0 011-1V7a1 1 0 011-1h2a1 1 0 011 1v3a1 1 0 001 1h1a1 1 0 011-1V7a1 1 0 011-1h2a1 1 0 011 1v3a1 1 0 001 1h1a1 1 0 011-1V7a1 1 0 011-1h2a1 1 0 011 1v3a1 1 0 001 1h1a1 1 0 011-1V7a1 1 0 011-1h2a1 1 0 011 1v3a1 1 0 001 1h1a1 1 0 011-1V7a1 1 0 011-1h2a1 1 0 011 1v3a1 1 0 001 1h1a1 1 0 011-1V7z" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* 展开的配置表单 */}
                {editingProviderId === provider.id && (
                  <div className="px-4 pb-4 border-t border-border-subtle">
                    <div className="pt-4 space-y-3">
                      <div>
                        <label className="block text-xs text-text-secondary mb-1">Provider 名称</label>
                        <input
                          type="text"
                          value={provider.name}
                          onChange={(e) => handleUpdateProvider(provider.id, { name: e.target.value })}
                          className="w-full px-3 py-2 rounded border border-border bg-background"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-text-secondary mb-1">API Key</label>
                        <input
                          type="password"
                          value={provider.api_key}
                          onChange={(e) => handleUpdateProvider(provider.id, { api_key: e.target.value })}
                          className="w-full px-3 py-2 rounded border border-border bg-background"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-text-secondary mb-1">API Base URL</label>
                        <input
                          type="text"
                          value={provider.api_base}
                          onChange={(e) => handleUpdateProvider(provider.id, { api_base: e.target.value })}
                          className="w-full px-3 py-2 rounded border border-border bg-background"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-text-secondary mb-1">模型名称</label>
                        <input
                          type="text"
                          value={provider.model}
                          onChange={(e) => handleUpdateProvider(provider.id, { model: e.target.value })}
                          className="w-full px-3 py-2 rounded border border-border bg-background"
                        />
                      </div>
                      <div className="flex items-center gap-3">
                        <label className="flex items-center gap-2 text-xs text-text-secondary">
                          <input
                            type="checkbox"
                            checked={provider.enabled}
                            onChange={(e) => handleUpdateProvider(provider.id, { enabled: e.target.checked })}
                            className="w-4 h-4"
                          />
                          启用此 Provider
                        </label>
                        <button
                          onClick={() => setEditingProviderId(null)}
                          className="ml-auto px-3 py-1.5 text-xs border border-border rounded hover:bg-background-hover"
                        >
                          收起
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* 添加新 Provider 按钮 */}
            <button
              onClick={handleAddProvider}
              className="w-full text-left p-4 rounded-lg border-2 border-dashed border-border-subtle text-text-tertiary hover:border-primary/50 hover:text-primary transition-all flex items-center justify-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              <span className="text-sm">添加 OpenAI Provider</span>
            </button>
          </div>
        </div>

        {localConfig.defaultEngine === 'claude-code' && (
          <div className="mb-6 p-4 bg-surface rounded-lg border border-border">
            <h3 className="text-sm font-medium text-text-primary mb-3">{t('claudeCode.title')}</h3>
            <div>
              <label className="block text-xs text-text-secondary mb-2">
                {t('claudeCode.cliPath')}
              </label>
              <ClaudePathSelector
                value={localConfig.claudeCode.cliPath}
                onChange={handleClaudeCmdChange}
                engineType="claude-code"
                disabled={loading}
              />
            </div>
          </div>
        )}

        {localConfig.defaultEngine === 'iflow' && (
          <div className="mb-6 p-4 bg-surface rounded-lg border border-border">
            <h3 className="text-sm font-medium text-text-primary mb-3">{t('iflow.title')}</h3>
            <div>
              <label className="block text-xs text-text-secondary mb-2">
                {t('iflow.cliPath')}
              </label>
              <ClaudePathSelector
                value={localConfig.iflow.cliPath || 'iflow'}
                onChange={handleIFlowCmdChange}
                engineType="iflow"
                disabled={loading}
                placeholder="iflow"
              />
            </div>
          </div>
        )}

        {localConfig.defaultEngine === 'codex' && (
          <div className="mb-6 p-4 bg-surface rounded-lg border border-border">
            <h3 className="text-sm font-medium text-text-primary mb-3">{t('codex.title', 'Codex CLI')}</h3>
            <div>
              <label className="block text-xs text-text-secondary mb-2">
                {t('codex.cliPath', 'CLI 路径')}
              </label>
              <ClaudePathSelector
                value={localConfig.codex?.cliPath || 'codex'}
                onChange={handleCodexCmdChange}
                engineType="codex"
                disabled={loading}
                placeholder="codex"
              />
            </div>
            <p className="mt-2 text-xs text-text-tertiary">
              {t('codex.hint', 'OpenAI Codex CLI 路径，留空使用系统 PATH 中的 codex 命令')}
            </p>
          </div>
        )}

        <div className="mb-6 p-4 bg-surface rounded-lg border border-border">
          <h3 className="text-sm font-medium text-text-primary mb-3">{t('language.title')}</h3>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-text-primary">{t('language.current')}</div>
              <div className="text-xs text-text-secondary">{t('language.hint')}</div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleLanguageChange('zh-CN')}
                className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                  (localConfig.language || 'zh-CN') === 'zh-CN'
                    ? 'bg-primary text-white'
                    : 'bg-background-surface border border-border text-text-secondary hover:text-text-primary'
                }`}
              >
                中文
              </button>
              <button
                type="button"
                onClick={() => handleLanguageChange('en-US')}
                className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                  localConfig.language === 'en-US'
                    ? 'bg-primary text-white'
                    : 'bg-background-surface border border-border text-text-secondary hover:text-text-primary'
                }`}
              >
                English
              </button>
            </div>
          </div>
        </div>

        {/* 钉钉集成配置 */}
        <div className="mb-6 p-4 bg-surface rounded-lg border border-border">
          <h3 className="text-sm font-medium text-text-primary mb-3">钉钉集成</h3>

          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-sm text-text-primary">启用钉钉集成</div>
              <div className="text-xs text-text-secondary">接收和发送钉钉消息</div>
            </div>
            <button
              type="button"
              onClick={() => handleDingTalkEnabledChange(!localConfig.dingtalk?.enabled)}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                localConfig.dingtalk?.enabled ? 'bg-primary' : 'bg-border'
              }`}
            >
              <span
                className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${
                  localConfig.dingtalk?.enabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {localConfig.dingtalk?.enabled && (
            <>
              <div className="mb-4">
                <label className="block text-xs text-text-secondary mb-2">
                  App Key
                </label>
                <input
                  type="text"
                  value={localConfig.dingtalk?.appKey || ''}
                  onChange={(e) => handleDingTalkAppKeyChange(e.target.value)}
                  placeholder="钉钉应用的 AppKey"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                  disabled={loading}
                />
              </div>

              <div className="mb-4">
                <label className="block text-xs text-text-secondary mb-2">
                  App Secret
                </label>
                <input
                  type="password"
                  value={localConfig.dingtalk?.appSecret || ''}
                  onChange={(e) => handleDingTalkAppSecretChange(e.target.value)}
                  placeholder="钉钉应用的 AppSecret"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                  disabled={loading}
                />
              </div>

              <div className="mb-4">
                <label className="block text-xs text-text-secondary mb-2">
                  测试群会话 ID
                </label>
                <input
                  type="text"
                  value={localConfig.dingtalk?.testConversationId || ''}
                  onChange={(e) => handleDingTalkTestConversationIdChange(e.target.value)}
                  placeholder="用于测试连接的会话 ID"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                  disabled={loading}
                />
              </div>

              <div className="mb-4">
                <label className="block text-xs text-text-secondary mb-2">
                  Webhook 端口
                </label>
                <input
                  type="number"
                  value={localConfig.dingtalk?.webhookPort || 3456}
                  onChange={(e) => handleDingTalkWebhookPortChange(parseInt(e.target.value) || 3456)}
                  placeholder="3456"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                  disabled={loading}
                />
              </div>

              <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg">
                <div className="flex items-start gap-2">
                  <svg className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                  </svg>
                  <div className="flex-1">
                    <p className="text-xs text-text-primary">
                      <span className="font-medium">配置说明：</span>
                    </p>
                    <ul className="text-xs text-text-tertiary mt-1 space-y-1 list-disc list-inside">
                      <li>在钉钉开放平台创建企业内部应用</li>
                      <li>获取 App Key 和 App Secret</li>
                      <li>配置机器人权限和消息接收地址</li>
                      <li>会话 ID 可以在群设置或单聊中查看</li>
                    </ul>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="mb-6 p-4 bg-surface rounded-lg border border-border">
          <h3 className="text-sm font-medium text-text-primary mb-3">{t('floatingWindow.title')}</h3>

          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-sm text-text-primary">{t('floatingWindow.enabled')}</div>
              <div className="text-xs text-text-secondary">{t('floatingWindow.enabledHint')}</div>
            </div>
            <button
              type="button"
              onClick={() => handleFloatingWindowEnabledChange(!localConfig.floatingWindow.enabled)}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                localConfig.floatingWindow.enabled ? 'bg-primary' : 'bg-border'
              }`}
            >
              <span
                className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${
                  localConfig.floatingWindow.enabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {localConfig.floatingWindow.enabled && (
            <>
              <div className="mb-4">
                <div className="text-xs text-text-secondary mb-2">{t('floatingWindow.mode')}</div>
                <div className="space-y-2">
                  {FLOATING_MODE_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => handleFloatingWindowModeChange(option.id)}
                      className={`w-full text-left p-3 rounded-lg border transition-all ${
                        localConfig.floatingWindow.mode === option.id
                          ? 'border-primary bg-primary/5'
                          : 'border-border-subtle hover:border-primary/30'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex-1">
                          <div className="text-sm text-text-primary">{option.name}</div>
                          <div className="text-xs text-text-secondary mt-0.5">{option.description}</div>
                        </div>
                        <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ml-2 ${
                          localConfig.floatingWindow.mode === option.id
                            ? 'border-primary'
                            : 'border-border'
                        }`}>
                          {localConfig.floatingWindow.mode === option.id && (
                            <div className="w-2 h-2 rounded-full bg-primary" />
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-sm text-text-primary">{t('floatingWindow.expandOnHover')}</div>
                  <div className="text-xs text-text-secondary">{t('floatingWindow.expandOnHoverHint')}</div>
                </div>
                <button
                  type="button"
                  onClick={() => handleFloatingWindowExpandOnHoverChange(!localConfig.floatingWindow.expandOnHover)}
                  className={`relative w-11 h-6 rounded-full transition-colors ${
                    localConfig.floatingWindow.expandOnHover ? 'bg-primary' : 'bg-border'
                  }`}
                >
                  <span
                    className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${
                      localConfig.floatingWindow.expandOnHover ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {localConfig.floatingWindow.mode === 'auto' && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <div className="text-sm text-text-primary">{t('floatingWindow.collapseDelay')}</div>
                      <div className="text-xs text-text-secondary">{t('floatingWindow.collapseDelayHint')}</div>
                    </div>
                    <div className="text-sm font-medium text-primary">
                      {localConfig.floatingWindow.collapseDelay} ms
                    </div>
                  </div>
                  <input
                    type="range"
                    min="100"
                    max="3000"
                    step="100"
                    value={localConfig.floatingWindow.collapseDelay}
                    onChange={(e) => handleFloatingWindowCollapseDelayChange(Number(e.target.value))}
                    className="w-full h-2 bg-border-subtle rounded-lg appearance-none cursor-pointer accent-primary"
                  />
                  <div className="flex justify-between text-xs text-text-tertiary mt-1">
                    <span>100ms</span>
                    <span>3000ms</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="mb-6 p-4 bg-surface rounded-lg border border-border">
          <h3 className="text-sm font-medium text-text-primary mb-3">{t('baiduTranslate.title')}</h3>
          <p className="text-xs text-text-secondary mb-4">
            {t('baiduTranslate.hint')}
          </p>

          <div className="mb-4">
            <label className="block text-xs text-text-secondary mb-2">
              {t('baiduTranslate.appId')}
            </label>
            <input
              type="text"
              value={localConfig.baiduTranslate?.appId || ''}
              onChange={(e) => handleBaiduTranslateAppIdChange(e.target.value)}
              placeholder={t('baiduTranslate.appIdPlaceholder')}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
              disabled={loading}
            />
          </div>

          <div className="mb-4">
            <label className="block text-xs text-text-secondary mb-2">
              {t('baiduTranslate.secretKey')}
            </label>
            <input
              type="password"
              value={localConfig.baiduTranslate?.secretKey || ''}
              onChange={(e) => handleBaiduTranslateSecretKeyChange(e.target.value)}
              placeholder={t('baiduTranslate.secretKeyPlaceholder')}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
              disabled={loading}
            />
          </div>

          <p className="text-xs text-text-tertiary">
            {t('baiduTranslate.applyHint')} <a href="https://fanyi-api.baidu.com/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t('baiduTranslate.platform')}</a>
          </p>
        </div>

        <div className="flex justify-end gap-3">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={loading}
          >
            {tCommon('buttons.cancel')}
          </Button>
          <Button
            onClick={handleSave}
            disabled={loading}
            className="min-w-[80px]"
          >
            {loading ? tCommon('status.saving') : tCommon('buttons.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
