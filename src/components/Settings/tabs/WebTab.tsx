/**
 * Web 服务配置 Tab
 */

import { useTranslation } from 'react-i18next';
import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import QRCode from 'react-qr-code';
import type { Config, WebConfig } from '../../../types';

interface WebTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

const DEFAULT_WEB_CONFIG: WebConfig = { enabled: false, host: '0.0.0.0', port: 9800 };

export function WebTab({ config, onConfigChange, loading }: WebTabProps) {
  const { t } = useTranslation('settings');
  const web = config.web ?? DEFAULT_WEB_CONFIG;
  const [tokenVisible, setTokenVisible] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [localIps, setLocalIps] = useState<string[]>([]);

  useEffect(() => {
    if (!web.enabled) return;
    invoke<string[]>('get_local_ips')
      .then(setLocalIps)
      .catch(() => setLocalIps([]));
  }, [web.enabled]);

  const updateWeb = (patch: Partial<typeof web>) => {
    onConfigChange({ ...config, web: { ...web, ...patch } });
  };

  const handleRegenerate = async () => {
    if (!confirm(t('web.tokenRegenerateConfirm'))) return;
    setRegenerating(true);
    try {
      const result = await invoke<{ token: string }>('regenerate_web_token');
      updateWeb({ token: result.token });
    } catch {
      // fallback: ignore
    } finally {
      setRegenerating(false);
    }
  };

  const qrUrl = web.token && localIps.length > 0
    ? `http://${localIps[0]}:${web.port}?token=${encodeURIComponent(web.token)}`
    : null;

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
            placeholder="9800"
            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            disabled={loading || !web.enabled}
          />
          <p className="mt-1 text-xs text-text-tertiary">
            {t('web.portHint')}
          </p>
        </div>
      </div>

      {/* Token 信息 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">{t('web.tokenTitle')}</h3>

        {web.token ? (
          <div>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-background rounded-lg text-sm text-text-primary font-mono overflow-hidden text-ellipsis whitespace-nowrap">
                {tokenVisible ? web.token : '•'.repeat(Math.min(web.token.length, 32))}
              </code>
              <button
                type="button"
                onClick={() => setTokenVisible(!tokenVisible)}
                className="px-3 py-2 text-xs text-text-secondary hover:text-text-primary border border-border rounded-lg"
              >
                {tokenVisible ? t('web.tokenHide') : t('web.tokenShow')}
              </button>
              <button
                type="button"
                onClick={handleRegenerate}
                disabled={regenerating || loading || !web.enabled}
                className="px-3 py-2 text-xs text-text-secondary hover:text-red-400 border border-border rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {regenerating ? '...' : t('web.tokenRegenerate')}
              </button>
            </div>
            <p className="mt-2 text-xs text-text-tertiary">
              {t('web.tokenHint')}
            </p>
          </div>
        ) : (
          <p className="text-xs text-text-tertiary">
            {t('web.tokenAutoGenerate')}
          </p>
        )}
      </div>

      {/* 访问信息 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">{t('web.accessInfo')}</h3>
        <div className="text-xs text-text-tertiary space-y-1">
          <p>
            <span className="text-text-secondary">{t('web.accessUrl')}：</span>
            <code className="text-text-primary">http://{web.host === '0.0.0.0' ? 'localhost' : web.host}:{web.port}</code>
          </p>
          <p>
            <span className="text-text-secondary">{t('web.accessHint')}：</span>
            {t('web.accessHintDesc')}
          </p>
        </div>
      </div>

      {/* 二维码 */}
      {web.enabled && (
        <div className="p-4 bg-surface rounded-lg border border-border">
          <h3 className="text-sm font-medium text-text-primary mb-3">{t('web.qrTitle')}</h3>
          {qrUrl ? (
            <div className="flex flex-col items-center gap-3">
              <div className="p-3 bg-white rounded-lg">
                <QRCode
                  value={qrUrl}
                  size={160}
                  level="M"
                />
              </div>
              <p className="text-xs text-text-tertiary text-center max-w-[240px]">
                {t('web.qrHint')}
              </p>
              {localIps.length > 1 && (
                <div className="text-xs text-text-tertiary text-center">
                  {localIps.map((ip) => (
                    <span key={ip} className="inline-block mr-2">
                      <code className="text-text-primary">{ip}:{web.port}</code>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : web.token ? (
            <p className="text-xs text-text-tertiary">{t('web.qrNoIp')}</p>
          ) : (
            <p className="text-xs text-text-tertiary">{t('web.qrDisabled')}</p>
          )}
        </div>
      )}
    </div>
  );
}
