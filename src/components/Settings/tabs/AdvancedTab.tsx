/**
 * 高级配置 Tab
 */

import { useTranslation } from 'react-i18next';
import type { Config } from '../../../types';

interface AdvancedTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

export function AdvancedTab({ config, onConfigChange, loading }: AdvancedTabProps) {
  const { t } = useTranslation('settings');
  const handleGitBinPathChange = (gitBinPath: string) => {
    onConfigChange({
      ...config,
      gitBinPath: gitBinPath || undefined
    });
  };

  const handleSessionDirChange = (sessionDir: string) => {
    onConfigChange({
      ...config,
      sessionDir: sessionDir || undefined
    });
  };

  return (
    <div className="space-y-6">
      {/* Git 配置 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">{t('advanced.gitConfig')}</h3>

        <div className="mb-4">
          <label className="block text-xs text-text-secondary mb-2">
            {t('advanced.gitBinPath')}
          </label>
          <input
            type="text"
            value={config.gitBinPath || ''}
            onChange={(e) => handleGitBinPathChange(e.target.value)}
            placeholder={t('advanced.gitBinPathPlaceholder')}
            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            disabled={loading}
          />
          <p className="mt-1 text-xs text-text-tertiary">
            {t('advanced.gitBinPathHint')}
          </p>
        </div>
      </div>

      {/* 会话配置 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">{t('advanced.sessionConfig')}</h3>

        <div className="mb-4">
          <label className="block text-xs text-text-secondary mb-2">
            {t('advanced.sessionDir')}
          </label>
          <input
            type="text"
            value={config.sessionDir || ''}
            onChange={(e) => handleSessionDirChange(e.target.value)}
            placeholder={t('advanced.sessionDirPlaceholder')}
            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            disabled={loading}
          />
          <p className="mt-1 text-xs text-text-tertiary">
            {t('advanced.sessionDirHint')}
          </p>
        </div>
      </div>

      {/* 调试信息 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">{t('advanced.debugInfo')}</h3>

        <div className="text-xs text-text-tertiary space-y-1">
          <p><span className="text-text-secondary">{t('advanced.configFile')}：</span>~/.config/claude-code-pro/config.json</p>
          <p><span className="text-text-secondary">{t('advanced.logDir')}：</span>~/.local/share/claude-code-pro/logs</p>
          <p><span className="text-text-secondary">{t('advanced.currentEngine')}：</span>{config.defaultEngine}</p>
        </div>
      </div>
    </div>
  );
}
