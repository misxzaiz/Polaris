/**
 * 翻译配置 Tab
 */

import type { Config } from '../../../types';

interface TranslateTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

export function TranslateTab({ config, onConfigChange, loading }: TranslateTabProps) {

  const handleAppIdChange = (appId: string) => {
    onConfigChange({
      ...config,
      baiduTranslate: { ...config.baiduTranslate, appId, secretKey: config.baiduTranslate?.secretKey || '' }
    });
  };

  const handleSecretKeyChange = (secretKey: string) => {
    onConfigChange({
      ...config,
      baiduTranslate: { ...config.baiduTranslate, appId: config.baiduTranslate?.appId || '', secretKey }
    });
  };

  return (
    <div className="space-y-6">
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">百度翻译 API</h3>

        <div className="mb-4">
          <label className="block text-xs text-text-secondary mb-2">
            App ID
          </label>
          <input
            type="text"
            value={config.baiduTranslate?.appId || ''}
            onChange={(e) => handleAppIdChange(e.target.value)}
            placeholder="百度翻译 App ID"
            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
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
            onChange={(e) => handleSecretKeyChange(e.target.value)}
            placeholder="百度翻译 Secret Key"
            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
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
                <span className="font-medium">配置说明：</span>
              </p>
              <ul className="text-xs text-text-tertiary mt-1 space-y-1 list-disc list-inside">
                <li>访问百度翻译开放平台申请 API</li>
                <li>标准版免费，每月 200 万字符</li>
                <li>支持选中文字右键翻译</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
