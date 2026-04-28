/**
 * Web 服务配置 Tab
 *
 * - 开关、端口配置：即时通过 apply_web_server 生效，无需重启
 */

import { useTranslation } from 'react-i18next';
import { useState, useEffect } from 'react';
import * as tauri from '@/services/tauri';
import { useConfigStore } from '../../../stores';
import { invoke } from '@/services/transport';
import { createLogger } from '../../../utils/logger';
import type { Config, WebConfig } from '../../../types';

const log = createLogger('WebTab');

interface WebTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

const DEFAULT_WEB_CONFIG: WebConfig = { enabled: false, host: '0.0.0.0', port: 9800 };

export function WebTab({ config, onConfigChange, loading }: WebTabProps) {
  const { t } = useTranslation(['settings', 'common']);
  const web = config.web ?? DEFAULT_WEB_CONFIG;
  const [localIps, setLocalIps] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applySuccess, setApplySuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!web.enabled) return;
    invoke<string[]>('get_local_ips')
      .then(setLocalIps)
      .catch(() => setLocalIps([]));
  }, [web.enabled]);

  const updateWeb = (patch: Partial<typeof web>) => {
    onConfigChange({ ...config, web: { ...web, ...patch } });
  };

  /** 调用后端 apply_web_server 命令，即时启停 Web 服务 */
  const applyWebServer = async () => {
    setApplying(true);
    setApplyError(null);
    setApplySuccess(null);
    try {
      const persistedConfig = await tauri.getConfig();
      const nextConfig = { ...persistedConfig, web };
      await tauri.updateConfig(nextConfig);
      const savedConfig = await tauri.getConfig();
      onConfigChange(savedConfig);
      useConfigStore.setState({ config: savedConfig });
      const result = await invoke<{ running: boolean }>('apply_web_server');
      setApplySuccess(result.running ? t('web.serverStarted') : t('web.serverStopped'));
      // 成功后刷新 IP 列表
      if (result.running) {
        invoke<string[]>('get_local_ips')
          .then(setLocalIps)
          .catch(() => setLocalIps([]));
      }
    } catch (e: unknown) {
      setApplyError(t('web.applyFailed'));
      log.warn('Apply web server failed', { error: String(e) });
    } finally {
      setApplying(false);
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

      {/* 应用按钮 — 即时启停 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-text-primary">{t('web.applyTitle')}</h3>
            <p className="mt-1 text-xs text-text-tertiary">{t('web.applyDesc')}</p>
          </div>
          <button
            type="button"
            onClick={applyWebServer}
            disabled={applying || loading}
            className="px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {applying ? '...' : t('web.applyButton')}
          </button>
        </div>
        {applyError && (
          <p className="mt-2 text-xs text-red-400">{applyError}</p>
        )}
        {applySuccess && (
          <p className="mt-2 text-xs text-green-400">{applySuccess}</p>
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

          {localIps.length > 1 && (
            <div className="text-xs text-text-tertiary">
              {localIps.map((ip) => (
                <span key={ip} className="inline-block mr-2">
                  <code className="text-text-primary">{ip}:{web.port}</code>
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

    </div>
  );
}
