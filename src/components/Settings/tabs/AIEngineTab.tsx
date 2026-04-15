/**
 * AI 引擎配置 Tab
 *
 * 包含：认证状态、引擎选择、CLI 路径、可用 Agent 列表
 */

import { useTranslation } from 'react-i18next';
import { ClaudePathSelector } from '../../Common';
import { useConfigStore } from '../../../stores';
import { useCliInfoStore } from '../../../stores/cliInfoStore';
import type { Config, EngineId } from '../../../types';
import { Shield, ShieldCheck, ShieldX, RefreshCw, Bot } from 'lucide-react';

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
  const { authStatus, agents, loading: cliLoading, fetchAll } = useCliInfoStore();

  const handleEngineChange = (engineId: EngineId) => {
    onConfigChange({
      ...config,
      defaultEngine: engineId,
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
      {/* 认证状态 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-text-secondary">
            {t('aiEngine.authStatus', '认证状态')}
          </label>
          <button
            onClick={() => fetchAll()}
            disabled={cliLoading}
            className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-50"
            title="刷新"
          >
            <RefreshCw size={12} className={cliLoading ? 'animate-spin' : ''} />
          </button>
        </div>
        {authStatus ? (
          <div className={`flex items-center gap-2 p-3 rounded-lg border ${
            authStatus.loggedIn
              ? 'bg-green-500/5 border-green-500/20'
              : 'bg-red-500/5 border-red-500/20'
          }`}>
            {authStatus.loggedIn ? (
              <ShieldCheck size={16} className="text-green-500 shrink-0" />
            ) : (
              <ShieldX size={16} className="text-red-500 shrink-0" />
            )}
            <div className="min-w-0">
              <div className={`text-sm font-medium ${
                authStatus.loggedIn ? 'text-green-600' : 'text-red-600'
              }`}>
                {authStatus.loggedIn
                  ? t('aiEngine.loggedIn', '已登录')
                  : t('aiEngine.notLoggedIn', '未登录')
                }
              </div>
              {authStatus.loggedIn && (
                <div className="text-xs text-text-tertiary mt-0.5">
                  {authStatus.authMethod === 'oauth_token' ? 'OAuth' : 'API Key'}
                  {' · '}
                  {authStatus.apiProvider === 'firstParty' ? 'Anthropic' : authStatus.apiProvider}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 p-3 rounded-lg border border-border bg-surface">
            <Shield size={16} className="text-text-muted shrink-0" />
            <span className="text-sm text-text-muted">
              {cliLoading
                ? t('aiEngine.checkingAuth', '检查中...')
                : t('aiEngine.authUnknown', '未知')
              }
            </span>
          </div>
        )}
      </div>

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

      {/* 可用 Agent 列表 */}
      {agents.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-text-secondary">
              {t('aiEngine.availableAgents', '可用 Agent')} ({agents.length})
            </label>
          </div>
          <div className="space-y-1">
            {/* 内置 Agent */}
            {agents.filter(a => a.source === 'builtin').length > 0 && (
              <div>
                <div className="text-xs text-text-tertiary px-2 py-1">
                  {t('aiEngine.builtinAgents', '内置')}
                </div>
                {agents.filter(a => a.source === 'builtin').map(agent => (
                  <div key={agent.id} className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-background-hover">
                    <Bot size={14} className="text-blue-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-text-primary truncate">{agent.name}</div>
                      <div className="text-xs text-text-tertiary truncate">{agent.id}</div>
                    </div>
                    {agent.defaultModel && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 shrink-0">
                        {agent.defaultModel}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {/* 插件 Agent */}
            {agents.filter(a => a.source === 'plugin').length > 0 && (
              <div>
                <div className="text-xs text-text-tertiary px-2 py-1 mt-1">
                  {t('aiEngine.pluginAgents', '插件')}
                </div>
                {agents.filter(a => a.source === 'plugin').map(agent => (
                  <div key={agent.id} className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-background-hover">
                    <Bot size={14} className="text-purple-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-text-primary truncate">{agent.name}</div>
                      <div className="text-xs text-text-tertiary truncate">{agent.id}</div>
                    </div>
                    {agent.defaultModel && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 shrink-0">
                        {agent.defaultModel}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
