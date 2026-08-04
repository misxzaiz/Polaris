/**
 * 通用设置 Tab
 * 包含语言、交互、翻译、数据存储、系统提示词等通用偏好
 */

import { useTranslation } from 'react-i18next';
import type { Config } from '@/types';
import { DataStorageCard } from './DataStorageCard';
import { DispatchSettingsSection } from './DispatchSettingsSection';
import { FocusModeSettings } from './FocusModeSettings';
import { SystemPromptSection } from './SystemPromptSection';

interface GeneralTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

export function GeneralTab({ config, onConfigChange, loading }: GeneralTabProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-6">
      {/* 语言设置 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">{t('language.title')}</h3>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-text-primary">{t('language.current')}</div>
            <div className="text-xs text-text-secondary">{t('language.hint')}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onConfigChange({ ...config, language: 'zh-CN' })}
              disabled={loading}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                (config.language || 'zh-CN') === 'zh-CN'
                  ? 'bg-primary text-on-primary'
                  : 'bg-background-surface border border-border text-text-secondary hover:text-text-primary'
              } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              中文
            </button>
            <button
              type="button"
              onClick={() => onConfigChange({ ...config, language: 'en-US' })}
              disabled={loading}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                config.language === 'en-US'
                  ? 'bg-primary text-on-primary'
                  : 'bg-background-surface border border-border text-text-secondary hover:text-text-primary'
              } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              English
            </button>
          </div>
        </div>
      </div>

      {/* 交互设置 — AskUserQuestion 等 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">
          {t('interaction.title', '交互')}
        </h3>
        <div className="flex items-center justify-between">
          <div className="flex-1 pr-4">
            <div className="text-sm text-text-primary">
              {t('interaction.askMcpEnabled', '允许 AI 弹出问题卡片')}
            </div>
            <div className="text-xs text-text-secondary">
              {t(
                'interaction.askMcpEnabledHint',
                '允许 AI 通过 polaris-ask MCP 在对话中弹出问题卡片向你提问。关闭后 AI 将无法主动提问。'
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() =>
              onConfigChange({
                ...config,
                interaction: {
                  ...(config.interaction ?? { askMcpEnabled: true }),
                  askMcpEnabled: !(config.interaction?.askMcpEnabled ?? true),
                },
              })
            }
            disabled={loading}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              (config.interaction?.askMcpEnabled ?? true)
                ? 'bg-primary'
                : 'bg-border'
            } ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            aria-pressed={config.interaction?.askMcpEnabled ?? true}
            aria-label={t('interaction.askMcpEnabled', '允许 AI 弹出问题卡片')}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                (config.interaction?.askMcpEnabled ?? true)
                  ? 'translate-x-4.5 translate-x-[18px]'
                  : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </div>

      {/* 派发任务设置 — 策略/结果注入/队员预设 */}
      <DispatchSettingsSection config={config} onConfigChange={onConfigChange} loading={loading} />

      {/* 阅读聚焦模式 — 独立 store，即时生效 */}
      <FocusModeSettings />

      {/* 翻译设置 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">
          {t('baiduTranslate.title', '百度翻译 API')}
        </h3>

        <div className="mb-4">
          <label className="block text-xs text-text-secondary mb-2">
            App ID
          </label>
          <input
            type="text"
            value={config.baiduTranslate?.appId || ''}
            onChange={(e) => onConfigChange({
              ...config,
              baiduTranslate: { ...config.baiduTranslate, appId: e.target.value, secretKey: config.baiduTranslate?.secretKey || '' }
            })}
            placeholder={t('baiduTranslate.appIdPlaceholder', '百度翻译 App ID')}
            className="w-full px-3 py-2 bg-background-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            disabled={loading}
          />
        </div>

        <div className="mb-4">
          <label className="block text-xs text-text-secondary mb-2">
            Secret Key
          </label>
          <input
            type="password"
            value={config.baiduTranslate?.secretKey || ''}
            onChange={(e) => onConfigChange({
              ...config,
              baiduTranslate: { ...config.baiduTranslate, appId: config.baiduTranslate?.appId || '', secretKey: e.target.value }
            })}
            placeholder={t('baiduTranslate.secretKeyPlaceholder', '百度翻译 Secret Key')}
            className="w-full px-3 py-2 bg-background-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            disabled={loading}
          />
        </div>

        <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg">
          <div className="flex items-start gap-2">
            <svg className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
            <div className="flex-1">
              <p className="text-xs text-text-primary">
                <span className="font-medium">{t('baiduTranslate.configHint', '配置说明：')}</span>
              </p>
              <ul className="text-xs text-text-tertiary mt-1 space-y-1 list-disc list-inside">
                <li>{t('baiduTranslate.platform', '访问百度翻译开放平台申请 API')}</li>
                <li>{t('baiduTranslate.freeQuota', '标准版免费，每月 200 万字符')}</li>
                <li>{t('baiduTranslate.usage', '支持选中文字右键翻译')}</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* 数据存储 */}
      <DataStorageCard />

      {/* 系统提示词 */}
      <SystemPromptSection />
    </div>
  );
}