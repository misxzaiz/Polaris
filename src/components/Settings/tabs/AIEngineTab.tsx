/**
 * AI 引擎配置 Tab
 *
 * 包含：认证状态、引擎选择、CLI 路径、模型 Profile 管理、Agnes 全模态引擎、可用 Agent 列表
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ClaudePathSelector } from '../../Common';
import { useConfigStore } from '@/stores';
import { useCliInfoStore } from '@/stores/cliInfoStore';
import { useModelProfileStore } from '@/stores/modelProfileStore';
import type { Config, EngineId, ModelProfile, WireApi, ProfileTargetEngine, ProfileCategory } from '@/types';
import { Shield, ShieldCheck, ShieldX, RefreshCw, Bot, Plus, Trash2, Globe, Check, RotateCcw, Key, Zap, Pencil, Loader2, TestTube, Sparkles } from 'lucide-react';
import { registerAgnesEngine } from '@/core/engine-bootstrap';
import { getEngineRegistry } from '@/ai-runtime';
import { createLogger } from '@/utils/logger';
import { testModelProfileConnection } from '@/services/tauri/modelProfileService';
import { COMMON_PROVIDER_PRESETS, type ProviderPreset } from '@/types/modelProfile';

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
];

/**
 * Profile 卡片组件 — 显示 Profile 的详细信息、引擎标签、分类、操作按钮
 */
