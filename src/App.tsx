import { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Layout, FileExplorer, ConnectingOverlay, ErrorBoundary, ToastContainer } from './components/Common';
import { createLogger } from './utils/logger';

const log = createLogger('App');

import { TopMenuBar as TopMenuBarComponent } from './components/TopMenuBar';
import { GitPanel } from './components/GitPanel';
import { ActivityBar, LeftPanel, LeftPanelContent, CenterStage, RightPanel } from './components/Layout';
import { EnhancedChatMessages, ChatInput, ChatStatusBar, SessionHistoryPanel, MultiSessionGrid, MultiWindowMenu, NewSessionButton, ErrorBanner } from './components/Chat';
import type { EditMode } from './components/Chat';
import type { SettingsTabId } from './components/Settings/SettingsSidebar';
import { SimpleTodoPanel } from './components/TodoPanel/SimpleTodoPanel';
import { TranslatePanel, SelectionContextMenu } from './components/Translate';
import { SchedulerPanel } from './components/Scheduler/SchedulerPanel';
import { RequirementPanel } from './components/RequirementPanel/RequirementPanel';
import { TerminalPanel } from './components/Terminal/TerminalPanel';
import { ProblemsPanel } from './components/Problems/ProblemsPanel';
import { DemoPluginPanel } from './components/Plugins/DemoPluginPanel';
import { ComicStudioPanel } from './components/ComicStudio';
import { NotificationCenterPanel } from './components/Notification';
import { VoiceCompanionOverlay } from './components/VoiceCompanion';

// 懒加载大型组件，减少初始 bundle 大小
const SettingsPage = lazy(() => import('./components/Settings/SettingsPage').then(m => ({ default: m.SettingsPage })));
const DeveloperPanel = lazy(() => import('./components/Developer/DeveloperPanel').then(m => ({ default: m.DeveloperPanel })));
const IntegrationPanel = lazy(() => import('./components/Integration/IntegrationPanel').then(m => ({ default: m.IntegrationPanel })));
const ExecutionConsolePanel = lazy(() => import('./components/ExecutionConsole').then(m => ({ default: m.ExecutionConsolePanel })));
const CreateWorkspaceModal = lazy(() => import('./components/Workspace/CreateWorkspaceModal').then(m => ({ default: m.CreateWorkspaceModal })));
const FileSearchModal = lazy(() => import('./components/Editor/FileSearchModal').then(m => ({ default: m.FileSearchModal })));
const SymbolPalette = lazy(() => import('./components/Editor/SymbolPalette').then(m => ({ default: m.SymbolPalette })));

import { useConfigStore, useViewStore, useWorkspaceStore, useTabStore } from './stores';
import { isPluginUiEnabled, usePluginStore } from './stores/pluginStore';
import { pluginRegistry } from './plugin-system';
import { useActiveSessionActions, useActiveSessionStreaming, useActiveSessionError } from './stores/conversationStore/useActiveSession';
import { getFileNameFromPath } from './utils/path';
import './index.css';

// 拆分后的 Hooks
import { useAppInit } from './hooks/useAppInit';
import { useAppEvents } from './hooks/useAppEvents';
import { useWindowManager } from './hooks/useWindowManager';
import { useWorkspaceSync } from './hooks/useWorkspaceSync';

