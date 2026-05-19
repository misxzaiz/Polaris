import { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Layout, ConnectingOverlay, ErrorBoundary } from './components/Common';
import { createLogger } from './utils/logger';

const log = createLogger('App');

import { TopMenuBar as TopMenuBarComponent } from './components/TopMenuBar';
import { ActivityBar, LayoutShell } from './components/Layout';
import { Dock } from './components/Dock';
import { SessionHistoryPanel } from './components/Chat';
import { SelectionContextMenu } from './components/Translate';
import { CommandPaletteProvider } from './components/CommandPalette';
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
import { useAppearanceSync } from './hooks/useAppearanceSync';
import { useBuiltinCommands } from './hooks/useBuiltinCommands';

function App() {
  const { t } = useTranslation('common');
  const { isConnecting, connectionState } = useConfigStore();

  // 一次性迁移旧 view-store 中的布局偏好 → layout-store (9.2.8 → 9.2.9 升级路径)
  useLayoutStoreMigration();
  // 把新插件按 manifest.defaultSlot 安置到布局; 仅对 "首次见到" 的 module 生效
  usePluginDefaultSlotsSweep();
  // V2: 同步 layoutStore.appearance → :root CSS 变量 + data-* 属性
  useAppearanceSync();
  // V2: 注册 Layout/Navigate/Action 三类内置命令到 commandRegistry
  useBuiltinCommands();

  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<string | undefined>(undefined);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [showFileSearch, setShowFileSearch] = useState(false);

  const workspaces = useWorkspaceStore(state => state.workspaces);
  const currentWorkspace = useWorkspaceStore(
    state => state.workspaces.find(w => w.id === state.currentWorkspaceId) || null
  );
  const activityBarPosition = useLayoutStore(state => state.activityBarPosition);
  const dockMode = useLayoutStore(state => state.appearance.dockMode);
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

  // V2: 根据 appearance.dockMode 决定渲染 Dock 还是 V1 ActivityBar.
  //   - 'expanded' (默认): 新 Dock — 三段结构 + 微标签 + Cmd+K 入口
  //   - 'compact'      : V1 ActivityBar — 兼容回退, 等用户主动切换
  //   - 'floating'     : 暂未实现, 临时落到 ActivityBar 保持可用
  // 接口完全等价 (side / onOpenSettings / forceCollapsed), 互换无副作用.
  const NavBar = dockMode === 'expanded' ? Dock : ActivityBar;
  const renderActivityBar = activityBarPosition === 'hidden' && !isCompact
    ? undefined
    : (
        <NavBar
          side={activityBarPosition === 'right' ? 'right' : 'left'}
          onOpenSettings={() => setShowSettings(true)}
          forceCollapsed={isCompact}
        />
      );

  return (
    <ErrorBoundary>
      <CommandPaletteProvider>
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
      </CommandPaletteProvider>
    </ErrorBoundary>
  );
}

export default App;
