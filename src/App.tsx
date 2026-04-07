import { useEffect, useState, useRef, lazy, Suspense, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Layout, FileExplorer, ConnectingOverlay, ErrorBoundary, ToastContainer } from './components/Common';
import { ConfirmDialog } from './components/Common/ConfirmDialog';

import { TopMenuBar as TopMenuBarComponent } from './components/TopMenuBar';
import { GitPanel } from './components/GitPanel';
import { ActivityBar, LeftPanel, LeftPanelContent, CenterStage, RightPanel } from './components/Layout';
import { EnhancedChatMessages, ChatInput, ChatStatusBar, SessionHistoryPanel, MultiSessionGrid, MultiSessionToggle, MultiSessionRowsToggle, MultiSessionWidthPopover, NewSessionButton } from './components/Chat';
import type { SettingsTabId } from './components/Settings/SettingsSidebar';
import { SimpleTodoPanel } from './components/TodoPanel/SimpleTodoPanel';
import { TranslatePanel, SelectionContextMenu } from './components/Translate';
import { SchedulerPanel } from './components/Scheduler/SchedulerPanel';
import { RequirementPanel } from './components/RequirementPanel/RequirementPanel';
import { TerminalPanel } from './components/Terminal/TerminalPanel';

// 懒加载大型组件，减少初始 bundle 大小
// 这些组件使用命名导出，所以需要使用 then 提取
const SettingsModal = lazy(() => import('./components/Settings/SettingsModal').then(m => ({ default: m.SettingsModal })));
const DeveloperPanel = lazy(() => import('./components/Developer/DeveloperPanel').then(m => ({ default: m.DeveloperPanel })));
const CreateWorkspaceModal = lazy(() => import('./components/Workspace/CreateWorkspaceModal').then(m => ({ default: m.CreateWorkspaceModal })));
import { useConfigStore, useEventChatStore, useViewStore, useWorkspaceStore, useTabStore, useIntegrationStore, useGitStore, useSessionStore, getSessionEffectiveWorkspace } from './stores';
import { sessionStoreManager } from './stores/conversationStore';
import { useActiveSessionActions, useActiveSessionStreaming, useActiveSessionError } from './stores/conversationStore/useActiveSession';
import { useWindowSize } from './hooks';
import * as tauri from './services/tauri';
import { bootstrapEngines } from './core/engine-bootstrap';
import { bootstrapAgents } from './core/agent-bootstrap';
import { bootstrapTools } from './core/tool-bootstrap';
import { listen } from '@tauri-apps/api/event';
import './index.css';
import type { EngineId } from './types';
import { createLogger } from './utils/logger';

const log = createLogger('App');

