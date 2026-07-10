import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/Common';
import { getServerUrl, md5Hex, storeServerUrl, storeTokenMd5 } from '@/services/transport/auth';
import { getConfig, healthCheck } from '@/services/tauri/configService';
import type { Config } from '@/types';

interface MobileConnectionGateProps {
  children: (state: MobileConnectionState) => ReactNode;
}

export interface MobileConnectionState {
  config: Config | null;
  connected: boolean;
  serverUrl: string;
  openSettings: () => void;
}

function isMobileTauriRuntime(): boolean {
  return typeof navigator !== 'undefined' &&
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) &&
    ('__TAURI_INTERNALS__' in window);
}

/**
 * 尝试从移动端 Rust 后端读取已持久化的服务配置。
 * 仅限移动 Tauri 环境；返回 null 表示不可用或未配置。
 */
async function tryLoadMobileServerConfig(): Promise<{ serverUrl: string; token: string } | null> {
  if (!isMobileTauriRuntime()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const config = await invoke<{ serverUrl?: string; server_url?: string; token?: string }>('get_server_config');
    const serverUrl = config?.serverUrl || config?.server_url || '';
    const token = config?.token || '';
    if (!serverUrl) return null;
    return { serverUrl, token };
  } catch {
    return null;
  }
}

export function MobileConnectionGate({ children }: MobileConnectionGateProps) {
  const [serverUrl, setServerUrl] = useState(() => getServerUrl());
  const [serverInput, setServerInput] = useState(() => getServerUrl());
  const [tokenInput, setTokenInput] = useState('');
  const [config, setConfig] = useState<Config | null>(null);
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(false);
  const [showSettings, setShowSettings] = useState(() => !getServerUrl());
  const [error, setError] = useState<string | null>(null);

  const checkConnection = useCallback(async () => {
    if (!getServerUrl()) {
      setConnected(false);
      setShowSettings(true);
      return;
    }

    setChecking(true);
    setError(null);
    try {
      const [nextConfig] = await Promise.all([getConfig(), healthCheck()]);
      setConfig(nextConfig);
      setConnected(true);
      setServerUrl(getServerUrl());
      setServerInput(getServerUrl());
      setShowSettings(false);
    } catch (err) {
      setConnected(false);
      setError(err instanceof Error ? err.message : String(err));
      setShowSettings(true);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    // 启动时若 localStorage 为空，尝试从移动后端回填隐藏配置
    // 解决 Tauri 启动时序：transport 的 loadMobileServerConfig 异步完成前，
    // Gate 已 mount 且 getServerUrl() 还空 → 立即显示配置页的竞态。
    const initialCheck = async () => {
      if (getServerUrl()) {
        await checkConnection();
        return;
      }
      const backendConfig = await tryLoadMobileServerConfig();
      if (backendConfig) {
        storeServerUrl(backendConfig.serverUrl);
        if (backendConfig.token) {
          storeTokenMd5(backendConfig.token);
        }
        // 填入后再跑连接检查
        await checkConnection();
        return;
      }
      // 无后端配置 → 显示设置页（checkConnection 也会走到 setShowSettings(true)）
      await checkConnection();
    };

    void initialCheck();
  }, [checkConnection]);

  const saveConnection = async () => {
    const nextUrl = serverInput.trim().replace(/\/$/, '');
    if (!nextUrl) return;

    storeServerUrl(nextUrl);
    if (tokenInput.trim()) {
      storeTokenMd5(await md5Hex(tokenInput.trim()));
    }
    await checkConnection();
  };

  if (showSettings) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background-base px-5 py-8 text-text-primary">
        <div className="w-full max-w-md rounded-3xl border border-border bg-background-elevated p-5 shadow-xl">
          <div className="mb-5">
            <h1 className="text-xl font-semibold">连接 Polaris 服务</h1>
            <p className="mt-2 text-sm leading-6 text-text-secondary">
              请输入桌面端或 Web 服务地址。连接成功后，移动端会进入专用界面。
            </p>
          </div>

          <div className="space-y-4">
            <label className="block space-y-2">
              <span className="text-sm text-text-secondary">服务地址</span>
              <input
                value={serverInput}
                onChange={(event) => setServerInput(event.target.value)}
                placeholder="http://192.168.1.10:9830"
                className="w-full rounded-xl border border-border bg-background-base px-3 py-3 text-sm text-text-primary outline-none focus:border-primary"
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm text-text-secondary">访问 Token（可选）</span>
              <input
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
                type="password"
                className="w-full rounded-xl border border-border bg-background-base px-3 py-3 text-sm text-text-primary outline-none focus:border-primary"
              />
            </label>

            {error && (
              <div className="rounded-xl border border-danger/30 bg-danger-faint px-3 py-2 text-sm text-danger">
                {error}
              </div>
            )}

            <Button onClick={saveConnection} disabled={checking || !serverInput.trim()} className="w-full">
              {checking ? '连接中...' : '保存并连接'}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return <>{children({ config, connected, serverUrl, openSettings: () => setShowSettings(true) })}</>;
}
