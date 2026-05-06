/**
 * Web 服务配置 Tab
 *
 * - 开关、端口配置：保存 Web 设置后即时生效，无需重启
 */

import { useTranslation } from 'react-i18next';
import { useState, useEffect } from 'react';
import * as tauri from '@/services/tauri';
import { invoke } from '@/services/transport';
import { createLogger } from '../../../utils/logger';
import type { Config, WebConfig } from '../../../types';
import type { WebServerStatus } from '@/services/tauri';

const log = createLogger('WebTab');

interface WebTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
  statusRefreshKey?: number;
}

const DEFAULT_WEB_CONFIG: WebConfig = { enabled: true, host: '0.0.0.0', port: 9830 };

export function WebTab({ config, onConfigChange, loading, statusRefreshKey = 0 }: WebTabProps) {
  const { t } = useTranslation(['settings', 'common']);
  const web = config.web ?? DEFAULT_WEB_CONFIG;
  const [localIps, setLocalIps] = useState<string[]>([]);
  const [webServerStatus, setWebServerStatus] = useState<WebServerStatus | null>(null);
  const [openingBrowser, setOpeningBrowser] = useState(false);

  useEffect(() => {
    if (!web.enabled) return;
    invoke<string[]>('get_local_ips')
      .then(setLocalIps)
      .catch(() => setLocalIps([]));
  }, [web.enabled]);

  useEffect(() => {
    let cancelled = false;
    tauri.getWebServerStatus()
      .then((status) => {
        if (!cancelled) setWebServerStatus(status);
      })
      .catch(() => {
        if (!cancelled) setWebServerStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [statusRefreshKey]);

  const updateWeb = (patch: Partial<typeof web>) => {
    onConfigChange({ ...config, web: { ...web, ...patch } });
  };

  const effectivePort = webServerStatus?.running && webServerStatus.port
    ? webServerStatus.port
    : web.port;
  const accessUrl = webServerStatus?.running && webServerStatus.url
    ? webServerStatus.url
    : `http://${web.host === '0.0.0.0' ? 'localhost' : web.host}:${effectivePort}`;
  const isUsingFallbackPort = Boolean(
    webServerStatus?.running
      && webServerStatus.port
      && webServerStatus.port !== web.port,
  );

  const handleOpenInBrowser = async () => {
    setOpeningBrowser(true);
    try {
      await tauri.openInBrowser(accessUrl);
    } catch (e: unknown) {
      log.warn('Open web URL failed', { error: String(e), url: accessUrl });
    } finally {
      setOpeningBrowser(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* 服务开关 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-text-primary">{t('web.enableTitle')}</h3>
            <p className="mt-1 text-xs text-text-tertiary">{t('web.enableDesc')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={web.enabled}
            onClick={() => updateWeb({ enabled: !web.enabled })}
            disabled={loading}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              web.enabled ? 'bg-primary' : 'bg-border'
            } ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                web.enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      {/* 访问信息 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h3 className="text-sm font-medium text-text-primary">{t('web.accessInfo')}</h3>
          <button
              type="button"
              onClick={handleOpenInBrowser}
              disabled={!web.enabled || openingBrowser || loading}
              className="px-3 py-1.5 text-xs font-medium text-white bg-primary rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {openingBrowser ? '...' : t('web.openInBrowser')}
          </button>
        </div>
        <div className="text-xs text-text-tertiary space-y-1">
          <p>
            <span className="text-text-secondary">{t('web.accessUrl')}：</span>
            <code className="text-text-primary">{accessUrl}</code>
          </p>
          {isUsingFallbackPort && (
              <p>
                <span className="text-text-secondary">{t('web.actualPort')}：</span>
                {t('web.actualPortHint', { port: effectivePort })}
              </p>
          )}

          <p>
            <code className="text-text-secondary">{t('web.otherAccessUrl')}：</code>
          </p>
          {localIps.length > 1 && (
              <div className="text-xs text-text-tertiary">
                {localIps.map((ip) => (
                    <span key={ip} className="inline-block mr-2">
                  <code className="text-text-primary">{ip}:{effectivePort}</code>
                </span>
                ))}
              </div>
          )}
          <p>
            <span className="text-text-secondary">{t('web.accessHint')}：</span>
            {t('web.accessHintDesc')}
          </p>
        </div>
      </div>

      {/* 端口配置 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">{t('web.portConfig')}</h3>

        <div className="mb-4">
          <label className="block text-xs text-text-secondary mb-2">
            {t('web.host')}
          </label>
          <input
            type="text"
            value={web.host}
            onChange={(e) => updateWeb({ host: e.target.value })}
            placeholder="0.0.0.0"
            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            disabled={loading || !web.enabled}
          />
          <p className="mt-1 text-xs text-text-tertiary">
            {t('web.hostHint')}
          </p>
        </div>

        <div>
          <label className="block text-xs text-text-secondary mb-2">
            {t('web.port')}
          </label>
          <input
            type="number"
            min={1024}
            max={65535}
            value={web.port}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val >= 1 && val <= 65535) {
                updateWeb({ port: val });
              }
            }}
            placeholder="9830"
            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            disabled={loading || !web.enabled}
          />
          <p className="mt-1 text-xs text-text-tertiary">
            {t('web.portHint')}
          </p>
        </div>

        <div className="mt-4">
          <label className="block text-xs text-text-secondary mb-2">
            {t('web.token')}
          </label>
          <input
            type="password"
            value={web.token ?? ''}
            onChange={(e) => updateWeb({ token: e.target.value })}
            placeholder={t('web.tokenPlaceholder')}
            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            disabled={loading || !web.enabled}
          />
          <p className="mt-1 text-xs text-text-tertiary">
            {t('web.tokenHint')}
          </p>
        </div>
      </div>

    </div>
  );
}
