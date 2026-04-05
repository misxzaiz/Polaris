/**
 * AI 引擎配置 Tab
 */

import { useTranslation } from 'react-i18next';
import { ClaudePathSelector } from '../../Common';
import { useConfigStore } from '../../../stores';
import type { Config, EngineId } from '../../../types';

interface AIEngineTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

// 固定的传统引擎选项
const FIXED_ENGINE_OPTIONS: { id: EngineId; nameKey: string; descKey: string }[] = [
  { id: 'claude-code', nameKey: 'engines.claudeCode.name', descKey: 'engines.claudeCode.description' },
];

export function AIEngineTab({ config, onConfigChange, loading }: AIEngineTabProps) {
  const { t } = useTranslation('settings');
  const { healthStatus } = useConfigStore();

  // 获取启用的 OpenAI Providers
  const enabledProviders = config.openaiProviders?.filter(p => p.enabled) || [];

  const handleEngineChange = (engineId: EngineId) => {
    const isProvider = engineId.startsWith('provider-');
    onConfigChange({
      ...config,
      defaultEngine: engineId,
      activeProviderId: isProvider ? engineId.replace('provider-', '') : config.activeProviderId,
    });
  };

  const handleClaudeCmdChange = (cmd: string) => {
    onConfigChange({
      ...config,
      claudeCode: { ...config.claudeCode, cliPath: cmd }
    });
  };

  return (
    <div className="space-y-6">
      {/* 引擎选择 */}
      <div>
        <label className="block text-sm font-medium text-text-secondary mb-3">
          {t('aiEngine')}
        </label>
        <div className="space-y-2">
          {FIXED_ENGINE_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => handleEngineChange(option.id)}
              className={`w-full text-left p-4 rounded-lg border-2 transition-all ${
                config.defaultEngine === option.id
                  ? 'border-primary bg-primary/5'
                  : 'border-border bg-surface hover:border-primary/30'
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-text-primary">{t(option.nameKey)}</div>
                  <div className="text-sm text-text-secondary mt-1">{t(option.descKey)}</div>
                </div>
                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                  config.defaultEngine === option.id
                    ? 'border-primary bg-primary'
                    : 'border-border'
                }`}>
                  {config.defaultEngine === option.id && (
                    <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  )}
                </div>
              </div>
            </button>
          ))}

          {/* OpenAI Provider 选项 */}
          {enabledProviders.length > 0 ? (
            <div className="mt-4 pt-4 border-t border-border">
              <div className="text-sm font-medium text-text-secondary mb-2">
                OpenAI Provider
              </div>
              {enabledProviders.map((provider) => {
                const providerEngineId = `provider-${provider.id}` as EngineId;
                const isSelected = config.defaultEngine === providerEngineId;
                return (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => handleEngineChange(providerEngineId)}
                    className={`w-full text-left p-4 rounded-lg border-2 transition-all mb-2 ${
                      isSelected
                        ? 'border-primary bg-primary/5'
                        : 'border-border bg-surface hover:border-primary/30'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-text-primary">{provider.name}</span>
                          {provider.supportsTools && (
                            <span className="text-xs px-1.5 py-0.5 bg-green-500/20 text-green-400 rounded">
                              {t('openaiProviders.toolSupport')}
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-text-secondary mt-1">
                          {t('openaiProviders.model')}: <span className="text-blue-400">{provider.model}</span>
                        </div>
                        <div className="text-xs text-text-tertiary mt-0.5 truncate">
                          {provider.apiBase}
                        </div>
                      </div>
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                        isSelected ? 'border-primary bg-primary' : 'border-border'
                      }`}>
                        {isSelected && (
                          <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="mt-4 pt-4 border-t border-border">
              <div className="text-sm font-medium text-text-secondary mb-2">
                OpenAI Provider
              </div>
              <p className="text-sm text-yellow-500 p-3 bg-yellow-500/10 rounded-lg border border-yellow-500/20">
                {t('openaiProviders.notConfigured')}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Claude Code 配置 */}
      {config.defaultEngine === 'claude-code' && (
        <div className="p-4 bg-surface rounded-lg border border-border">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-text-primary">{t('claudeCode.title')}</h3>
            {/* Claude Code 版本状态 */}
            {healthStatus?.claudeVersion && (
              <span className="text-xs px-2 py-1 rounded-full bg-green-500/10 text-green-500 border border-green-500/20">
                v{healthStatus.claudeVersion}
              </span>
            )}
            {healthStatus && !healthStatus.claudeAvailable && (
              <span className="text-xs px-2 py-1 rounded-full bg-red-500/10 text-red-500 border border-red-500/20">
                {t('claudeCode.notAvailable', '未安装')}
              </span>
            )}
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-2">
              {t('claudeCode.cliPath')}
            </label>
            <ClaudePathSelector
              value={config.claudeCode.cliPath}
              onChange={handleClaudeCmdChange}
              engineType="claude-code"
              disabled={loading}
            />
          </div>
        </div>
      )}
    </div>
  );
}