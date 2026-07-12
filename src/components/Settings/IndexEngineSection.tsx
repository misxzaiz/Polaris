/**
 * LspTab 中的"索引引擎"卡片（tree-sitter + SQLite 后端）。
 *
 * 显示：当前 workspace 的索引状态、构建进度、统计、上次构建时间；
 * 操作：重建索引、查看 DB 路径。
 */

import { useEffect, useState } from 'react';
import { Database, Loader2, RefreshCw, AlertTriangle, Zap, FileCode } from 'lucide-react';
import { useLspIndexStore } from '@/stores/lspIndexStore';
import { useLspUiStore } from '@/stores/lspUiStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type { IndexStatus } from '@/services/tauri/lspService';

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function relativeTime(ms: number | null): string {
  if (!ms) return '从未';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function IndexEngineSection() {
  const workspace = useWorkspaceStore((s) => s.getCurrentWorkspace?.()?.path);
  const status = useLspUiStore((s) => {
    if (!workspace) return null;
    return (
      s.indexStatuses[workspace] ??
      Object.values(s.indexStatuses).find((st) =>
        st.workspace ? matchPath(workspace, st.workspace) : false,
      ) ??
      null
    );
  });
  const refresh = useLspIndexStore((s) => s.refresh);
  const rebuild = useLspIndexStore((s) => s.rebuild);
  const ensureOpen = useLspIndexStore((s) => s.ensureOpen);
  const [acting, setActing] = useState(false);

  // 设置页打开时主动刷一次状态
  useEffect(() => {
    if (workspace) {
      void ensureOpen(workspace);
      void refresh(workspace);
    }
  }, [workspace, ensureOpen, refresh]);

  if (!workspace) {
    return (
      <div className="p-3 bg-surface rounded-lg border border-border-subtle">
        <div className="flex items-center gap-2 mb-1">
          <Database size={14} className="text-text-tertiary" />
          <div className="text-sm font-medium text-text-primary">索引引擎</div>
        </div>
        <div className="text-xs text-text-muted">先打开一个工作区</div>
      </div>
    );
  }

  return (
    <div className="p-3 bg-surface rounded-lg border border-border-subtle space-y-3">
      <div className="flex items-center gap-2">
        <Database size={14} className="text-primary" />
        <div className="text-sm font-medium text-text-primary">索引引擎（Java）</div>
        <StateBadge status={status} />
        <div className="ml-auto flex gap-2">
          <button
            onClick={async () => {
              setActing(true);
              try {
                await rebuild(workspace);
              } finally {
                setActing(false);
              }
            }}
            disabled={acting || status?.state === 'building'}
            className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-md text-text-secondary hover:bg-background border border-border-subtle hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
          >
            {acting || status?.state === 'building' ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <RefreshCw size={11} />
            )}
            重建索引
          </button>
        </div>
      </div>

      <div className="text-[11px] text-text-muted leading-relaxed">
        基于 tree-sitter 的 AST 级 Java 索引，支持跨文件跳转、查找引用、import / 同包感知排序。
        索引存于 <code className="text-[10px] bg-background px-1 rounded">.polaris/index.db</code>，文件保存即增量更新。
      </div>

      {status?.state === 'building' && (
        <div>
          <div className="flex items-center justify-between text-[10px] text-text-tertiary mb-1">
            <span>构建中</span>
            <span>
              {status.progressDone} / {status.progressTotal || '…'}
            </span>
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

      {status?.state === 'error' && status.error && (
        <div className="text-[11px] text-danger break-words p-2 bg-danger/5 rounded border border-danger/30">
          {status.error}
        </div>
      )}

      {status && (
        <div className="grid grid-cols-4 gap-2 text-[11px] pt-1 border-t border-border-subtle">
          <Stat icon={<FileCode size={11} />} label="文件" value={fmt(status.files)} />
          <Stat icon={<span className="font-mono text-[10px]">{}</span>} label="符号" value={fmt(status.symbols)} />
          <Stat icon={<span className="font-mono text-[10px]">→</span>} label="引用" value={fmt(status.refs)} />
          <Stat icon={<Zap size={11} />} label="上次构建" value={relativeTime(status.lastBuiltAt)} />
        </div>
      )}
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="text-center">
      <div className="text-text-secondary font-mono flex items-center justify-center gap-1">
        {icon}
        <span>{value}</span>
      </div>
      <div className="text-text-tertiary text-[10px] mt-0.5">{label}</div>
    </div>
  );
}

function StateBadge({ status }: { status: IndexStatus | null }) {
  if (!status) return null;
  switch (status.state) {
    case 'building':
      return (
        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-primary/10 text-primary">
          <Loader2 size={9} className="animate-spin" />
          构建中
        </span>
      );
    case 'ready':
      return (
        <span className="px-1.5 py-0.5 rounded text-[10px] bg-green-400/10 text-green-400">就绪</span>
      );
    case 'error':
      return (
        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-danger/10 text-danger">
          <AlertTriangle size={9} />
          错误
        </span>
      );
    default:
      return (
        <span className="px-1.5 py-0.5 rounded text-[10px] bg-text-tertiary/10 text-text-tertiary">
          空闲
        </span>
      );
  }
}

function matchPath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}
