import { useEffect, useState, useRef, lazy, Suspense, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Layout, FileExplorer, ResizeHandle, ConnectingOverlay, ErrorBoundary, ToastContainer } from './components/Common';
import { ConfirmDialog } from './components/Common/ConfirmDialog';

import { EnhancedChatMessages, ChatInput } from './components/Chat';
import { ToolPanel } from './components/ToolPanel';
import { TopMenuBar as TopMenuBarComponent } from './components/TopMenuBar';
import { GitPanel } from './components/GitPanel';
import { ActivityBar, LeftPanel, LeftPanelContent, CenterStage, RightPanel } from './components/Layout';
import { SimpleTodoPanel } from './components/TodoPanel/SimpleTodoPanel';
import { TranslatePanel, SelectionContextMenu } from './components/Translate';
import { SchedulerPanel } from './components/Scheduler/SchedulerPanel';
import { TerminalPanel } from './components/Terminal/TerminalPanel';

// 懒加载大型组件，减少初始 bundle 大小
// 这些组件使用命名导出，所以需要使用 then 提取
const SettingsModal = lazy(() => import('./components/Settings/SettingsModal').then(m => ({ default: m.SettingsModal })));
const DeveloperPanel = lazy(() => import('./components/Developer/DeveloperPanel').then(m => ({ default: m.DeveloperPanel })));
const CreateWorkspaceModal = lazy(() => import('./components/Workspace/CreateWorkspaceModal').then(m => ({ default: m.CreateWorkspaceModal })));
const SessionHistoryPanel = lazy(() => import('./components/Chat/SessionHistoryPanel').then(m => ({ default: m.SessionHistoryPanel })));
import { useConfigStore, useEventChatStore, useViewStore, useWorkspaceStore, useFloatingWindowStore, useTabStore, useIntegrationStore } from './stores';
import * as tauri from './services/tauri';
import { bootstrapEngines, bootstrapOpenAIProviders } from './core/engine-bootstrap';
import { bootstrapAgents } from './core/agent-bootstrap';
import { bootstrapTools } from './core/tool-bootstrap';
import { listen, emit } from '@tauri-apps/api/event';
import './index.css';
import type { EngineId } from './types';

