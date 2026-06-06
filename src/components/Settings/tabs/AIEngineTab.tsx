/**
 * AI 引擎配置 Tab
 *
 * 包含：认证状态、引擎选择、CLI 路径、Agnes 全模态引擎、可用 Agent 列表。
 * 模型供应商 Profile 管理已抽离至独立的 ModelProviderTab（设置 → 模型供应商）。
 */

import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ClaudePathSelector } from '../../Common';
import { useConfigStore } from '@/stores';
import { useCliInfoStore } from '@/stores/cliInfoStore';
import type { Config, EngineId } from '@/types';
import { Shield, ShieldCheck, ShieldX, RefreshCw, Bot, RotateCcw, Key, Zap, Check } from 'lucide-react';
import { registerAgnesEngine } from '@/core/engine-bootstrap';
import { getEngineRegistry } from '@/ai-runtime';
import { createLogger } from '@/utils/logger';

const log = createLogger('AIEngineTab');

interface AIEngineTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

// 固定的传统引擎选项（Agnes 是独立的多模态引擎，不在此列表）
const FIXED_ENGINE_OPTIONS: { id: EngineId; nameKey: string; descKey: string }[] = [
  { id: 'claude-code', nameKey: 'engines.claudeCode.name', descKey: 'engines.claudeCode.description' },
  { id: 'codex', nameKey: 'engines.codex.name', descKey: 'engines.codex.description' },
  { id: 'simple-ai', nameKey: 'engines.simpleAi.name', descKey: 'engines.simpleAi.description' },
];

/**
 * Agnes AI 全模态引擎配置区块
 *
 * 独立于对话引擎（Claude Code / Codex），提供：
 * - API Key 输入与保存
 * - 引擎运行时注册（保存后立即生效，无需重启）
 * - 注册状态实时反馈
 */
