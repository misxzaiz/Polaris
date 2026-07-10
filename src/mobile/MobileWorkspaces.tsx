import { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderKanban, RefreshCw, CheckCircle2, XCircle, Home } from 'lucide-react';
import { invoke } from '@/services/transport';
import type { WorkspaceEntry } from '@/types/config';

interface MobileWorkspacesProps {
  workspacePath: string | null;
  config: { workspaces?: WorkspaceEntry[]; currentWorkspaceId?: string } | null;
}

interface PathValidation {
  valid: boolean;
  error?: string;
}

export function MobileWorkspaces({ workspacePath, config }: MobileWorkspacesProps) {
  const [validation, setValidation] = useState<PathValidation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentWorkspace = useMemo(() => {
    if (!config?.workspaces || !config.currentWorkspaceId) return null;
    return config.workspaces.find(w => w.id === config.currentWorkspaceId) ?? null;
  }, [config]);

  const allWorkspaces = useMemo(() => {
    return config?.workspaces ?? [];
  }, [config]);

  const validatePath = useCallback(async () => {
    const path = workspacePath || currentWorkspace?.path;
    if (!path) {
      setValidation(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<PathValidation>('validate_workspace_path', { path });
      setValidation(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setValidation(null);
    } finally {
      setLoading(false);
    }
  }, [workspacePath, currentWorkspace?.path]);

  useEffect(() => {
    void validatePath();
  }, [validatePath]);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">工作区</h2>
          <p className="text-xs text-text-tertiary">当前工作区与关联项目</p>
        </div>
        <button
          type="button"
          onClick={() => void validatePath()}
          className="rounded-full border border-border p-2 text-text-secondary"
          aria-label="刷新工作区状态"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-danger/30 bg-danger-faint px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {/* 当前工作区 */}
      <div className="rounded-2xl border border-border bg-background-elevated p-4 shadow-soft">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-primary-faint p-2">
              <Home size={18} className="text-primary" />
            </div>
            <div>
              <div className="text-sm font-medium text-text-primary">
                {currentWorkspace?.name || '当前工作区'}
              </div>
              <div className="mt-0.5 text-xs text-text-tertiary">
                {workspacePath || currentWorkspace?.path || '未设置工作目录'}
              </div>
            </div>
          </div>
          {validation && (
            <div className="flex items-center gap-1 text-xs">
              {validation.valid ? (
                <span className="flex items-center gap-1 text-success">
                  <CheckCircle2 size={13} />
                  可用
                </span>
              ) : (
                <span className="flex items-center gap-1 text-danger">
                  <XCircle size={13} />
                  不可用
                </span>
              )}
            </div>
          )}
        </div>
        {validation && !validation.valid && validation.error && (
          <div className="mt-3 rounded-xl border border-warning/30 bg-warning-faint px-3 py-2 text-xs text-text-secondary">
            {validation.error}
          </div>
        )}
      </div>

      {/* 全部工作区列表 */}
      {allWorkspaces.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-text-secondary">全部工作区</h3>
          <div className="grid grid-cols-1 gap-2">
            {allWorkspaces.map(ws => (
              <div
                key={ws.id}
                className={`rounded-2xl border bg-background-elevated p-3 shadow-soft ${
                  ws.id === config?.currentWorkspaceId
                    ? 'border-primary/30'
                    : 'border-border'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-primary">{ws.name}</span>
                      {ws.id === config?.currentWorkspaceId && (
                        <span className="rounded-full bg-primary-faint px-2 py-0.5 text-[10px] text-primary">
                          当前
                        </span>
                      )}
                    </div>
                    <div className="mt-1 truncate text-xs text-text-tertiary">{ws.path}</div>
                  </div>
                  <FolderKanban size={15} className="shrink-0 text-text-tertiary" />
                </div>
                {ws.lastAccessed && (
                  <div className="mt-2 text-[10px] text-text-tertiary">
                    最近访问: {formatTime(ws.lastAccessed)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {allWorkspaces.length === 0 && !workspacePath && (
        <div className="rounded-2xl border border-border bg-background-elevated p-4 shadow-soft">
          <p className="text-sm leading-6 text-text-secondary">
            未配置工作区。请在桌面端添加工作区后，在移动端查看。
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