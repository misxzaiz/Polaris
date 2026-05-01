/**
 * AI 引擎配置 Tab
 *
 * 包含：认证状态、引擎选择、CLI 路径、模型 Profile 管理、可用 Agent 列表
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ClaudePathSelector } from '../../Common';
import { useConfigStore } from '../../../stores';
import { useCliInfoStore } from '../../../stores/cliInfoStore';
import { useModelProfileStore } from '../../../stores/modelProfileStore';
import type { Config, EngineId, ModelProfile } from '../../../types';
import { Shield, ShieldCheck, ShieldX, RefreshCw, Bot, Plus, Trash2, Globe, Check } from 'lucide-react';

interface AIEngineTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

// 固定的传统引擎选项
const FIXED_ENGINE_OPTIONS: { id: EngineId; nameKey: string; descKey: string }[] = [
  { id: 'claude-code', nameKey: 'engines.claudeCode.name', descKey: 'engines.claudeCode.description' },
  { id: 'codex', nameKey: 'engines.codex.name', descKey: 'engines.codex.description' },
];

export function AIEngineTab({ config, onConfigChange, loading }: AIEngineTabProps) {
  const { t } = useTranslation('settings');
  const { healthStatus } = useConfigStore();
  const { authStatus, agents, loading: cliLoading, fetchAll } = useCliInfoStore();
  const { profiles, activeProfileId, addProfile, removeProfile, activateProfile, setProfiles, setActiveProfileId } = useModelProfileStore();
  const [showAddForm, setShowAddForm] = useState(false);
  const [newProfile, setNewProfile] = useState({ name: '', baseUrl: '', apiKey: '', model: '', description: '' });
  const isCodex = config.defaultEngine === 'codex';

  // 初始化同步：确保 modelProfileStore 和 localConfig 双向一致
  useEffect(() => {
    const configProfiles = config.modelProfiles || []
    if (profiles.length > 0 && configProfiles.length === 0) {
      // localStorage 有数据但后端没有 → 同步到 localConfig
      syncProfilesToConfig(profiles, activeProfileId)
    } else if (configProfiles.length > 0 && profiles.length === 0) {
      // 后端有数据但 localStorage 没有 → 同步到 modelProfileStore
      setProfiles(configProfiles)
      if (config.activeModelProfileId) {
        setActiveProfileId(config.activeModelProfileId)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  const handleAddProfile = () => {
    if (!newProfile.name || !newProfile.baseUrl || !newProfile.apiKey || !newProfile.model) return;
    addProfile(newProfile);
    setNewProfile({ name: '', baseUrl: '', apiKey: '', model: '', description: '' });
    setShowAddForm(false);
    // 同步到 localConfig，确保保存时写入后端配置文件
    const updated = useModelProfileStore.getState()
    syncProfilesToConfig(updated.profiles, updated.activeProfileId)
  };

  const handleDeleteProfile = (id: string) => {
    removeProfile(id);
    // 同步到 localConfig
    const updated = useModelProfileStore.getState()
    syncProfilesToConfig(updated.profiles, updated.activeProfileId)
  };

  // 保存 profiles 到 config（通过 onConfigChange 同步）
  const syncProfilesToConfig = (updatedProfiles: ModelProfile[], updatedActiveId: string | null) => {
    onConfigChange({
      ...config,
      modelProfiles: updatedProfiles,
      activeModelProfileId: updatedActiveId ?? undefined,
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

      {/* 模型 Profile 管理 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-text-primary">
            {t('modelProfile.title', '模型 Profile')}
          </h3>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="flex items-center gap-1 text-xs text-primary hover:text-primary-hover transition-colors"
          >
            <Plus size={14} />
            {t('modelProfile.add', '添加')}
          </button>
        </div>

        {/* 添加 Profile 表单 */}
        {showAddForm && (
          <div className="mb-4 p-3 bg-background-default rounded-lg border border-border space-y-3">
            <input
              type="text"
              placeholder={t('modelProfile.profileName', 'Profile 名称')}
              value={newProfile.name}
              onChange={(e) => setNewProfile({ ...newProfile, name: e.target.value })}
              className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg outline-none focus:border-primary"
            />
            <input
              type="text"
              placeholder={
                isCodex
                  ? t('modelProfile.codexBaseUrl', 'API 端点 URL (如 https://api.openai.com/v1)')
                  : t('modelProfile.baseUrl', 'API 端点 URL (如 https://api.deepseek.com/anthropic)')
              }
              value={newProfile.baseUrl}
              onChange={(e) => setNewProfile({ ...newProfile, baseUrl: e.target.value })}
              className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg outline-none focus:border-primary"
            />
            <input
              type="password"
              placeholder={t('modelProfile.apiKey', 'API Key')}
              value={newProfile.apiKey}
              onChange={(e) => setNewProfile({ ...newProfile, apiKey: e.target.value })}
              className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg outline-none focus:border-primary"
            />
            <input
              type="text"
              placeholder={
                isCodex
                  ? t('modelProfile.codexModelName', '模型名称 (如 gpt-5.1)')
                  : t('modelProfile.modelName', '模型名称 (如 deepseek-chat)')
              }
              value={newProfile.model}
              onChange={(e) => setNewProfile({ ...newProfile, model: e.target.value })}
              className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg outline-none focus:border-primary"
            />
            <input
              type="text"
              placeholder={t('modelProfile.description', '描述 (可选)')}
              value={newProfile.description}
              onChange={(e) => setNewProfile({ ...newProfile, description: e.target.value })}
              className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg outline-none focus:border-primary"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowAddForm(false); setNewProfile({ name: '', baseUrl: '', apiKey: '', model: '', description: '' }); }}
                className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                onClick={handleAddProfile}
                disabled={!newProfile.name || !newProfile.baseUrl || !newProfile.apiKey || !newProfile.model}
                className="px-3 py-1.5 text-xs bg-primary text-white rounded hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('common.add', '添加')}
              </button>
            </div>
          </div>
        )}

        {/* Profile 列表 */}
        {profiles.length === 0 ? (
          <div className="text-center py-4 text-xs text-text-tertiary">
            {t('modelProfile.noProfiles', '暂无模型 Profile，点击添加配置第三方模型端点')}
          </div>
        ) : (
          <div className="space-y-2">
            {profiles.map((profile) => (
              <div
                key={profile.id}
                className={`flex items-center gap-3 p-3 rounded-lg border transition-all cursor-pointer ${
                  activeProfileId === profile.id
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-background-default hover:border-primary/30'
                }`}
                onClick={() => {
                  const newActiveId = activeProfileId === profile.id ? null : profile.id
                  activateProfile(newActiveId)
                  // 同步到 localConfig
                  syncProfilesToConfig(useModelProfileStore.getState().profiles, newActiveId)
                }}
              >
                <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                  activeProfileId === profile.id ? 'border-primary bg-primary' : 'border-border'
                }`}>
                  {activeProfileId === profile.id && <Check size={10} className="text-white" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Globe size={12} className="text-text-tertiary shrink-0" />
                    <span className="text-sm font-medium text-text-primary truncate">{profile.name}</span>
                  </div>
                  <div className="text-xs text-text-tertiary truncate mt-0.5">
                    {profile.model} · {profile.baseUrl}
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDeleteProfile(profile.id); }}
                  className="text-text-tertiary hover:text-red-500 transition-colors shrink-0"
                  title={t('common.delete', '删除')}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
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

      {/* Codex 配置 */}
      {config.defaultEngine === 'codex' && (
        <div className="p-4 bg-surface rounded-lg border border-border">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-text-primary">{t('codex.title', 'OpenAI Codex 配置')}</h3>
            {healthStatus?.codexVersion && (
              <span className="text-xs px-2 py-1 rounded-full bg-green-500/10 text-green-500 border border-green-500/20">
                {healthStatus.codexVersion}
              </span>
            )}
            {healthStatus && !healthStatus.codexAvailable && (
              <span className="text-xs px-2 py-1 rounded-full bg-red-500/10 text-red-500 border border-red-500/20">
                {t('codex.notAvailable', '未安装')}
              </span>
            )}
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-2">
              {t('codex.cliPath', 'Codex CLI 命令路径')}
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
