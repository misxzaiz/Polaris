/**
 * ConnectPage — 连接桌面端（可选）
 *
 * 功能：
 * - 输入桌面端服务地址 + Token
 * - 检测连接健康状态
 * - 支持断开连接
 * - 配置保存到 localStorage
 * - 连接成功后显示可用能力列表 + 快速跳转
 * - 各能力卡片可点击进入对应子页面
 */
import { useState, useEffect } from "react";
import { DesktopSessions } from "./DesktopSessions";
import { DesktopTasks } from "./DesktopTasks";
import { DesktopWorkspaces } from "./DesktopWorkspaces";
import {
  md5Hex,
  getServerUrl,
  storeServerUrl,
  storeTokenMd5,
  clearServerUrl,
  getServerHistory,
  addServerToHistory,
  removeServerFromHistory,
  type ServerHistoryEntry,
} from "../services/auth";
import { initTransport, connect, disconnect } from "../services/desktopTransport";

// 连接后可用能力列表
interface Capability {
  key: string;
  icon: string;
  label: string;
  desc: string;
  status: "ready" | "planned";
  statusLabel: string;
}

const CONNECTED_CAPABILITIES: Capability[] = [
  { key: "sessions", icon: "💬", label: "续接桌面会话", desc: "查看和继续桌面端正在进行或最近的 AI 对话", status: "ready", statusLabel: "就绪" },
  { key: "pending", icon: "📋", label: "查看待处理交互", desc: "处理桌面端待回答的问题、待审批的计划", status: "ready", statusLabel: "就绪" },
  { key: "workspaces", icon: "📁", label: "管理工作区", desc: "查看桌面端工作区状态和当前工作目录", status: "ready", statusLabel: "就绪" },
  { key: "tasks", icon: "⏱", label: "查看任务调度", desc: "查看桌面端定时任务状态和运行日志", status: "ready", statusLabel: "就绪" },
];

type ChildView = "sessions" | "pending" | "workspaces" | "tasks" | null;

