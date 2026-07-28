/** Connect — 连接桌面端（可选） */
import { useState } from "react";

interface Props {
  onConnected: () => void;
}

export function ConnectPage({ onConnected }: Props) {
  const [url, setUrl] = useState(() => localStorage.getItem("pocket-server-url") || "");
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(false);

  const test = async () => {
    if (!url.trim()) return;
    setChecking(true);
    try {
      const res = await fetch(url.replace(/\/+$/, "") + "/api/health", { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        localStorage.setItem("pocket-server-url", url.trim());
        setConnected(true);
        onConnected();
      }
    } catch {
      setConnected(false);
    } finally { setChecking(false); }
  };

  const disconnect = () => {
    localStorage.removeItem("pocket-server-url");
    setConnected(false);
    setUrl("");
  };

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">连接桌面端</h2>
      <p className="text-[10px] leading-5 text-text-tertiary">
        连接 Polaris 桌面端后可获取完整工程能力（会话续接、工作区管理、任务调度）。不连接也不影响 Pocket 独立功能。
      </p>
      <div className="rounded-xl border border-border bg-background-elevated p-3 space-y-2">
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="http://192.168.1.10:9830"
          className="w-full rounded border border-border bg-background-surface px-3 py-2 text-sm outline-none" />
        <div className="flex gap-2">
          <button onClick={test} disabled={!url.trim() || checking}
            className="flex-1 rounded bg-primary px-3 py-2 text-sm text-background-base disabled:opacity-40">
            {checking ? "检测中..." : connected ? "已连接" : "连接测试"}
          </button>
          {connected && <button onClick={disconnect} className="rounded border border-danger/50 px-3 py-2 text-sm text-danger">断开</button>}
        </div>
        {connected && <p className="text-xs text-success">✓ 连接成功</p>}
      </div>
    </div>
  );
}