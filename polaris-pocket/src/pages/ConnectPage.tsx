/**
 * ConnectPage — 连接桌面端（可选）
 *
 * 功能：
 * - 输入桌面端服务地址 + Token
 * - 检测连接健康状态
 * - 支持断开连接
 * - 配置保存到 localStorage
 */
import { useState, useEffect } from "react";

export function ConnectPage() {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [checking, setChecking] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 初始化时读取已保存的配置
  useEffect(() => {
    const savedUrl = localStorage.getItem("pocket-server-url") || "";
    const savedToken = localStorage.getItem("pocket-server-token") || "";
    setUrl(savedUrl);
    setToken(savedToken);
  }, []);

  const checkConnection = async () => {
    setError(null);
    const trimmedUrl = url.trim().replace(/\/+$/, "");
    if (!trimmedUrl) {
      setError("请输入服务地址");
      return;
    }

    setChecking(true);
    try {
      const headers: Record<string, string> = {};
      if (token.trim()) {
        headers["Authorization"] = `Bearer ${token.trim()}`;
      }

      const res = await fetch(`${trimmedUrl}/api/health`, {
        headers,
        signal: AbortSignal.timeout(8000),
      });

      if (res.ok) {
        localStorage.setItem("pocket-server-url", trimmedUrl);
        localStorage.setItem("pocket-server-token", token.trim());
        setConnected(true);
        setError(null);
      } else {
        const statusText = res.statusText || `HTTP ${res.status}`;
        if (res.status === 401 || res.status === 403) {
          setError("Token 无效或已过期，请检查后重试");
        } else {
          setError(`连接被拒绝: ${statusText}`);
        }
        setConnected(false);
      }
    } catch (e: unknown) {
      setConnected(false);
      const msg = (e as Error).message || "连接失败";
      if ((e as Error).name === "TimeoutError" || msg.includes("timeout")) {
        setError("请求超时，请检查地址和桌面端是否开启");
      } else {
        setError(`无法连接: ${msg}`);
      }
    } finally {
      setChecking(false);
    }
  };

  const disconnect = () => {
    localStorage.removeItem("pocket-server-url");
    localStorage.removeItem("pocket-server-token");
    setConnected(false);
    setUrl("");
    setToken("");
    setError(null);
  };

  const canConnect = url.trim() !== "";
  const hasSavedUrl = url.trim() !== "";

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">连接桌面端</h2>
      <p className="text-[10px] leading-5 text-text-tertiary">
        连接 Polaris 桌面端后可获取完整工程能力（会话续接、工作区管理、任务调度）。
        不连接也不影响 Pocket 的独立功能。
      </p>

      <div className="rounded-xl border border-border bg-background-elevated p-3 space-y-2.5">
        {/* 服务地址 */}
        <div>
          <label className="block text-[10px] text-text-tertiary mb-1">
            服务地址
          </label>
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="http://192.168.1.10:9830"
            className="w-full rounded border border-border bg-background-surface px-3 py-2 text-sm outline-none focus:border-primary"
            disabled={checking}
          />
        </div>

        {/* Token */}
        <div>
          <label className="block text-[10px] text-text-tertiary mb-1">
            Token <span className="text-text-tertiary">(可选)</span>
          </label>
          <input
            value={token}
            onChange={e => setToken(e.target.value)}
            type="password"
            placeholder="polaris-token-..."
            className="w-full rounded border border-border bg-background-surface px-3 py-2 text-sm outline-none focus:border-primary"
            disabled={checking}
          />
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-[11px] text-danger">
            {error}
          </div>
        )}

        {/* 按钮 */}
        <div className="flex gap-2">
          <button
            onClick={checkConnection}
            disabled={!canConnect || checking}
            className="flex-1 rounded bg-primary px-3 py-2 text-sm text-background-base disabled:opacity-40"
          >
            {checking ? "检测中..." : connected ? "已连接" : "连接测试"}
          </button>
          {connected && (
            <button
              onClick={disconnect}
              disabled={checking}
              className="rounded border border-danger/50 px-3 py-2 text-sm text-danger disabled:opacity-40"
            >
              断开
            </button>
          )}
        </div>

        {/* 连接成功状态 */}
        {connected && !error && (
          <div className="flex items-center gap-2 text-[11px] text-success">
            <span>✓</span>
            <span>已连接到桌面端</span>
          </div>
        )}
      </div>
    </div>
  );
}