function AgnesSection({
  config,
  onConfigChange,
}: {
  config: Config;
  onConfigChange: (config: Config) => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [registering, setRegistering] = useState(false);
  const [registerStatus, setRegisterStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [statusMessage, setStatusMessage] = useState('');

  // 检查引擎是否已注册
  const isRegistered = getEngineRegistry().has('agnes');

  const handleRegister = useCallback(async () => {
    const apiKey = config.agnesApiKey?.trim();
    if (!apiKey) {
      setRegisterStatus('error');
      setStatusMessage(t('engines.agnes.apiKeyRequired', { defaultValue: '请先输入 API Key' }));
      return;
    }

    setRegistering(true);
    setRegisterStatus('idle');
    setStatusMessage('');

    try {
      // 持久化到后端配置文件（写入 config.json，刷新后不丢失）
      await useConfigStore.getState().updateConfigPatch({ agnesApiKey: apiKey });
      // 同步本地 state，保持 UI 即时一致
      onConfigChange({ ...config, agnesApiKey: apiKey });

      // 注册引擎（运行时立即生效，无需重启）
      registerAgnesEngine({ apiKey });
      setRegisterStatus('success');
      setStatusMessage(t('engines.agnes.registered', { defaultValue: '引擎已注册，可立即使用' }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to register Agnes engine: ${msg}`);
      setRegisterStatus('error');
      setStatusMessage(msg);
    } finally {
      setRegistering(false);
    }
  }, [config, onConfigChange, t]);

  return (
    <div className="p-4 bg-surface rounded-lg border border-border">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Zap size={16} className="text-amber-400" />
          <h3 className="text-sm font-medium text-text-primary">
            {t('engines.agnes.name', { defaultValue: 'Agnes AI 全模态' })}
          </h3>
        </div>
        <div className="flex items-center gap-2">
          {isRegistered ? (
            <span className="text-xs px-2 py-1 rounded-full bg-green-500/10 text-green-500 border border-green-500/20 flex items-center gap-1">
              <Check size={10} />
              {t('engines.agnes.registeredBadge', { defaultValue: '已注册' })}
            </span>
          ) : (
            <span className="text-xs px-2 py-1 rounded-full bg-yellow-500/10 text-yellow-500 border border-yellow-500/20">
              {t('engines.agnes.unregisteredBadge', { defaultValue: '未注册' })}
            </span>
          )}
        </div>
      </div>

      <p className="text-xs text-text-secondary mb-4">
        {t('engines.agnes.description', { defaultValue: '对话 / 文生图 / 图生图 / 文生视频 / 图生视频 / 漫画漫剧管线' })}
      </p>

      {/* API Key 输入 */}
      <div className="mb-3">
        <label className="block text-xs text-text-secondary mb-2">
          {t('engines.agnes.apiKeyLabel', { defaultValue: 'Agnes API Key' })}
        </label>
        <input
          type="password"
          placeholder={t('engines.agnes.apiKeyPlaceholder', { defaultValue: '输入你的 Agnes API Key（从 agnes-ai.com 获取）' })}
          value={config.agnesApiKey || ''}
          onChange={(e) => {
            onConfigChange({ ...config, agnesApiKey: e.target.value });
            setRegisterStatus('idle');
            setStatusMessage('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleRegister();
          }}
          className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg outline-none focus:border-primary"
        />
      </div>

      {/* Key 预览 */}
      {config.agnesApiKey && (
        <p className="text-xs text-text-tertiary mb-3 font-mono">
          {config.agnesApiKey.substring(0, 8)}...{config.agnesApiKey.substring(config.agnesApiKey.length - 4)}
        </p>
      )}

      {/* 状态消息 */}
      {statusMessage && (
        <div
          className={`mb-3 px-3 py-2 rounded-md text-xs ${
            registerStatus === 'success'
              ? 'bg-green-500/10 text-green-400 border border-green-500/20'
              : registerStatus === 'error'
                ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                : ''
          }`}
        >
          {statusMessage}
        </div>
      )}

      {/* 注册按钮 */}
      <button
        onClick={handleRegister}
        disabled={registering || !config.agnesApiKey?.trim()}
        className="flex items-center gap-2 px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        <Key size={14} className={registering ? 'animate-pulse' : ''} />
        {registering
          ? t('engines.agnes.registering', { defaultValue: '注册中...' })
          : isRegistered
            ? t('engines.agnes.reRegister', { defaultValue: '重新注册引擎' })
            : t('engines.agnes.register', { defaultValue: '注册引擎' })}
      </button>

      <p className="text-xs text-text-tertiary mt-2">
        {t('engines.agnes.apiKeyHint', { defaultValue: 'API Key 将安全存储于本地配置文件，仅用于 Agnes API 调用。注册后立即生效。' })}
      </p>
    </div>
  );
}

export function AIEngineTab({ config, onConfigChange, loading }: AIEngineTabProps) {
  const { t } = useTranslation(['settings', 'common']);
  const { healthStatus, resetCliConfig } = useConfigStore();
  const { authStatus, agents, loading: cliLoading, fetchAll } = useCliInfoStore();
  const [resetting, setResetting] = useState(false);

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

  const handleCodexCmdChange = (cmd: string) => {
    onConfigChange({
      ...config,
      codexCode: { ...(config.codexCode || { cliPath: 'codex' }), cliPath: cmd }
    });
  };

  const handleResetCliConfig = async () => {
    const confirmed = window.confirm(
      t('aiEngine.resetCliConfirm')
    );
    if (!confirmed) return;
    setResetting(true);
    try {
      await resetCliConfig();
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* 认证状态 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-text-secondary">
            {t('aiEngine.authStatus')}
          </label>
          <button
            onClick={() => fetchAll()}
            disabled={cliLoading}
            className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-50"
            title={t('buttons.refresh', { ns: 'common' })}
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
                  ? t('aiEngine.loggedIn')
                  : t('aiEngine.notLoggedIn')
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
                ? t('aiEngine.checkingAuth')
                : t('aiEngine.authUnknown')
              }
            </span>
          </div>
        )}
      </div>

      {/* 引擎选择 */}
      <div>
        <label className="block text-sm font-medium text-text-secondary mb-3">
          {t('aiEngine.title')}
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
                {t('claudeCode.notAvailable')}
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

      {/* Codex 配置 */}
      {config.defaultEngine === 'codex' && (
        <div className="p-4 bg-surface rounded-lg border border-border">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-text-primary">{t('codex.title')}</h3>
            {healthStatus?.codexVersion && (
              <span className="text-xs px-2 py-1 rounded-full bg-green-500/10 text-green-500 border border-green-500/20">
                {healthStatus.codexVersion}
              </span>
            )}
            {healthStatus && !healthStatus.codexAvailable && (
              <span className="text-xs px-2 py-1 rounded-full bg-red-500/10 text-red-500 border border-red-500/20">
                {t('codex.notAvailable')}
              </span>
            )}
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-2">
              {t('codex.cliPath')}
            </label>
            <ClaudePathSelector
              value={config.codexCode?.cliPath || 'codex'}
              onChange={handleCodexCmdChange}
              engineType="codex"
              disabled={loading}
            />
          </div>
        </div>
      )}

      {/* Agnes AI 全模态引擎 — 独立区块，不作为对话引擎选项 */}
      <AgnesSection config={config} onConfigChange={onConfigChange} />

      {/* 重置 CLI 配置(测试/调试用) */}
      <div className="p-4 rounded-lg border border-amber-500/30 bg-amber-500/5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-amber-600 dark:text-amber-400">
              {t('aiEngine.resetCliTitle')}
            </h3>
            <p className="text-xs text-text-secondary mt-1">
              {t('aiEngine.resetCliDescription')}
            </p>
          </div>
          <button
            type="button"
            onClick={handleResetCliConfig}
            disabled={resetting || loading}
            className="shrink-0 flex items-center gap-1.5 text-xs px-3 py-2 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RotateCcw size={12} className={resetting ? 'animate-spin' : ''} />
            {resetting
              ? t('aiEngine.resetting')
              : t('aiEngine.resetCliAction')}
          </button>
        </div>
      </div>

      {/* 可用 Agent 列表 */}
      {agents.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-text-secondary">
              {t('aiEngine.availableAgents')} ({agents.length})
            </label>
          </div>
          <div className="space-y-1">
            {/* 内置 Agent */}
            {agents.filter(a => a.source === 'builtin').length > 0 && (
              <div>
                <div className="text-xs text-text-tertiary px-2 py-1">
                  {t('aiEngine.builtinAgents')}
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
                  {t('aiEngine.pluginAgents')}
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
