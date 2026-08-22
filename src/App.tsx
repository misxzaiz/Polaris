import { useEffect, useState, useCallback, useRef, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Layout, ConnectingOverlay, ErrorBoundary, ToastContainer } from './components/Common';
import { FileExplorer } from './components/FileExplorer';
import { createLogger } from './utils/logger';

const log = createLogger('App');

import { TopMenuBar as TopMenuBarComponent } from './components/TopMenuBar';
import { ActivityBar, LeftPanel, LeftPanelContent, LeftPanelDrawer, CenterStage, RightPanel } from './components/Layout';
import { EnhancedChatMessages, ChatInput, ChatStatusBar, SessionHistoryPanel, MultiSessionGrid, MultiWindowMenu, NewSessionButton, CompactHandoffButton, DispatchCenterButton, CompactHandoffProgress, ErrorBanner } from './components/Chat';
import type { EditMode } from './components/Chat';
import type { SettingsTabId } from './components/Settings/SettingsSidebar';
import { OverlayGuard } from './components/Browser/OverlayGuard';
import { SelectionContextMenu } from './components/Translate';

// 懒加载大型组件，减少初始 bundle 大小
const SettingsPage = lazy(() => import('./components/Settings/SettingsPage').then(m => ({ default: m.SettingsPage })));
const DeveloperPanel = lazy(() => import('./components/Developer/DeveloperPanel').then(m => ({ default: m.DeveloperPanel })));
const IntegrationPanel = lazy(() => import('./components/Integration/IntegrationPanel').then(m => ({ default: m.IntegrationPanel })));
const ExecutionConsolePanel = lazy(() => import('./components/ExecutionConsole').then(m => ({ default: m.ExecutionConsolePanel })));
const CreateWorkspaceModal = lazy(() => import('./components/Workspace/CreateWorkspaceModal').then(m => ({ default: m.CreateWorkspaceModal })));
const CreateSessionModal = lazy(() => import('./components/Session/CreateSessionModal').then(m => ({ default: m.CreateSessionModal })));
const FileSearchModal = lazy(() => import('./components/Editor/FileSearchModal').then(m => ({ default: m.FileSearchModal })));
const SymbolPalette = lazy(() => import('./components/Editor/SymbolPalette').then(m => ({ default: m.SymbolPalette })));
const ReferencesPanel = lazy(() => import('./components/Editor/ReferencesPanel').then(m => ({ default: m.ReferencesPanel })));
const DefinitionPeek = lazy(() => import('./components/Editor/DefinitionPeek').then(m => ({ default: m.DefinitionPeek })));

// 懒加载大型面板组件，减少初始 bundle 大小
const GitPanel = lazy(() => import('./components/GitPanel').then(m => ({ default: m.GitPanel })));
const SchedulerPanel = lazy(() => import('./components/Scheduler/SchedulerPanel').then(m => ({ default: m.SchedulerPanel })));
const SimpleTodoPanel = lazy(() => import('./components/TodoPanel/SimpleTodoPanel').then(m => ({ default: m.SimpleTodoPanel })));
const TranslatePanel = lazy(() => import('./components/Translate/TranslatePanel').then(m => ({ default: m.TranslatePanel })));
const RequirementPanel = lazy(() => import('./components/RequirementPanel/RequirementPanel').then(m => ({ default: m.RequirementPanel })));
const TerminalPanel = lazy(() => import('./components/Terminal/TerminalPanel').then(m => ({ default: m.TerminalPanel })));
const DemoPluginPanel = lazy(() => import('./components/Plugins/DemoPluginPanel').then(m => ({ default: m.DemoPluginPanel })));
const BrowserSidebarPanel = lazy(() => import('./components/Browser/BrowserSidebarPanel').then(m => ({ default: m.BrowserSidebarPanel })));
const NotificationCenterPanel = lazy(() => import('./components/Notification/NotificationCenterPanel').then(m => ({ default: m.NotificationCenterPanel })));
const VoiceCompanionOverlay = lazy(() => import('./components/VoiceCompanion/VoiceCompanionOverlay').then(m => ({ default: m.VoiceCompanionOverlay })));
const FocusOverlay = lazy(() => import('./components/FocusMode/FocusOverlay').then(m => ({ default: m.FocusOverlay })));

