/**
 * 模型供应商配置 Tab
 *
 * 从 AIEngineTab 抽离的独立模型 Profile 管理界面。
 * 采用「卡片列表 + 弹层分组编辑器」布局，支持：
 * - 三态 wireApi（anthropic-messages / openai-chat-completions / openai-responses）
 * - 结构化认证（authType + apiKeyEnvName + customHeaders + customEnv）
 * - 从端点拉取模型列表（GET /v1/models）
 * - 连接测试、预设画廊、搜索、引擎筛选、激活态高亮
 *
 * Profile 数据通过 onConfigChange 同步到 SettingsPage 的 localConfig，
 * 由底部「保存」按钮统一持久化到后端 config.json。
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useModelProfileStore } from '@/stores/modelProfileStore'
import { useToastStore } from '@/stores'
import type {
  Config,
  ModelProfile,
  WireApi,
  ProfileTargetEngine,
  ProfileCategory,
  AuthType,
} from '@/types'
import { COMMON_PROVIDER_PRESETS, type ProviderPreset, type ConnectionTestResult, resolveAuthType } from '@/types/modelProfile'
import {
  testModelProfileConnection,
  fetchModelsForProfile,
} from '@/services/tauri/modelProfileService'
import { createLogger } from '@/utils/logger'
import {
  Search,
  Plus,
  Trash2,
  Globe,
  Check,
  Pencil,
  Loader2,
  TestTube,
  Sparkles,
  X,
  Download,
  KeyRound,
  Server,
} from 'lucide-react'

const log = createLogger('ModelProviderTab')

type EngineFilter = 'all' | 'claude' | 'codex'

/** 键值对（用于 customHeaders / customEnv 的表单态） */
interface KeyValuePair {
  key: string
  value: string
}

/** 编辑器表单状态 */
interface ProfileForm {
  name: string
  baseUrl: string
  apiKey: string
  model: string
  wireApi: WireApi
  targetEngine: ProfileTargetEngine
  category: ProfileCategory | ''
  description: string
  authType: AuthType
  apiKeyEnvName: string
  customHeaders: KeyValuePair[]
  customEnv: KeyValuePair[]
}

const EMPTY_FORM: ProfileForm = {
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  wireApi: 'anthropic-messages',
  targetEngine: 'both',
  category: '',
  description: '',
  authType: 'auth_token',
  apiKeyEnvName: '',
  customHeaders: [],
  customEnv: [],
}

// ---------- 辅助函数 ----------

/** Record → 键值对数组（编辑表单用） */
function recordToPairs(record?: Record<string, string>): KeyValuePair[] {
  if (!record) return []
  return Object.entries(record).map(([key, value]) => ({ key, value }))
}

/** 键值对数组 → Record；空键自动过滤；无有效项返回 undefined */
function pairsToRecord(pairs: KeyValuePair[]): Record<string, string> | undefined {
  const entries = pairs
    .map((p) => [p.key.trim(), p.value] as const)
    .filter(([key]) => key.length > 0)
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries)
}

/** 安全解析 hostname，非法 URL 返回原串 */
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** 由表单构造用于「连接测试 / 拉取模型」的临时 Profile */
function formToProbeProfile(form: ProfileForm): ModelProfile {
  return {
    id: '__probe__',
    name: form.name || 'probe',
    baseUrl: form.baseUrl,
    apiKey: form.apiKey,
    model: form.model,
    active: false,
    wireApi: form.wireApi,
    targetEngine: form.targetEngine,
    category: form.category || undefined,
    authType: form.authType,
    apiKeyEnvName: form.apiKeyEnvName || undefined,
    customHeaders: pairsToRecord(form.customHeaders),
    customEnv: pairsToRecord(form.customEnv),
  }
}