function ProfileCard({
  profile,
  isActive,
  onActivate,
  onEdit,
  onDelete,
  onTestConnection,
  isTesting,
  t,
}: {
  profile: ModelProfile
  isActive: boolean
  onActivate: () => void
  onEdit: (p: ModelProfile) => void
  onDelete: (id: string) => void
  onTestConnection: (p: ModelProfile) => void
  isTesting: boolean
  t: (key: string) => string
}) {
  const engineTags: string[] = []
  if (profile.targetEngine === 'both' || profile.targetEngine === 'claude') {
    engineTags.push('claude')
  }
  if (profile.targetEngine === 'both' || profile.targetEngine === 'codex') {
    engineTags.push('codex')
  }

  return (
    <div
      className={`flex items-center gap-3 p-3 rounded-lg border transition-all cursor-pointer ${
        isActive
          ? 'border-primary bg-primary/5'
          : 'border-border bg-background-default hover:border-primary/30'
      }`}
      onClick={onActivate}
    >
      {/* 激活指示器 */}
      <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
        isActive ? 'border-primary bg-primary' : 'border-border'
      }`}>
        {isActive && <Check size={10} className="text-white" />}
      </div>

      {/* 主体信息 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Globe size={12} className="text-text-tertiary shrink-0" />
          <span className="text-sm font-medium text-text-primary truncate">{profile.name}</span>
          {/* 引擎标签 */}
          {engineTags.includes('claude') && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 shrink-0">
              Claude
            </span>
          )}
          {engineTags.includes('codex') && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 shrink-0">
              Codex
            </span>
          )}
          {/* wireApi 标签 */}
          {profile.wireApi === 'openai-chat-completions' && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 shrink-0">
              OpenAI
            </span>
          )}
          {/* 分类标签 */}
          {profile.category && profile.category !== 'custom' && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 shrink-0">
              {profile.category === 'official' ? '官方' :
               profile.category === 'cn_official' ? '国内' :
               profile.category === 'aggregator' ? '聚合' :
               profile.category === 'third_party' ? '第三方' : profile.category}
            </span>
          )}
        </div>
        <div className="text-xs text-text-tertiary truncate mt-0.5">
          {profile.model} · {new URL(profile.baseUrl).hostname}
        </div>
      </div>

      {/* 操作按钮区域 */}
      <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
        {/* 连接测试按钮 */}
        <button
          onClick={() => onTestConnection(profile)}
          className="p-1 text-text-tertiary hover:text-blue-400 transition-colors"
          title={t('modelProfile.testConnection')}
          disabled={isTesting}
        >
          {isTesting ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <TestTube size={14} />
          )}
        </button>
        <button
          onClick={() => onEdit(profile)}
          className="p-1 text-text-tertiary hover:text-primary transition-colors"
          title={t('modelProfile.edit')}
        >
          <Pencil size={14} />
        </button>
        <button
          onClick={() => onDelete(profile.id)}
          className="p-1 text-text-tertiary hover:text-red-500 transition-colors"
          title={t('common.delete')}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}

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
  const { profiles, activeProfileId, addProfile, updateProfile, removeProfile, activateProfile, setProfiles, setActiveProfileId } = useModelProfileStore();
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [testingProfileId, setTestingProfileId] = useState<string | null>(null);
  // 表单状态（支持新字段）
  const [formProfile, setFormProfile] = useState({
    name: '', baseUrl: '', apiKey: '', model: '',
    wireApi: undefined as WireApi | undefined,
    targetEngine: undefined as ProfileTargetEngine | undefined,
    category: undefined as ProfileCategory | undefined,
    description: '',
  });
  const [resetting, setResetting] = useState(false);
  const [showPresetSelector, setShowPresetSelector] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  const presetRef = useRef<HTMLDivElement>(null);

  // 初始化同步：确保 modelProfileStore 和 localConfig 双向一致
  useEffect(() => {
    const configProfiles = config.modelProfiles || []
    if (profiles.length > 0 && configProfiles.length === 0) {
      syncProfilesToConfig(profiles, activeProfileId)
    } else if (configProfiles.length > 0 && profiles.length === 0) {
      setProfiles(configProfiles)
      if (config.activeModelProfileId) {
        setActiveProfileId(config.activeModelProfileId)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync once on mount from backend config
  }, [])

  // 点击外部关闭预设选择器
  useEffect(() => {
    if (!showPresetSelector) return
    const handleClickOutside = (e: MouseEvent) => {
      if (presetRef.current && !presetRef.current.contains(e.target as Node)) {
        setShowPresetSelector(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showPresetSelector])

  // 表单展开时自动滚动到表单位置
  useEffect(() => {
    if (showAddForm && formRef.current) {
      formRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [showAddForm])

  // 切换预设选择器
  const togglePresetSelector = () => setShowPresetSelector(p => !p)

  // 应用预设
  const applyPreset = (preset: ProviderPreset) => {
    setFormProfile({
      name: preset.name,
      baseUrl: preset.baseUrls[0] || '',
      apiKey: '',
      model: preset.commonModels[0] || '',
      wireApi: preset.defaultWireApi,
      targetEngine: preset.defaultTargetEngine,
      category: preset.category,
      description: preset.description,
    })
    setShowPresetSelector(false)
  }

  // 测试 Profile 连接
  const handleTestConnection = useCallback(async (profile: ModelProfile) => {
    setTestingProfileId(profile.id)
    try {
      const ok = await testModelProfileConnection(profile)
      if (ok) {
        log.info(`Profile ${profile.name} 连接测试成功`)
      } else {
        log.warn(`Profile ${profile.name} 连接测试失败`)
      }
    } catch (err) {
      log.error(`Profile ${profile.name} 连接测试异常: ${err}`)
    } finally {
      setTestingProfileId(null)
    }
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

  const handleSaveProfile = () => {
    if (!formProfile.name || !formProfile.baseUrl || !formProfile.apiKey || !formProfile.model) return;

    if (editingProfileId) {
      updateProfile({ id: editingProfileId, ...formProfile });
    } else {
      addProfile(formProfile);
    }

    // 重置表单状态
    resetForm();
    // 同步到 localConfig
    const updated = useModelProfileStore.getState()
    syncProfilesToConfig(updated.profiles, updated.activeProfileId)
  };

  const resetForm = () => {
    setFormProfile({ name: '', baseUrl: '', apiKey: '', model: '', wireApi: undefined, targetEngine: undefined, category: undefined, description: '' });
    setShowAddForm(false);
    setEditingProfileId(null);
  };

  const handleEditProfile = (profile: ModelProfile) => {
    setEditingProfileId(profile.id);
    setFormProfile({
      name: profile.name,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      model: profile.model,
      wireApi: profile.wireApi,
      targetEngine: profile.targetEngine,
      category: profile.category,
      description: profile.description || '',
    });
    setShowAddForm(true);
  };

  const handleDeleteProfile = (id: string) => {
    removeProfile(id);
    if (editingProfileId === id) {
      resetForm();
    }
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

      {/* 模型 Profile 管理 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-text-primary">
            {t('modelProfile.title')}
          </h3>
          <div className="flex items-center gap-2">
            {/* 预设选择器按钮 */}
            <button
              onClick={togglePresetSelector}
              className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 transition-colors"
              title={t('modelProfile.fromPreset')}
            >
              <Sparkles size={14} />
              {t('modelProfile.fromPreset')}
            </button>
            <button
              onClick={() => {
                if (showAddForm) {
                  resetForm();
                } else {
                  resetForm();
                  setShowAddForm(true);
                }
              }}
              className="flex items-center gap-1 text-xs text-primary hover:text-primary-hover transition-colors"
            >
              <Plus size={14} />
              {t('modelProfile.add')}
            </button>
          </div>
        </div>

        {/* 预设选择器下拉面板 */}
        {showPresetSelector && (
          <div ref={presetRef} className="mb-4 p-3 bg-background-default rounded-lg border border-border">
            <p className="text-xs text-text-secondary mb-2">{t('modelProfile.presetHint')}</p>
            <div className="grid grid-cols-1 gap-2">
              {COMMON_PROVIDER_PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  onClick={() => applyPreset(preset)}
                  className="flex items-center gap-3 p-2 rounded-md border border-border hover:border-primary/30 hover:bg-primary/5 transition-all text-left"
                >
                  <Sparkles size={14} className="text-amber-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-text-primary truncate">{preset.name}</div>
                    <div className="text-[10px] text-text-tertiary truncate">{preset.description}</div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {preset.defaultTargetEngine === 'both' || preset.defaultTargetEngine === 'claude' ? (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-400">Claude</span>
                    ) : null}
                    {preset.defaultTargetEngine === 'both' || preset.defaultTargetEngine === 'codex' ? (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-400">Codex</span>
                    ) : null}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 添加/编辑 Profile 表单 */}
        {showAddForm && (
          <div ref={formRef} className="mb-4 p-3 bg-background-default rounded-lg border border-border space-y-3">
            {/* Profile 名称 */}
            <input
              type="text"
              placeholder={t('modelProfile.profileName')}
              value={formProfile.name}
              onChange={(e) => setFormProfile({ ...formProfile, name: e.target.value })}
              className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg outline-none focus:border-primary"
            />
            {/* API 端点 URL */}
            <input
              type="text"
              placeholder={t('modelProfile.baseUrl')}
              value={formProfile.baseUrl}
              onChange={(e) => setFormProfile({ ...formProfile, baseUrl: e.target.value })}
              className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg outline-none focus:border-primary"
            />
            {/* API Key */}
            <input
              type="password"
              placeholder={t('modelProfile.apiKey')}
              value={formProfile.apiKey}
              onChange={(e) => setFormProfile({ ...formProfile, apiKey: e.target.value })}
              className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg outline-none focus:border-primary"
            />
            {/* 模型名称 */}
            <input
              type="text"
              placeholder={t('modelProfile.modelName')}
              value={formProfile.model}
              onChange={(e) => setFormProfile({ ...formProfile, model: e.target.value })}
              className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg outline-none focus:border-primary"
            />

            {/* 适用引擎选择 */}
            <div>
              <label className="block text-xs text-text-secondary mb-1">
                {t('modelProfile.targetEngine.label')}
              </label>
              <div className="flex gap-2">
                {(['claude', 'codex', 'both'] as ProfileTargetEngine[]).map((engine) => (
                  <button
                    key={engine}
                    type="button"
                    onClick={() => setFormProfile({ ...formProfile, targetEngine: engine })}
                    className={`flex-1 px-3 py-1.5 text-xs rounded-md border transition-all ${
                      formProfile.targetEngine === engine
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-background-surface text-text-tertiary hover:border-primary/30'
                    }`}
                  >
                    {engine === 'claude'
                      ? t('modelProfile.targetEngine.claude')
                      : engine === 'codex'
                        ? t('modelProfile.targetEngine.codex')
                        : t('modelProfile.targetEngine.both')}
                  </button>
                ))}
              </div>
            </div>

            {/* 供应商分类选择 */}
            <div>
              <label className="block text-xs text-text-secondary mb-1">
                {t('modelProfile.category.label')}
              </label>
              <select
                value={formProfile.category || ''}
                onChange={(e) => setFormProfile({ ...formProfile, category: (e.target.value || undefined) as ProfileCategory | undefined })}
                className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg outline-none focus:border-primary"
              >
                <option value="">{t('modelProfile.category.unspecified')}</option>
                <option value="official">{t('modelProfile.category.official')}</option>
                <option value="cn_official">{t('modelProfile.category.cn_official')}</option>
                <option value="aggregator">{t('modelProfile.category.aggregator')}</option>
                <option value="third_party">{t('modelProfile.category.third_party')}</option>
                <option value="custom">{t('modelProfile.category.custom')}</option>
              </select>
            </div>

            {/* Wire API 选择 */}
            <div>
              <label className="block text-xs text-text-secondary mb-1">
                {t('modelProfile.wireApi.label')}
              </label>
              <select
                value={formProfile.wireApi || ''}
                onChange={(e) => setFormProfile({ ...formProfile, wireApi: (e.target.value || undefined) as WireApi | undefined })}
                className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg outline-none focus:border-primary"
              >
                <option value="">{t('modelProfile.wireApi.anthropicMessages')}</option>
                <option value="openai-chat-completions">{t('modelProfile.wireApi.openaiChatCompletions')}</option>
              </select>
              {formProfile.wireApi === 'openai-chat-completions' && (
                <p className="text-xs text-text-tertiary mt-1">
                  {t('modelProfile.wireApi.openaiHint')}
                </p>
              )}
            </div>

            {/* 描述 */}
            <input
              type="text"
              placeholder={t('modelProfile.description')}
              value={formProfile.description}
              onChange={(e) => setFormProfile({ ...formProfile, description: e.target.value })}
              className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg outline-none focus:border-primary"
            />

            {/* 操作按钮 */}
            <div className="flex justify-end gap-2">
              <button
                onClick={resetForm}
                className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSaveProfile}
                disabled={!formProfile.name || !formProfile.baseUrl || !formProfile.apiKey || !formProfile.model}
                className="px-3 py-1.5 text-xs bg-primary text-white rounded hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {editingProfileId ? t('modelProfile.save') : t('common.add')}
              </button>
            </div>
          </div>
        )}

        {/* Profile 列表 */}
        {profiles.length === 0 ? (
          <div className="text-center py-4 text-xs text-text-tertiary">
            {t('modelProfile.noProfiles')}
          </div>
        ) : (
          <div className="space-y-2">
            {profiles.map((profile) => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                isActive={activeProfileId === profile.id}
                onActivate={() => {
                  const newActiveId = activeProfileId === profile.id ? null : profile.id
                  activateProfile(newActiveId)
                  syncProfilesToConfig(useModelProfileStore.getState().profiles, newActiveId)
                }}
                onEdit={handleEditProfile}
                onDelete={handleDeleteProfile}
                onTestConnection={handleTestConnection}
                isTesting={testingProfileId === profile.id}
                t={t}
              />
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