export function ConnectPage() {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [checking, setChecking] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [childView, setChildView] = useState<ChildView>(null);
  const [history, setHistory] = useState<ServerHistoryEntry[]>([]);

  const reloadHistory = () => setHistory(getServerHistory());

  // 初始化时读取已保存的配置
  useEffect(() => {
    setUrl(getServerUrl());
    // 如果已保存 url，尝试自动连接
    const savedUrl = getServerUrl();
    if (savedUrl) {
      setUrl(savedUrl);
      setConnected(true);
      // 初始化 WS 传输
      initTransport();
      connect().catch(() => {});
      reloadHistory();
    }
    return () => {
      // 组件卸载时不断开（保持全局 WS 连接）
    };
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
      // 计算 Token MD5
      let tokenMd5 = "";
      if (token.trim()) {
        tokenMd5 = await md5Hex(token.trim());
      }

      const headers: Record<string, string> = {};
      if (tokenMd5) {
        headers["Authorization"] = `Bearer ${tokenMd5}`;
      }

      const res = await fetch(`${trimmedUrl}/api/health`, {
        headers,
        signal: AbortSignal.timeout(8000),
      });

      if (res.ok) {
        // 使用 auth.ts 保存
        storeServerUrl(trimmedUrl);
        if (tokenMd5) {
          storeTokenMd5(tokenMd5);
        }
        addServerToHistory(trimmedUrl, tokenMd5 || undefined);
        reloadHistory();

        setConnected(true);
        setError(null);

        // 初始化 WS 传输并连接
        initTransport();
        connect().catch(() => {});

        window.dispatchEvent(new CustomEvent("pocket-connection-changed"));
      } else {
        if (res.status === 401 || res.status === 403) {
          setError("Token 无效或已过期，请检查后重试");
        } else {
          setError(`连接被拒绝: ${res.statusText || `HTTP ${res.status}`}`);
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

  const handleDisconnect = () => {
    disconnect();
    clearServerUrl();
    setConnected(false);
    setUrl("");
    setToken("");
    setError(null);
    setChildView(null);
    reloadHistory();
    window.dispatchEvent(new CustomEvent("pocket-connection-changed"));
  };

  const pickFromHistory = async (entry: ServerHistoryEntry) => {
    setUrl(entry.url);
    setToken("");
    storeServerUrl(entry.url);
    if (entry.tokenMd5) {
      storeTokenMd5(entry.tokenMd5);
    } else {
      storeTokenMd5("");
    }
    initTransport();
    connect().catch(() => {});
    setConnected(true);
    setError(null);
    window.dispatchEvent(new CustomEvent("pocket-connection-changed"));
  };

  const removeHistoryEntry = (serverUrl: string) => {
    removeServerFromHistory(serverUrl);
    reloadHistory();
  };

  const canConnect = url.trim() !== "";

  // ================================================================
  // 子视图：渲染各能力页面
  // ================================================================
  if (childView === "sessions" || childView === "pending") {
    return (
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setChildView(null)}
          className="inline-flex items-center gap-1 text-[11px] text-text-tertiary"
        >
          ← 返回能力列表
        </button>
        <DesktopSessions />
      </div>
    );
  }

  if (childView === "tasks") {
    return (
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setChildView(null)}
          className="inline-flex items-center gap-1 text-[11px] text-text-tertiary"
        >
          ← 返回能力列表
        </button>
        <DesktopTasks />
      </div>
    );
  }

  if (childView === "workspaces") {
    return (
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setChildView(null)}
          className="inline-flex items-center gap-1 text-[11px] text-text-tertiary"
        >
          ← 返回能力列表
        </button>
        <DesktopWorkspaces />
      </div>
    );
  }

  // ================================================================
  // 主视图：连接配置 + 能力列表
  // ================================================================
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

        {/* 历史连接 */}
        {history.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-[10px] text-text-tertiary">最近连接</span>
            {history.map((entry) => (
              <div
                key={entry.url}
                className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background-surface px-2.5 py-2"
              >
                <button
                  type="button"
                  onClick={() => pickFromHistory(entry)}
                  disabled={checking}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="truncate text-[11px] text-text-primary">{entry.url}</span>
                  <span className="block text-[9px] text-text-tertiary">
                    {entry.tokenMd5 ? '已配 Token' : '无 Token'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => removeHistoryEntry(entry.url)}
                  className="shrink-0 p-1 text-text-tertiary hover:text-danger"
                  aria-label="删除该历史"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

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
              onClick={handleDisconnect}
              disabled={checking}
              className="rounded border border-danger/50 px-3 py-2 text-sm text-danger disabled:opacity-40"
            >
              断开
            </button>
          )}
        </div>

        {/* 连接成功状态 + 可用能力入口 */}
        {connected && !error && (
          <>
            <div className="flex items-center gap-2 text-[11px] text-success">
              <span>✓</span>
              <span>已连接到桌面端</span>
            </div>

            {/* 可用能力卡片 — 点击进入对应功能 */}
            <div className="space-y-2">
              <p className="text-[11px] font-semibold text-text-primary">
                连接成功，你可以在 Pocket 中：
              </p>
              {CONNECTED_CAPABILITIES.map((cap) => (
                <button
                  key={cap.key}
                  type="button"
                  onClick={() => setChildView(cap.key as ChildView)}
                  className="w-full flex items-center gap-2 rounded-lg bg-background-surface px-3 py-2.5 text-left hover:bg-background-surface/80 transition-colors"
                >
                  <span className="shrink-0 text-sm">{cap.icon}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-medium text-text-primary">{cap.label}</p>
                    <p className="text-[10px] text-text-tertiary leading-5">{cap.desc}</p>
                  </div>
                  <span className="shrink-0 rounded bg-primary/10 px-2 py-0.5 text-[9px] text-primary">
                    {cap.statusLabel}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}