import { useConfigStore, useViewStore, useWorkspaceStore, useTabStore } from './stores';
import { isPluginUiEnabled, usePluginStore } from './stores/pluginStore';
import { pluginRegistry } from './plugin-system';
import { useActiveSessionActions, useActiveSessionStreaming, useActiveSessionError } from './stores/conversationStore/useActiveSession';
import { useOverlayStore } from './stores/overlayStore';
import { getFileNameFromPath } from './utils/path';
import './index.css';
import './App.css';

// 拆分后的 Hooks
import { useAppInit } from './hooks/useAppInit';
import { usePluginServiceSync } from './hooks/usePluginServiceSync';
import { useAppEvents } from './hooks/useAppEvents';
import { useWindowManager } from './hooks/useWindowManager';
import { useWorkspaceSync } from './hooks/useWorkspaceSync';

function App() {
  const { t } = useTranslation('common');
  const { isConnecting, connectionState } = useConfigStore();

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
  const [settingsInitialTab, setSettingsInitialTab] = useState<string | undefined>(undefined);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);

  // OverlayStore 状态（替代 useState）
  const showSettings = useOverlayStore(s => s.settingsOpen);
  const showCreateSession = useOverlayStore(s => s.createSessionOpen);
  const showFileSearch = useOverlayStore(s => s.fileSearchOpen);

  // Store 状态
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const currentWorkspace = useWorkspaceStore(
    state => state.workspaces.find(w => w.id === state.currentWorkspaceId) || null
  );
  const leftPanelType = useViewStore(state => state.leftPanelType);
  const pluginStates = usePluginStore(state => state.pluginStates);
  const rightPanelCollapsed = useViewStore(state => state.rightPanelCollapsed);
  const terminalFullscreen = useViewStore(state => state.terminalFullscreen);
  const toggleRightPanel = useViewStore(state => state.toggleRightPanel);
  const closeLeftPanel = useViewStore(state => state.closeLeftPanel);
  const activityBarCollapsed = useViewStore(state => state.activityBarCollapsed);
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
    onNoWorkspaces: useCallback(() => {
      setShowCreateWorkspace(true);
      useOverlayStore.getState().increment();
    }, []),
  });

  usePluginServiceSync();

  useAppEvents();

  const { isCompact } = useWindowManager({
    isCreateSessionModalOpen: showCreateSession,
  });

  useWorkspaceSync(true);

  // 监听 polaris:open-settings 自定义事件（从 ContextMeter 等组件触发）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tab?: string } | undefined
      setSettingsInitialTab(detail?.tab)
      useOverlayStore.getState().setSettingsOpen(true)
    }
    window.addEventListener('polaris:open-settings', handler)
    return () => window.removeEventListener('polaris:open-settings', handler)
  }, [])

  // 进入小屏模式时自动关闭左侧面板：leftPanelType 持久化且默认 'files'，
  // 不关闭的话手机首屏会被左面板抽屉直接盖住聊天区
  // 注意：窗口不可见时不触发（防止 Alt+Tab 切回时 resize 瞬态值误触发）
  useEffect(() => {
    if (isCompact && !document.hidden) {
      closeLeftPanel();
    }
  }, [isCompact, closeLeftPanel]);

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
  const hasLeftPanel = leftPanelType !== 'none' &&
    !!activeLeftPanelContribution &&
    isPluginUiEnabled(pluginStates, activeLeftPanelContribution.pluginId);
  // [诊断] 临时：追踪 hasLeftPanel 从 true 变 false 的时刻
  const hasLeftPanelRef = useRef(hasLeftPanel);
  if (hasLeftPanelRef.current && !hasLeftPanel) {
    // eslint-disable-next-line no-console
    console.warn(`[PanelTrace] hasLeftPanel false → leftPanelType="${leftPanelType}" contribution=${!!activeLeftPanelContribution} pluginStates keys=${Object.keys(pluginStates).length}`, new Error().stack?.split('\n').slice(2, 6).join(' | '))
  }
  hasLeftPanelRef.current = hasLeftPanel;
  const hasCenterStage = !isCompact && hasOpenTabs;

  // 右侧面板填充模式：无编辑器时自适应填充，有编辑器时固定宽度
  const rightPanelFillRemaining = !hasCenterStage;

  // 左侧面板自适应填充剩余空间：AI 面板折叠 + 无编辑器打开时 flex-1 撑满，
  // 解决"关闭 AI 面板 + 无打开编辑器 → 左侧面板右侧空一半"问题。
  // 终端全屏模式优先级更高，由 fullscreen 分支单独处理。
  const leftPanelFillRemaining = !hasCenterStage && rightPanelCollapsed && !terminalFullscreen;

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

  // 左侧面板内容：桌面布局停靠在 LeftPanel，小屏模式渲染在 LeftPanelDrawer 抽屉中
  const leftPanelContent = (
    <LeftPanelContent
      filesContent={<FileExplorer />}
      gitContent={
        <Suspense fallback={loadingFallback}>
          <GitPanel
            onOpenDiffInTab={(diff, options) => openDiffTab(diff, options)}
            onOpenFileInEditor={openFileInEditor}
            onOpenWorkbench={openGitWorkbench}
          />
        </Suspense>
      }
      browserContent={<Suspense fallback={loadingFallback}><BrowserSidebarPanel /></Suspense>}
      todoContent={<Suspense fallback={loadingFallback}><SimpleTodoPanel /></Suspense>}
      translateContent={<Suspense fallback={loadingFallback}><TranslatePanel onSendToChat={sendMessage} /></Suspense>}
      schedulerContent={<Suspense fallback={loadingFallback}><SchedulerPanel /></Suspense>}
      requirementContent={<Suspense fallback={loadingFallback}><RequirementPanel /></Suspense>}
      terminalContent={<Suspense fallback={loadingFallback}><TerminalPanel /></Suspense>}
      developerContent={<Suspense fallback={loadingFallback}><DeveloperPanel fillRemaining /></Suspense>}
      integrationContent={<Suspense fallback={loadingFallback}><IntegrationPanel /></Suspense>}
      aiConsoleContent={<Suspense fallback={loadingFallback}><ExecutionConsolePanel /></Suspense>}
      demoPluginContent={<Suspense fallback={loadingFallback}><DemoPluginPanel onSendToChat={sendMessage} /></Suspense>}
    />
  );

  return (
    <ErrorBoundary>
      <Layout>
        {(isConnecting || connectionState === 'needsToken') && <ConnectingOverlay />}

        <TopMenuBarComponent
          onToggleRightPanel={toggleRightPanel}
          rightPanelCollapsed={rightPanelCollapsed}
          isCompactMode={isCompact}
          onOpenSettings={() => useOverlayStore.getState().setSettingsOpen(true)}
        />

        <div className="flex flex-1 overflow-hidden relative">
          {showSettings ? (
            <Suspense fallback={loadingFallback}>
              <SettingsPage
                initialTab={settingsInitialTab as SettingsTabId | undefined}
                onClose={() => { useOverlayStore.getState().setSettingsOpen(false); setSettingsInitialTab(undefined); }}
              />
            </Suspense>
          ) : (
            <>
              <ActivityBar
                onOpenSettings={() => useOverlayStore.getState().setSettingsOpen(true)}
                onToggleRightPanel={toggleRightPanel}
                rightPanelCollapsed={rightPanelCollapsed}
                forceCollapsed={isCompact || activityBarCollapsed}
              />

              {!isCompact && hasLeftPanel && (
                <LeftPanel fillRemaining={leftPanelFillRemaining} fullscreen={terminalFullscreen}>
                  {leftPanelContent}
                </LeftPanel>
              )}

              {/* 小屏模式：左侧面板以覆盖式抽屉渲染，保证扇形菜单各功能入口可用 */}
              {isCompact && hasLeftPanel && (
                <LeftPanelDrawer onClose={closeLeftPanel}>
                  {leftPanelContent}
                </LeftPanelDrawer>
              )}

              {/* 终端全屏时让位，不渲染编辑器 */}
              {!isCompact && hasCenterStage && !terminalFullscreen && <CenterStage fillRemaining={!rightPanelCollapsed} />}

              {(isCompact || (!rightPanelCollapsed && !terminalFullscreen)) && (
                <RightPanel fillRemaining={rightPanelFillRemaining} forceShow={isCompact}>
                  {error && <ErrorBanner error={error} />}

                  {multiSessionMode ? (
                    <MultiSessionGrid onEditMessage={handleEditMessage} />
                  ) : (
                    <EnhancedChatMessages onEditMessage={handleEditMessage} />
                  )}

                  <ChatInput
                    onSend={sendMessage}
                    onInterrupt={interruptChat}
                    disabled={!currentWorkspace}
                    isStreaming={isStreaming}
                    editMode={editMode}
                    onCancelEdit={handleCancelEdit}
                    onEditSend={handleEditSend}
                    statusBarSlot={
                      <ChatStatusBar embedded>
                        <MultiWindowMenu />
                        <NewSessionButton />
                        <CompactHandoffButton />
                        <DispatchCenterButton />
                      </ChatStatusBar>
                    }
                  />
                </RightPanel>
              )}
            </>
          )}
        </div>

        {/* 压缩交接后台进度胶囊（右下角，不阻塞界面） */}
        <CompactHandoffProgress />

        {showCreateWorkspace && (
          <Suspense fallback={<div className="flex items-center justify-center text-text-muted">{t('status.loading')}</div>}>
            <CreateWorkspaceModal onClose={() => { setShowCreateWorkspace(false); useOverlayStore.getState().decrement(); }} />
          </Suspense>
        )}

        {/* Ctrl/Cmd+Shift+'+' 唤出：选择主工作区/关联工作区新建会话 */}
        {showCreateSession && (
          <Suspense fallback={null}>
            <CreateSessionModal
              onClose={() => useOverlayStore.getState().setCreateSessionOpen(false)}
              onCreated={() => {
                // createSession 已切换活跃会话，这里等一帧后请求聚焦输入框
                requestAnimationFrame(() => {
                  window.dispatchEvent(new CustomEvent('chat:focus-input'));
                });
              }}
            />
          </Suspense>
        )}

        {showFileSearch && (
          <Suspense fallback={null}>
            <FileSearchModal onClose={() => useOverlayStore.getState().setFileSearchOpen(false)} />
          </Suspense>
        )}

        {showSessionHistory && (
          <OverlayGuard>
            <div
              className="fixed z-50 bg-background-elevated border border-border rounded-l-xl shadow-xl animate-in slide-in-from-right duration-200"
              style={{ top: '10%', right: '0', height: '80%', width: 'min(400px, 90vw)' }}
            >
              <SessionHistoryPanel onClose={toggleSessionHistory} />
            </div>
          </OverlayGuard>
        )}

        {/* 全局消息中心：右侧滑出，复用会话历史面板的浮层范式 */}
        {showNotificationCenter && (
          <OverlayGuard>
            <div
              className="fixed z-50 bg-background-elevated border border-border rounded-l-xl shadow-xl animate-in slide-in-from-right duration-200"
              style={{ top: '10%', right: '0', height: '80%', width: 'min(400px, 90vw)' }}
            >
              <Suspense fallback={null}>
                <NotificationCenterPanel onClose={toggleNotificationCenter} />
              </Suspense>
            </div>
          </OverlayGuard>
        )}

        <SelectionContextMenu />

        {/* 全局 Toast 通知：挂载在视图切换之外，经 Portal 渲染到 body，浮于所有面板/弹窗之上 */}
        <ToastContainer />

        {/* LSP 符号面板（Mod+Shift+O），只有在 LSP keymap 触发后才有内容挂载 */}
        <Suspense fallback={null}>
          <SymbolPalette />
        </Suspense>

        {/* LSP 查找引用面板（Shift+F12），仅在触发后挂载内容 */}
        <Suspense fallback={null}>
          <ReferencesPanel />
        </Suspense>

        {/* LSP 跳转定义多候选浮窗（Ctrl+Click / 跳定义快捷键） */}
        <Suspense fallback={null}>
          <DefinitionPeek />
        </Suspense>

        {/* 语音伙伴「小陈」：未打开时渲染悬浮入口，打开时全屏通话界面 */}
        <Suspense fallback={null}>
          <VoiceCompanionOverlay />
        </Suspense>

        {/* 全局阅读聚焦模式：L1 语义高亮 / L2 聚光灯遮罩，pointer-events:none 不阻断交互 */}
        <Suspense fallback={null}>
          <FocusOverlay />
        </Suspense>
      </Layout>
    </ErrorBoundary>
  );
}

export default App;
