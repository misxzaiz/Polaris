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
import { useSessionConfig } from '@/stores/sessionConfigStore'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { useToastStore } from '@/stores'
import type {
  Config,
  ModelProfile,
  WireApi,
  ProfileTargetEngine,
  ProfileCategory,
  AuthType,
  ProviderGroup,
  RouteStrategy,
  FailoverPattern,
} from '@/types'
import { OFFICIAL_API_PROFILE, type ConnectionTestResult, resolveAuthType, resolveTargetEngines, isProfileForEngine, ALL_ENGINES } from '@/types/modelProfile'
import { useEngineMetadataStore } from '@/stores/engineMetadataStore'
import { getEngineDisplayName } from '@/utils/engineDisplay'
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
  X,
  Download,
  KeyRound,
  Server,
  Eye,
  EyeOff,
  Copy,
  Zap,
  Route,
  ChevronDown,
  ChevronUp,
  Layers,
  ShieldAlert,
  Clock,
  RotateCcw,
} from 'lucide-react'

const log = createLogger('ModelProviderTab')


/** 上下文窗口快捷预设值（对应 locale 中的 key） */
const CONTEXT_WINDOW_PRESETS: Record<string, string> = {
  '180k': '180000',
  '256k': '256000',
  '1m': '1000000',
};

type EngineFilter = 'all' | 'claude' | 'codex' | 'simple-ai' | 'pi' | (string & NonNullable<unknown>)

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
  modelOptions: string[]
  fetchedModels: string[]
  wireApi: WireApi
  targetEngines: ProfileTargetEngine[]
  category: ProfileCategory | ''
  description: string
  authType: AuthType
  apiKeyEnvName: string
  customHeaders: KeyValuePair[]
  customEnv: KeyValuePair[]
  /** 单次输出 token 上限；表单态存字符串，提交时解析正整数 */
  maxTokens: string
  /** 上下文窗口 token；表单态存字符串，提交时解析正整数 */
  contextWindow: string
}

