import { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Layout, FileExplorer, ConnectingOverlay, ErrorBoundary, ToastContainer } from './components/Common';
import { createLogger } from './utils/logger';

const log = createLogger('App');
import { ConfirmDialog } from './components/Common/ConfirmDialog';

import { TopMenuBar as TopMenuBarComponent } from './components/TopMenuBar';
import { GitPanel } from './components/GitPanel';
import { ActivityBar, LeftPanel, LeftPanelContent, CenterStage, RightPanel } from './components/Layout';
import { EnhancedChatMessages, ChatInput, ChatStatusBar, SessionHistoryPanel, MultiSessionGrid, MultiWindowMenu, NewSessionButton } from './components/Chat';
import type { SettingsTabId } from './components/Settings/SettingsSidebar';
import { SimpleTodoPanel } from './components/TodoPanel/SimpleTodoPanel';
import { TranslatePanel, SelectionContextMenu } from './components/Translate';
import { SchedulerPanel } from './components/Scheduler/SchedulerPanel';
import { RequirementPanel } from './components/RequirementPanel/RequirementPanel';
import { TerminalPanel } from './components/Terminal/TerminalPanel';
import { AssistantPanel } from './assistant';
import { KnowledgePanel } from './components/KnowledgePanel';
import { ProblemsPanel } from './components/Problems/ProblemsPanel';

// 懒加载大型组件，减少初始 bundle 大小
const SettingsModal = lazy(() => import('./components/Settings/SettingsModal').then(m => ({ default: m.SettingsModal })));
const DeveloperPanel = lazy(() => import('./components/Developer/DeveloperPanel').then(m => ({ default: m.DeveloperPanel })));
const IntegrationPanel = lazy(() => import('./components/Integration/IntegrationPanel').then(m => ({ default: m.IntegrationPanel })));
const McpPanel = lazy(() => import('./components/Mcp/McpPanel').then(m => ({ default: m.McpPanel })));
const CreateWorkspaceModal = lazy(() => import('./components/Workspace/CreateWorkspaceModal').then(m => ({ default: m.CreateWorkspaceModal })));
const FileSearchModal = lazy(() => import('./components/Editor/FileSearchModal').then(m => ({ default: m.FileSearchModal })));
const SymbolPalette = lazy(() => import('./components/Editor/SymbolPalette').then(m => ({ default: m.SymbolPalette })));

import { useConfigStore, useViewStore, useWorkspaceStore, useTabStore } from './stores';
import { useActiveSessionActions, useActiveSessionStreaming, useActiveSessionError } from './stores/conversationStore/useActiveSession';
import type { EngineId } from './types';
import './index.css';

// 拆分后的 Hooks
import { useAppInit } from './hooks/useAppInit';
import { useAppEvents } from './hooks/useAppEvents';
import { useWindowManager } from './hooks/useWindowManager';
import { useWorkspaceSync } from './hooks/useWorkspaceSync';

