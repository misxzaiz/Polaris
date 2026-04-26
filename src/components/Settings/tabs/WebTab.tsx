/**
 * Web 服务配置 Tab — 即时保存模式
 *
 * 所有变更即时保存到后端并立即生效，无需手动点击"应用"按钮。
 * - 开关切换 → 立即保存并启停服务
 * - 端口/Host 变更 → 失焦或 Enter 时保存并重启服务
 * - Token 变更 → 失焦或 Enter 时保存
 * - 认证开关 → 即时生效，关闭时隐藏 Token 区域并显示安全提示
 * - 端口被占用时自动递增，并显示实际端口
 */

import { useTranslation } from 'react-i18next';
import { useState, useEffect, useCallback, useRef } from 'react';
import { currentMode, invoke, storeToken, clearStoredToken } from '@/services/transport';
import { useConfigStore } from '../../../stores';
import QRCode from 'react-qr-code';
import { createLogger } from '../../../utils/logger';
import { generateUUID } from '../../../utils/uuid';
import type { WebConfig } from '../../../types';

const log = createLogger('WebTab');

interface WebTabProps {
  loading: boolean;
  onWebConfigChange?: (webConfig: WebConfig) => void;
}

interface WebServerStatus {
  running: boolean;
  actualPort: number | null;
  configuredPort: number;
  host: string;
  token?: string;
  enabled: boolean;
  authEnabled: boolean;
}

interface ApplyResult {
  running: boolean;
  actualPort: number | null;
  portRedirected: boolean;
  token?: string;
}

const DEFAULT_WEB_CONFIG: WebConfig = { enabled: false, host: '0.0.0.0', port: 9800, authEnabled: true };

/** 前端生成 32 位 hex Token（与 Rust 端 generate_token 逻辑一致） */
function generateRandomToken(): string {
  return generateUUID().replace(/-/g, '');
}