const EMPTY_FORM: ProfileForm = {
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  modelOptions: [],
  fetchedModels: [],
  wireApi: 'anthropic-messages',
  targetEngines: [],
  category: '',
  description: '',
  authType: 'auth_token',
  apiKeyEnvName: '',
  customHeaders: [],
  customEnv: [],
  maxTokens: '',
  contextWindow: '',
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

/** 表单数字串 → 正整数；空/非法/非正返回 undefined（不落盘） */
function parsePositiveInt(s: string): number | undefined {
  const n = parseInt(s.trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** 安全解析 hostname，非法 URL 返回原串 */
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function normalizeModelOptions(model: string, modelOptions: string[] = [], fetchedModels: string[] = []): string[] {
  return [...new Set([model, ...modelOptions, ...fetchedModels].map(m => m.trim()).filter(Boolean))]
}

/** 由表单构造用于「连接测试 / 拉取模型」的临时 Profile */
function formToProbeProfile(form: ProfileForm): ModelProfile {
  return {
    id: '__probe__',
    name: form.name || 'probe',
    baseUrl: form.baseUrl,
    apiKey: form.apiKey,
    model: form.model,
    modelOptions: normalizeModelOptions(form.model, form.modelOptions, form.fetchedModels),
    active: false,
    wireApi: form.wireApi,
    targetEngines: form.targetEngines,
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
  onDuplicate,
  onTestConnection,
}: {
  profile: ModelProfile
  isActive: boolean
  isTesting: boolean
  onActivate: () => void
  onEdit: (p: ModelProfile) => void
  onDelete: (id: string) => void
  onDuplicate: (p: ModelProfile) => void
  onTestConnection: (p: ModelProfile) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const engineList = resolveTargetEngines(profile)
  const wire = profile.wireApi ?? 'anthropic-messages'

  return (
    <div
      className={`flex items-center gap-3 p-3 rounded-lg border transition-all cursor-pointer ${
        isActive
          ? 'border-primary bg-primary/5'
          : 'border-border bg-background-surface hover:border-primary/30'
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
          {engineList.length === 0 || engineList.includes('claude') ? (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 shrink-0">
              Claude
            </span>
          ) : null}
          {engineList.length === 0 || engineList.includes('codex') ? (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 shrink-0">
              Codex
            </span>
          ) : null}
          {engineList.length === 0 || engineList.includes('simple-ai') ? (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 shrink-0">
              Simple
            </span>
          ) : null}
          {engineList.length === 0 || engineList.includes('pi') ? (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 shrink-0">
              Pi
            </span>
          ) : null}
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
          onClick={() => onDuplicate(profile)}
          className="p-1 text-text-tertiary hover:text-emerald-400 transition-colors"
          title={t('modelProfile.duplicate')}
        >
          <Copy size={14} />
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

/** 解析快速输入文本：格式为 `[url] [model] [apikey]`（空格分隔，apikey 可含空格） */
function parseQuickInput(text: string): { baseUrl: string; model: string; apiKey: string } | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  // 按空格分割，第一个 token 若为 URL 则作为 baseUrl
  // 之后第一个非 URL token 为 model，剩余全部为 apiKey
  const tokens = trimmed.split(/\s+/)

  // 找到 URL 位置（第一个以 http 开头的 token）
  const urlIdx = tokens.findIndex((t) => t.startsWith('http://') || t.startsWith('https://'))
  if (urlIdx === -1) return null

  const baseUrl = tokens[urlIdx]
  // URL 之后的第一个 token 为 model，再往后全部为 apiKey
  const modelIdx = urlIdx + 1
  if (modelIdx >= tokens.length) return null

  const model = tokens[modelIdx]
  const apiKey = tokens.slice(modelIdx + 1).join(' ').trim()

  if (!model) return null

  return { baseUrl, model, apiKey }
}

// ---------- 编辑器弹层 ----------

function ProfileEditorModal({
  initialProfile,
  onSave,
  onClose,
  allEngines,
}: {
  initialProfile: ModelProfile | null
  onSave: (form: ProfileForm) => void
  onClose: () => void
  allEngines: string[]
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
      modelOptions: [...(initialProfile.modelOptions ?? [])],
      fetchedModels: [...(initialProfile.fetchedModels ?? [])],
      wireApi: initialProfile.wireApi ?? 'anthropic-messages',
      targetEngines: resolveTargetEngines(initialProfile),
      category: initialProfile.category ?? '',
      description: initialProfile.description ?? '',
      authType: resolveAuthType(initialProfile),
      apiKeyEnvName: initialProfile.apiKeyEnvName ?? '',
      customHeaders: recordToPairs(initialProfile.customHeaders),
      customEnv: recordToPairs(initialProfile.customEnv),
      maxTokens: initialProfile.maxTokens != null ? String(initialProfile.maxTokens) : '',
      contextWindow: initialProfile.contextWindow != null ? String(initialProfile.contextWindow) : '',
    }
  })
  const [fetching, setFetching] = useState(false)
  const [testing, setTesting] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)

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
      // 合并去重后写入 form.fetchedModels，并并入 modelOptions 供保存持久化
      const merged = normalizeModelOptions(form.model, form.modelOptions, models)
      patch({ fetchedModels: models, modelOptions: merged })
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
  const sectionClass = 'space-y-3 p-3 bg-background-surface rounded-lg border border-border'
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
          {/* 快速输入 — 仅新建时显示 */}
          {!editing && (
            <div className={sectionClass}>
              <div className={`${sectionTitleClass} flex items-center gap-1.5`}>
                <Zap size={12} />
                {t('modelProfile.quickInput')}
              </div>
              <div>
                <input
                  type="text"
                  placeholder={t('modelProfile.quickInputPlaceholder')}
                  onPaste={(e) => {
                    // 粘贴后异步读取剪贴板文本并解析
                    const pasted = e.clipboardData.getData('text')
                    const parsed = parseQuickInput(pasted)
                    if (parsed) {
                      // 仅当表单字段仍为空时才自动填充，避免覆盖用户已有输入
                      setForm((prev) => {
                        const next = { ...prev }
                        if (!prev.baseUrl) next.baseUrl = parsed.baseUrl
                        if (!prev.model) next.model = parsed.model
                        if (!prev.name) next.name = parsed.model
                        if (!prev.apiKey) next.apiKey = parsed.apiKey
                        return next
                      })
                    }
                  }}
                  className={`${fieldClass} font-mono text-xs`}
                />
                <p className="text-[11px] text-text-tertiary mt-1">
                  <code className="text-[10px] bg-background-surface px-1 py-0.5 rounded">
                    https://api.example.com model-name sk-xxxxxxxx
                  </code>
                </p>
              </div>
            </div>
          )}

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
                  {form.fetchedModels.map((m) => (
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
              {form.fetchedModels.length > 0 && (
                <p className="text-[11px] text-text-tertiary mt-1">
                  {t('modelProfile.fetchedModelsHint', { count: form.fetchedModels.length })}
                </p>
              )}
              {/* 可选模型列表：默认模型必须来自此列表 */}
              <div className="mt-2 space-y-1.5">
                {form.modelOptions.map((m, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => patch({ model: m })}
                      className={`shrink-0 w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${
                        form.model === m ? 'border-primary bg-primary' : 'border-border'
                      }`}
                      title={form.model === m ? t('modelProfile.defaultModel') : t('modelProfile.setAsDefault')}
                    >
                      {form.model === m && <Check size={10} className="text-white" />}
                    </button>
                    <input
                      type="text"
                      value={m}
                      onChange={(e) => {
                        const next = e.target.value
                        const updated = [...form.modelOptions]
                        updated[idx] = next
                        patch({ modelOptions: updated, model: form.model === m ? next : form.model })
                      }}
                      className={`${fieldClass} text-xs font-mono`}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const updated = form.modelOptions.filter((_, i) => i !== idx)
                        // 删除的是默认模型 → 自动切到列表第一项
                        const nextModel = form.model === m ? (updated[0] ?? '') : form.model
                        patch({ modelOptions: updated, model: nextModel })
                      }}
                      className="shrink-0 p-1 text-text-tertiary hover:text-red-500 transition-colors"
                      title={t('common:delete')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    const next = form.modelOptions.includes('') ? form.modelOptions : [...form.modelOptions, '']
                    patch({ modelOptions: next })
                  }}
                  className="flex items-center gap-1 text-xs text-primary hover:text-primary-hover transition-colors"
                >
                  <Plus size={12} />
                  {t('modelProfile.addModelOption')}
                </button>
              </div>
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
                <div className="relative">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={form.apiKey}
                    onChange={(e) => patch({ apiKey: e.target.value })}
                    autoComplete="off"
                    className={`${fieldClass} pr-9`}
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowApiKey((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-text-tertiary hover:text-text-primary transition-colors shrink-0"
                    title={showApiKey ? t('modelProfile.hideApiKey') : t('modelProfile.showApiKey')}
                  >
                    {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
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
              {/* 全选切换 */}
              <button
                type="button"
                onClick={() => {
                  const allSelected = allEngines.every((e) => form.targetEngines.includes(e))
                  patch({ targetEngines: allSelected ? [] : [...allEngines] })
                }}
                className="mb-2 px-2 py-1 text-[10px] rounded-md border transition-all hover:border-primary/30"
              >
                {ALL_ENGINES.every((e) => form.targetEngines.includes(e))
                  ? t('modelProfile.targetEngine.selectAll')
                  : t('modelProfile.targetEngine.selectAll')}
              </button>
              {/* 引擎多选 */}
              <div className="grid grid-cols-2 gap-2">
                {allEngines.map((engineOption) => (
                  <button
                    key={engineOption}
                    type="button"
                    onClick={() => {
                      const selected = form.targetEngines.includes(engineOption)
                      patch({
                        targetEngines: selected
                          ? form.targetEngines.filter((e) => e !== engineOption)
                          : [...form.targetEngines, engineOption],
                      })
                    }}
                    className={`px-3 py-1.5 text-xs rounded-md border transition-all ${
                      form.targetEngines.includes(engineOption)
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-background-surface text-text-tertiary hover:border-primary/30'
                    }`}
                  >
                    {ALL_ENGINES.includes(engineOption)
                      ? t(`modelProfile.targetEngine.${engineOption}`)
                      : getEngineDisplayName(engineOption)}
                  </button>
                ))}
              </div>
              {form.targetEngines.length === 0 && (
                <p className="text-[11px] text-text-tertiary mt-1">{t('modelProfile.targetEngine.allEngines')}</p>
              )}
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
<div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>{t('modelProfile.maxTokens')}</label>
                <input
                  type="number"
                  min={1}
                  value={form.maxTokens}
                  onChange={(e) => patch({ maxTokens: e.target.value })}
                  placeholder={t('modelProfile.maxTokensPlaceholder')}
                  className={fieldClass}
                />
              </div>
              <div>
                <label className={labelClass}>{t('modelProfile.contextWindow')}</label>
                <div className="flex flex-col gap-1.5">
                  <div className="flex gap-1.5">
                    {(['180k', '256k', '1m'] as const).map((key) => {
                      const isActive = form.contextWindow === CONTEXT_WINDOW_PRESETS[key];
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => patch({ contextWindow: CONTEXT_WINDOW_PRESETS[key] })}
                          className={`flex-1 px-2 py-1.5 text-xs rounded-md border transition-colors ${
                            isActive
                              ? 'bg-primary/15 border-primary text-primary font-semibold'
                              : 'bg-background-surface border-border text-text-secondary hover:border-text-tertiary'
                          }`}
                        >
                          {t(`modelProfile.contextWindowPresets.${key}`)}
                        </button>
                      );
                    })}
                  </div>
                  <input
                    type="number"
                    min={1}
                    value={form.contextWindow}
                    onChange={(e) => patch({ contextWindow: e.target.value })}
                    placeholder={t('modelProfile.contextWindowPlaceholder')}
                    className={fieldClass}
                  />
                </div>
              </div>
            </div>
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

// ---------- 供应商分组配置 ----------

/** 分组路由策略选项（对应后端 RouteStrategy lowercase 序列化） */
const STRATEGY_LABEL: Record<RouteStrategy, string> = {
  failover: 'Failover',
  roundrobin: 'RoundRobin',
  weighted: 'Weighted',
}

/** 默认 failover 触发模式集（对应后端 FailoverPattern::defaults()） */
const DEFAULT_FAILOVER_PATTERNS: FailoverPattern[] = [
  { HttpStatus: { code: 401 } },
  { HttpStatus: { code: 403 } },
  { HttpStatus: { code: 429 } },
  { HttpStatus: { code: 500 } },
  'FirstTokenTimeout',
  'ConnectionRefused',
]

/** 生成分组 ID */
function generateGroupId(): string {
  return `group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** failover 触发模式表单项 */
interface FailoverPatternFormItem {
  kind: 'HttpStatus' | 'FirstTokenTimeout' | 'ConnectionRefused' | 'StderrContains'
  code?: string
  pattern?: string
}

/** FailoverPattern → 表单项 */
function patternToForm(p: FailoverPattern): FailoverPatternFormItem {
  if (typeof p === 'string') {
    return { kind: p }
  }
  if ('HttpStatus' in p) return { kind: 'HttpStatus', code: String(p.HttpStatus.code) }
  if ('StderrContains' in p) return { kind: 'StderrContains', pattern: p.StderrContains.pattern }
  return { kind: 'HttpStatus', code: '500' }
}

/** 表单项 → FailoverPattern（无效返回 null） */
function formToPattern(f: FailoverPatternFormItem): FailoverPattern | null {
  switch (f.kind) {
    case 'HttpStatus': {
      const code = parseInt(f.code ?? '', 10)
      return Number.isFinite(code) ? { HttpStatus: { code } } : null
    }
    case 'StderrContains': {
      const pattern = (f.pattern ?? '').trim()
      return pattern ? { StderrContains: { pattern } } : null
    }
    case 'FirstTokenTimeout': return 'FirstTokenTimeout'
    case 'ConnectionRefused': return 'ConnectionRefused'
  }
}

/** 分组成员表单项 */
interface MemberFormItem {
  profileId: string
  priority: string
  weight: string
  /** 多 Key 池（可选） */
  keys: string[]
  /** Key 级路由策略 */
  keyStrategy: RouteStrategy
}

/** 分组编辑表单状态 */
interface GroupForm {
  id: string
  name: string
  strategy: RouteStrategy
  defaultModel: string
  targetEngines: string[]
  description: string
  category: string
  members: MemberFormItem[]
  failoverOn: FailoverPatternFormItem[]
  firstTokenTimeoutSecs: string
  maxFailoverAttempts: string
  active: boolean
}

// ---------- 分组卡片 ----------

function ProviderGroupCard({
  group,
  isActiveGroup,
  profiles,
  onEdit,
  onDelete,
  onSetActive,
  onTestConnection,
  isTesting,
}: {
  group: ProviderGroup
  isActiveGroup: boolean
  profiles: ModelProfile[]
  onEdit: (g: ProviderGroup) => void
  onDelete: (id: string) => void
  onSetActive: (id: string) => void
  onTestConnection?: (g: ProviderGroup) => void
  isTesting?: boolean
}) {
  const memberNames = group.members
    .map((m) => profiles.find((p) => p.id === m.profileId)?.name || '已删除')
  const missing = group.members.filter((m) => !profiles.some((p) => p.id === m.profileId)).length

  return (
    <div
      className={`rounded-lg border p-3 transition-all ${
        isActiveGroup ? 'border-primary bg-primary/5' : 'border-border bg-background-surface'
      }`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Route size={14} className="text-text-tertiary shrink-0" />
        <span className="text-sm font-medium text-text-primary truncate">{group.name}</span>
        <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 shrink-0">{STRATEGY_LABEL[group.strategy]}</span>
        <span className="text-[9px] px-1.5 py-0.5 rounded bg-text-tertiary/10 text-text-tertiary shrink-0">{group.members.length} 成员</span>
        {group.members.some(m => m.keys && m.keys.length > 0) && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 shrink-0">
            {group.members.reduce((sum, m) => sum + (m.keys?.length ?? 0), 0)} Key
          </span>
        )}
        {group.category && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 shrink-0">{group.category}</span>
        )}
        {group.defaultModel && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary shrink-0">默认: {group.defaultModel}</span>
        )}
        {!group.active && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 shrink-0">已停用</span>
        )}
        {missing > 0 && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 shrink-0">{missing} 引用失效</span>
        )}
        {isActiveGroup && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 shrink-0">当前生效</span>
        )}
      </div>
      {group.description && (
        <div className="text-xs text-text-tertiary mt-1">{group.description}</div>
      )}
      <div className="text-xs text-text-tertiary truncate mt-1">
        {memberNames.join(' → ') || '（空分组）'}
      </div>
      <div className="flex items-center gap-1 mt-2 shrink-0">
        <button
          onClick={() => onSetActive(group.id)}
          title="设为当前生效分组"
          disabled={isActiveGroup}
          className="p-1 text-text-tertiary hover:text-green-400 transition-colors disabled:opacity-40"
        >
          <Check size={14} />
        </button>
        {onTestConnection && (
          <button
            onClick={() => onTestConnection(group)}
            className="p-1 text-text-tertiary hover:text-blue-400 transition-colors"
            title="测试组内所有成员连接"
            disabled={isTesting || missing > 0}
          >
            {isTesting ? <Loader2 size={14} className="animate-spin" /> : <TestTube size={14} />}
          </button>
        )}
        <button
          onClick={() => onEdit(group)}
          className="p-1 text-text-tertiary hover:text-primary transition-colors"
          title="编辑分组"
        >
          <Pencil size={14} />
        </button>
        <button
          onClick={() => onDelete(group.id)}
          className="p-1 text-text-tertiary hover:text-red-500 transition-colors"
          title="删除分组"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}

// ---------- 分组编辑器弹层 ----------

function ProviderGroupEditorModal({
  initialGroup,
  profiles,
  onSave,
  onClose,
  allEngines,
}: {
  initialGroup: ProviderGroup | null
  profiles: ModelProfile[]
  onSave: (form: GroupForm) => void
  onClose: () => void
  allEngines: string[]
}) {
  const editing = Boolean(initialGroup?.id)
  const [form, setForm] = useState<GroupForm>(() => {
    if (!initialGroup) {
      return {
        id: generateGroupId(),
        name: '',
        strategy: 'failover',
        defaultModel: '',
        targetEngines: [],
        description: '',
        category: '',
        members: [],
        failoverOn: DEFAULT_FAILOVER_PATTERNS.map(patternToForm),
        firstTokenTimeoutSecs: '',
        maxFailoverAttempts: '3',
        active: true,
      }
    }
    return {
      id: initialGroup.id,
      name: initialGroup.name,
      strategy: initialGroup.strategy,
      defaultModel: initialGroup.defaultModel ?? '',
      targetEngines: [...(initialGroup.targetEngines ?? [])],
      description: initialGroup.description ?? '',
      category: initialGroup.category ?? '',
      members: initialGroup.members.map((m) => ({
        profileId: m.profileId,
        priority: String(m.priority),
        weight: String(m.weight),
        keys: [...(m.keys ?? [])],
        keyStrategy: m.keyStrategy ?? 'roundrobin',
      })),
      failoverOn: (initialGroup.failoverOn?.length
        ? initialGroup.failoverOn
        : DEFAULT_FAILOVER_PATTERNS
      ).map(patternToForm),
      firstTokenTimeoutSecs: initialGroup.firstTokenTimeoutSecs != null ? String(initialGroup.firstTokenTimeoutSecs) : '',
      maxFailoverAttempts: String(initialGroup.maxFailoverAttempts ?? 3),
      active: initialGroup.active,
    }
  })
  const patch = (p: Partial<GroupForm>) => setForm((prev) => ({ ...prev, ...p }))

  // 组内模型并集（用于默认模型下拉选项）
  const groupModelUnion = useMemo(() => {
    const profileIds = new Set(form.members.map((m) => m.profileId).filter(Boolean))
    const modelSet = new Set<string>()
    profiles.forEach((p) => {
      if (profileIds.has(p.id)) {
        const options = (p.modelOptions?.length ? p.modelOptions : [p.model]).filter(Boolean)
        options.forEach((m) => modelSet.add(m))
      }
    })
    return Array.from(modelSet)
  }, [form.members, profiles])

  const canSubmit = form.name.trim().length > 0 && form.members.some((m) => m.profileId)

  // 成员操作
  const updateMember = (idx: number, p: Partial<MemberFormItem>) =>
    patch({ members: form.members.map((m, i) => (i === idx ? { ...m, ...p } : m)) })
  const addMember = () => {
    const used = new Set(form.members.map((m) => m.profileId))
    const firstFree = profiles.find((p) => !used.has(p.id))
    patch({ members: [...form.members, { profileId: firstFree?.id ?? '', priority: '0', weight: '1', keys: [], keyStrategy: 'roundrobin' }] })
  }
  const removeMember = (idx: number) => patch({ members: form.members.filter((_, i) => i !== idx) })

  // failover 模式操作
  const updatePattern = (idx: number, p: Partial<FailoverPatternFormItem>) =>
    patch({ failoverOn: form.failoverOn.map((m, i) => (i === idx ? { ...m, ...p } : m)) })
  const addPattern = () => patch({ failoverOn: [...form.failoverOn, { kind: 'HttpStatus', code: '429' }] })
  const removePattern = (idx: number) => patch({ failoverOn: form.failoverOn.filter((_, i) => i !== idx) })

  const fieldClass =
    'w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg outline-none focus:border-primary'
  const labelClass = 'block text-xs text-text-secondary mb-1'
  const sectionClass = 'space-y-3 p-3 bg-background-surface rounded-lg border border-border'
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
          <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
            <Route size={16} className="text-primary" />
            {editing ? '编辑供应商分组' : '新建供应商分组'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* 表单主体 */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* 基础信息 */}
          <div className={sectionClass}>
            <div className={sectionTitleClass}>基础信息</div>
            <div>
              <label className={labelClass}>分组名称</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="如：主备切换 / 负载均衡"
                className={fieldClass}
              />
            </div>
            <div>
              <label className={labelClass}>路由策略</label>
              <select
                value={form.strategy}
                onChange={(e) => patch({ strategy: e.target.value as RouteStrategy })}
                className={fieldClass}
              >
                <option value="failover">Failover — 主备切换（priority 小优先）</option>
                <option value="roundrobin">RoundRobin — 轮询（新会话轮转）</option>
                <option value="weighted">Weighted — 加权随机（按 weight）</option>
              </select>
            </div>
            <div>
              <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) => patch({ active: e.target.checked })}
                  className="accent-primary"
                />
                启用此分组
              </label>
            </div>
            {/* 默认模型 */}
            <div>
              <label className={labelClass}>默认模型（可选）</label>
              <select
                value={form.defaultModel}
                onChange={(e) => patch({ defaultModel: e.target.value })}
                className={fieldClass}
              >
                <option value="">— 不设置，用户需手动选择 —</option>
                {groupModelUnion.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <p className="text-[11px] text-text-tertiary mt-1">
                选项来自组内所有 Profile 的 modelOptions 并集。切换分组路由时自动选中此项。
              </p>
            </div>
            {/* 适用引擎 */}
            <div>
              <label className={labelClass}>适用引擎（多选，空 = 全部引擎）</label>
              <div className="grid grid-cols-2 gap-2">
                {allEngines.map((engineOption) => (
                  <button
                    key={engineOption}
                    type="button"
                    onClick={() => {
                      const selected = form.targetEngines.includes(engineOption)
                      patch({
                        targetEngines: selected
                          ? form.targetEngines.filter((e) => e !== engineOption)
                          : [...form.targetEngines, engineOption],
                      })
                    }}
                    className={`px-3 py-1.5 text-xs rounded-md border transition-all ${
                      form.targetEngines.includes(engineOption)
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-background-surface text-text-tertiary hover:border-primary/30'
                    }`}
                  >
                    {ALL_ENGINES.includes(engineOption)
                      ? engineOption === 'claude' ? 'Claude'
                        : engineOption === 'codex' ? 'Codex'
                          : engineOption === 'simple-ai' ? 'SimpleAI'
                            : engineOption === 'pi' ? 'Pi'
                              : engineOption
                      : getEngineDisplayName(engineOption)}
                  </button>
                ))}
              </div>
              {form.targetEngines.length === 0 && (
                <p className="text-[11px] text-text-tertiary mt-1">未选择时适用于所有引擎。</p>
              )}
            </div>
            {/* 描述 */}
            <div>
              <label className={labelClass}>描述（可选）</label>
              <input
                type="text"
                value={form.description}
                onChange={(e) => patch({ description: e.target.value })}
                placeholder="如：主备切换至 Azure / GCP"
                className={fieldClass}
              />
            </div>
            {/* 分类 */}
            <div>
              <label className={labelClass}>分类标签（可选）</label>
              <select
                value={form.category}
                onChange={(e) => patch({ category: e.target.value })}
                className={fieldClass}
              >
                <option value="">— 不设置 —</option>
                <option value="official">官方</option>
                <option value="cn_official">国内官方</option>
                <option value="aggregator">聚合平台</option>
                <option value="third_party">第三方</option>
                <option value="custom">自定义</option>
              </select>
            </div>
          </div>

          {/* 分组成员 */}
          <div className={sectionClass}>
            <div className={`${sectionTitleClass} flex items-center gap-1.5`}>
              <Layers size={12} />
              分组成员
            </div>
            <div className="space-y-3">
              {form.members.map((m, idx) => (
                <div key={idx} className="border border-border rounded-lg p-2.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <select
                      value={m.profileId}
                      onChange={(e) => updateMember(idx, { profileId: e.target.value })}
                      className="flex-1 min-w-0 px-2.5 py-1.5 text-xs bg-background-surface border border-border rounded-md outline-none focus:border-primary"
                    >
                      <option value="">— 选择 Profile —</option>
                      {profiles.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}（{p.model}）</option>
                      ))}
                    </select>
                    {form.strategy === 'failover' && (
                      <input
                        type="number"
                        min={0}
                        value={m.priority}
                        onChange={(e) => updateMember(idx, { priority: e.target.value })}
                        title="优先级（数字小优先）"
                        className="w-16 px-2 py-1.5 text-xs font-mono bg-background-surface border border-border rounded-md outline-none focus:border-primary"
                      />
                    )}
                    {form.strategy === 'weighted' && (
                      <input
                        type="number"
                        min={1}
                        value={m.weight}
                        onChange={(e) => updateMember(idx, { weight: e.target.value })}
                        title="权重"
                        className="w-16 px-2 py-1.5 text-xs font-mono bg-background-surface border border-border rounded-md outline-none focus:border-primary"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => removeMember(idx)}
                      className="p-1 text-text-tertiary hover:text-red-500 transition-colors shrink-0"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {/* 多 Key 配置（可折叠） */}
                  <div className="pl-1">
                    <div className="flex items-center gap-2 mb-1.5">
                      <KeyRound size={12} className="text-text-tertiary shrink-0" />
                      <span className="text-[11px] text-text-tertiary">多 Key 配置</span>
                      {m.keys.length > 0 && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">{m.keys.length} 个 Key</span>
                      )}
                    </div>
                    {/* Key 策略 */}
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-[10px] text-text-tertiary whitespace-nowrap">Key 策略:</span>
                      <select
                        value={m.keyStrategy}
                        onChange={(e) => updateMember(idx, { keyStrategy: e.target.value as RouteStrategy })}
                        className="flex-1 min-w-0 px-2 py-1 text-[10px] bg-background-surface border border-border rounded-md outline-none focus:border-primary"
                      >
                        <option value="roundrobin">RoundRobin — 轮转</option>
                        <option value="failover">Failover — 顺序，失败换下一个</option>
                        <option value="weighted">Weighted — 等权随机</option>
                      </select>
                    </div>
                    {/* Key 列表 */}
                    <div className="space-y-1">
                      {m.keys.map((key, ki) => (
                        <div key={ki} className="flex items-center gap-1">
                          <input
                            type="text"
                            value={key}
                            onChange={(e) => {
                              const next = [...m.keys]
                              next[ki] = e.target.value
                              updateMember(idx, { keys: next })
                            }}
                            placeholder="sk-..."
                            className="flex-1 min-w-0 px-2 py-1 text-[11px] font-mono bg-background-surface border border-border rounded-md outline-none focus:border-primary"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const next = m.keys.filter((_, i) => i !== ki)
                              updateMember(idx, { keys: next })
                            }}
                            className="p-1 text-text-tertiary hover:text-red-500 transition-colors shrink-0"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <button
                        type="button"
                        onClick={() => updateMember(idx, { keys: [...m.keys, ''] })}
                        className="flex items-center gap-1 text-[10px] text-primary hover:text-primary-hover transition-colors"
                      >
                        <Plus size={10} />
                        添加 Key
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const paste = window.prompt('粘贴多个 Key，每行一个：')
                          if (paste) {
                            const parsed = paste.split('\n').map(s => s.trim()).filter(Boolean)
                            updateMember(idx, { keys: [...m.keys, ...parsed] })
                          }
                        }}
                        className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-primary transition-colors"
                      >
                        <Copy size={10} />
                        批量粘贴
                      </button>
                      {m.keys.length > 0 && (
                        <button
                          type="button"
                          onClick={() => updateMember(idx, { keys: [] })}
                          className="text-[10px] text-text-tertiary hover:text-red-500 transition-colors ml-auto"
                        >
                          清空
                        </button>
                      )}
                    </div>
                    {m.keys.length === 0 && (
                      <p className="text-[10px] text-text-tertiary/60 mt-0.5">不填多 Key 时使用 Profile 的 apiKey</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addMember}
              disabled={profiles.length === 0}
              className="flex items-center gap-1 text-xs text-primary hover:text-primary-hover transition-colors disabled:opacity-40"
            >
              <Plus size={12} />
              {profiles.length === 0 ? '请先在模型供应商中创建 Profile' : '添加成员'}
            </button>
            {form.members.length > 0 && form.members.every((m) => !m.profileId) && (
              <p className="text-[11px] text-text-tertiary">请为每个成员选择 Profile。</p>
            )}
          </div>

          {/* Failover 触发条件 */}
          <div className={sectionClass}>
            <div className={`${sectionTitleClass} flex items-center gap-1.5`}>
              <ShieldAlert size={12} />
              Failover 错误触发条件
            </div>
            <div className="space-y-2">
              {form.failoverOn.map((p, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <select
                    value={p.kind}
                    onChange={(e) => updatePattern(idx, { kind: e.target.value as FailoverPatternFormItem['kind'] })}
                    className="w-40 px-2 py-1.5 text-xs bg-background-surface border border-border rounded-md outline-none focus:border-primary"
                  >
                    <option value="HttpStatus">HTTP 状态码</option>
                    <option value="FirstTokenTimeout">首字超时</option>
                    <option value="ConnectionRefused">连接被拒</option>
                    <option value="StderrContains">stderr 关键词</option>
                  </select>
                  {p.kind === 'HttpStatus' && (
                    <input
                      type="number"
                      min={100}
                      max={599}
                      value={p.code ?? ''}
                      onChange={(e) => updatePattern(idx, { code: e.target.value })}
                      placeholder="如 429；500 代表 5xx 全段"
                      className="flex-1 min-w-0 px-2.5 py-1.5 text-xs font-mono bg-background-surface border border-border rounded-md outline-none focus:border-primary"
                    />
                  )}
                  {p.kind === 'StderrContains' && (
                    <input
                      type="text"
                      value={p.pattern ?? ''}
                      onChange={(e) => updatePattern(idx, { pattern: e.target.value })}
                      placeholder="如 api key invalid（不区分大小写）"
                      className="flex-1 min-w-0 px-2.5 py-1.5 text-xs bg-background-surface border border-border rounded-md outline-none focus:border-primary"
                    />
                  )}
                  {p.kind !== 'HttpStatus' && p.kind !== 'StderrContains' && (
                    <span className="flex-1 text-[11px] text-text-tertiary">
                      {p.kind === 'FirstTokenTimeout' ? 'spawn 后超过首字超时阈值仍未输出' : 'spawn 后立即崩溃 / 代理起不来'}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removePattern(idx)}
                    className="p-1 text-text-tertiary hover:text-red-500 transition-colors shrink-0"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={addPattern}
                className="flex items-center gap-1 text-xs text-primary hover:text-primary-hover transition-colors"
              >
                <Plus size={12} />
                添加触发条件
              </button>
              <button
                type="button"
                onClick={() => setForm((prev) => ({ ...prev, failoverOn: DEFAULT_FAILOVER_PATTERNS.map(patternToForm) }))}
                className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-primary transition-colors"
              >
                <RotateCcw size={12} />
                恢复默认
              </button>
            </div>
            <p className="text-[11px] text-text-tertiary">
              默认组合：401 / 403 / 429 / 5xx / 首字超时 / 连接被拒。仅“首字前失败”会透明切换。
            </p>
          </div>

          {/* 高级选项 */}
          <div className={sectionClass}>
            <div className={`${sectionTitleClass} flex items-center gap-1.5`}>
              <Clock size={12} />
              高级选项
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>首字超时（秒）</label>
                <input
                  type="number"
                  min={1}
                  value={form.firstTokenTimeoutSecs}
                  onChange={(e) => patch({ firstTokenTimeoutSecs: e.target.value })}
                  placeholder="留空 = 不检测"
                  className={fieldClass}
                />
              </div>
              <div>
                <label className={labelClass}>最大 Failover 次数</label>
                <input
                  type="number"
                  min={1}
                  value={form.maxFailoverAttempts}
                  onChange={(e) => patch({ maxFailoverAttempts: e.target.value })}
                  placeholder="默认 3"
                  className={fieldClass}
                />
              </div>
            </div>
          </div>
        </div>

        {/* 底部操作栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-border-subtle shrink-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary rounded-lg transition-colors"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => onSave(form)}
              disabled={!canSubmit}
              className="px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {editing ? '保存' : '创建'}
            </button>
          </div>
          {form.strategy === 'failover' && (
            <span className="text-[11px] text-text-tertiary hidden sm:block">数字越小优先级越高</span>
          )}
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

  // 动态引擎列表：已知引擎 + 插件引擎（来自 engineMetadataStore）
  const engineMetaIds = useEngineMetadataStore(s => s.metadatas)
  const dynamicEngineList = useMemo<ProfileTargetEngine[]>(() => {
    const known: ProfileTargetEngine[] = ['claude', 'codex', 'simple-ai', 'pi']
    // 插件引擎的 id（如 "omp"）映射为 profile 引擎名
    const pluginIds = engineMetaIds
      .filter(m => !['claude-code', 'codex', 'simple-ai', 'pi'].includes(m.id))
      .map(m => m.id as ProfileTargetEngine)
    return [...known, ...pluginIds]
  }, [engineMetaIds])

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
      if (engineFilter === 'all') {
        // 全部筛选：显示所有 Profile
      } else {
        // 按引擎筛选：用 isProfileForEngine 判断
        if (!isProfileForEngine(p, engineFilter)) return false
      }
      if (!q) return true
      return (
        p.name.toLowerCase().includes(q) ||
        p.model.toLowerCase().includes(q) ||
        p.baseUrl.toLowerCase().includes(q)
      )
    })
  }, [profiles, search, engineFilter])

  const openCreate = () => {
    setEditingProfile(null)
    setShowEditor(true)
  }

  const openEdit = (profile: ModelProfile) => {
    setEditingProfile(profile)
    setShowEditor(true)
  }

  const openDuplicate = (profile: ModelProfile) => {
    setEditingProfile({
      ...profile,
      id: '',
      name: `${profile.name} (副本)`,
      modelOptions: [...(profile.modelOptions ?? [])],
      active: false,
    })
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
      modelOptions: normalizeModelOptions(form.model, form.modelOptions, form.fetchedModels),
      wireApi: form.wireApi,
      targetEngines: form.targetEngines,
      category: form.category || undefined,
      description: form.description.trim() || undefined,
      authType: form.authType,
      apiKeyEnvName: form.apiKeyEnvName.trim() || undefined,
      customHeaders: pairsToRecord(form.customHeaders),
      customEnv: pairsToRecord(form.customEnv),
      maxTokens: parsePositiveInt(form.maxTokens),
      contextWindow: parsePositiveInt(form.contextWindow),
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
    // P0 修复：如果删除的是当前在状态栏激活的 Profile，同步清除
    const sessionConfig = useSessionConfig.getState()
    if (sessionConfig.config.modelProfileId === id) {
      sessionConfig.setModelProfileId('')
    }
    // P1: 清扫所有会话 metadata 中指向已删除 Profile 的悬空引用，
    // 避免该会话因悬空 id 遮蔽全局默认而意外回退到官方 API。
    const mgr = sessionStoreManager.getState()
    mgr.sessionMetadata.forEach((meta, sid) => {
      if (meta.modelProfileId === id) {
        mgr.updateSessionModelProfile(sid, null)
      }
    })
    syncToConfig(updated.profiles, updated.activeProfileId)
    if (editingProfile?.id === id) closeEditor()
  }

  const handleActivate = (profile: ModelProfile) => {
    const nextActiveId = activeProfileId === profile.id ? null : profile.id
    activateProfile(nextActiveId)
    // P1: 设置页激活 = 设全局默认。状态栏镜像应显示当前会话的生效值：
    // 会话有覆盖则保持覆盖，无覆盖才跟随新全局默认（避免"显示全局却发覆盖值"）。
    const activeId = sessionStoreManager.getState().activeSessionId
    const activeMeta = activeId ? sessionStoreManager.getState().sessionMetadata.get(activeId) : undefined
    // 会话明确选官方（哨兵）→ 镜像置空（保持「官方 API」显示，不被新全局默认覆盖）；
    // 有具体覆盖 → 原样；未设置 → 跟随新全局默认 nextActiveId。
    const sessionOverride = activeMeta?.modelProfileId
    const mirror = sessionOverride === OFFICIAL_API_PROFILE
      ? ''
      : (sessionOverride ?? nextActiveId ?? '')
    useSessionConfig.getState().setModelProfileId(mirror)
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

  // ===== 供应商分组状态 =====
  const [groupsExpanded, setGroupsExpanded] = useState(true)
  const [showGroupEditor, setShowGroupEditor] = useState(false)
  const [editingGroup, setEditingGroup] = useState<ProviderGroup | null>(null)
  const [testingGroupId, setTestingGroupId] = useState<string | null>(null)

  // 从 config 读取分组列表与激活分组
  const providerGroups = config.providerGroups || []
  const activeGroupId = config.activeProviderGroupId

  const openCreateGroup = () => {
    setEditingGroup(null)
    setShowGroupEditor(true)
  }

  const openEditGroup = (group: ProviderGroup) => {
    setEditingGroup(group)
    setShowGroupEditor(true)
  }

  const closeGroupEditor = () => {
    setShowGroupEditor(false)
    setEditingGroup(null)
  }

  // 保存分组（新建或更新）
  const handleSaveGroup = (form: GroupForm) => {
    const failoverOn = form.failoverOn
      .map(formToPattern)
      .filter((p): p is FailoverPattern => p !== null)
    const group: ProviderGroup = {
      id: form.id,
      name: form.name.trim(),
      strategy: form.strategy,
      defaultModel: form.defaultModel || undefined,
      targetEngines: form.targetEngines.length > 0 ? form.targetEngines : undefined,
      description: form.description.trim() || undefined,
      category: form.category || undefined,
      members: form.members
        .filter((m) => m.profileId)
        .map((m) => ({
          profileId: m.profileId,
          priority: parseInt(m.priority || '0', 10),
          weight: parseInt(m.weight || '1', 10),
          keys: m.keys.length > 0 ? m.keys.filter(k => k.trim().length > 0) : undefined,
          keyStrategy: m.keys.length > 0 ? m.keyStrategy : undefined,
        })),
      failoverOn,
      firstTokenTimeoutSecs: form.firstTokenTimeoutSecs ? parseInt(form.firstTokenTimeoutSecs, 10) : undefined,
      maxFailoverAttempts: parseInt(form.maxFailoverAttempts || '3', 10),
      active: form.active,
    }
    const existing = providerGroups.some((g) => g.id === group.id)
    const nextGroups = existing
      ? providerGroups.map((g) => (g.id === group.id ? group : g))
      : [...providerGroups, group]
    onConfigChange({ ...config, providerGroups: nextGroups })
    success('供应商分组', existing ? '分组已更新' : '分组已创建')
    closeGroupEditor()
  }

  const handleDeleteGroup = (id: string) => {
    const nextGroups = providerGroups.filter((g) => g.id !== id)
    onConfigChange({
      ...config,
      providerGroups: nextGroups,
      // 删除的是当前生效分组 → 清除激活，回退单 Profile 路径
      activeProviderGroupId: activeGroupId === id ? undefined : activeGroupId,
    })
    // 若删除的是当前生效分组，同步切离「分组路由」模式（否则残留 group 模式，
    // 新会话仍会尝试走分组但无可用分组 → 后端回退官方并记录 OfficialFallback 日志）。
    if (activeGroupId === id) {
      useSessionConfig.getState().setProfileMode('profile')
    }
  }

  const handleSetActiveGroup = (id: string) => {
    onConfigChange({ ...config, activeProviderGroupId: id })
    // 关键联动：激活分组 = 全局默认启用「分组路由」模式。
    // 否则前端 profileMode 保持默认 'profile'，若存在全局激活单 Profile，
    // modelProfileId 会被传入后端短路分组，分组永远不会生效。
    useSessionConfig.getState().setProfileMode('group')
    // 同步清理状态栏镜像的单 Profile（group 模式不绑定单 Profile）
    useSessionConfig.getState().setModelProfileId('')
  }

  // 分组连接测试：逐一对组内成员测试连接，汇总结果
  const handleTestGroupConnection = useCallback(async (group: ProviderGroup) => {
    setTestingGroupId(group.id)
    const results: { name: string; ok: boolean; detail?: string }[] = []
    for (const member of group.members) {
      const profile = profiles.find((p) => p.id === member.profileId)
      if (!profile) {
        results.push({ name: member.profileId, ok: false, detail: 'Profile 已删除' })
        continue
      }
      try {
        const result = await testModelProfileConnection(profile)
        results.push({ name: profile.name, ok: result.ok, detail: result.detail })
      } catch (err) {
        results.push({ name: profile.name, ok: false, detail: err instanceof Error ? err.message : String(err) })
      }
    }
    const okCount = results.filter((r) => r.ok).length
    const total = results.length
    if (okCount === total) {
      success('供应商分组', `${group.name}：${total}/${total} 成员连接成功`)
    } else {
      const failDetails = results
        .filter((r) => !r.ok)
        .map((r) => `${r.name}：${r.detail || '未知错误'}`)
        .join('；')
      toastError('供应商分组', `${group.name}：${okCount}/${total} 成功，失败：${failDetails}`)
    }
    setTestingGroupId(null)
  }, [profiles, success, toastError])

  return (
    <div className="space-y-4">
      {/* 说明 */}
      <p className="text-xs text-text-secondary">{t('modelProfile.tabDescription')}</p>

      {/* 工具栏 */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        {/* 添加按钮 */}
        <button
          onClick={() => openCreate()}
          className="flex items-center gap-1.5 px-3 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors shrink-0"
        >
          <Plus size={14} />
          {t('modelProfile.add')}
        </button>

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
        <div className="flex flex-wrap gap-1 shrink-0">
          {(['all', 'claude', 'codex', 'simple-ai', 'pi'] as EngineFilter[]).concat(
  dynamicEngineList.filter(e => !['claude', 'codex', 'simple-ai', 'pi'].includes(e))
).map((f) => (
            <button
              key={f}
              onClick={() => setEngineFilter(f)}
              className={`px-3 py-2 text-xs rounded-lg border transition-all ${
                engineFilter === f
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-surface text-text-tertiary hover:border-primary/30'
              }`}
            >
              {f === 'all'
                ? t('modelProfile.filter.all')
                : ALL_ENGINES.includes(f)
                  ? t(`modelProfile.filter.${f}`)
                  : getEngineDisplayName(f)}
            </button>
          ))}
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
              onDuplicate={openDuplicate}
              onDelete={handleDelete}
              onTestConnection={handleTestConnection}
            />
          ))}
        </div>
      )}

      {/* ===== 供应商分组配置 ===== */}
      <div className="rounded-lg border border-border-subtle overflow-hidden">
        {/* 折叠标题栏 */}
        <button
          onClick={() => setGroupsExpanded((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-2.5 bg-surface text-sm hover:bg-surface/70 transition-colors"
        >
          <Route size={14} className="text-primary shrink-0" />
          <span className="text-text-primary font-medium">供应商分组路由</span>
          <span className="text-xs text-text-tertiary">{providerGroups.length} 个分组</span>
          {activeGroupId && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400">
              已启用
            </span>
          )}
          <span className="ml-auto text-text-tertiary">
            {groupsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </span>
        </button>

        {groupsExpanded && (
          <div className="p-3 space-y-3">
            {/* 说明 */}
            <p className="text-xs text-text-tertiary">
              供应商分组路由可将多个模型 Profile 组合为 Failover、RoundRobin 或 Weighted 策略组。
              激活分组后，新会话将通过分组路由自动选择 Profile。日志可在「路由日志」面板中查看。
            </p>
            <p className="text-xs text-text-tertiary bg-primary/5 border border-primary/10 rounded-md px-2 py-1.5">
              会话状态栏「模型供应商」选择器中选中「分组路由」即可启用本组；
              未显式选择时，新会话默认跟随下方激活的全局分组。
            </p>

            {/* 分组列表 */}
            {providerGroups.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 text-center">
                <Route size={24} className="text-text-muted mb-2" />
                <p className="text-xs text-text-tertiary">暂无供应商分组。请先创建至少一个模型 Profile，再组合为分组。</p>
              </div>
            ) : (
              <div className="space-y-2">
                {providerGroups.map((group) => (
                  <ProviderGroupCard
                    key={group.id}
                    group={group}
                    isActiveGroup={activeGroupId === group.id}
                    profiles={profiles}
                    onEdit={openEditGroup}
                    onDelete={handleDeleteGroup}
                    onSetActive={handleSetActiveGroup}
                    onTestConnection={handleTestGroupConnection}
                    isTesting={testingGroupId === group.id}
                  />
                ))}
              </div>
            )}

            {/* 新建分组按钮 */}
            <button
              onClick={openCreateGroup}
              disabled={profiles.length === 0}
              className="flex items-center gap-1.5 px-3 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors shrink-0 disabled:opacity-50"
            >
              <Plus size={14} />
              新建分组
            </button>
          </div>
        )}
      </div>

      {/* 编辑器弹层 */}
      {showEditor && (
        <ProfileEditorModal
          key={editingProfile?.id || 'new'}
          initialProfile={editingProfile}
          onSave={handleSave}
          onClose={closeEditor}
          allEngines={dynamicEngineList}
        />
      )}

      {/* 分组编辑器弹层 */}
      {showGroupEditor && (
        <ProviderGroupEditorModal
          key={editingGroup?.id || 'new'}
          initialGroup={editingGroup}
          profiles={profiles}
          onSave={handleSaveGroup}
          onClose={closeGroupEditor}
          allEngines={dynamicEngineList}
        />
      )}
    </div>
  )
}
