import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/Common';
import { X, Camera } from 'lucide-react';
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
  parseQrContent,
  type ServerHistoryEntry,
} from '@/services/transport/auth';
import { waitForMobileConfig, rebuildTransport, disconnect } from '@/services/transport';
import { getConfig, healthCheck } from '@/services/tauri/configService';
import { supportsQrScanning } from '@/mobile/platform';
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
  const [showScanner, setShowScanner] = useState(false);
  const [scannerError, setScannerError] = useState<string | null>(null);
  const scannerRef = useRef<{ stop: () => Promise<void> } | null>(null);

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

  /** 启动二维码扫描 */
  const startScanner = useCallback(async () => {
    setScannerError(null);
    try {
      const { Html5Qrcode } = await import('html5-qrcode');
      const scanner = new Html5Qrcode('qr-reader');
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
          // 扫描成功：停止扫描，解析内容，自动填入
          scanner.stop().catch(() => {});
          scannerRef.current = null;
          setShowScanner(false);

          const { serverUrl, token } = parseQrContent(decodedText);
          setServerInput(serverUrl);
          if (token) {
            setTokenInput(token);
            // 自动触发连接
            storeServerUrl(serverUrl);
            md5Hex(token).then(md5 => storeTokenMd5(md5));
            rebuildTransport();
            void checkConnection();
          } else {
            // 无 Token，只填 URL，用户手动输入
            setError('已填入服务地址，如需 Token 请手动输入后连接');
          }
        },
        () => {
          // 非成功回调，不处理
        },
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setScannerError('需要相机权限才能扫码，请在系统设置中开启');
      } else {
        setScannerError('无法启动相机，请尝试手动输入');
      }
    }
  }, [checkConnection]);

  /** 显示扫描器时自动启动相机 */
  useEffect(() => {
    if (showScanner) {
      void startScanner();
    }
  }, [showScanner, startScanner]);

  /** 停止二维码扫描 */
  const stopScanner = useCallback(() => {
    if (scannerRef.current) {
      scannerRef.current.stop().catch(() => {});
      scannerRef.current = null;
    }
    setShowScanner(false);
    setScannerError(null);
  }, []);

  /** 扫描完成时清理 */
  useEffect(() => {
    if (!showScanner) {
      if (scannerRef.current) {
        scannerRef.current.stop().catch(() => {});
        scannerRef.current = null;
      }
    }
  }, [showScanner]);

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
      <>
        <div className="flex h-[100dvh] overflow-y-auto bg-background-base px-5 py-8 text-text-primary">
        <div className="m-auto w-full max-w-md rounded-3xl border border-border bg-background-elevated p-5 shadow-xl">
          <div className="mb-5">
            <h1 className="text-xl font-semibold">连接 Polaris 服务</h1>
            <p className="mt-2 text-sm leading-6 text-text-secondary">
              扫码桌面端设置页的二维码，或手动输入地址。
            </p>
          </div>

          {/* 已连接状态行 */}
          {connected && (
            <div className="mb-4 px-4 py-3 rounded-xl bg-green/5 border border-green/20 flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2 h-2 rounded-full bg-green shrink-0 shadow-[0_0_6px_rgba(166,227,161,0.5)]" />
                <span className="text-sm text-green shrink-0">已连接</span>
                <code className="text-xs text-text-tertiary truncate">{serverUrl}</code>
              </div>
              <button
                onClick={handleDisconnect}
                className="text-xs text-danger/80 hover:text-danger shrink-0 ml-2"
              >
                断开
              </button>
            </div>
          )}

          {/* 扫码按钮 */}
          {supportsQrScanning() && !connected && (
            <div className="mb-4">
              <button
                onClick={() => { setShowScanner(true); setScannerError(null); }}
                className="w-full py-3 px-4 rounded-xl border-2 border-dashed border-primary/40
                           bg-primary/5 text-primary font-medium text-sm
                           flex items-center justify-center gap-2
                           hover:bg-primary/10 transition-colors"
              >
                <Camera size={18} />
                扫描桌面端二维码
              </button>
            </div>
          )}

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

      {/* 相机取景框覆盖层 */}
      {showScanner && (
        <div className="fixed inset-0 z-50 bg-black flex flex-col">
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <button
              onClick={stopScanner}
              className="px-4 py-2 rounded-lg bg-white/15 text-white text-sm"
            >
              取消
            </button>
            <span className="text-white text-sm font-medium">扫描二维码</span>
            <span className="w-16" />
          </div>

          <div className="flex-1 flex items-center justify-center">
            <div className="relative w-64 h-64">
              <div id="qr-reader" className="w-full h-full" />
              {/* 扫描框装饰角 */}
              <div className="absolute top-0 left-0 w-8 h-8 border-t-2 border-l-2 border-primary rounded-tl" />
              <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 border-primary rounded-tr" />
              <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-primary rounded-bl" />
              <div className="absolute bottom-0 right-0 w-8 h-8 border-b-2 border-r-2 border-primary rounded-br" />
            </div>
          </div>

          <div className="text-center text-white/60 text-sm pb-8">
            {scannerError ? (
              <span className="text-danger">{scannerError}</span>
            ) : (
              <span>将二维码对准框内自动扫描</span>
            )}
          </div>
        </div>
      )}
    </>
  );
  }

  return <>{children({ config, connected, serverUrl, openSettings: () => setShowSettings(true) })}</>;
}
