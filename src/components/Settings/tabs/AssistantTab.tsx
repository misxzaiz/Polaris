import { useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { Config } from '../../../types'
import {
  DEFAULT_ASSISTANT_CONFIG,
  DEFAULT_SYSTEM_PROMPT_CONFIG,
  type SystemPromptMode,
} from '../../../assistant/types'
import { getDefaultSystemPrompt } from '../../../assistant/core/SystemPrompt'

interface AssistantTabProps {
  config: Config
  onConfigChange: (config: Config) => void
  loading: boolean
}

export function AssistantTab({ config, onConfigChange, loading }: AssistantTabProps) {
  const { t } = useTranslation('settings')
  const [showPreview, setShowPreview] = useState(false)

  const assistantConfig = config?.assistant || DEFAULT_ASSISTANT_CONFIG
  const systemPromptConfig = assistantConfig.systemPrompt || DEFAULT_SYSTEM_PROMPT_CONFIG

  const handleToggle = () => {
    onConfigChange({
      ...config,
      assistant: {
        ...assistantConfig,
        enabled: !assistantConfig.enabled,
      },
    } as Config)
  }

  const handleLLMConfigChange = (key: string, value: string | number) => {
    onConfigChange({
      ...config,
      assistant: {
        ...assistantConfig,
        llm: {
          ...assistantConfig.llm,
          [key]: value,
        },
      },
    } as Config)
  }

  // 系统提示词配置变更
  const handleSystemPromptChange = (key: string, value: string | boolean) => {
    onConfigChange({
      ...config,
      assistant: {
        ...assistantConfig,
        systemPrompt: {
          ...systemPromptConfig,
          [key]: value,
        },
      },
    } as Config)
  }

  // 填入默认系统提示词
  const handleFillDefaultPrompt = useCallback(() => {
    handleSystemPromptChange('customPrompt', getDefaultSystemPrompt())
  }, [])

  // 重置系统提示词配置
  const handleResetSystemPrompt = useCallback(() => {
    if (window.confirm(t('assistant.systemPromptResetConfirm', '确定要重置系统提示词配置吗？'))) {
      onConfigChange({
        ...config,
        assistant: {
          ...assistantConfig,
          systemPrompt: DEFAULT_SYSTEM_PROMPT_CONFIG,
        },
      } as Config)
    }
  }, [t, config, assistantConfig, onConfigChange])

  // 计算实际生效的系统提示词（用于预览）
  const effectivePrompt = useMemo(() => {
    if (!systemPromptConfig.enabled || !systemPromptConfig.customPrompt.trim()) {
      return getDefaultSystemPrompt()
    }
    if (systemPromptConfig.mode === 'replace') {
      return systemPromptConfig.customPrompt
    }
    // append 模式
    return `${getDefaultSystemPrompt()}\n\n${systemPromptConfig.customPrompt}`
  }, [systemPromptConfig.enabled, systemPromptConfig.mode, systemPromptConfig.customPrompt])

  // 获取模式描述
  const getModeDescription = useCallback((mode: SystemPromptMode) => {
    if (mode === 'append') {
      return t('assistant.systemPromptModeAppendDesc', '在默认提示词后追加内容，适合微调助手行为')
    }
    return t('assistant.systemPromptModeReplaceDesc', '完全替换默认提示词，适合高级用户自定义')
  }, [t])

  return (
    <div className="space-y-6">
      {/* 启用开关 */}
      <div className="flex items-center justify-between p-4 bg-background-surface rounded-lg border border-border">
        <div>
          <h3 className="text-sm font-medium text-text-primary">
            {t('assistant.enable')}
          </h3>
          <p className="text-xs text-text-secondary mt-1">
            {t('assistant.enableDescription')}
          </p>
        </div>
        <button
          onClick={handleToggle}
          disabled={loading}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            assistantConfig.enabled ? 'bg-primary' : 'bg-background-elevated'
          } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              assistantConfig.enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* LLM 配置 */}
      <div className="space-y-4 p-4 bg-background-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary">
          {t('assistant.llmConfig')}
        </h3>

        {/* Base URL */}
        <div>
          <label className="block text-xs text-text-secondary mb-1">
            {t('assistant.baseUrl')}
          </label>
          <input
            type="text"
            value={assistantConfig.llm.baseUrl}
            onChange={(e) => handleLLMConfigChange('baseUrl', e.target.value)}
            disabled={loading}
            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-primary disabled:opacity-50"
            placeholder="https://api.openai.com/v1"
          />
        </div>

        {/* API Key */}
        <div>
          <label className="block text-xs text-text-secondary mb-1">
            {t('assistant.apiKey')}
          </label>
          <input
            type="password"
            value={assistantConfig.llm.apiKey}
            onChange={(e) => handleLLMConfigChange('apiKey', e.target.value)}
            disabled={loading}
            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-primary disabled:opacity-50"
            placeholder="sk-..."
          />
        </div>

        {/* Model */}
        <div>
          <label className="block text-xs text-text-secondary mb-1">
            {t('assistant.model')}
          </label>
          <input
            type="text"
            value={assistantConfig.llm.model}
            onChange={(e) => handleLLMConfigChange('model', e.target.value)}
            disabled={loading}
            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-primary disabled:opacity-50"
            placeholder="gpt-4o"
          />
        </div>

        {/* Temperature */}
        <div>
          <label className="block text-xs text-text-secondary mb-1">
            {t('assistant.temperature')}
          </label>
          <input
            type="number"
            min="0"
            max="2"
            step="0.1"
            value={assistantConfig.llm.temperature || 0.7}
            onChange={(e) => handleLLMConfigChange('temperature', parseFloat(e.target.value))}
            disabled={loading}
            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-primary disabled:opacity-50"
          />
        </div>
      </div>

      {/* 系统提示词配置 */}
      <div className="space-y-4 p-4 bg-background-surface rounded-lg border border-border">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-text-primary">
            {t('assistant.systemPrompt', '系统提示词')}
          </h3>
          <button
            type="button"
            onClick={() => setShowPreview(!showPreview)}
            disabled={!systemPromptConfig.enabled}
            className={`text-xs text-primary hover:underline ${
              !systemPromptConfig.enabled ? 'opacity-50 cursor-not-allowed' : ''
            }`}
          >
            {showPreview
              ? t('assistant.hidePreview', '隐藏预览')
              : t('assistant.showPreview', '显示预览')}
          </button>
        </div>

        {/* 启用开关 */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-text-primary">
              {t('assistant.systemPromptEnable', '启用自定义系统提示词')}
            </p>
            <p className="text-xs text-text-secondary mt-0.5">
              {t('assistant.systemPromptEnableDesc', '启用后可自定义 AI 助手的角色和行为')}
            </p>
          </div>
          <button
            onClick={() => handleSystemPromptChange('enabled', !systemPromptConfig.enabled)}
            disabled={loading}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              systemPromptConfig.enabled ? 'bg-primary' : 'bg-background-elevated'
            } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                systemPromptConfig.enabled ? 'translate-x-5' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {/* 模式选择 */}
        {systemPromptConfig.enabled && (
          <div className="space-y-2 pt-2 border-t border-border-subtle">
            <p className="text-xs text-text-secondary">
              {t('assistant.systemPromptMode', '模式选择')}
            </p>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="systemPromptMode"
                checked={systemPromptConfig.mode === 'append'}
                onChange={() => handleSystemPromptChange('mode', 'append')}
                className="mt-0.5"
              />
              <div>
                <span className="text-sm text-text-primary">
                  {t('assistant.systemPromptModeAppend', '追加模式')}
                  <span className="ml-1 text-xs text-primary">({t('common.recommended', '推荐')})</span>
                </span>
                <p className="text-xs text-text-secondary">{getModeDescription('append')}</p>
              </div>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="systemPromptMode"
                checked={systemPromptConfig.mode === 'replace'}
                onChange={() => handleSystemPromptChange('mode', 'replace')}
                className="mt-0.5"
              />
              <div>
                <span className="text-sm text-text-primary">
                  {t('assistant.systemPromptModeReplace', '替换模式')}
                </span>
                <p className="text-xs text-text-secondary">{getModeDescription('replace')}</p>
              </div>
            </label>
          </div>
        )}

        {/* 模式提示 */}
        {systemPromptConfig.enabled && (
          <div className="p-2 bg-background-faint rounded text-xs text-text-secondary">
            {systemPromptConfig.mode === 'append' ? (
              <span>{t('assistant.systemPromptAppendHint', '输入的内容将追加到默认提示词后面')}</span>
            ) : (
              <span className="text-warning">
                {t('assistant.systemPromptReplaceHint', '⚠️ 替换模式将完全覆盖默认提示词，请确保输入完整内容')}
              </span>
            )}
          </div>
        )}

        {/* 编辑器 */}
        <div className="flex items-center justify-between">
          <label className="text-xs text-text-secondary">
            {t('assistant.systemPromptCustom', '自定义内容')}
          </label>
          <button
            type="button"
            onClick={handleFillDefaultPrompt}
            disabled={!systemPromptConfig.enabled || loading}
            className={`text-xs text-primary hover:underline ${
              !systemPromptConfig.enabled || loading ? 'opacity-50 cursor-not-allowed' : ''
            }`}
          >
            {t('assistant.systemPromptFillDefault', '填入默认')}
          </button>
        </div>
        <textarea
          value={systemPromptConfig.customPrompt}
          onChange={(e) => handleSystemPromptChange('customPrompt', e.target.value)}
          disabled={!systemPromptConfig.enabled || loading}
          placeholder={
            systemPromptConfig.mode === 'append'
              ? t(
                  'assistant.systemPromptPlaceholderAppend',
                  '输入要追加的内容...\n\n例如：\n# 额外规则\n- 优先使用 TypeScript\n- 代码注释使用中文'
                )
              : t(
                  'assistant.systemPromptPlaceholderReplace',
                  '输入完整的系统提示词...\n\n点击"填入默认"可获取默认提示词作为基础'
                )
          }
          className={`w-full h-32 p-3 bg-background border border-border-subtle rounded-lg text-sm text-text-primary placeholder-text-muted resize-y focus:outline-none focus:border-primary ${
            !systemPromptConfig.enabled || loading ? 'opacity-50 cursor-not-allowed' : ''
          }`}
        />

        {/* 字数统计 */}
        <div className="flex justify-between items-center">
          <span className="text-xs text-text-muted">
            {t('assistant.systemPromptCharCount', '{{count}} 字符', { count: systemPromptConfig.customPrompt.length })}
            {systemPromptConfig.enabled && systemPromptConfig.mode === 'append' && (
              <span className="ml-2">
                ({t('assistant.systemPromptEffectiveCount', '实际: {{count}}', { count: effectivePrompt.length })})
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={handleResetSystemPrompt}
            disabled={loading}
            className="text-xs text-text-secondary hover:text-danger transition-colors"
          >
            {t('assistant.systemPromptReset', '重置')}
          </button>
        </div>

        {/* 预览 */}
        {systemPromptConfig.enabled && showPreview && (
          <div className="pt-2 border-t border-border-subtle">
            <p className="text-xs text-text-secondary mb-2">
              {t('assistant.systemPromptPreview', '实际生效的系统提示词')}
            </p>
            <div className="p-3 bg-background-faint rounded-lg text-xs font-mono whitespace-pre-wrap text-text-secondary max-h-48 overflow-y-auto">
              {effectivePrompt}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
