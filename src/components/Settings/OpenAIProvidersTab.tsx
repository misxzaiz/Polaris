/**
 * OpenAI Providers 配置组件
 *
 * 用于管理多个 OpenAI 兼容的 API Provider
 *
 * @author Polaris Team
 * @since 2025-03-11
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Config, OpenAIProvider, EngineId } from '../../types'
import { clsx } from 'clsx'

/** 测试连接结果 */
interface TestResult {
  success: boolean
  latency?: number
  errorMessage?: string
  modelAvailable?: boolean
}

interface OpenAIProvidersTabProps {
  config: Config
  onConfigChange: (config: Config) => void
  loading: boolean
}

export function OpenAIProvidersTab({ config, onConfigChange, loading }: OpenAIProvidersTabProps) {
  const { t } = useTranslation('settings')
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Map<string, TestResult>>(new Map())

  const providers = config.openaiProviders || []
  const activeProviderId = config.activeProviderId

  // 添加新 Provider
  const addProvider = () => {
    const newProvider: OpenAIProvider = {
      id: `provider-${Date.now()}`,
      name: 'New Provider',
      apiKey: '',
      apiBase: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      temperature: 0.7,
      maxTokens: 8192,
      enabled: true,
      supportsTools: true,
    }
    onConfigChange({
      ...config,
      openaiProviders: [...providers, newProvider]
    })
  }

  // 删除 Provider
  const removeProvider = (id: string) => {
    const updatedProviders = providers.filter(p => p.id !== id)

    onConfigChange({
      ...config,
      openaiProviders: updatedProviders,
      activeProviderId: activeProviderId === id ? undefined : activeProviderId
    })

    // 清除测试结果
    setTestResults(prev => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }

  // 更新 Provider
  const updateProvider = (id: string, updates: Partial<OpenAIProvider>) => {
    onConfigChange({
      ...config,
      openaiProviders: providers.map(p => p.id === id ? { ...p, ...updates } : p)
    })
  }

  // 测试连接
  const testConnection = async (provider: OpenAIProvider) => {
    setTestingProviderId(provider.id)

    const startTime = Date.now()
    const baseUrl = provider.apiBase.replace(/\/$/, '')

    try {
      const response = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${provider.apiKey}`,
        },
        signal: AbortSignal.timeout(10000),
      })

      const latency = Date.now() - startTime

      if (!response.ok) {
        const errorMessage = getErrorMessage(response.status, t)
        setTestResults(prev => new Map(prev).set(provider.id, {
          success: false,
          latency,
          errorMessage,
        }))
        return
      }

      // 检查模型是否在列表中
      let modelAvailable = false
      try {
        const data = await response.json()
        const modelList: string[] = data?.data?.map((m: { id: string }) => m.id) ?? []
        modelAvailable = modelList.includes(provider.model)
      } catch {
        // 无法解析模型列表，忽略（某些提供商可能不支持 /models）
        modelAvailable = true
      }

      setTestResults(prev => new Map(prev).set(provider.id, {
        success: true,
        latency,
        modelAvailable,
      }))
    } catch (error) {
      const latency = Date.now() - startTime
      const errorMessage = error instanceof TypeError
        ? t('openaiProviders.errorNetwork')
        : t('openaiProviders.errorUnknown', { message: error instanceof Error ? error.message : String(error) })

      setTestResults(prev => new Map(prev).set(provider.id, {
        success: false,
        latency,
        errorMessage,
      }))
    } finally {
      setTestingProviderId(null)
    }
  }

  // 复制 Provider
  const duplicateProvider = (provider: OpenAIProvider) => {
    const duplicated: OpenAIProvider = {
      ...provider,
      id: `provider-${Date.now()}`,
      name: `${provider.name} (Copy)`,
      enabled: false,
    }
    onConfigChange({
      ...config,
      openaiProviders: [...providers, duplicated]
    })
  }

  // 设为当前活跃 Provider
  const setActiveProvider = (id: string) => {
    onConfigChange({
      ...config,
      activeProviderId: id,
      defaultEngine: id as EngineId
    })
  }

  return (
    <div className="space-y-4">
      {/* 说明 */}
      <p className="text-sm text-text-secondary mb-4">
        {t('openaiProviders.description')}
      </p>

      {/* Provider 列表 */}
      <div className="space-y-3">
        {providers.map(provider => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            isActive={provider.id === activeProviderId}
            isTesting={testingProviderId === provider.id}
            testResult={testResults.get(provider.id)}
            disabled={loading}
            onUpdate={(updates) => updateProvider(provider.id, updates)}
            onRemove={() => removeProvider(provider.id)}
            onDuplicate={() => duplicateProvider(provider)}
            onTest={() => testConnection(provider)}
            onSelectActive={() => setActiveProvider(provider.id)}
            onDismissResult={() => {
              setTestResults(prev => {
                const next = new Map(prev)
                next.delete(provider.id)
                return next
              })
            }}
          />
        ))}
      </div>

      {/* 添加按钮 */}
      <button
        onClick={addProvider}
        disabled={loading}
        className="w-full text-left p-4 rounded-lg border-2 border-dashed border-border-subtle text-text-tertiary hover:border-primary/50 hover:text-primary transition-all flex items-center justify-center gap-2"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
        <span className="text-sm">{t('openaiProviders.addProvider')}</span>
      </button>
    </div>
  )
}

/** 根据 HTTP 状态码返回错误提示 */
function getErrorMessage(status: number, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (status === 401 || status === 403) return t('openaiProviders.errorAuth')
  if (status === 404) return t('openaiProviders.errorModel')
  if (status >= 500) return t('openaiProviders.errorNetwork')
  return t('openaiProviders.errorUnknown', { message: `HTTP ${status}` })
}

/**
 * Provider 卡片组件
 */
interface ProviderCardProps {
  provider: OpenAIProvider
  isActive: boolean
  isTesting: boolean
  testResult?: TestResult
  disabled: boolean
  onUpdate: (updates: Partial<OpenAIProvider>) => void
  onRemove: () => void
  onDuplicate: () => void
  onTest: () => Promise<void>
  onSelectActive: () => void
  onDismissResult: () => void
}

function ProviderCard({
  provider,
  isActive,
  isTesting,
  testResult,
  disabled,
  onUpdate,
  onRemove,
  onDuplicate,
  onTest,
  onSelectActive,
  onDismissResult,
}: ProviderCardProps) {
  const { t } = useTranslation('settings')
  const [isExpanded, setIsExpanded] = useState(false)

  // 状态圆点样式
  const statusDotClass = clsx(
    "w-2 h-2 rounded-full flex-shrink-0",
    isTesting && "bg-yellow-500 animate-pulse",
    !isTesting && testResult?.success && "bg-green-500",
    !isTesting && testResult && !testResult.success && "bg-red-500",
    !isTesting && !testResult && "bg-gray-400"
  )

  return (
    <div
      className={clsx(
        "border rounded-lg overflow-hidden transition-all",
        isActive ? "border-primary bg-primary/5" : "border-border-subtle"
      )}
    >
      {/* 头部 */}
      <div className="flex items-center justify-between p-4 bg-surface">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {/* 状态圆点 */}
          <div className={statusDotClass} title={
            isTesting ? t('openaiProviders.testing') :
            testResult?.success ? t('openaiProviders.testSuccess', { model: provider.model, latency: testResult.latency }) :
            testResult ? t('openaiProviders.testFailed') : ''
          } />

          {/* 启用开关 */}
          <label className="flex items-center gap-2 flex-shrink-0">
            <input
              type="checkbox"
              checked={provider.enabled}
              onChange={(e) => onUpdate({ enabled: e.target.checked })}
              disabled={disabled}
              className="w-4 h-4"
            />
            <span className="text-sm text-text-secondary">{t('openaiProviders.enable')}</span>
          </label>

          {/* Provider 名称 */}
          <input
            type="text"
            value={provider.name}
            onChange={(e) => onUpdate({ name: e.target.value })}
            disabled={disabled}
            placeholder={t('openaiProviders.setName')}
            className={clsx(
              "flex-1 min-w-0 px-3 py-1.5 rounded border bg-background text-sm",
              isActive ? "border-primary" : "border-border-subtle focus:border-primary"
            )}
          />

          {/* 模型名 */}
          <span className="text-xs text-text-tertiary flex-shrink-0">{provider.model}</span>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
          {/* 设为当前 */}
          {!isActive && provider.enabled && (
            <button
              onClick={onSelectActive}
              disabled={disabled}
              className="px-3 py-1 text-xs rounded border border-primary text-primary hover:bg-primary/10"
            >
              {t('openaiProviders.setActive')}
            </button>
          )}

          {isActive && (
            <span className="px-3 py-1 text-xs rounded bg-primary text-white">
              {t('openaiProviders.current')}
            </span>
          )}

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 text-text-muted hover:text-text transition-colors"
          >
            <svg className={clsx("w-4 h-4 transition-transform", isExpanded && "rotate-180")} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>

      {/* 测试结果横幅 */}
      {testResult && !isTesting && (
        <div className={clsx(
          "px-4 py-2 text-xs flex items-center justify-between border-t",
          testResult.success
            ? "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20"
            : "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20"
        )}>
          <span>
            {testResult.success ? (
              testResult.modelAvailable
                ? t('openaiProviders.testSuccess', { model: provider.model, latency: testResult.latency })
                : t('openaiProviders.testSuccessModelNotFound', { model: provider.model, latency: testResult.latency })
            ) : (
              <>
                {t('openaiProviders.testFailed')}
                {testResult.errorMessage && ` · ${testResult.errorMessage}`}
              </>
            )}
          </span>
          <button
            onClick={onDismissResult}
            className="ml-2 opacity-60 hover:opacity-100 transition-opacity"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* 展开配置 */}
      {isExpanded && (
        <div className="p-4 space-y-3 border-t border-border-subtle">
          {/* API Key */}
          <div>
            <label className="block text-xs text-text-secondary mb-1">{t('openaiProviders.apiKey')}</label>
            <input
              type="password"
              value={provider.apiKey}
              onChange={(e) => onUpdate({ apiKey: e.target.value })}
              disabled={disabled}
              placeholder="sk-..."
              className="w-full px-3 py-2 rounded border border-border bg-background text-sm"
            />
          </div>

          {/* API Base URL */}
          <div>
            <label className="block text-xs text-text-secondary mb-1">{t('openaiProviders.apiBase')}</label>
            <input
              type="text"
              value={provider.apiBase}
              onChange={(e) => onUpdate({ apiBase: e.target.value })}
              disabled={disabled}
              placeholder="https://api.openai.com/v1"
              className="w-full px-3 py-2 rounded border border-border bg-background text-sm"
            />
          </div>

          {/* 模型名称 */}
          <div>
            <label className="block text-xs text-text-secondary mb-1">{t('openaiProviders.modelName')}</label>
            <input
              type="text"
              value={provider.model}
              onChange={(e) => onUpdate({ model: e.target.value })}
              disabled={disabled}
              placeholder="gpt-4o-mini"
              className="w-full px-3 py-2 rounded border border-border bg-background text-sm"
            />
            <p className="text-xs text-text-tertiary mt-1">
              {t('openaiProviders.modelNameHint')}
            </p>
          </div>

          {/* 温度和 Token 数 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-secondary mb-1">{t('openaiProviders.temperature')}</label>
              <input
                type="number"
                min="0"
                max="2"
                step="0.1"
                value={provider.temperature}
                onChange={(e) => onUpdate({ temperature: parseFloat(e.target.value) })}
                disabled={disabled}
                className="w-full px-3 py-2 rounded border border-border bg-background text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">{t('openaiProviders.maxTokens')}</label>
              <input
                type="number"
                min="1"
                value={provider.maxTokens}
                onChange={(e) => onUpdate({ maxTokens: parseInt(e.target.value) })}
                disabled={disabled}
                className="w-full px-3 py-2 rounded border border-border bg-background text-sm"
              />
            </div>
          </div>

          {/* 操作按钮 */}
          <div className="flex justify-between items-center pt-2">
            <div className="flex gap-2">
              <button
                onClick={onTest}
                disabled={isTesting || !provider.apiKey || disabled}
                className={clsx(
                  "px-4 py-2 text-sm rounded border",
                  isTesting
                    ? "bg-disabled text-text-muted cursor-wait"
                    : "border-primary text-primary hover:bg-primary/10"
                )}
              >
                {isTesting ? t('openaiProviders.testing') : t('openaiProviders.testConnection')}
              </button>

              <button
                onClick={onDuplicate}
                disabled={disabled}
                className="px-4 py-2 text-sm rounded border border-border hover:bg-background-hover"
              >
                {t('openaiProviders.duplicate')}
              </button>
            </div>

            <button
              onClick={onRemove}
              disabled={disabled}
              className="px-4 py-2 text-sm rounded border border-danger/30 text-danger hover:bg-danger/10"
            >
              {t('openaiProviders.remove')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
