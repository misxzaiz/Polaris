import { useTranslation } from 'react-i18next'
import { useConfigStore } from '../../../stores/configStore'
import { DEFAULT_ASSISTANT_CONFIG } from '../../../assistant/types'

export function AssistantTab() {
  const { t } = useTranslation('settings')
  const { config, updateConfig } = useConfigStore()

  const assistantConfig = config?.assistant || DEFAULT_ASSISTANT_CONFIG

  const handleToggle = () => {
    updateConfig({
      ...config,
      assistant: {
        ...assistantConfig,
        enabled: !assistantConfig.enabled,
      },
    } as any)
  }

  const handleLLMConfigChange = (key: string, value: string | number) => {
    updateConfig({
      ...config,
      assistant: {
        ...assistantConfig,
        llm: {
          ...assistantConfig.llm,
          [key]: value,
        },
      },
    } as any)
  }

  return (
    <div className="space-y-6">
      {/* 启用开关 */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-text">
            {t('assistant.enable')}
          </h3>
          <p className="text-xs text-text-muted mt-1">
            {t('assistant.enableDescription')}
          </p>
        </div>
        <button
          onClick={handleToggle}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            assistantConfig.enabled ? 'bg-primary' : 'bg-surface-elevated'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              assistantConfig.enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* LLM 配置 */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-text">
          {t('assistant.llmConfig')}
        </h3>

        {/* Base URL */}
        <div>
          <label className="block text-xs text-text-muted mb-1">
            {t('assistant.baseUrl')}
          </label>
          <input
            type="text"
            value={assistantConfig.llm.baseUrl}
            onChange={(e) => handleLLMConfigChange('baseUrl', e.target.value)}
            className="w-full px-3 py-2 bg-surface-elevated border border-border rounded-lg text-sm text-text"
            placeholder="https://api.openai.com/v1"
          />
        </div>

        {/* API Key */}
        <div>
          <label className="block text-xs text-text-muted mb-1">
            {t('assistant.apiKey')}
          </label>
          <input
            type="password"
            value={assistantConfig.llm.apiKey}
            onChange={(e) => handleLLMConfigChange('apiKey', e.target.value)}
            className="w-full px-3 py-2 bg-surface-elevated border border-border rounded-lg text-sm text-text"
            placeholder="sk-..."
          />
        </div>

        {/* Model */}
        <div>
          <label className="block text-xs text-text-muted mb-1">
            {t('assistant.model')}
          </label>
          <input
            type="text"
            value={assistantConfig.llm.model}
            onChange={(e) => handleLLMConfigChange('model', e.target.value)}
            className="w-full px-3 py-2 bg-surface-elevated border border-border rounded-lg text-sm text-text"
            placeholder="gpt-4o"
          />
        </div>

        {/* Temperature */}
        <div>
          <label className="block text-xs text-text-muted mb-1">
            {t('assistant.temperature')}
          </label>
          <input
            type="number"
            min="0"
            max="2"
            step="0.1"
            value={assistantConfig.llm.temperature || 0.7}
            onChange={(e) => handleLLMConfigChange('temperature', parseFloat(e.target.value))}
            className="w-full px-3 py-2 bg-surface-elevated border border-border rounded-lg text-sm text-text"
          />
        </div>
      </div>
    </div>
  )
}
