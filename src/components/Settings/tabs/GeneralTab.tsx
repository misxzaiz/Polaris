/**
 * 通用设置 Tab
 * 包含语言、翻译、数据存储、系统提示词等通用偏好
 * （AI 主动提问的启停开关归属 polaris.ask 插件，在插件页管理）
 */

import { useTranslation } from 'react-i18next';
import { Smartphone, Plug, PlugZap } from 'lucide-react';
import type { Config } from '@/types';
import { DataStorageCard } from './DataStorageCard';
import { FocusModeSettings } from './FocusModeSettings';
import { SystemPromptSection } from './SystemPromptSection';
import { useMobileConnection } from '@/mobile/MobileConnectionContext';
import { isMobileTauriRuntime } from '@/mobile/platform';

interface GeneralTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

export function GeneralTab({ config, onConfigChange, loading }: GeneralTabProps) {
  const { t } = useTranslation('settings');
  const mobileConnection = useMobileConnection();
  const isMobile = isMobileTauriRuntime();

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

      {/* AI 界面控制 — cap.ui.* 能力开关（默认关闭，开启后 AI 工具集含 cap.ui.theme/cap.ui.chat） */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-medium text-text-primary flex items-center gap-1.5">
              {t('uiControl.title', 'AI 界面控制')}
            </h3>
            <p className="text-xs text-text-secondary mt-1">
              {t('uiControl.description', '允许 AI 调整主题配色与对话渲染配置（字号、消息间距等），三端同源生效')}
            </p>
            <p className="text-xs text-text-tertiary mt-0.5">
              {t('uiControl.hint', '关闭时隐藏 bus 中的 cap.ui.* 工具；开启后 AI 即可经工具调用控制界面样式')}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={config.uiControlEnabled === true}
            aria-label={config.uiControlEnabled === true ? '关闭 AI 界面控制' : '开启 AI 界面控制'}
            title={config.uiControlEnabled ? '关闭' : '开启'}
            onClick={() => onConfigChange({ ...config, uiControlEnabled: config.uiControlEnabled !== true })}
            disabled={loading}
            className={`
              relative inline-flex items-center h-6 w-11 rounded-full shrink-0
              transition-colors
              focus:outline-none
              focus-visible:ring-2 focus-visible:ring-primary
              focus-visible:ring-offset-2
              ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
              ${config.uiControlEnabled === true ? 'bg-primary' : 'bg-border'}
            `}
          >
            <span
              className={`
                inline-block h-4 w-4 transform rounded-full bg-white
                shadow-sm transition-transform
                ${config.uiControlEnabled === true ? 'translate-x-5' : 'translate-x-1'}
              `}
            />
          </button>
        </div>
      </div>

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

      {/* 移动端连接管理 — 仅在移动端 Tauri 运行时显示 */}
      {isMobile && mobileConnection && (
        <div className="p-4 bg-surface rounded-lg border border-border">
          <h3 className="text-sm font-medium text-text-primary mb-3 flex items-center gap-1.5">
            <Smartphone size={14} />
            {t('mobileConnection.title', '移动端连接管理')}
          </h3>
          <div className="flex items-center justify-between">
            <div className="min-w-0 flex-1 pr-4">
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    mobileConnection.connected
                      ? 'bg-green shadow-[0_0_6px_rgba(166,227,161,0.5)]'
                      : 'bg-text-tertiary'
                  }`}
                />
                <span className="text-sm text-text-primary">
                  {mobileConnection.connected
                    ? t('mobileConnection.connected', '已连接')
                    : t('mobileConnection.disconnected', '未连接')}
                </span>
              </div>
              <p className="text-xs text-text-secondary mt-1">
                {t('mobileConnection.hint', '管理移动端与桌面端的连接，可查看状态或断开连接')}
              </p>
            </div>
            <button
              type="button"
              onClick={mobileConnection.openConnectionSettings}
              className="shrink-0 flex items-center gap-1.5 text-xs px-3 py-2 rounded-md border border-border bg-surface text-text-secondary hover:bg-background-hover transition-colors"
            >
              {mobileConnection.connected ? <PlugZap size={12} /> : <Plug size={12} />}
              {t('mobileConnection.manage', '管理连接')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}