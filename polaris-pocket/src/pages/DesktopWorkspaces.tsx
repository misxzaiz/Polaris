/**
 * DesktopWorkspaces — 连接桌面端后的工作区查看页面
 *
 * 参考 polaris-mobile MobileWorkspaces.tsx 的 HTTP 调用模式。
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { clsx } from 'clsx';
import {
  getConfig,
  validateWorkspacePath,
  type Config,
  type WorkspaceEntry,
} from '../services/desktopClient';

export function DesktopWorkspaces() {
  const [config, setConfig] = useState<Config | null>(null);
  const [validation, setValidation] = useState<{ valid: boolean; error?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cfg = await getConfig();
      setConfig(cfg);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const currentWorkspace = useMemo(() => {
    if (!config?.workspaces || !config.currentWorkspaceId) return null;
    return config.workspaces.find((w) => w.id === config.currentWorkspaceId) ?? null;
  }, [config]);

  const allWorkspaces: WorkspaceEntry[] = config?.workspaces ?? [];

  const checkPath = useCallback(async () => {
    const path = currentWorkspace?.path;
    if (!path) {
      setValidation(null);
      return;
    }
    setLoading(true);
    try {
      const result = await validateWorkspacePath(path);
      setValidation(result);
    } catch (err) {
      setValidation({ valid: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }, [currentWorkspace?.path]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void checkPath(); }, [checkPath]);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">工作区</h2>
          <p className="text-[10px] text-text-tertiary">桌面端工作区状态</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-full border border-border p-2 text-text-secondary"
          aria-label="刷新"
        >
          <span className={clsx('inline-block', loading && 'animate-spin')}>⟳</span>
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-[11px] text-danger">{error}</div>
      )}

      {/* 当前工作区 */}
      <div className="rounded-xl border border-border bg-background-elevated p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-primary/10 p-2">
              <span className="text-sm">🏠</span>
            </div>
            <div>
              <div className="text-[11px] font-medium text-text-primary">
                {currentWorkspace?.name || '当前工作区'}
              </div>
              <div className="mt-0.5 text-[10px] text-text-tertiary">
                {currentWorkspace?.path || '未设置工作目录'}
              </div>
            </div>
          </div>
          {validation && (
            <span className={clsx(
              'flex items-center gap-1 text-[10px]',
              validation.valid ? 'text-success' : 'text-danger',
            )}>
              {validation.valid ? '✓ 可用' : '✗ 不可用'}
            </span>
          )}
        </div>
        {validation && !validation.valid && validation.error && (
          <div className="mt-2 rounded-lg border border-warning/30 bg-warning/5 px-2 py-1.5 text-[10px] text-text-secondary">
            {validation.error}
          </div>
        )}
      </div>

      {/* 全部工作区 */}
      {allWorkspaces.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-[11px] font-medium text-text-secondary">全部工作区</h3>
          <div className="space-y-2">
            {allWorkspaces.map((ws) => (
              <div
                key={ws.id}
                className={clsx(
                  'rounded-xl border bg-background-elevated p-3',
                  ws.id === config?.currentWorkspaceId ? 'border-primary/30' : 'border-border',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-medium text-text-primary">{ws.name}</span>
                      {ws.id === config?.currentWorkspaceId && (
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">当前</span>
                      )}
                    </div>
                    <div className="mt-1 truncate text-[10px] text-text-tertiary">{ws.path}</div>
                  </div>
                </div>
                {ws.lastAccessed && (
                  <div className="mt-1 text-[9px] text-text-tertiary">
                    最近访问: {formatTime(ws.lastAccessed)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {allWorkspaces.length === 0 && !currentWorkspace && (
        <div className="rounded-xl border border-border bg-background-elevated p-3">
          <p className="text-[11px] leading-6 text-text-secondary">
            未配置工作区。请在桌面端添加工作区后重试。
          </p>
        </div>
      )}
    </section>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}