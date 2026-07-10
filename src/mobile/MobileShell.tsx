import { MessageSquare, Settings, CheckSquare, FolderKanban } from 'lucide-react';
import type { Config } from '@/types';
import { MobileSessions, type MobileSessionDetail } from './MobileSessions';
import { MobileTasks } from './MobileTasks';
import { MobileWorkspaces } from './MobileWorkspaces';

type MobileTab = 'sessions' | 'tasks' | 'workspaces' | 'settings';

interface MobileShellProps {
  activeTab: MobileTab;
  activeSession: MobileSessionDetail | null;
  config: Config | null;
  connected: boolean;
  serverUrl: string;
  onTabChange: (tab: MobileTab) => void;
  onOpenSession: (session: MobileSessionDetail) => void;
  onCloseSession: () => void;
  onOpenConnectionSettings: () => void;
}

const tabs: Array<{ id: MobileTab; label: string; icon: typeof MessageSquare }> = [
  { id: 'sessions', label: '会话', icon: MessageSquare },
  { id: 'tasks', label: '任务', icon: CheckSquare },
  { id: 'workspaces', label: '工作区', icon: FolderKanban },
  { id: 'settings', label: '设置', icon: Settings },
];

export function MobileShell({
  activeTab,
  activeSession,
  config,
  connected,
  serverUrl,
  onTabChange,
  onOpenSession,
  onCloseSession,
  onOpenConnectionSettings,
}: MobileShellProps) {
  const currentWorkspace = config?.workspaces?.find(workspace => workspace.id === config.currentWorkspaceId);
  const workspacePath = currentWorkspace?.path || config?.workDir || null;

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background-base text-text-primary">
      <header className="shrink-0 border-b border-border bg-background-elevated px-4 pb-3 pt-[calc(env(safe-area-inset-top)+12px)]">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-lg font-semibold">Polaris</div>
            <div className="mt-1 truncate text-xs text-text-tertiary">
              {currentWorkspace?.name || config?.workDir || '未选择工作区'}
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenConnectionSettings}
            className="rounded-full border border-border px-3 py-1.5 text-xs text-text-secondary"
          >
            {connected ? '已连接' : '未连接'}
          </button>
        </div>
        <div className="mt-3 flex items-center gap-2 text-xs text-text-tertiary">
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-success' : 'bg-danger'}`} />
          <span className="truncate">{serverUrl || '未配置服务地址'}</span>
          <span className="shrink-0">{config?.defaultEngine || 'unknown'}</span>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-4 pb-[calc(env(safe-area-inset-bottom)+88px)]">
        {activeTab === 'sessions' && (
          <MobileSessions
            activeSession={activeSession}
            onOpenSession={onOpenSession}
            onCloseSession={onCloseSession}
          />
        )}
        {activeTab === 'tasks' && <MobileTasks workspacePath={workspacePath} />}
        {activeTab === 'workspaces' && <MobileWorkspaces workspacePath={workspacePath} config={config} />}
        {activeTab === 'settings' && (
          <div className="space-y-3">
            <MobilePlaceholder title="设置" description="当前阶段先提供连接状态，后续接入模型与显示设置。" />
            <button
              type="button"
              onClick={onOpenConnectionSettings}
              className="w-full rounded-xl border border-border bg-background-surface px-4 py-3 text-left text-sm"
            >
              连接设置
            </button>
          </div>
        )}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background-elevated/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <div className="grid grid-cols-4 px-2 py-2">
          {tabs.map(tab => {
            const Icon = tab.icon;
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onTabChange(tab.id)}
                className={`flex flex-col items-center gap-1 rounded-xl px-2 py-2 text-xs ${selected ? 'text-primary' : 'text-text-tertiary'}`}
              >
                <Icon size={20} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

function MobilePlaceholder({ title, description }: { title: string; description: string }) {
  return (
    <section className="rounded-2xl border border-border bg-background-elevated p-4 shadow-soft">
      <h2 className="text-base font-semibold text-text-primary">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-text-secondary">{description}</p>
    </section>
  );
}