function App() {
  const { t } = useTranslation('common');
  const { isConnecting, connectionState, config, updateConfig } = useConfigStore();

  // Chat 状态
  const isStreaming = useActiveSessionStreaming();
  const error = useActiveSessionError();
  const { sendMessage, interrupt: interruptChat, clearMessages } = useActiveSessionActions();

  // UI 状态
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<string | undefined>(undefined);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [showFileSearch, setShowFileSearch] = useState(false);
  const [showEngineSwitchConfirm, setShowEngineSwitchConfirm] = useState(false);
  const [pendingEngineId, setPendingEngineId] = useState<EngineId | null>(null);

  // Store 状态
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const currentWorkspace = useWorkspaceStore(
    state => state.workspaces.find(w => w.id === state.currentWorkspaceId) || null
  );
  const leftPanelType = useViewStore(state => state.leftPanelType);
  const rightPanelCollapsed = useViewStore(state => state.rightPanelCollapsed);
  const toggleRightPanel = useViewStore(state => state.toggleRightPanel);
  const showSessionHistory = useViewStore(state => state.showSessionHistory);
  const toggleSessionHistory = useViewStore(state => state.toggleSessionHistory);
  const multiSessionMode = useViewStore(state => state.multiSessionMode);
  const openDiffTab = useTabStore(state => state.openDiffTab);
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
  const hasLeftPanel = !isCompact && leftPanelType !== 'none';
  const hasCenterStage = !isCompact && hasOpenTabs;

  // 右侧面板填充模式：无编辑器时自适应填充，有编辑器时固定宽度
  const rightPanelFillRemaining = !hasCenterStage;

  // === 引擎切换 ===
  const applyEngineSwitch = useCallback(async (engineId: EngineId) => {
    if (!config) return;
    if (engineId === config.defaultEngine) return;

    if (isStreaming) {
      try {
        await interruptChat();
      } catch (e) {
        log.warn('Interrupt failed, continuing engine switch', { error: e instanceof Error ? e.message : String(e) });
      }
    }

    clearMessages();
    await updateConfig({ ...config, defaultEngine: engineId });
  }, [config, isStreaming, interruptChat, clearMessages, updateConfig]);

  // === 渲染 ===
  const loadingFallback = (
    <div className="flex items-center justify-center h-full text-text-muted">{t('status.loading')}</div>
  );

  return (
    <ErrorBoundary>
      <Layout>
        {(isConnecting || connectionState === 'failed') && <ConnectingOverlay />}

        <TopMenuBarComponent
          onToggleRightPanel={toggleRightPanel}
          rightPanelCollapsed={rightPanelCollapsed}
          isCompactMode={isCompact}
        />

        <div className="flex flex-1 overflow-hidden relative">
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
                gitContent={<GitPanel onOpenDiffInTab={(diff) => openDiffTab(diff)} />}
                todoContent={<SimpleTodoPanel />}
                translateContent={<TranslatePanel onSendToChat={sendMessage} />}
                schedulerContent={<SchedulerPanel />}
                requirementContent={<RequirementPanel />}
                terminalContent={<TerminalPanel />}
                developerContent={<Suspense fallback={loadingFallback}><DeveloperPanel fillRemaining /></Suspense>}
                integrationContent={<Suspense fallback={loadingFallback}><IntegrationPanel /></Suspense>}
                assistantContent={<AssistantPanel />}
                mcpContent={<Suspense fallback={loadingFallback}><McpPanel /></Suspense>}
                knowledgeContent={<KnowledgePanel />}
                problemsContent={<ProblemsPanel />}
              />
            </LeftPanel>
          )}

          {!isCompact && hasCenterStage && <CenterStage fillRemaining={!rightPanelCollapsed} />}

          {(isCompact || !rightPanelCollapsed) && (
            <RightPanel fillRemaining={rightPanelFillRemaining}>
              {error && (
                <div className="mx-4 mt-4 p-3 bg-danger-faint border border-danger/30 rounded-xl text-danger text-sm shrink-0">
                  {error}
                </div>
              )}

              {multiSessionMode ? (
                <MultiSessionGrid />
              ) : (
                <EnhancedChatMessages />
              )}

              <div className="relative">
                <ToastContainer />
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
              />
            </RightPanel>
          )}
        </div>

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

        {showEngineSwitchConfirm && (
          <ConfirmDialog
            message={t('messages.engineSwitchConfirm', { ns: 'common' })}
            onCancel={() => { setShowEngineSwitchConfirm(false); setPendingEngineId(null); }}
            onConfirm={async () => {
              const nextId = pendingEngineId;
              setShowEngineSwitchConfirm(false);
              setPendingEngineId(null);
              if (nextId) await applyEngineSwitch(nextId);
            }}
          />
        )}

        {showSessionHistory && (
          <div
            className="fixed z-50 bg-[#1A1A1F] border border-border rounded-l-xl shadow-xl animate-in slide-in-from-right duration-200"
            style={{ top: '10%', right: '0', height: '80%', width: 'min(400px, 90vw)' }}
          >
            <SessionHistoryPanel onClose={toggleSessionHistory} />
          </div>
        )}

        <SelectionContextMenu />

        {/* LSP 符号面板（Mod+Shift+O），只有在 LSP keymap 触发后才有内容挂载 */}
        <Suspense fallback={null}>
          <SymbolPalette />
        </Suspense>
      </Layout>
    </ErrorBoundary>
  );
}

export default App;
