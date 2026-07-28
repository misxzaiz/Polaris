import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/Common';
import { X } from 'lucide-react';
import {
  getServerUrl,
  getTokenMd5,
  md5Hex,
  storeServerUrl,
  storeTokenMd5,
  getServerHistory,
  addServerToHistory,
  removeServerFromHistory,
  clearServerUrl,
  type ServerHistoryEntry,
} from '@/services/transport/auth';
import { waitForMobileConfig, rebuildTransport, disconnect } from '@/services/transport';
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

/**
 * 显示连接设置页（未连接时）或 连接设置页（已连接后从设置页打开）。
 * 已连接时额外提供"断开连接"按钮。
 */
export function MobileConnectionGate({ children }: MobileConnectionGateProps) {
  const [serverUrl, setServerUrl] = useState(() => getServerUrl());
  const [serverInput, setServerInput] = useState(() => getServerUrl());
  const [tokenInput, setTokenInput] = useState('');
  const [config, setConfig] = useState<Config | null>(null);
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(false);
  const [showSettings, setShowSettings] = useState(() => !getServerUrl());
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ServerHistoryEntry[]>(getServerHistory);

  const reloadHistory = useCallback(() => {
    setHistory(getServerHistory());
  }, []);

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
      addServerToHistory(getServerUrl(), getTokenMd5());
      reloadHistory();
    } catch (err) {
      setConnected(false);
      setError(err instanceof Error ? err.message : String(err));
      setShowSettings(true);
    } finally {
      setChecking(false);
    }
  }, [reloadHistory]);

  useEffect(() => {
    const initialCheck = async () => {
      await waitForMobileConfig();
      await checkConnection();
    };
    void initialCheck();
  }, [checkConnection]);

  /** 用户填写新地址后保存并连接 */
  const saveConnection = async () => {
    const nextUrl = serverInput.trim().replace(/\/$/, '');
    if (!nextUrl) return;

    storeServerUrl(nextUrl);
    if (tokenInput.trim()) {
      storeTokenMd5(await md5Hex(tokenInput.trim()));
    }
    rebuildTransport();
    await checkConnection();
  };

  /** 从历史记录选择地址：自动填入 Token 后连接 */
  const pickFromHistory = async (entry: ServerHistoryEntry) => {
    setServerInput(entry.url);
    setServerUrl(entry.url);
    setTokenInput('');
    // 先写 url，再写 token，确保 saveToMobileBackend 两次写入
    // 第二次覆盖第一次，后端最终状态为正确值（url + token 完整）
    storeServerUrl(entry.url);
    if (entry.tokenMd5) {
      storeTokenMd5(entry.tokenMd5);
    } else {
      storeTokenMd5('');
    }
    rebuildTransport();
    await checkConnection();
  };

  /** 从历史记录中移除单条 */
  const removeHistoryEntry = (url: string) => {
    removeServerFromHistory(url);
    reloadHistory();
  };

  /**
   * 手动断开当前连接。
   * 1. 关闭 WebSocket + 停止自动重连（disconnect）
   * 2. 清除当前地址与 Token，保留历史（clearServerUrl）
   *    await 等待后端清空 RPC 完成，避免与后续 storeServerUrl 的
   *    saveToMobileBackend 并发写写覆盖
   * 3. 回到设置页
   */
  const handleDisconnect = async () => {
    disconnect();
    await clearServerUrl();
    rebuildTransport();
    setConnected(false);
    setConfig(null);
    setServerUrl('');
    setServerInput('');
    setTokenInput('');
    setError(null);
    setShowSettings(true);
    reloadHistory();
  };

  if (showSettings) {
    return (
      <div className="flex h-[100dvh] overflow-y-auto bg-background-base px-5 py-8 text-text-primary">
        <div className="m-auto w-full max-w-md rounded-3xl border border-border bg-background-elevated p-5 shadow-xl">
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

            {history.length > 0 && (
              <div className="space-y-2">
                <span className="text-sm text-text-secondary">最近连接</span>
                <div className="space-y-2">
                  {history.map((entry) => (
                    <div
                      key={entry.url}
                      className="flex items-center justify-between gap-2 rounded-xl border border-border bg-background-surface px-3 py-2.5"
                    >
                      <button
                        type="button"
                        onClick={() => pickFromHistory(entry)}
                        disabled={checking}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span className="truncate text-sm text-text-primary">{entry.url}</span>
                        <span className="block text-xs text-text-tertiary">
                          {entry.tokenMd5 ? '已配 Token' : '无 Token'}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => removeHistoryEntry(entry.url)}
                        className="shrink-0 p-1 text-text-tertiary hover:text-danger"
                        aria-label="删除该历史"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {error && (
              <div className="rounded-xl border border-danger/30 bg-danger-faint px-3 py-2 text-sm text-danger">
                {error}
              </div>
            )}

            <Button onClick={saveConnection} disabled={checking || !serverInput.trim()} className="w-full">
              {checking ? '连接中...' : '保存并连接'}
            </Button>

            {connected && (
              <Button
                onClick={handleDisconnect}
                variant="danger"
                className="w-full"
              >
                断开当前连接
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return <>{children({ config, connected, serverUrl, openSettings: () => setShowSettings(true) })}</>;
}