function App() {
  const { t } = useTranslation('common');
  const { connectionState } = useConfigStore();

  // Chat 状态
  const isStreaming = useActiveSessionStreaming();
  const error = useActiveSessionError();
  const { sendMessage, interrupt: interruptChat, editAndResend } = useActiveSessionActions();

  // 编辑模式状态
  const [editMode, setEditMode] = useState<EditMode | null>(null);
  const handleEditMessage = useCallback((messageId: string, content: string) => {
    setEditMode({ messageId, content });
  }, []);
  const handleCancelEdit = useCallback(() => {
    setEditMode(null);
  }, []);
  const handleEditSend = useCallback((messageId: string, newContent: string, _workspaceDir?: string) => {
    editAndResend(messageId, newContent);
    setEditMode(null);
  }, [editAndResend]);

  // UI 状态
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<string | undefined>(undefined);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [showFileSearch, setShowFileSearch] = useState(false);
  // 连接诊断面板：静默加载下默认不弹，由顶栏连接状态指示器按需唤出
  const [showConnectionDiagnostics, setShowConnectionDiagnostics] = useState(false);

  // Store 状态
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const currentWorkspace = useWorkspaceStore(
    state => state.workspaces.find(w => w.id === state.currentWorkspaceId) || null
  );
  const leftPanelType = useViewStore(state => state.leftPanelType);
  const pluginStates = usePluginStore(state => state.pluginStates);
  const rightPanelCollapsed = useViewStore(state => state.rightPanelCollapsed);
  const toggleRightPanel = useViewStore(state => state.toggleRightPanel);
  const closeLeftPanel = useViewStore(state => state.closeLeftPanel);
  const showSessionHistory = useViewStore(state => state.showSessionHistory);
  const toggleSessionHistory = useViewStore(state => state.toggleSessionHistory);
  const showNotificationCenter = useViewStore(state => state.showNotificationCenter);
  const toggleNotificationCenter = useViewStore(state => state.toggleNotificationCenter);
  const multiSessionMode = useViewStore(state => state.multiSessionMode);
  const openDiffTab = useTabStore(state => state.openDiffTab);
  const openGitTab = useTabStore(state => state.openGitTab);
  const openEditorTab = useTabStore(state => state.openEditorTab);
  const hasOpenTabs = useTabStore(state => state.tabs.length > 0);

  // === 拆分后的 Hooks ===
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

  // 连接恢复后自动收起诊断面板
  useEffect(() => {
    if (connectionState === 'success') {
      setShowConnectionDiagnostics(false);
    }
  }, [connectionState]);

  // === 诊断日志 ===
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

  // === 面板显示状态 ===
  const activeLeftPanelContribution = pluginRegistry
    .listViewContributions('activityBar')
    .find(view => view.panelType === leftPanelType);
  const hasLeftPanel = !isCompact &&
    leftPanelType !== 'none' &&
    !!activeLeftPanelContribution &&
    isPluginUiEnabled(pluginStates, activeLeftPanelContribution.pluginId);
  const hasCenterStage = !isCompact && hasOpenTabs;

  // 右侧面板填充模式：无编辑器时自适应填充，有编辑器时固定宽度
  const rightPanelFillRemaining = !hasCenterStage;

  const openGitWorkbench = useCallback((options?: { initialGitTab?: string }) => {
    openGitTab(options);
    closeLeftPanel();
    if (!rightPanelCollapsed) {
      toggleRightPanel();
    }
  }, [closeLeftPanel, openGitTab, rightPanelCollapsed, toggleRightPanel]);

  const openFileInEditor = useCallback((filePath: string) => {
    openEditorTab(filePath, getFileNameFromPath(filePath));
  }, [openEditorTab]);

  // === 渲染 ===
  const loadingFallback = (
    <div className="flex items-center justify-center h-full text-text-muted">{t('status.loading')}</div>
  );

  return (
    <ErrorBoundary>
      <Layout>
        {(connectionState === 'needsToken' || showConnectionDiagnostics) && (
          <ConnectingOverlay
            onClose={connectionState === 'needsToken' ? undefined : () => setShowConnectionDiagnostics(false)}
          />
        )}

        <TopMenuBarComponent
          onToggleRightPanel={toggleRightPanel}
          rightPanelCollapsed={rightPanelCollapsed}
          isCompactMode={isCompact}
          onShowConnectionDiagnostics={() => setShowConnectionDiagnostics(true)}
        />

        <div className="flex flex-1 overflow-hidden relative">
          {showSettings ? (
            <Suspense fallback={loadingFallback}>
              <SettingsPage
                initialTab={settingsInitialTab as SettingsTabId | undefined}
                onClose={() => { setShowSettings(false); setSettingsInitialTab(undefined); }}
              />
            </Suspense>
          ) : (
            <>
              <ActivityBar
                onOpenSettings={() => setShowSettings(true)}
                onToggleRightPanel={toggleRightPanel}
                rightPanelCollapsed={rightPanelCollapsed}
                forceCollapsed={isCompact}
              />

              {!isCompact && hasLeftPanel && (
                <LeftPanel>
                  <LeftPanelContent
                    filesContent={<FileExplorer />}
                    gitContent={(
                      <GitPanel
                        onOpenDiffInTab={(diff, options) => openDiffTab(diff, options)}
                        onOpenFileInEditor={openFileInEditor}
                        onOpenWorkbench={openGitWorkbench}
                      />
                    )}
                    todoContent={<SimpleTodoPanel />}
                    translateContent={<TranslatePanel onSendToChat={sendMessage} />}
                    schedulerContent={<SchedulerPanel />}
                    requirementContent={<RequirementPanel />}
                    terminalContent={<TerminalPanel />}
                    developerContent={<Suspense fallback={loadingFallback}><DeveloperPanel fillRemaining /></Suspense>}
                    integrationContent={<Suspense fallback={loadingFallback}><IntegrationPanel /></Suspense>}
                    aiConsoleContent={<Suspense fallback={loadingFallback}><ExecutionConsolePanel /></Suspense>}
                    problemsContent={<ProblemsPanel />}
                    demoPluginContent={<DemoPluginPanel onSendToChat={sendMessage} />}
                    comicStudioContent={<ComicStudioPanel />}
                  />
                </LeftPanel>
              )}

              {!isCompact && hasCenterStage && <CenterStage fillRemaining={!rightPanelCollapsed} />}

              {(isCompact || !rightPanelCollapsed) && (
                <RightPanel fillRemaining={rightPanelFillRemaining}>
                  {error && <ErrorBanner error={error} />}

                  {multiSessionMode ? (
                    <MultiSessionGrid />
                  ) : (
                    <EnhancedChatMessages onEditMessage={handleEditMessage} />
                  )}

                  <div className="relative">
                    <ChatStatusBar>
                      <MultiWindowMenu />
                      <NewSessionButton />
                    </ChatStatusBar>
                  </div>

                  <ChatInput
                    onSend={sendMessage}
                    onInterrupt={interruptChat}
                    disabled={!currentWorkspace}
                    isStreaming={isStreaming}
                    editMode={editMode}
                    onCancelEdit={handleCancelEdit}
                    onEditSend={handleEditSend}
                  />
                </RightPanel>
              )}
            </>
          )}
        </div>

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

        {/* 全局消息中心：右侧滑出，复用会话历史面板的浮层范式 */}
        {showNotificationCenter && (
          <div
            className="fixed z-50 bg-background-elevated border border-border rounded-l-xl shadow-xl animate-in slide-in-from-right duration-200"
            style={{ top: '10%', right: '0', height: '80%', width: 'min(400px, 90vw)' }}
          >
            <NotificationCenterPanel onClose={toggleNotificationCenter} />
          </div>
        )}

        <SelectionContextMenu />

        {/* 全局 Toast 通知：挂载在视图切换之外，经 Portal 渲染到 body，浮于所有面板/弹窗之上 */}
        <ToastContainer />

        {/* LSP 符号面板（Mod+Shift+O），只有在 LSP keymap 触发后才有内容挂载 */}
        <Suspense fallback={null}>
          <SymbolPalette />
        </Suspense>

        {/* 语音伙伴「小白」：未打开时渲染悬浮入口，打开时全屏通话界面 */}
        <VoiceCompanionOverlay />
      </Layout>
    </ErrorBoundary>
  );
}

export default App;
