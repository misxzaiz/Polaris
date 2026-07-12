/**
 * 索引引擎状态栏指示器（角标）。
 *
 * 显示当前 workspace 的索引状态：building / ready / error / idle，
 * 点击展开详情卡片，可触发重建。
 */

import { useEffect, useRef, useState } from 'react';
import { Database, Loader2, AlertTriangle, Zap, RefreshCw } from 'lucide-react';
import { useLspUiStore } from '@/stores/lspUiStore';
import { useLspIndexStore } from '@/stores/lspIndexStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type { IndexStatus } from '@/services/tauri/lspService';

function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function relativeTime(ms: number | null): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function IndexStatusBadge() {
  const workspace = useWorkspaceStore((s) => s.getCurrentWorkspace?.()?.path);
  // 用 workspace 路径取最新状态。后端 canonicalize 后的路径可能不同——
  // 最稳妥是兜底：找最近一次 status；这里简单起见用 workspace 直接 lookup。
  const status = useLspUiStore((s) => {
    if (!workspace) return null;
    // 直接 workspace path 找；找不到时遍历找最匹配
    return (
      s.indexStatuses[workspace] ??
      Object.values(s.indexStatuses).find((st) =>
        st.workspace ? matchPath(workspace, st.workspace) : false,
      ) ??
      null
    );
  });
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (
        popRef.current?.contains(e.target as Node) ||
        btnRef.current?.contains(e.target as Node)
      ) {
        return;
      }
      setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  if (!workspace || !status) return null;

  const { icon, label, color } = visualOf(status);

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono transition-colors hover:bg-background-hover ${color}`}
        title={`索引：${label}`}
      >
        {icon}
        {status.state === 'building' ? (
          <span>
            {status.progressDone}/{status.progressTotal || '…'}
          </span>
        ) : (
          <span>{formatNumber(status.symbols)}</span>
        )}
      </button>

      {open && (
        <div
          ref={popRef}
          className="absolute right-0 bottom-full mb-1 w-72 bg-background-elevated border border-border rounded-lg shadow-glow text-xs overflow-hidden"
          style={{ zIndex: 70 }}
        >
          <IndexStatusDetail status={status} workspace={workspace} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

function IndexStatusDetail({
  status,
  workspace,
  onClose,
}: {
  status: IndexStatus;
  workspace: string;
  onClose: () => void;
}) {
  const rebuild = useLspIndexStore((s) => s.rebuild);
  const [rebuilding, setRebuilding] = useState(false);

  async function onRebuild() {
    setRebuilding(true);
    try {
      await rebuild(workspace);
    } finally {
      setRebuilding(false);
    }
  }

  const { icon, label, color } = visualOf(status);

  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className={color}>{icon}</span>
        <span className="font-medium text-text-primary">索引引擎</span>
        <span className="ml-auto text-text-tertiary normal-case">{label}</span>
      </div>

      {status.state === 'building' && (
        <div>
          <div className="text-[10px] text-text-tertiary mb-1">
            构建中：{status.progressDone} / {status.progressTotal || '…'}
          </div>
          <div className="h-1 bg-background rounded overflow-hidden">
            <div
              className="h-full bg-primary transition-all"
              style={{
                width:
                  status.progressTotal > 0
                    ? `${Math.min(100, (status.progressDone * 100) / status.progressTotal)}%`
                    : '10%',
              }}
            />
          </div>
        </div>
      )}

      {status.state === 'error' && status.error && (
        <div className="text-[11px] text-danger break-words">{status.error}</div>
      )}

      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <div className="text-center">
          <div className="text-text-secondary font-mono">{formatNumber(status.files)}</div>
          <div className="text-text-tertiary text-[10px]">文件</div>
        </div>
        <div className="text-center">
          <div className="text-text-secondary font-mono">{formatNumber(status.symbols)}</div>
          <div className="text-text-tertiary text-[10px]">符号</div>
        </div>
        <div className="text-center">
          <div className="text-text-secondary font-mono">{formatNumber(status.refs)}</div>
          <div className="text-text-tertiary text-[10px]">引用</div>
        </div>
      </div>

      {status.lastBuiltAt && (
        <div className="text-[10px] text-text-tertiary">
          上次构建：{relativeTime(status.lastBuiltAt)}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={() => void onRebuild()}
          disabled={rebuilding || status.state === 'building'}
          className="flex-1 flex items-center justify-center gap-1 px-2 py-1 bg-background hover:bg-background-hover border border-border rounded text-[11px] disabled:opacity-50"
        >
          {rebuilding || status.state === 'building' ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
          重建索引
        </button>
        <button
          onClick={onClose}
          className="px-2 py-1 hover:bg-background-hover border border-border rounded text-[11px] text-text-tertiary"
        >
          关闭
        </button>
      </div>
    </div>
  );
}

function visualOf(status: IndexStatus) {
  switch (status.state) {
    case 'building':
      return {
        icon: <Loader2 className="w-3 h-3 animate-spin" />,
        label: '构建中',
        color: 'text-primary',
      };
    case 'ready':
      return {
        icon: <Zap className="w-3 h-3" />,
        label: '就绪',
        color: 'text-green-400',
      };
    case 'error':
      return {
        icon: <AlertTriangle className="w-3 h-3" />,
        label: '错误',
        color: 'text-danger',
      };
    case 'idle':
    default:
      return {
        icon: <Database className="w-3 h-3" />,
        label: '空闲',
        color: 'text-text-tertiary',
      };
  }
}

function matchPath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}
