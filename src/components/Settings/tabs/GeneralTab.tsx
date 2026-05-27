/**
 * 通用设置 Tab
 * 包含语言、主题等全局外观偏好
 */

import { useTranslation } from 'react-i18next';
import type { Config } from '@/types';

interface GeneralTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

export function GeneralTab({ config, onConfigChange, loading }: GeneralTabProps) {
  const { t } = useTranslation('settings');

  const currentTheme = config.theme ?? 'dark';

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

      {/* 外观主题 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">{t('appearance.title')}</h3>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-text-primary">{t('appearance.current')}</div>
            <div className="text-xs text-text-secondary">{t('appearance.hint')}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onConfigChange({ ...config, theme: 'dark' })}
              disabled={loading}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                currentTheme === 'dark'
                  ? 'bg-primary text-on-primary'
                  : 'bg-background-surface border border-border text-text-secondary hover:text-text-primary'
              } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {t('appearance.dark')}
            </button>
            <button
              type="button"
              onClick={() => onConfigChange({ ...config, theme: 'light' })}
              disabled={loading}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors inline-flex items-center gap-1.5 ${
                currentTheme === 'light'
                  ? 'bg-primary text-on-primary'
                  : 'bg-background-surface border border-border text-text-secondary hover:text-text-primary'
              } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
              title={t('appearance.experimental')}
            >
              {t('appearance.light')}
              <span className="text-[10px] px-1 py-0.5 rounded bg-accent-workspace/15 text-accent-workspace leading-none">
                β
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