function App() {
  const { t } = useTranslation('common');
  const { isConnecting, connectionState, loadConfig, config, updateConfig } = useConfigStore();
  const {
    initializeEventListeners,
    clearMessages,
    setDependencies,
  } = useEventChatStore();
  
  // 使用新架构的状态和操作
  const isStreaming = useActiveSessionStreaming()
  const error = useActiveSessionError()
  const { sendMessage, interrupt: interruptChat } = useActiveSessionActions();
  
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const currentWorkspace = useWorkspaceStore(state => state.getCurrentWorkspace());
  const currentWorkspacePath = currentWorkspace?.path;

  // 添加日志用于诊断
  useEffect(() => {
    console.log('[App] 工作区状态更新', {
      workspacesCount: workspaces.length,
      currentWorkspaceId: useWorkspaceStore.getState().currentWorkspaceId,
      currentWorkspace: currentWorkspace ? {
        id: currentWorkspace.id,
        name: currentWorkspace.name,
        path: currentWorkspace.path,
      } : null,
    });
  }, [workspaces, currentWorkspace]);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<string | undefined>(undefined);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [showEngineSwitchConfirm, setShowEngineSwitchConfirm] = useState(false);
  const [pendingEngineId, setPendingEngineId] = useState<EngineId | null>(null);
  // 使用 ref 确保初始化只执行一次
  const isInitialized = useRef(false);
  const hasCheckedWorkspaces = useRef(false);
  const {
    // 新布局状态
    leftPanelType,
    rightPanelCollapsed,
    toggleRightPanel,
    // 小屏模式
    compactMode,
    updateCompactMode,
    // 会话历史面板
    showSessionHistory,
    toggleSessionHistory,
    // 多会话窗口模式
    multiSessionMode,
  } = useViewStore();
  const { openDiffTab, tabs } = useTabStore();
  const hasOpenTabs = tabs.length > 0;

  // 窗口尺寸监听 - 小屏模式检测
  const { width: windowWidth, height: windowHeight, isCompact } = useWindowSize({ compactThreshold: 500 });

  // 同步小屏模式状态到 store
  useEffect(() => {
    if (compactMode.isCompactMode !== isCompact ||
        compactMode.windowWidth !== windowWidth ||
        compactMode.windowHeight !== windowHeight) {
      updateCompactMode({
        isCompactMode: isCompact,
        windowWidth,
        windowHeight,
      });
    }
  }, [isCompact, windowWidth, windowHeight, compactMode, updateCompactMode]);

  // 计算各面板的显示状态
  // 小屏模式下隐藏左侧面板和中间编辑区
  const hasLeftPanel = !isCompact && leftPanelType !== 'none';
  const hasCenterStage = !isCompact && hasOpenTabs;
  const hasRightPanel = !rightPanelCollapsed;

  // 计算各面板是否需要填充剩余空间
  // 左侧面板：只有在没有中间编辑区和右侧面板时才填充
  const leftPanelFillRemaining = hasLeftPanel && !hasCenterStage && !hasRightPanel;
  // 中间编辑区：只有在没有右侧面板时才填充
  const centerStageFillRemaining = hasCenterStage && !hasRightPanel;
  // 右侧面板：只有在没有中间编辑区时才填充（不管有没有左侧面板）
  const rightPanelFillRemaining = !hasCenterStage;

  const applyEngineSwitch = useCallback(async (engineId: EngineId) => {
    if (!config) return;
    if (engineId === config.defaultEngine) return;

    if (isStreaming) {
      try {
        await interruptChat();
      } catch (e) {
        console.warn('[App] 中断失败，继续切换引擎:', e);
      }
    }

    clearMessages();

    await updateConfig({
      ...config,
      defaultEngine: engineId,
    });
  }, [config, isStreaming, interruptChat, clearMessages, updateConfig]);

  // 初始化配置（只执行一次）
  useEffect(() => {
    const initializeApp = async () => {
      // 双重检查：防止 Strict Mode 或其他原因导致重复执行
      if (isInitialized.current) return;
      isInitialized.current = true;

      try {
        // 先加载配置，获取默认引擎
        await loadConfig();

        // 获取配置
        const config = useConfigStore.getState().config;
        const defaultEngine = config?.defaultEngine || 'claude-code';

        // 注册 OpenAI Providers（如果有）
        // 按需初始化传统 AI Engine
        await bootstrapEngines(defaultEngine as any);

        // 初始化 Agent 系统
        await bootstrapAgents();

        // 注册 AI 工具
        bootstrapTools();

        // 注入外部依赖（解耦 Store 间依赖）
        setDependencies({
          gitActions: {
            refreshStatusDebounced: (workspacePath) =>
              useGitStore.getState().refreshStatusDebounced(workspacePath),
          },
          configActions: {
            getConfig: () => useConfigStore.getState().config,
          },
          workspaceActions: {
            getCurrentWorkspace: () => useWorkspaceStore.getState().getCurrentWorkspace(),
            getWorkspaces: () => useWorkspaceStore.getState().workspaces,
            getContextWorkspaces: () => useWorkspaceStore.getState().getContextWorkspaces(),
            getCurrentWorkspaceId: () => useWorkspaceStore.getState().currentWorkspaceId,
            getWorkspaceById: (id: string) => useWorkspaceStore.getState().workspaces.find(w => w.id === id) || null,
          },
          sessionSyncActions: {
            getActiveSessionId: () => useSessionStore.getState().activeSessionId,
            getSessionMessages: (sessionId: string) => {
              const state = useSessionStore.getState().getSessionMessages(sessionId)
              return state ? {
                messages: state.messages,
                archivedMessages: state.archivedMessages,
                conversationId: state.conversationId,
              } : undefined
            },
            setSessionMessages: (sessionId: string, state: { messages: unknown[]; archivedMessages?: unknown[]; conversationId?: string | null }) => {
              useSessionStore.getState().setSessionMessages(sessionId, state)
            },
            updateSessionStatus: (sessionId: string, status: 'idle' | 'running' | 'waiting' | 'error') => {
              useSessionStore.getState().updateSessionStatus(sessionId, status)
            },
            updateSessionExternalId: (sessionId: string, externalSessionId: string) => {
              useSessionStore.getState().updateSessionExternalId(sessionId, externalSessionId)
            },
            getSessionEffectiveWorkspace: (sessionId: string) => {
              const session = useSessionStore.getState().sessions.get(sessionId)
              if (!session) return null
              return getSessionEffectiveWorkspace(session, useWorkspaceStore.getState().currentWorkspaceId)
            },
            getSessionContextWorkspaceIds: (sessionId: string) => {
              const session = useSessionStore.getState().sessions.get(sessionId)
              return session?.contextWorkspaceIds || []
            },
          },
        });

        // 恢复窗口透明度（初始使用大窗透明度，后续根据窗口尺寸自动切换）
        if (config?.window) {
          const initialOpacity = (config.window.normalOpacity ?? 100) / 100;
          if (initialOpacity < 1.0) {
            document.documentElement.style.setProperty('--window-opacity', String(initialOpacity));
            log.info(`窗口透明度已恢复: ${initialOpacity}`);
          }
        }

        // 初始化集成管理器并自动连接 QQ Bot（如果配置了）
        const qqbotConfig = config?.qqbot;
        if (qqbotConfig?.enabled && qqbotConfig.instances.length > 0) {
          log.info('QQ Bot 已启用，开始初始化...');
          try {
            const { initialize, startPlatform } = useIntegrationStore.getState();
            await initialize(qqbotConfig);

            // 查找激活实例或第一个启用的实例
            const activeInstance = qqbotConfig.activeInstanceId
              ? qqbotConfig.instances.find(i => i.id === qqbotConfig.activeInstanceId)
              : qqbotConfig.instances.find(i => i.enabled);

            // 如果实例配置了自动连接，则启动连接
            if (activeInstance && activeInstance.autoConnect !== false) {
              log.info('自动连接 QQ Bot...');
              await startPlatform('qqbot');
            }
          } catch (error) {
            log.error('QQ Bot 初始化失败', error as Error);
          }
        }
      } catch (error) {
        log.error('初始化失败', error as Error);
        // 失败时重置标志，允许重试
        isInitialized.current = false;
      }
    };

    initializeApp();

    // 组件卸载时清理 IntegrationStore 资源
    return () => {
      const { cleanup } = useIntegrationStore.getState();
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 单独的 effect：检查工作区状态
  // 使用 ref 确保只检查一次，避免重复弹出模态框
  useEffect(() => {
    if (hasCheckedWorkspaces.current) return;

    // zustand persist 是异步恢复的，需要等待 workspaces 加载完成
    // 如果 workspaces 为空数组且已经过了初始化阶段，说明真的没有工作区
    if (workspaces.length === 0 && isInitialized.current) {
      console.log('[App] 无工作区，显示创建工作区模态框');
      setShowCreateWorkspace(true);
      hasCheckedWorkspaces.current = true;
    } else if (workspaces.length > 0) {
      // 有工作区，标记已检查
      hasCheckedWorkspaces.current = true;
    }
  }, [workspaces.length]);

  // 同步当前工作区路径到后端配置
  useEffect(() => {
    if (!currentWorkspacePath || !isInitialized.current) return;

    const syncWorkspace = async () => {
      try {
        await tauri.setWorkDir(currentWorkspacePath);
        console.log('[App] 工作区路径已同步:', currentWorkspacePath);
      } catch (error) {
        console.error('[App] 同步工作区路径失败:', error);
      }
    };

    syncWorkspace();
  }, [currentWorkspacePath]);

  // 监听窗口透明度变化并应用（根据当前模式选择对应透明度）
  useEffect(() => {
    const windowSettings = config?.window;
    if (!windowSettings) return;

    // 根据当前模式选择透明度，转换为 0-1 范围
    const opacityValue = isCompact
      ? (windowSettings.compactOpacity ?? 100) / 100
      : (windowSettings.normalOpacity ?? 100) / 100;

    document.documentElement.style.setProperty('--window-opacity', String(opacityValue));
  }, [config?.window, isCompact]);

  // 注意：崩溃保存和恢复功能已由 zustand persist 中间件自动处理
  // 不再需要手动监听 app:crash-save 和 app:recover 事件

  // 监听导航到设置页面事件
  useEffect(() => {
    const handleNavigateToSettings = (e: CustomEvent<{ tab?: string }>) => {
      setSettingsInitialTab(e.detail?.tab);
      setShowSettings(true);
    };

    window.addEventListener('navigate-to-settings', handleNavigateToSettings as EventListener);
    return () => window.removeEventListener('navigate-to-settings', handleNavigateToSettings as EventListener);
  }, []);

  // 监听工作区切换事件，清除聊天错误
  useEffect(() => {
    const handleWorkspaceSwitched = () => {
      // 清除聊天相关的错误提示
      const { error } = useEventChatStore.getState();
      if (error) {
        useEventChatStore.getState().setError(null);
      }
    };

    window.addEventListener('workspace-switched', handleWorkspaceSwitched);
    return () => window.removeEventListener('workspace-switched', handleWorkspaceSwitched);
  }, []);

  // 初始化事件监听器（事件驱动架构核心）
  // 注意：store 内部已有 _eventListenersInitialized 状态防止重复初始化
  // 使用 ref 存储 cleanup 函数，确保即使 Promise 后 resolve 也能正确清理
  const eventListenerCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let mounted = true;

    // 初始化 SessionStoreManager
    sessionStoreManager.getState().initialize().then(() => {
      if (mounted) {
        console.log('[App] SessionStoreManager 初始化完成');
      }
    });

    initializeEventListeners().then((cleanup) => {
      if (mounted) {
        eventListenerCleanupRef.current = cleanup;
      }
    });

    return () => {
      mounted = false;
      // 使用 ref 确保总是能获取到最新的 cleanup 函数
      eventListenerCleanupRef.current?.();
      eventListenerCleanupRef.current = null;
    };
  }, [initializeEventListeners]);

    // 监听文件打开事件,创建 Editor Tab
    useEffect(() => {
      const unlistenPromise = listen('file:opened', (event: any) => {
        const { path, name } = event.payload;
        console.log('[App] 收到 file:opened 事件:', { path, name });
        // 创建 Editor Tab
        useTabStore.getState().openEditorTab(path, name);
      });

      return () => {
        unlistenPromise.then(unlisten => unlisten());
      };
    }, []);

    // 监听文件预览事件,创建 Preview Tab
    useEffect(() => {
      const unlistenPromise = listen('file:preview', (event: any) => {
        const { path, name, kind } = event.payload;
        console.log('[App] 收到 file:preview 事件:', { path, name, kind });
        useTabStore.getState().openPreviewTab(path, name, { kind });
      });

      return () => {
        unlistenPromise.then(unlisten => unlisten());
      };
    }, []);

    // 监听编辑器关闭事件，自动隐藏编辑器视图（事件驱动解耦）
    useEffect(() => {
      const unlistenPromise = listen('editor:closed', () => {
        console.log('[App] 收到 editor:closed 事件，隐藏编辑器视图');
        useViewStore.getState().setShowEditor(false);
      });

      return () => {
        unlistenPromise.then(unlisten => unlisten());
      };
    }, []);

  // F12 快捷键 - 切换 DevTools
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === 'F12') {
        e.preventDefault();
        try {
          await tauri.invoke('toggle_devtools');
        } catch (error) {
          log.error('切换 DevTools 失败', error as Error);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <ErrorBoundary>
      <Layout>
        {/* 连接中蒙板 */}
        {(isConnecting || connectionState === 'failed') && <ConnectingOverlay />}

      {/* 顶部菜单栏 - 小屏模式下简化 */}
      <TopMenuBarComponent
        onToggleRightPanel={toggleRightPanel}
        rightPanelCollapsed={rightPanelCollapsed}
        isCompactMode={isCompact}
      />

      {/* 主内容区域 - 正常模式和小窗模式统一布局 */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Activity Bar - 仅正常模式显示 */}
        {!isCompact && (
          <ActivityBar
            onOpenSettings={() => setShowSettings(true)}
            onToggleRightPanel={toggleRightPanel}
            rightPanelCollapsed={rightPanelCollapsed}
          />
        )}

        {/* 左侧可切换面板 - 仅正常模式显示 */}
        {!isCompact && hasLeftPanel && (
          <LeftPanel fillRemaining={leftPanelFillRemaining}>
            <LeftPanelContent
              filesContent={<FileExplorer />}
              gitContent={
                <GitPanel
                  onOpenDiffInTab={(diff) => {
                    openDiffTab(diff);
                  }}
                />
              }
              todoContent={<SimpleTodoPanel />}
              translateContent={<TranslatePanel onSendToChat={sendMessage} />}
              schedulerContent={<SchedulerPanel />}
              requirementContent={<RequirementPanel />}
              terminalContent={<TerminalPanel />}
              developerContent={
                <Suspense fallback={<div className="flex items-center justify-center h-full text-text-muted">{t('status.loading')}</div>}>
                  <DeveloperPanel fillRemaining />
                </Suspense>
              }
            />
          </LeftPanel>
        )}

        {/* 中间编辑区 (Tab 系统) - 仅正常模式显示 */}
        {!isCompact && hasCenterStage && <CenterStage fillRemaining={centerStageFillRemaining} />}

        {/* 右侧 AI 对话面板 - 小窗模式始终显示，正常模式可折叠 */}
        {(isCompact || !rightPanelCollapsed) && (
          <RightPanel fillRemaining={isCompact || rightPanelFillRemaining}>
          {/* 错误提示 */}
          {error && (
            <div className="mx-4 mt-4 p-3 bg-danger-faint border border-danger/30 rounded-xl text-danger text-sm shrink-0">
              {error}
            </div>
          )}

          {/* 消息区域 - 根据多会话模式选择渲染 */}
          {multiSessionMode ? (
            <MultiSessionGrid />
          ) : (
            <EnhancedChatMessages />
          )}

          {/* 状态栏容器（带通知） */}
          <div className="relative">
            {/* Toast 通知区域 */}
            <ToastContainer />

            {/* 对话状态栏 */}
            <ChatStatusBar>
              {/* 多会话切换按钮 */}
              <MultiSessionToggle />
              {/* 行数切换（多窗口模式时显示） */}
              <MultiSessionRowsToggle />
              {/* 格子宽度设置（多窗口模式时显示） */}
              <MultiSessionWidthPopover />
              {/* 新建会话按钮 */}
              <NewSessionButton />
            </ChatStatusBar>
          </div>

          {/* 输入区域 */}
          <ChatInput
            onSend={sendMessage}
            onInterrupt={interruptChat}
            disabled={!currentWorkspace}
            isStreaming={isStreaming}
          />
        </RightPanel>
        )}
      </div>

      {/* 设置模态框 */}
      {showSettings && (
        <Suspense fallback={<div className="flex items-center justify-center text-text-muted">{t('status.loading')}</div>}>
          <SettingsModal
            initialTab={settingsInitialTab as SettingsTabId | undefined}
            onClose={() => {
              setShowSettings(false);
              setSettingsInitialTab(undefined);
            }}
          />
        </Suspense>
      )}

      {showCreateWorkspace && (
        <Suspense fallback={<div className="flex items-center justify-center text-text-muted">{t('status.loading')}</div>}>
          <CreateWorkspaceModal onClose={() => setShowCreateWorkspace(false)} />
        </Suspense>
      )}

      {showEngineSwitchConfirm && (
        <ConfirmDialog
          message={t('messages.engineSwitchConfirm', { ns: 'common' })}
          onCancel={() => {
            setShowEngineSwitchConfirm(false);
            setPendingEngineId(null);
          }}
          onConfirm={async () => {
            const nextId = pendingEngineId;
            setShowEngineSwitchConfirm(false);
            setPendingEngineId(null);
            if (nextId) {
              await applyEngineSwitch(nextId);
            }
          }}
        />
      )}

      {/* 会话历史面板 - 右侧悬浮 */}
      {showSessionHistory && (
        <div
          className="fixed z-50 bg-background-elevated border border-border rounded-l-xl shadow-xl animate-in slide-in-from-right duration-200"
          style={{
            top: '10%',
            right: '0',
            height: '80%',
            width: '400px'
          }}
        >
          <SessionHistoryPanel onClose={toggleSessionHistory} />
        </div>
      )}

      {/* 全局右键菜单 */}
      <SelectionContextMenu />

      </Layout>
    </ErrorBoundary>
  );
}

export default App;