export function WebTab({ loading, onWebConfigChange }: WebTabProps) {
  const { t } = useTranslation('settings');
  const [webConfig, setWebConfig] = useState<WebConfig>(DEFAULT_WEB_CONFIG);
  const [status, setStatus] = useState<WebServerStatus | null>(null);
  const [localIps, setLocalIps] = useState<string[]>([]);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appliedConfigRef = useRef<WebConfig>(DEFAULT_WEB_CONFIG);

  const syncWebConfig = useCallback((nextWebConfig: WebConfig) => {
    onWebConfigChange?.(nextWebConfig);
    useConfigStore.setState((state) => ({
      config: state.config ? { ...state.config, web: nextWebConfig } : state.config,
    }));
  }, [onWebConfigChange]);

  // 加载当前状态
  useEffect(() => {
    invoke<WebServerStatus>('get_web_server_status')
      .then((s) => {
        setStatus(s);
        setWebConfig({
          enabled: s.enabled,
          host: s.host,
          port: s.configuredPort,
          token: s.token,
          authEnabled: s.authEnabled,
        });
        appliedConfigRef.current = {
          enabled: s.enabled,
          host: s.host,
          port: s.configuredPort,
          token: s.token,
          authEnabled: s.authEnabled,
        };
        syncWebConfig(appliedConfigRef.current);
      })
      .catch((e) => {
        log.warn('Failed to load web server status', { error: String(e) });
      });
  }, [syncWebConfig]);

  // 获取局域网 IP（服务运行时）
  useEffect(() => {
    if (webConfig.enabled) {
      invoke<string[]>('get_local_ips')
        .then(setLocalIps)
        .catch(() => setLocalIps([]));
    }
  }, [webConfig.enabled, status?.running]);

  /** 即时保存并应用 Web 配置（失败时自动回滚本地状态） */
  const applyConfig = useCallback(async (newConfig: WebConfig) => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const prevConfig = { ...appliedConfigRef.current };
    setWebConfig(newConfig);
    syncWebConfig(newConfig);
    setApplying(true);
    setError(null);
    try {
      const result = await invoke<ApplyResult>('update_and_apply_web', { webConfig: newConfig });
      const effectiveConfig = {
        ...newConfig,
        token: result.token || newConfig.token,
      };
      if (currentMode === 'http') {
        if (effectiveConfig.authEnabled && effectiveConfig.token) {
          storeToken(effectiveConfig.token);
        } else if (!effectiveConfig.authEnabled) {
          // Auth disabled — clear stored token so stale magic values don't cause 401 on re-enable
          clearStoredToken();
        }
      }
      appliedConfigRef.current = effectiveConfig;
      setStatus({
        running: result.running,
        actualPort: result.actualPort,
        configuredPort: newConfig.port,
        host: newConfig.host,
        token: effectiveConfig.token,
        enabled: newConfig.enabled,
        authEnabled: newConfig.authEnabled,
      });
      setWebConfig(effectiveConfig);
      syncWebConfig(effectiveConfig);
      // 刷新 IP 列表
      if (result.running) {
        invoke<string[]>('get_local_ips')
          .then(setLocalIps)
          .catch(() => setLocalIps([]));
      }
    } catch (e: unknown) {
      setWebConfig(prevConfig);  // 回滚到变更前的状态
      syncWebConfig(prevConfig);
      setError(t('web.applyFailed'));
      log.warn('Apply web config failed', { error: String(e) });
    } finally {
      setApplying(false);
    }
  }, [syncWebConfig, t]);

  /** 防抖保存（用于端口、Host、Token 变更） */
  const debouncedApply = useCallback((newConfig: WebConfig) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    applyConfig(newConfig);
  }, [applyConfig]);

  // 清理 debounce
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  /** Toggle 开关 — 即时生效 */
  const handleToggle = () => {
    const newConfig = { ...webConfig, enabled: !webConfig.enabled };
    applyConfig(newConfig);
  };

  /** 端口变更 — 失焦/Enter 时生效 */
  const handlePortBlur = (raw: string) => {
    const val = parseInt(raw, 10);
    if (!isNaN(val) && val >= 1024 && val <= 65535 && val !== appliedConfigRef.current.port) {
      const newConfig = { ...webConfig, port: val };
      setWebConfig(newConfig);
      debouncedApply(newConfig);
    }
  };

  /** Host 变更 — 失焦/Enter 时生效 */
  const handleHostBlur = (val: string) => {
    if (val && val !== appliedConfigRef.current.host) {
      const newConfig = { ...webConfig, host: val };
      setWebConfig(newConfig);
      debouncedApply(newConfig);
    }
  };

  /** Token 变更 — 失焦/Enter 时生效 */
  const handleTokenBlur = (val: string | undefined) => {
    const newToken = val || undefined;
    if (newToken !== appliedConfigRef.current.token) {
      const newConfig = { ...webConfig, token: newToken };
      setWebConfig(newConfig);
      debouncedApply(newConfig);
    }
  };

  /** 随机生成 Token */
  const handleRandomToken = () => {
    const newToken = generateRandomToken();
    const newConfig = { ...webConfig, token: newToken };
    applyConfig(newConfig);
  };

  /** 认证开关 — 即时生效 */
  const handleAuthToggle = () => {
    const newConfig = { ...webConfig, authEnabled: !webConfig.authEnabled };
    applyConfig(newConfig);
  };

  /** 在浏览器打开 */
  const handleOpenInBrowser = async () => {
    const host = webConfig.host === '0.0.0.0' ? 'localhost' : webConfig.host;
    const port = displayPort;
    const tokenParam = webConfig.authEnabled && webConfig.token ? `?token=${encodeURIComponent(webConfig.token)}` : '';
    const url = `http://${host}:${port}${tokenParam}`;
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    } catch {
      window.open(url, '_blank');
    }
  };

  /** 重启 Web 服务 */
  const handleRestart = () => {
    applyConfig(webConfig);
  };

  // 计算显示用的端口和 URL
  const displayPort = status?.actualPort ?? webConfig.port;

  const qrUrl = status?.running && localIps.length > 0
    ? webConfig.authEnabled && webConfig.token
      ? `http://${localIps[0]}:${displayPort}?token=${encodeURIComponent(webConfig.token)}`
      : `http://${localIps[0]}:${displayPort}`
    : null;

  return (
    <div className="space-y-6">
      {/* 运行状态指示 */}
      {status && (
        <div className={`p-4 rounded-lg border ${
          status.running
            ? 'bg-green-500/10 border-green-500/30'
            : status.enabled
              ? 'bg-yellow-500/10 border-yellow-500/30'
              : 'bg-surface border-border'
        }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className={`inline-block w-2 h-2 rounded-full ${
                  status.running ? 'bg-green-500 animate-pulse' : 'bg-text-tertiary'
                }`}
              />
              <span className="text-sm text-text-primary">
                {status.running
                  ? t('web.statusRunning', { port: status.actualPort })
                  : t('web.statusStopped')}
              </span>
              {applying && (
                <span className="text-xs text-text-tertiary">{t('web.applying')}</span>
              )}
            </div>
            {status.running && (
              <button
                type="button"
                onClick={handleRestart}
                disabled={loading || applying}
                className="px-3 py-1 text-xs text-text-secondary hover:text-primary border border-border rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('web.restartServer')}
              </button>
            )}
          </div>
          {status.running && status.actualPort != null && status.actualPort !== webConfig.port && (
            <p className="mt-1.5 text-xs text-yellow-400">
              {t('web.portRedirected', { original: webConfig.port, actual: status.actualPort })}
            </p>
          )}
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      {/* 服务开关 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-text-primary">{t('web.enableTitle')}</h3>
            <p className="mt-1 text-xs text-text-tertiary">{t('web.enableDescNew')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={webConfig.enabled}
            onClick={handleToggle}
            disabled={loading || applying}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              webConfig.enabled ? 'bg-primary' : 'bg-border'
            } ${(loading || applying) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                webConfig.enabled ? 'translate-x-6' : 'translate-x-1'
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
            value={webConfig.host}
            onChange={(e) => setWebConfig((prev) => ({ ...prev, host: e.target.value }))}
            onBlur={(e) => handleHostBlur(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleHostBlur((e.target as HTMLInputElement).value);
            }}
            placeholder="0.0.0.0"
            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            disabled={loading || !webConfig.enabled}
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
            value={webConfig.port}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val >= 1 && val <= 65535) {
                setWebConfig((prev) => ({ ...prev, port: val }));
              }
            }}
            onBlur={(e) => handlePortBlur(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handlePortBlur((e.target as HTMLInputElement).value);
            }}
            placeholder="9800"
            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            disabled={loading || !webConfig.enabled}
          />
          <p className="mt-1 text-xs text-text-tertiary">
            {t('web.portHintNew')}
          </p>
        </div>
      </div>

      {/* 认证开关 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-text-primary">{t('web.authEnabled')}</h3>
            <p className="mt-1 text-xs text-text-tertiary">{t('web.authEnabledHint')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={webConfig.authEnabled}
            onClick={handleAuthToggle}
            disabled={loading || !webConfig.enabled || applying}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              webConfig.authEnabled ? 'bg-primary' : 'bg-border'
            } ${(loading || !webConfig.enabled || applying) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                webConfig.authEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

       {/* 无认证安全提示 */}
      {!webConfig.authEnabled && webConfig.enabled && (
        <div className="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
          <p className="text-xs text-yellow-400">{t('web.noAuthWarning')}</p>
        </div>
      )}

      {/* Token 配置 — 仅在认证开启时显示 */}
      {webConfig.authEnabled && (
        <div className="p-4 bg-surface rounded-lg border border-border">
          <h3 className="text-sm font-medium text-text-primary mb-3">{t('web.tokenTitle')}</h3>

          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <input
                type={tokenVisible ? 'text' : 'password'}
                value={webConfig.token ?? ''}
                onChange={(e) => setWebConfig((prev) => ({ ...prev, token: e.target.value || undefined }))}
                onBlur={(e) => handleTokenBlur(e.target.value || undefined)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleTokenBlur((e.target as HTMLInputElement).value || undefined);
                }}
                placeholder={t('web.tokenPlaceholder')}
                className="w-full px-3 py-2 pr-10 bg-background border border-border rounded-lg text-sm text-text-primary font-mono focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                disabled={loading || !webConfig.enabled}
              />
              <button
                type="button"
                onClick={() => setTokenVisible(!tokenVisible)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary"
                title={tokenVisible ? t('web.tokenHide') : t('web.tokenShow')}
              >
                {tokenVisible ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                )}
              </button>
            </div>
            <button
              type="button"
              onClick={handleRandomToken}
              disabled={loading || !webConfig.enabled}
              className="px-3 py-2 text-xs text-text-secondary hover:text-primary border border-border rounded-lg disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
              title={t('web.tokenRandomHint')}
            >
              {t('web.tokenRandom')}
            </button>
          </div>
          <p className="mt-2 text-xs text-text-tertiary">
            {t('web.tokenHint')}
          </p>
        </div>
      )}

      {/* 访问信息 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">{t('web.accessInfo')}</h3>
        <div className="text-xs text-text-tertiary space-y-1">
          <p>
            <span className="text-text-secondary">{t('web.accessUrl')}：</span>
            <code className="text-text-primary">
              http://{webConfig.host === '0.0.0.0' ? 'localhost' : webConfig.host}:{displayPort}
            </code>
          </p>
          <p>
            <span className="text-text-secondary">{t('web.accessHint')}：</span>
            {webConfig.authEnabled
              ? t('web.accessHintDescNew')
              : t('web.accessHintDescNoAuth')}
          </p>
        </div>
        {webConfig.enabled && status?.running && (
          <button
            type="button"
            onClick={handleOpenInBrowser}
            className="mt-3 px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={loading || applying}
          >
            {t('web.openInBrowser')}
          </button>
        )}
      </div>

      {/* 二维码 */}
      {webConfig.enabled && status?.running && (
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
                      <code className="text-text-primary">{ip}:{displayPort}</code>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : webConfig.authEnabled && webConfig.token ? (
            <p className="text-xs text-text-tertiary">{t('web.qrNoIp')}</p>
          ) : (
            <p className="text-xs text-text-tertiary">{t('web.qrDisabled')}</p>
          )}
        </div>
      )}
    </div>
  );
}