/** 按 HTTP 状态码归类连接测试失败原因，返回 i18n key 与状态码（纯逻辑，不依赖 t） */
function classifyTestFailure(result: ConnectionTestResult): { key: string; status?: number } {
  const { status } = result
  if (status === undefined) return { key: 'modelProfile.testNetworkError' }
  if (status === 401 || status === 403) return { key: 'modelProfile.testAuthFailed', status }
  if (status === 404) return { key: 'modelProfile.testNotFound', status }
  if (status >= 500) return { key: 'modelProfile.testServerError', status }
  return { key: 'modelProfile.testBadStatus', status }
}

// ---------- 键值对编辑器 ----------

function KeyValueEditor({
  pairs,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
}: {
  pairs: KeyValuePair[]
  onChange: (next: KeyValuePair[]) => void
  keyPlaceholder: string
  valuePlaceholder: string
  addLabel: string
}) {
  const update = (index: number, patch: Partial<KeyValuePair>) => {
    onChange(pairs.map((p, i) => (i === index ? { ...p, ...patch } : p)))
  }
  const remove = (index: number) => onChange(pairs.filter((_, i) => i !== index))
  const add = () => onChange([...pairs, { key: '', value: '' }])

  return (
    <div className="space-y-2">
      {pairs.map((pair, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            type="text"
            placeholder={keyPlaceholder}
            value={pair.key}
            onChange={(e) => update(index, { key: e.target.value })}
            className="flex-1 min-w-0 px-2.5 py-1.5 text-xs font-mono bg-background-surface border border-border rounded-md outline-none focus:border-primary"
          />
          <input
            type="text"
            placeholder={valuePlaceholder}
            value={pair.value}
            onChange={(e) => update(index, { value: e.target.value })}
            className="flex-1 min-w-0 px-2.5 py-1.5 text-xs font-mono bg-background-surface border border-border rounded-md outline-none focus:border-primary"
          />
          <button
            type="button"
            onClick={() => remove(index)}
            className="p-1 text-text-tertiary hover:text-red-500 transition-colors shrink-0"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="flex items-center gap-1 text-xs text-primary hover:text-primary-hover transition-colors"
      >
        <Plus size={12} />
        {addLabel}
      </button>
    </div>
  )
}

// ---------- Profile 卡片 ----------

function ProfileCard({
  profile,
  isActive,
  isTesting,
  onActivate,
  onEdit,
  onDelete,
  onTestConnection,
}: {
  profile: ModelProfile
  isActive: boolean
  isTesting: boolean
  onActivate: () => void
  onEdit: (p: ModelProfile) => void
  onDelete: (id: string) => void
  onTestConnection: (p: ModelProfile) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const engine = profile.targetEngine ?? 'both'
  const wire = profile.wireApi ?? 'anthropic-messages'

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
      <div
        className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
          isActive ? 'border-primary bg-primary' : 'border-border'
        }`}
      >
        {isActive && <Check size={10} className="text-white" />}
      </div>

      {/* 主体信息 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Globe size={12} className="text-text-tertiary shrink-0" />
          <span className="text-sm font-medium text-text-primary truncate">{profile.name}</span>
          {(engine === 'both' || engine === 'claude') && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 shrink-0">
              Claude
            </span>
          )}
          {(engine === 'both' || engine === 'codex') && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 shrink-0">
              Codex
            </span>
          )}
          {wire === 'openai-chat-completions' && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 shrink-0">
              OpenAI Chat
            </span>
          )}
          {wire === 'openai-responses' && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-pink-500/10 text-pink-400 shrink-0">
              Responses
            </span>
          )}
          {profile.category && profile.category !== 'custom' && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 shrink-0">
              {t(`modelProfile.category.${profile.category}`)}
            </span>
          )}
        </div>
        <div className="text-xs text-text-tertiary truncate mt-0.5">
          {profile.model} · {safeHostname(profile.baseUrl)}
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => onTestConnection(profile)}
          className="p-1 text-text-tertiary hover:text-blue-400 transition-colors"
          title={t('modelProfile.testConnection')}
          disabled={isTesting}
        >
          {isTesting ? <Loader2 size={14} className="animate-spin" /> : <TestTube size={14} />}
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
          title={t('modelProfile.delete')}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}

// ---------- 编辑器弹层 ----------

function ProfileEditorModal({
  initialProfile,
  onSave,
  onClose,
}: {
  initialProfile: ModelProfile | null
  onSave: (form: ProfileForm) => void
  onClose: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const { success, error: toastError } = useToastStore()
  // id 非空 → 编辑已有 Profile；空串（预设新建）或 null → 新建
  const editing = Boolean(initialProfile?.id)
  const [form, setForm] = useState<ProfileForm>(() => {
    if (!initialProfile) return EMPTY_FORM
    return {
      name: initialProfile.name,
      baseUrl: initialProfile.baseUrl,
      apiKey: initialProfile.apiKey,
      model: initialProfile.model,
      wireApi: initialProfile.wireApi ?? 'anthropic-messages',
      targetEngine: initialProfile.targetEngine ?? 'both',
      category: initialProfile.category ?? '',
      description: initialProfile.description ?? '',
      authType: resolveAuthType(initialProfile),
      apiKeyEnvName: initialProfile.apiKeyEnvName ?? '',
      customHeaders: recordToPairs(initialProfile.customHeaders),
      customEnv: recordToPairs(initialProfile.customEnv),
    }
  })
  const [fetchedModels, setFetchedModels] = useState<string[]>(initialProfile?.fetchedModels ?? [])
  const [fetching, setFetching] = useState(false)
  const [testing, setTesting] = useState(false)

  const patch = (p: Partial<ProfileForm>) => setForm((prev) => ({ ...prev, ...p }))

  const canSubmit = Boolean(
    form.name.trim() &&
      form.baseUrl.trim() &&
      form.model.trim() &&
      (form.authType === 'none' || form.apiKey.trim()) &&
      (form.authType !== 'custom_env' || form.apiKeyEnvName.trim()),
  )

  const handleFetchModels = useCallback(async () => {
    if (!form.baseUrl.trim()) {
      toastError(t('modelProfile.fetchModels'), t('modelProfile.baseUrlRequired'))
      return
    }
    setFetching(true)
    try {
      const models = await fetchModelsForProfile(formToProbeProfile(form))
      setFetchedModels(models)
      if (models.length > 0) {
        success(t('modelProfile.fetchModels'), t('modelProfile.fetchModelsSuccess', { count: models.length }))
        if (!form.model) patch({ model: models[0] })
      } else {
        toastError(t('modelProfile.fetchModels'), t('modelProfile.fetchModelsEmpty'))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error(`拉取模型失败: ${msg}`)
      toastError(t('modelProfile.fetchModels'), msg)
    } finally {
      setFetching(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form])

  const handleTest = useCallback(async () => {
    if (!form.baseUrl.trim()) {
      toastError(t('modelProfile.testConnection'), t('modelProfile.baseUrlRequired'))
      return
    }
    setTesting(true)
    try {
      const result = await testModelProfileConnection(formToProbeProfile(form))
      if (result.ok) {
        success(t('modelProfile.testSuccessTitle'), t('modelProfile.testSuccessDesc', { name: form.name || form.baseUrl }))
      } else {
        const { key, status } = classifyTestFailure(result)
        const reason = status !== undefined ? t(key, { status }) : t(key)
        toastError(t('modelProfile.testFailedTitle'), result.detail ? `${reason} — ${result.detail}` : reason)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toastError(t('modelProfile.testErrorTitle'), msg)
    } finally {
      setTesting(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form])

  const fieldClass =
    'w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg outline-none focus:border-primary'
  const labelClass = 'block text-xs text-text-secondary mb-1'
  const sectionClass = 'space-y-3 p-3 bg-background-default rounded-lg border border-border'
  const sectionTitleClass = 'text-xs font-semibold text-text-secondary uppercase tracking-wide'

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="bg-background-elevated rounded-xl w-full max-w-lg border border-border shadow-glow max-h-[88vh] flex flex-col">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle shrink-0">
          <h2 className="text-base font-semibold text-text-primary">
            {editing ? t('modelProfile.editTitle') : t('modelProfile.addTitle')}
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* 表单主体（可滚动） */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* 基础信息 */}
          <div className={sectionClass}>
            <div className={sectionTitleClass}>{t('modelProfile.sectionBasic')}</div>
            <div>
              <label className={labelClass}>{t('modelProfile.profileName')}</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
                className={fieldClass}
              />
            </div>
            <div>
              <label className={labelClass}>{t('modelProfile.baseUrl')}</label>
              <input
                type="text"
                value={form.baseUrl}
                onChange={(e) => patch({ baseUrl: e.target.value })}
                className={fieldClass}
              />
            </div>
            <div>
              <label className={labelClass}>{t('modelProfile.modelName')}</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  list="model-provider-fetched-models"
                  value={form.model}
                  onChange={(e) => patch({ model: e.target.value })}
                  className={fieldClass}
                />
                <datalist id="model-provider-fetched-models">
                  {fetchedModels.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <button
                  type="button"
                  onClick={handleFetchModels}
                  disabled={fetching}
                  title={t('modelProfile.fetchModels')}
                  className="shrink-0 flex items-center gap-1 px-3 py-2 text-xs rounded-lg border border-border text-text-secondary hover:border-primary/40 hover:text-primary transition-colors disabled:opacity-50"
                >
                  {fetching ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                  {t('modelProfile.fetchModels')}
                </button>
              </div>
              {fetchedModels.length > 0 && (
                <p className="text-[11px] text-text-tertiary mt-1">
                  {t('modelProfile.fetchedModelsHint', { count: fetchedModels.length })}
                </p>
              )}
            </div>
          </div>

          {/* 认证配置 */}
          <div className={sectionClass}>
            <div className={`${sectionTitleClass} flex items-center gap-1.5`}>
              <KeyRound size={12} />
              {t('modelProfile.sectionAuth')}
            </div>
            <div>
              <label className={labelClass}>{t('modelProfile.authType.label')}</label>
              <select
                value={form.authType}
                onChange={(e) => patch({ authType: e.target.value as AuthType })}
                className={fieldClass}
              >
                <option value="auth_token">{t('modelProfile.authType.authToken')}</option>
                <option value="api_key">{t('modelProfile.authType.apiKey')}</option>
                <option value="custom_env">{t('modelProfile.authType.customEnv')}</option>
                <option value="none">{t('modelProfile.authType.none')}</option>
              </select>
              <p className="text-[11px] text-text-tertiary mt-1">
                {t(`modelProfile.authType.hint.${form.authType}`)}
              </p>
            </div>
            {form.authType === 'custom_env' && (
              <div>
                <label className={labelClass}>{t('modelProfile.apiKeyEnvName')}</label>
                <input
                  type="text"
                  placeholder="OPENAI_API_KEY"
                  value={form.apiKeyEnvName}
                  onChange={(e) => patch({ apiKeyEnvName: e.target.value })}
                  className={`${fieldClass} font-mono`}
                />
              </div>
            )}
            {form.authType !== 'none' && (
              <div>
                <label className={labelClass}>{t('modelProfile.apiKey')}</label>
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => patch({ apiKey: e.target.value })}
                  className={fieldClass}
                />
              </div>
            )}
          </div>

          {/* 协议与适用范围 */}
          <div className={sectionClass}>
            <div className={sectionTitleClass}>{t('modelProfile.sectionProtocol')}</div>
            <div>
              <label className={labelClass}>{t('modelProfile.wireApi.label')}</label>
              <select
                value={form.wireApi}
                onChange={(e) => patch({ wireApi: e.target.value as WireApi })}
                className={fieldClass}
              >
                <option value="anthropic-messages">{t('modelProfile.wireApi.anthropicMessages')}</option>
                <option value="openai-chat-completions">{t('modelProfile.wireApi.openaiChatCompletions')}</option>
                <option value="openai-responses">{t('modelProfile.wireApi.openaiResponses')}</option>
              </select>
              {form.wireApi === 'openai-chat-completions' && (
                <p className="text-[11px] text-text-tertiary mt-1">{t('modelProfile.wireApi.openaiHint')}</p>
              )}
              {form.wireApi === 'openai-responses' && (
                <p className="text-[11px] text-text-tertiary mt-1">{t('modelProfile.wireApi.responsesHint')}</p>
              )}
            </div>
            <div>
              <label className={labelClass}>{t('modelProfile.targetEngine.label')}</label>
              <div className="grid grid-cols-3 gap-2">
                {(['claude', 'codex', 'simple-ai', 'both', 'all'] as ProfileTargetEngine[]).map((engineOption) => (
                  <button
                    key={engineOption}
                    type="button"
                    onClick={() => patch({ targetEngine: engineOption })}
                    className={`px-3 py-1.5 text-xs rounded-md border transition-all ${
                      form.targetEngine === engineOption
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-background-surface text-text-tertiary hover:border-primary/30'
                    }`}
                  >
                    {t(`modelProfile.targetEngine.${engineOption}`)}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className={labelClass}>{t('modelProfile.category.label')}</label>
              <select
                value={form.category}
                onChange={(e) => patch({ category: e.target.value as ProfileCategory | '' })}
                className={fieldClass}
              >
                <option value="">{t('modelProfile.category.unspecified')}</option>
                <option value="official">{t('modelProfile.category.official')}</option>
                <option value="cn_official">{t('modelProfile.category.cn_official')}</option>
                <option value="aggregator">{t('modelProfile.category.aggregator')}</option>
                <option value="third_party">{t('modelProfile.category.third_party')}</option>
                <option value="custom">{t('modelProfile.category.custom')}</option>
              </select>
            </div>
          </div>

          {/* 高级选项 */}
          <div className={sectionClass}>
            <div className={sectionTitleClass}>{t('modelProfile.sectionAdvanced')}</div>
            <div>
              <label className={labelClass}>{t('modelProfile.customHeaders')}</label>
              <KeyValueEditor
                pairs={form.customHeaders}
                onChange={(next) => patch({ customHeaders: next })}
                keyPlaceholder="Header-Name"
                valuePlaceholder="value"
                addLabel={t('modelProfile.addHeader')}
              />
            </div>
            <div>
              <label className={labelClass}>{t('modelProfile.customEnv')}</label>
              <KeyValueEditor
                pairs={form.customEnv}
                onChange={(next) => patch({ customEnv: next })}
                keyPlaceholder="ENV_NAME"
                valuePlaceholder="value"
                addLabel={t('modelProfile.addEnv')}
              />
            </div>
            <div>
              <label className={labelClass}>{t('modelProfile.description')}</label>
              <input
                type="text"
                value={form.description}
                onChange={(e) => patch({ description: e.target.value })}
                className={fieldClass}
              />
            </div>
          </div>
        </div>

        {/* 底部操作栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-border-subtle shrink-0">
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg border border-border text-text-secondary hover:border-blue-400/40 hover:text-blue-400 transition-colors disabled:opacity-50"
          >
            {testing ? <Loader2 size={14} className="animate-spin" /> : <TestTube size={14} />}
            {t('modelProfile.testConnection')}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary rounded-lg transition-colors"
            >
              {t('modelProfile.cancel')}
            </button>
            <button
              type="button"
              onClick={() => onSave(form)}
              disabled={!canSubmit}
              className="px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {editing ? t('modelProfile.save') : t('modelProfile.add')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- 主组件 ----------

interface ModelProviderTabProps {
  config: Config
  onConfigChange: (config: Config) => void
  loading: boolean
}

export function ModelProviderTab({ config, onConfigChange }: ModelProviderTabProps) {
  const { t } = useTranslation(['settings', 'common'])
  const { success, error: toastError } = useToastStore()
  const {
    profiles,
    activeProfileId,
    addProfile,
    updateProfile,
    removeProfile,
    activateProfile,
    setProfiles,
    setActiveProfileId,
  } = useModelProfileStore()

  const [search, setSearch] = useState('')
  const [engineFilter, setEngineFilter] = useState<EngineFilter>('all')
  const [showEditor, setShowEditor] = useState(false)
  const [editingProfile, setEditingProfile] = useState<ModelProfile | null>(null)
  const [testingProfileId, setTestingProfileId] = useState<string | null>(null)
  const [showPresets, setShowPresets] = useState(false)

  // 同步 store → config（onConfigChange 回传 SettingsPage）
  const syncToConfig = useCallback(
    (nextProfiles: ModelProfile[], nextActiveId: string | null) => {
      onConfigChange({
        ...config,
        modelProfiles: nextProfiles,
        activeModelProfileId: nextActiveId ?? undefined,
      })
    },
    [config, onConfigChange],
  )

  // 初始化：从后端 config 灌入 store（仅 mount 时）
  useEffect(() => {
    const configProfiles = config.modelProfiles || []
    if (profiles.length > 0 && configProfiles.length === 0) {
      syncToConfig(profiles, activeProfileId)
    } else if (configProfiles.length > 0 && profiles.length === 0) {
      setProfiles(configProfiles)
      if (config.activeModelProfileId) setActiveProfileId(config.activeModelProfileId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync once on mount from backend config
  }, [])

  // 筛选后的列表
  const filteredProfiles = useMemo(() => {
    const q = search.trim().toLowerCase()
    return profiles.filter((p) => {
      const engine = p.targetEngine ?? 'both'
      const matchEngine = engineFilter === 'all' || engine === 'both' || engine === engineFilter
      if (!matchEngine) return false
      if (!q) return true
      return (
        p.name.toLowerCase().includes(q) ||
        p.model.toLowerCase().includes(q) ||
        p.baseUrl.toLowerCase().includes(q)
      )
    })
  }, [profiles, search, engineFilter])

  const openCreate = (preset?: ProviderPreset) => {
    setShowPresets(false)
    if (preset) {
      setEditingProfile({
        id: '',
        name: preset.name,
        baseUrl: preset.baseUrls[0] || '',
        apiKey: '',
        model: preset.commonModels[0] || '',
        active: false,
        wireApi: preset.defaultWireApi,
        targetEngine: preset.defaultTargetEngine,
        category: preset.category,
        description: preset.description,
      })
    } else {
      setEditingProfile(null)
    }
    setShowEditor(true)
  }

  const openEdit = (profile: ModelProfile) => {
    setEditingProfile(profile)
    setShowEditor(true)
  }

  const closeEditor = () => {
    setShowEditor(false)
    setEditingProfile(null)
  }

  // 编辑器是「预设新建」时 id 为空串，按新建处理
  const isEditing = Boolean(editingProfile && editingProfile.id)

  const handleSave = (form: ProfileForm) => {
    const params = {
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      apiKey: form.apiKey,
      model: form.model.trim(),
      wireApi: form.wireApi,
      targetEngine: form.targetEngine,
      category: form.category || undefined,
      description: form.description.trim() || undefined,
      authType: form.authType,
      apiKeyEnvName: form.apiKeyEnvName.trim() || undefined,
      customHeaders: pairsToRecord(form.customHeaders),
      customEnv: pairsToRecord(form.customEnv),
    }

    if (isEditing && editingProfile) {
      updateProfile({ id: editingProfile.id, ...params })
    } else {
      addProfile(params)
    }

    const updated = useModelProfileStore.getState()
    syncToConfig(updated.profiles, updated.activeProfileId)
    success(t('modelProfile.title'), t(isEditing ? 'modelProfile.updated' : 'modelProfile.created'))
    closeEditor()
  }

  const handleDelete = (id: string) => {
    removeProfile(id)
    const updated = useModelProfileStore.getState()
    syncToConfig(updated.profiles, updated.activeProfileId)
    if (editingProfile?.id === id) closeEditor()
  }

  const handleActivate = (profile: ModelProfile) => {
    const nextActiveId = activeProfileId === profile.id ? null : profile.id
    activateProfile(nextActiveId)
    syncToConfig(useModelProfileStore.getState().profiles, nextActiveId)
  }

  const handleTestConnection = useCallback(
    async (profile: ModelProfile) => {
      setTestingProfileId(profile.id)
      try {
        const result = await testModelProfileConnection(profile)
        if (result.ok) {
          success(t('modelProfile.testSuccessTitle'), t('modelProfile.testSuccessDesc', { name: profile.name }))
        } else {
          const { key, status } = classifyTestFailure(result)
          const reason = status !== undefined ? t(key, { status }) : t(key)
          toastError(t('modelProfile.testFailedTitle'), result.detail ? `${reason} — ${result.detail}` : reason)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toastError(t('modelProfile.testErrorTitle'), msg)
      } finally {
        setTestingProfileId(null)
      }
    },
    [success, toastError, t],
  )

  return (
    <div className="space-y-4">
      {/* 说明 */}
      <p className="text-xs text-text-secondary">{t('modelProfile.tabDescription')}</p>

      {/* 工具栏 */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        {/* 搜索 */}
        <div className="relative flex-1">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('modelProfile.searchPlaceholder')}
            className="w-full bg-surface border border-border rounded-lg pl-8 pr-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-primary"
          />
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
        </div>

        {/* 引擎筛选 */}
        <div className="flex gap-1 shrink-0">
          {(['all', 'claude', 'codex'] as EngineFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setEngineFilter(f)}
              className={`px-3 py-2 text-xs rounded-lg border transition-all ${
                engineFilter === f
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-surface text-text-tertiary hover:border-primary/30'
              }`}
            >
              {t(`modelProfile.filter.${f}`)}
            </button>
          ))}
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => openCreate()}
          className="flex items-center gap-1.5 px-3 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors"
        >
          <Plus size={14} />
          {t('modelProfile.add')}
        </button>
        <div className="relative">
          <button
            onClick={() => setShowPresets((p) => !p)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-amber-500/40 text-amber-500 hover:bg-amber-500/10 transition-colors"
          >
            <Sparkles size={14} />
            {t('modelProfile.fromPreset')}
          </button>
          {showPresets && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowPresets(false)} />
              <div className="absolute left-0 top-full mt-1 z-50 w-72 p-2 bg-background-elevated rounded-lg border border-border shadow-glow max-h-80 overflow-y-auto">
                <p className="text-[11px] text-text-tertiary px-1 py-1">{t('modelProfile.presetHint')}</p>
                {COMMON_PROVIDER_PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    onClick={() => openCreate(preset)}
                    className="w-full flex items-center gap-2 p-2 rounded-md hover:bg-primary/5 transition-colors text-left"
                  >
                    <Sparkles size={14} className="text-amber-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-text-primary truncate">{preset.name}</div>
                      <div className="text-[10px] text-text-tertiary truncate">{preset.description}</div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Profile 列表 */}
      {profiles.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Server size={32} className="text-text-muted mb-3" />
          <p className="text-sm text-text-tertiary">{t('modelProfile.noProfiles')}</p>
        </div>
      ) : filteredProfiles.length === 0 ? (
        <div className="text-center py-8 text-xs text-text-tertiary">
          {t('modelProfile.noMatchingProfiles')}
        </div>
      ) : (
        <div className="space-y-2">
          {filteredProfiles.map((profile) => (
            <ProfileCard
              key={profile.id}
              profile={profile}
              isActive={activeProfileId === profile.id}
              isTesting={testingProfileId === profile.id}
              onActivate={() => handleActivate(profile)}
              onEdit={openEdit}
              onDelete={handleDelete}
              onTestConnection={handleTestConnection}
            />
          ))}
        </div>
      )}

      {/* 编辑器弹层 */}
      {showEditor && (
        <ProfileEditorModal
          key={editingProfile?.id || 'new'}
          initialProfile={editingProfile}
          onSave={handleSave}
          onClose={closeEditor}
        />
      )}
    </div>
  )
}