function App() {
  const { t } = useTranslation('common');
  const { healthStatus, isConnecting, connectionState, loadConfig, config, updateConfig } = useConfigStore();
  const {
    isStreaming,
    sendMessage,
    interruptChat,
    error,
    restoreFromStorage,
    saveToStorage,
    initializeEventListeners,
    messages,
    clearMessages,
  } = useEventChatStore();
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
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [showEngineSwitchConfirm, setShowEngineSwitchConfirm] = useState(false);
  const [pendingEngineId, setPendingEngineId] = useState<EngineId | null>(null);
  // 使用 ref 确保初始化只执行一次
  const isInitialized = useRef(false);
  const hasCheckedWorkspaces = useRef(false);
  const lastOpenAIProvidersRef = useRef<string>(JSON.stringify([]));
  const lastActiveProviderIdRef = useRef<string | undefined>(undefined);
  const mouseLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const {
    showToolPanel,
    showDeveloperPanel,
    showSessionHistory,
    toolPanelWidth,
    developerPanelWidth,
    setToolPanelWidth,
    setDeveloperPanelWidth,
    toggleSessionHistory,
    // 新布局状态
    leftPanelWidth,
    leftPanelType,
  } = useViewStore();
  const { showFloatingWindow } = useFloatingWindowStore();
  const { openDiffTab } = useTabStore();

  const engineOptions = useMemo(() => {
    const options: { id: EngineId; name: string }[] = [
      { id: 'claude-code', name: 'Claude Code' },
      { id: 'iflow', name: 'IFlow' },
      { id: 'codex', name: 'Codex' },
    ];

    if (config?.openaiProviders && config.openaiProviders.length > 0) {
      for (const provider of config.openaiProviders) {
        if (!provider.enabled) continue;
        options.push({
          id: provider.id as EngineId,
          name: provider.name || provider.id,
        });
      }
    }

    return options;
  }, [config?.openaiProviders]);

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

    const isProvider = engineId.startsWith('provider-');
    const nextConfig = {
      ...config,
      defaultEngine: engineId,
      activeProviderId: isProvider ? engineId : config.activeProviderId,
    };
    await updateConfig(nextConfig);
  }, [config, isStreaming, interruptChat, clearMessages, updateConfig]);

  const handleEngineSelect = useCallback((engineId: EngineId) => {
    if (!config) return;
    if (engineId === config.defaultEngine) return;
    setPendingEngineId(engineId);
    setShowEngineSwitchConfirm(true);
  }, [config]);

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
        console.log('[App] 检查 OpenAI Providers 配置:', {
          hasProviders: !!config?.openaiProviders,
          providerCount: config?.openaiProviders?.length || 0,
          activeProviderId: config?.activeProviderId
        })

        if (config?.openaiProviders && config.openaiProviders.length > 0) {
          console.log('[App] 开始注册 OpenAI Providers:', config.openaiProviders.map(p => ({ id: p.id, name: p.name, enabled: p.enabled })))
          await bootstrapOpenAIProviders(config.openaiProviders, config.activeProviderId)
          console.log('[App] OpenAI Providers 注册完成')

          // 记录初始配置，用于后续变化检测
          lastOpenAIProvidersRef.current = JSON.stringify(config.openaiProviders)
          lastActiveProviderIdRef.current = config.activeProviderId
        } else {
          console.log('[App] 没有 OpenAI Providers 需要注册')
          lastOpenAIProvidersRef.current = JSON.stringify([])
          lastActiveProviderIdRef.current = undefined
        }

        // 按需初始化传统 AI Engine
        const codexConfig = {
          executablePath: config?.codex.cliPath || 'codex',
        };

        await bootstrapEngines(defaultEngine as any, codexConfig);

        // 初始化 Agent 系统
        await bootstrapAgents();

        // 注册 AI 工具
        bootstrapTools();

        // 尝试从本地存储恢复聊天状态
        const restored = restoreFromStorage();
        if (restored) {
          console.log('[App] 已从崩溃中恢复聊天状态');
        }

        // 初始化集成管理器并自动连接 QQ Bot（如果配置了）
        const qqbotConfig = config?.qqbot;
        if (qqbotConfig?.enabled && qqbotConfig?.appId && qqbotConfig?.clientSecret) {
          console.log('[App] QQ Bot 已启用，开始初始化...');
          try {
            const { initialize, startPlatform } = useIntegrationStore.getState();
            await initialize(qqbotConfig);

            // 如果配置了自动连接，则启动连接
            if (qqbotConfig.autoConnect !== false) {
              console.log('[App] 自动连接 QQ Bot...');
              await startPlatform('qqbot');
            }
          } catch (error) {
            console.error('[App] QQ Bot 初始化失败:', error);
          }
        }
      } catch (error) {
        console.error('[App] 初始化失败:', error);
        // 失败时重置标志，允许重试
        isInitialized.current = false;
      }
    };

    initializeApp();
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

  // 监听 OpenAI Providers 配置变化，自动重新注册引擎
  useEffect(() => {
    // 跳过初始化阶段
    if (!isInitialized.current) return;

    const currentProvidersJson = JSON.stringify(config?.openaiProviders || []);
    const currentActiveProviderId = config?.activeProviderId;

    // 检查是否有变化
    const providersChanged = lastOpenAIProvidersRef.current !== currentProvidersJson;
    const activeProviderChanged = lastActiveProviderIdRef.current !== currentActiveProviderId;

    if (providersChanged || activeProviderChanged) {
      console.log('[App] 检测到 OpenAI Providers 配置变化，重新注册引擎');

      // 更新 ref
      lastOpenAIProvidersRef.current = currentProvidersJson;
      lastActiveProviderIdRef.current = currentActiveProviderId;

      // 重新注册 OpenAI Providers
      if (config?.openaiProviders && config.openaiProviders.length > 0) {
        bootstrapOpenAIProviders(config.openaiProviders, config.activeProviderId).catch(error => {
          console.error('[App] 重新注册 OpenAI Providers 失败:', error);
        });
      } else {
        // 如果没有 Providers 了，清理所有 provider 引擎
        import('./engines/openai-provider').then(({ clearOpenAIProviderEngines }) => {
          clearOpenAIProviderEngines().catch(console.error);
        });
      }
    }
  }, [config?.openaiProviders, config?.activeProviderId]);

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

  // 监听崩溃保存事件
  useEffect(() => {
    const handleCrashSave = () => {
      console.log('[App] 检测到崩溃信号，保存状态...');
      saveToStorage();
    };

    window.addEventListener('app:crash-save', handleCrashSave);
    return () => window.removeEventListener('app:crash-save', handleCrashSave);
  }, [saveToStorage]);

  // 监听恢复事件
  useEffect(() => {
    const handleRecover = () => {
      console.log('[App] 收到恢复信号...');
      const restored = restoreFromStorage();
      if (restored) {
        window.location.reload();
      }
    };

    window.addEventListener('app:recover', handleRecover);
    return () => window.removeEventListener('app:recover', handleRecover);
  }, [restoreFromStorage]);

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
  const eventListenersCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (eventListenersCleanupRef.current) return; // 已经初始化过了
    
    let mounted = true;
    initializeEventListeners().then((cleanup) => {
      if (mounted) {
        eventListenersCleanupRef.current = cleanup;
      }
    });
    
    return () => {
      mounted = false;
      if (eventListenersCleanupRef.current) {
        eventListenersCleanupRef.current();
      }
    };
  }, [initializeEventListeners]);

  // 窗口焦点检测 - 自动切换到悬浮窗模式
  useEffect(() => {
    // 只在配置启用且模式为 auto 时才监听
    const floatingConfig = config?.floatingWindow
    if (!floatingConfig?.enabled || floatingConfig.mode !== 'auto') {
      return
    }

    const delay = floatingConfig.collapseDelay || 500

    // 窗口失去焦点时，延迟后切换到悬浮窗
    const handleBlur = () => {
      console.log('[App] 窗口失去焦点，准备切换到悬浮窗')
      // 延迟后切换到悬浮窗
      mouseLeaveTimerRef.current = setTimeout(() => {
        if (document.visibilityState === 'visible') {
          console.log('[App] 窗口仍无焦点，切换到悬浮窗')
          showFloatingWindow();
        }
      }, delay);
    };

    // 窗口获得焦点时，取消切换
    const handleFocus = () => {
      console.log('[App] 窗口获得焦点，取消自动切换')
      if (mouseLeaveTimerRef.current) {
        clearTimeout(mouseLeaveTimerRef.current);
        mouseLeaveTimerRef.current = null;
      }
    };

    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);

    return () => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      if (mouseLeaveTimerRef.current) {
        clearTimeout(mouseLeaveTimerRef.current);
      }
    };
    // 使用具体值作为依赖，避免对象引用变化导致重复执行
  }, [config?.floatingWindow?.enabled, config?.floatingWindow?.mode, config?.floatingWindow?.collapseDelay]);

  // 跨窗口数据同步 - 同步消息到 localStorage（供悬浮窗读取）
  useEffect(() => {
    // 将完整消息同步到 localStorage
    localStorage.setItem('chat_messages_sync', JSON.stringify(messages));

    // 同步流式状态
    localStorage.setItem('chat_is_streaming', JSON.stringify(isStreaming));
  }, [messages, isStreaming]);

  // 跨窗口数据同步 - 监听悬浮窗发送的消息
  useEffect(() => {
    const unlistenPromise = listen('floating:send_message', async (event: any) => {
      const { message } = event.payload;
      await sendMessage(message);
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten());
    };
  }, [sendMessage]);

  // 跨窗口数据同步 - 监听悬浮窗的中断请求
  useEffect(() => {
    const unlistenPromise = listen('floating:interrupt_chat', async () => {
      interruptChat();
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten());
    };
  }, [interruptChat]);

  // 跨窗口数据同步 - 同步流式状态
  useEffect(() => {
    emit('chat:streaming_changed', { isStreaming });
  }, [isStreaming]);

  // 配置更新时通知悬浮窗
  useEffect(() => {
    if (config) {
      emit('config:updated', { config });
      // 同时保存到 localStorage 供悬浮窗读取
      localStorage.setItem('app_config', JSON.stringify(config));
    }
  }, [config]);

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

  // F12 快捷键 - 切换 DevTools
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === 'F12') {
        e.preventDefault();
        try {
          await tauri.invoke('toggle_devtools');
        } catch (error) {
          console.error('[App] 切换 DevTools 失败:', error);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // ToolPanel 拖拽处理（左边手柄）
  const handleToolPanelResize = (delta: number) => {
    const newWidth = Math.max(200, Math.min(600, toolPanelWidth - delta));
    setToolPanelWidth(newWidth);
  };

  // DeveloperPanel 拖拽处理（左边手柄）
  const handleDeveloperPanelResize = (delta: number) => {
    const newWidth = Math.max(300, Math.min(800, developerPanelWidth - delta));
    setDeveloperPanelWidth(newWidth);
  };

  return (
    <ErrorBoundary>
      <Layout>
        {/* 连接中蒙板 */}
        {(isConnecting || connectionState === 'failed') && <ConnectingOverlay />}

      {/* 顶部菜单栏 */}
      <TopMenuBarComponent
        onNewConversation={() => {
          // 新对话功能直接清空消息
        }}
        onCreateWorkspace={() => setShowCreateWorkspace(true)}
      />

      {/* 主体内容区域：新布局 */}
      <div className="flex flex-1 overflow-hidden">
        {/* Activity Bar - 始终显示 */}
        <ActivityBar onOpenSettings={() => setShowSettings(true)} />

        {/* 左侧可切换面板 (FileExplorer 或 GitPanel 或 TodoPanel) - 条件显示 */}
        {leftPanelType !== 'none' && (
          <LeftPanel>
            <LeftPanelContent
              filesContent={<FileExplorer />}
              gitContent={
                <GitPanel
                  width={leftPanelWidth}
                  onOpenDiffInTab={(diff) => {
                    openDiffTab(diff);
                  }}
                />
              }
              todoContent={<SimpleTodoPanel />}
              translateContent={<TranslatePanel onSendToChat={sendMessage} />}
              schedulerContent={<SchedulerPanel />}
              terminalContent={<TerminalPanel />}
            />
          </LeftPanel>
        )}

        {/* 中间编辑区 (Tab 系统) */}
        <CenterStage />

        {/* 右侧 AI 对话面板 */}
        <RightPanel>
          {/* 状态指示器 */}
          <div className="flex items-center justify-between px-4 py-2 bg-background-elevated border-b border-border-subtle">
            <span className="text-sm text-text-primary">{t('labels.aiChat')}</span>
            <div className="flex items-center gap-3">
              <select
                className="bg-background-elevated border border-border-subtle text-text-primary text-xs px-2 py-1 rounded-md"
                value={config?.defaultEngine || 'claude-code'}
                onChange={(e) => handleEngineSelect(e.target.value as EngineId)}
              >
                {engineOptions.map((opt) => (
                  <option key={opt.id} value={opt.id} className="bg-background text-text-primary">{opt.name}</option>
                ))}
              </select>
            </div>
          </div>

          {error && (
            <div className="mx-4 mt-4 p-3 bg-danger-faint border border-danger/30 rounded-xl text-danger text-sm">
              {error}
            </div>
          )}

          <EnhancedChatMessages />

          <ChatInput
            onSend={sendMessage}
            onInterrupt={interruptChat}
            disabled={!healthStatus?.claudeAvailable || !currentWorkspace}
            isStreaming={isStreaming}
          />
        </RightPanel>

        {/* 保留: ToolPanel (可选显示) */}
        {showToolPanel && (
          <>
            <ResizeHandle
              direction="horizontal"
              position="left"
              onDrag={handleToolPanelResize}
            />
            <ToolPanel width={toolPanelWidth} />
          </>
        )}

        {/* 保留: DeveloperPanel (可选显示) */}
        {showDeveloperPanel && (
          <>
            <ResizeHandle
              direction="horizontal"
              position="left"
              onDrag={handleDeveloperPanelResize}
            />
            <Suspense fallback={<div className="flex items-center justify-center text-text-muted">{t('status.loading')}</div>}>
              <DeveloperPanel width={developerPanelWidth} />
            </Suspense>
          </>
        )}
      </div>

      {/* 设置模态框 */}
      {showSettings && (
        <Suspense fallback={<div className="flex items-center justify-center text-text-muted">{t('status.loading')}</div>}>
          <SettingsModal onClose={() => setShowSettings(false)} />
        </Suspense>
      )}

      {showCreateWorkspace && (
        <Suspense fallback={<div className="flex items-center justify-center text-text-muted">{t('status.loading')}</div>}>
          <CreateWorkspaceModal onClose={() => setShowCreateWorkspace(false)} />
        </Suspense>
      )}

      {showEngineSwitchConfirm && (
        <ConfirmDialog
          message="切换引擎会清空当前对话并重新开始，是否继续？"
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

      {/* 会话历史模态框 */}
      {showSessionHistory && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-50"
            onClick={toggleSessionHistory}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none p-4">
            <div
              className="bg-background-elevated border border-border rounded-xl shadow-xl w-full max-w-2xl h-[80vh] flex flex-col pointer-events-auto overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <Suspense fallback={<div className="flex items-center justify-center h-full text-text-muted">{t('status.loading')}</div>}>
                <SessionHistoryPanel onClose={toggleSessionHistory} />
              </Suspense>
            </div>
          </div>
        </>
      )}

      {/* 全局右键菜单 */}
      <SelectionContextMenu />

      {/* 全局 Toast 通知 */}
      <ToastContainer />

      </Layout>
    </ErrorBoundary>
  );
}

export default App;
