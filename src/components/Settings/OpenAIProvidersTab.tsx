/**
 * OpenAI Providers 配置组件
 *
 * 用于管理多个 OpenAI 兼容的 API Provider
 *
 * @author Polaris Team
 * @since 2025-03-11
 */

import { useState } from 'react'
import type { Config, OpenAIProvider, EngineId } from '../../types'
import { clsx } from 'clsx'

interface OpenAIProvidersTabProps {
  config: Config
  onConfigChange: (config: Config) => void
  loading: boolean
}

export function OpenAIProvidersTab({ config, onConfigChange, loading }: OpenAIProvidersTabProps) {
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Map<string, boolean>>(new Map())

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

    try {
      const response = await fetch(`${provider.apiBase.replace(/\/$/, '')}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${provider.apiKey}`,
        },
        signal: AbortSignal.timeout(10000), // 10 秒超时
      })

      const success = response.ok
      setTestResults(prev => new Map(prev).set(provider.id, success))

      return success
    } catch (error) {
      console.error(`Test connection failed for ${provider.name}:`, error)
      setTestResults(prev => new Map(prev).set(provider.id, false))
      return false
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
      enabled: false, // 默认禁用复制的 Provider
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
        配置多个 OpenAI 协议兼容的 API 服务。支持 OpenAI 官方、DeepSeek、Ollama 本地等。
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
        <span className="text-sm">添加 OpenAI Provider</span>
      </button>
    </div>
  )
}

/**
 * Provider 卡片组件
 */
interface ProviderCardProps {
  provider: OpenAIProvider
  isActive: boolean
  isTesting: boolean
  testResult?: boolean
  disabled: boolean
  onUpdate: (updates: Partial<OpenAIProvider>) => void
  onRemove: () => void
  onDuplicate: () => void
  onTest: () => Promise<boolean>
  onSelectActive: () => void
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
}: ProviderCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  return (
    <div
      className={clsx(
        "border rounded-lg overflow-hidden transition-all",
        isActive ? "border-primary bg-primary/5" : "border-border-subtle"
      )}
    >
      {/* 头部 */}
      <div className="flex items-center justify-between p-4 bg-surface">
        <div className="flex items-center gap-3 flex-1">
          {/* 启用开关 */}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={provider.enabled}
              onChange={(e) => onUpdate({ enabled: e.target.checked })}
              disabled={disabled}
              className="w-4 h-4"
            />
            <span className="text-sm text-text-secondary">启用</span>
          </label>

          {/* Provider 名称 */}
          <input
            type="text"
            value={provider.name}
            onChange={(e) => onUpdate({ name: e.target.value })}
            disabled={disabled}
            placeholder="Provider 名称"
            className={clsx(
              "flex-1 px-3 py-1.5 rounded border bg-background text-sm",
              isActive ? "border-primary" : "border-border-subtle focus:border-primary"
            )}
          />

          {/* 状态指示 */}
          {testResult === true && (
            <span className="text-success text-xs">✓ 连接成功</span>
          )}
          {testResult === false && (
            <span className="text-error text-xs">✗ 连接失败</span>
          )}
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-2">
          {/* 设为当前 */}
          {!isActive && provider.enabled && (
            <button
              onClick={onSelectActive}
              disabled={disabled}
              className="px-3 py-1 text-xs rounded border border-primary text-primary hover:bg-primary/10"
            >
              设为当前
            </button>
          )}

          {isActive && (
            <span className="px-3 py-1 text-xs rounded bg-primary text-white">
              当前
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

      {/* 展开配置 */}
      {isExpanded && (
        <div className="p-4 space-y-3 border-t border-border-subtle">
          {/* API Key */}
          <div>
            <label className="block text-xs text-text-secondary mb-1">API Key</label>
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
            <label className="block text-xs text-text-secondary mb-1">API Base URL</label>
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
            <label className="block text-xs text-text-secondary mb-1">模型名称</label>
            <input
              type="text"
              value={provider.model}
              onChange={(e) => onUpdate({ model: e.target.value })}
              disabled={disabled}
              placeholder="gpt-4o-mini"
              className="w-full px-3 py-2 rounded border border-border bg-background text-sm"
            />
            <p className="text-xs text-text-tertiary mt-1">
              完全由您决定，可以是任意模型名称
            </p>
          </div>

          {/* 温度和 Token 数 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-secondary mb-1">温度 (0-2)</label>
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
              <label className="block text-xs text-text-secondary mb-1">最大 Token 数</label>
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
                {isTesting ? '测试中...' : '测试连接'}
              </button>

              <button
                onClick={onDuplicate}
                disabled={disabled}
                className="px-4 py-2 text-sm rounded border border-border hover:bg-background-hover"
              >
                复制
              </button>
            </div>

            <button
              onClick={onRemove}
              disabled={disabled}
              className="px-4 py-2 text-sm rounded border border-danger/30 text-danger hover:bg-danger/10"
            >
              删除
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
