import { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Layout, ConnectingOverlay, ErrorBoundary } from './components/Common';
import { createLogger } from './utils/logger';

const log = createLogger('App');

import { TopMenuBar as TopMenuBarComponent } from './components/TopMenuBar';
import { ActivityBar, LayoutShell } from './components/Layout';
import { SessionHistoryPanel } from './components/Chat';
import { SelectionContextMenu } from './components/Translate';
import type { SettingsTabId } from './components/Settings/SettingsSidebar';

const SettingsModal = lazy(() => import('./components/Settings/SettingsModal').then(m => ({ default: m.SettingsModal })));
const CreateWorkspaceModal = lazy(() => import('./components/Workspace/CreateWorkspaceModal').then(m => ({ default: m.CreateWorkspaceModal })));
const FileSearchModal = lazy(() => import('./components/Editor/FileSearchModal').then(m => ({ default: m.FileSearchModal })));
const SymbolPalette = lazy(() => import('./components/Editor/SymbolPalette').then(m => ({ default: m.SymbolPalette })));

import { useConfigStore, useViewStore, useWorkspaceStore, useLayoutStore } from './stores';
import { useLayoutStoreMigration } from './stores/layoutStoreMigration';
import { usePluginDefaultSlotsSweep } from './stores/pluginDefaultSlots';
import { startLongGoalSessionTracker } from './services/longGoalSessionTracker';
import './index.css';

import { useAppInit } from './hooks/useAppInit';
import { useAppEvents } from './hooks/useAppEvents';
import { useWindowManager } from './hooks/useWindowManager';
import { useWorkspaceSync } from './hooks/useWorkspaceSync';

function App() {
  const { t } = useTranslation('common');
  const { isConnecting, connectionState } = useConfigStore();

  // 一次性迁移旧 view-store 中的布局偏好 → layout-store (9.2.8 → 9.2.9 升级路径)
  useLayoutStoreMigration();
  // 把新插件按 manifest.defaultSlot 安置到布局; 仅对 "首次见到" 的 module 生效
  usePluginDefaultSlotsSweep();

  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<string | undefined>(undefined);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [showFileSearch, setShowFileSearch] = useState(false);

  const workspaces = useWorkspaceStore(state => state.workspaces);
  const currentWorkspace = useWorkspaceStore(
    state => state.workspaces.find(w => w.id === state.currentWorkspaceId) || null
  );
  const activityBarPosition = useLayoutStore(state => state.activityBarPosition);
  const showSessionHistory = useViewStore(state => state.showSessionHistory);
  const toggleSessionHistory = useViewStore(state => state.toggleSessionHistory);

  useAppInit({
    onNoWorkspaces: useCallback(() => setShowCreateWorkspace(true), []),
  });

  useAppEvents();

  const { isCompact } = useWindowManager({
    onOpenSettings: useCallback((tab?: string) => {
      setSettingsInitialTab(tab);
      setShowSettings(true);
    }, []),
    onToggleFileSearch: useCallback(() => {
      setShowFileSearch(prev => !prev);
    }, []),
  });

  useWorkspaceSync(true);

  useEffect(() => {
    return startLongGoalSessionTracker();
  }, []);

  useEffect(() => {
    log.info('Workspace state updated', {
      workspacesCount: workspaces.length,
      currentWorkspaceId: useWorkspaceStore.getState().currentWorkspaceId,
      currentWorkspace: currentWorkspace ? {
        id: currentWorkspace.id,
        name: currentWorkspace.name,
        path: currentWorkspace.path,
      } : null,
    });
  }, [workspaces, currentWorkspace]);

  // ActivityBar 实例化 (位置由 LayoutShell 根据 layoutStore 决定;hidden 时不渲染)
  const renderActivityBar = activityBarPosition === 'hidden' && !isCompact
    ? undefined
    : (
        <ActivityBar
          side={activityBarPosition === 'right' ? 'right' : 'left'}
          onOpenSettings={() => setShowSettings(true)}
          forceCollapsed={isCompact}
        />
      );

  return (
    <ErrorBoundary>
      <Layout>
        {(isConnecting || connectionState === 'failed' || connectionState === 'needsToken') && <ConnectingOverlay />}

        <TopMenuBarComponent isCompactMode={isCompact} />

        <LayoutShell isCompactMode={isCompact} activityBar={renderActivityBar} />

        {showSettings && (
          <Suspense fallback={<div className="flex items-center justify-center text-text-muted">{t('status.loading')}</div>}>
            <SettingsModal
              initialTab={settingsInitialTab as SettingsTabId | undefined}
              onClose={() => { setShowSettings(false); setSettingsInitialTab(undefined); }}
            />
          </Suspense>
        )}

        {showCreateWorkspace && (
          <Suspense fallback={<div className="flex items-center justify-center text-text-muted">{t('status.loading')}</div>}>
            <CreateWorkspaceModal onClose={() => setShowCreateWorkspace(false)} />
          </Suspense>
        )}

        {showFileSearch && (
          <Suspense fallback={null}>
            <FileSearchModal onClose={() => setShowFileSearch(false)} />
          </Suspense>
        )}

        {showSessionHistory && (
          <div
            className="fixed z-50 bg-background-elevated border border-border rounded-l-xl shadow-xl animate-in slide-in-from-right duration-200"
            style={{ top: '10%', right: '0', height: '80%', width: 'min(400px, 90vw)' }}
          >
            <SessionHistoryPanel onClose={toggleSessionHistory} />
          </div>
        )}

        <SelectionContextMenu />

        <Suspense fallback={null}>
          <SymbolPalette />
        </Suspense>
      </Layout>
    </ErrorBoundary>
  );
}

export default App;
