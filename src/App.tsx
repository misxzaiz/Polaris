import { useEffect, useState, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Layout, ConnectingOverlay, ErrorBoundary, ToastContainer, PermissionPromptHost } from './components/Common';
import { FileExplorer } from './components/FileExplorer';
import { createLogger } from './utils/logger';

const log = createLogger('App');

import { TopMenuBar as TopMenuBarComponent } from './components/TopMenuBar';
import { ActivityBar, LeftPanel, LeftPanelContent, LeftPanelTabStrip, CenterStage, RightPanel } from './components/Layout';
import { PluginPanelHost } from './components/Plugins/PluginPanelHost';
// FE-A: 此前经 './components/Chat' barrel 静态导入 7 组件，barrel re-export 的渲染子树
// （renderChatMessage/SessionMessagesView/MessageSearchPanel → chatBlocks/chatBubbles/tool-calls
// 约 1 万行）因「懒 chunk 反向 import main」被拽进入口 chunk（main 内出现 ToolCallBlock/
// noHighlightRe 等仅懒侧使用的标识）。改深度路径直引断开传导，见 plans/fea-chat-barrel-spec.md。
import { ChatInput } from './components/Chat/input/ChatInput';
import type { EditMode } from './components/Chat/input/ChatInput';
import { ChatStatusBar } from './components/Chat/common/ChatStatusBar';
import { ErrorBanner } from './components/Chat/common/ErrorBanner';
import { CompactHandoffButton } from './components/Chat/compact-handoff/CompactHandoffButton';
import { CompactHandoffProgress } from './components/Chat/compact-handoff/CompactHandoffProgress';
import { MultiWindowMenu } from './components/Chat/session/MultiWindowMenu';
import { NewSessionButton } from './components/Chat/session/NewSessionButton';
// 条件渲染的重组件统一懒加载，避免首帧解析 400+ 模块的 Chat barrel 传递依赖
const MultiSessionGridLazy = lazy(() => import('./components/Chat/session/MultiSessionGrid').then(m => ({ default: m.MultiSessionGrid })));
// FE-2: NarrowTabOverlay 原经 Editor barrel 静态 import，会把 EditorPanel/Editor.tsx
// 传导的 @codemirror 全家（manualChunks 钉入单一 codemirror chunk，~1MB）拽回首载。
// 它仅 isCompact && narrowTabId 时渲染，改 React.lazy 移出首载；overlay 场景
// fallback 用 null，对齐本文件 FileSearchModal 等既有 Suspense 范式。
const NarrowTabOverlayLazy = lazy(() => import('./components/Editor/NarrowTabOverlay').then(m => ({ default: m.NarrowTabOverlay })));
import type { SettingsTabId } from './components/Settings/SettingsSidebar';
import { RightSlideOver } from './components/Common/RightSlideOver';
import { PluginSlotPlaceholder } from './components/PluginSlotPlaceholder';

// 懒加载大型组件，减少初始 bundle 大小
const SettingsPage = lazy(() => import('./components/Settings/SettingsPage').then(m => ({ default: m.SettingsPage })));
const DeveloperPanel = lazy(() => import('./components/Developer/DeveloperPanel').then(m => ({ default: m.DeveloperPanel })));
const CreateWorkspaceModal = lazy(() => import('./components/Workspace/CreateWorkspaceModal').then(m => ({ default: m.CreateWorkspaceModal })));
const CreateSessionModal = lazy(() => import('./components/Session/CreateSessionModal').then(m => ({ default: m.CreateSessionModal })));
const FileSearchModal = lazy(() => import('./components/Editor/FileSearchModal').then(m => ({ default: m.FileSearchModal })));

// 懒加载大型面板组件，减少初始 bundle 大小
// Git 面板已插件化（2026-11-12）：内置 GitPanel 移出主仓，git.panel 席位由
// polaris-git 插件 shadow 接管；未启用插件时渲染通用席位占位兜底。
// 翻译面板已插件化（2026-11-14）：translate 域移出主仓，translate.panel 席位由
// translate 插件 shadow 接管；未启用插件时渲染通用席位占位兜底。
// 终端面板已插件化（2026-11-14，P5）：内置 TerminalPanel 移出主仓，terminal.panel
// 席位由 terminal-desk 插件 shadow 接管；未启用插件时渲染席位空态引导卡。
import { SlotEmpty } from './components/Layout/SlotEmpty';
import { TerminalSlotEmpty } from './components/Layout/TerminalSlotEmpty';
const DemoPluginPanel = lazy(() => import('./components/Plugins/DemoPluginPanel').then(m => ({ default: m.DemoPluginPanel })));
const NotificationCenterPanel = lazy(() => import('./components/Notification/NotificationCenterPanel').then(m => ({ default: m.NotificationCenterPanel })));
const FocusOverlay = lazy(() => import('./components/FocusMode/FocusOverlay').then(m => ({ default: m.FocusOverlay })));

import { useConfigStore, useViewStore, useWorkspaceStore, useTabStore } from './stores';
import { useNarrowTabStore } from './stores/narrowTabStore';
import { isPluginUiEnabled, usePluginStore } from './stores/pluginStore';
import { pluginRegistry } from './plugin-system';
import { useActiveSessionActions, useActiveSessionStreaming, useActiveSessionError } from './stores/conversationStore/useActiveSession';
import { useSessionMetadataList, useActiveSessionId } from './stores/conversationStore/sessionStoreManager';
import { useOverlayStore } from './stores/overlayStore';
import { eventBus } from './services/eventBus';
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
  const activeSessionId = useActiveSessionId();
  // 活跃会话是否为"自由会话"（无工作区）。free 会话即使无全局工作区也应可发送。
  const sessionMetadataList = useSessionMetadataList();
  const activeSessionIsFree = useMemo(
    () => sessionMetadataList.some((s) => s.id === activeSessionId && s.type === 'free'),
    [sessionMetadataList, activeSessionId]
  );

  // 全局发送桥：外部插件面板（news-curator 等）sendToChat 的降级通道。
  // 首选路径是 LeftPanelContent → PluginPanelHost 的 onSendToChat props；
  // 此桥覆盖 props 未传递/旧面板场景，保证「生成日报/语音」等按钮可用。
  useEffect(() => {
    ;(window as any).__POLARIS_SEND_TO_CHAT__ = (msg: string) => {
      void sendMessage(msg);
    };
  }, [sendMessage]);

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
  // 设置页关闭退场：showSettings 置 false 后保留渲染 200ms 播退出动画
  const [settingsKept, setSettingsKept] = useState(false);
  // 左面板（桌面）关闭退场：hasLeftPanel 变 false 后保留渲染 150ms 播淡出
  const [leftPanelKept, setLeftPanelKept] = useState(false);

  // OverlayStore 状态（替代 useState）
  const showSettings = useOverlayStore(s => s.settingsOpen);
  // 实际渲染标志：打开立即渲染；关闭延迟 200ms 退场后再真正移除
  const settingsRendering = showSettings || settingsKept;
  const showCreateSession = useOverlayStore(s => s.createSessionOpen);
  const showFileSearch = useOverlayStore(s => s.fileSearchOpen);
  // 会话历史/消息中心后退场保活：先播滑出动画 260ms 再卸载
  const [sessionHistoryKept, setSessionHistoryKept] = useState(false);
  const [notificationCenterKept, setNotificationCenterKept] = useState(false);

  const sessionHistoryExited = useCallback(() => {
    setSessionHistoryKept(false);
  }, []);
  // 关闭会话历史抽屉：viewStore 开关翻转 + 退场保活（对齐 closeNotificationCenter）。
  // P4 收尾：PluginPanelHost 现向插件面板注入 onClose，history-desk 的
  // 「继续 → restore 成功 → 关抽屉」链路由此真正生效（此前 onClose 为 no-op）。
  const closeSessionHistoryDrawer = useCallback(() => {
    if (useViewStore.getState().showSessionHistory) {
      useViewStore.getState().toggleSessionHistory();
    }
    setSessionHistoryKept(true);
  }, []);
  // 关闭消息中心：同上
  const closeNotificationCenter = useCallback(() => {
    if (useViewStore.getState().showNotificationCenter) {
      useViewStore.getState().toggleNotificationCenter();
    }
    setNotificationCenterKept(true);
  }, []);
  const notificationCenterExited = useCallback(() => {
    setNotificationCenterKept(false);
  }, []);

  const handleCloseSettings = useCallback(() => {
    useOverlayStore.getState().setSettingsOpen(false);
    // 先播退场动画，200ms 后再移除 DOM
    setSettingsKept(true);
    window.setTimeout(() => {
      setSettingsKept(false);
      setSettingsInitialTab(undefined);
    }, 200);
  }, []);

  // Store 状态
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const currentWorkspace = useWorkspaceStore(
    state => state.workspaces.find(w => w.id === state.currentWorkspaceId) || null
  );
  const leftPanelType = useViewStore(state => state.leftPanelType);
  // 记忆的激活面板（close 后 strip/外壳仍高亮该类型）。viewStore 统一记忆，
  // 替代原先 App 内手写 lastLeftPanelTypeRef + useSection 拼接——记忆随 store 持久化，
  // 跨会话/刷新保留。
  const activeLeftPanelType = useViewStore(state => state.activeLeftPanelType);
  const pluginStates = usePluginStore(state => state.pluginStates);
  const rightPanelCollapsed = useViewStore(state => state.rightPanelCollapsed);
  const terminalFullscreen = useViewStore(state => state.terminalFullscreen);
  const toggleRightPanel = useViewStore(state => state.toggleRightPanel);
  const closeLeftPanel = useViewStore(state => state.closeLeftPanel);
  const activityBarCollapsed = useViewStore(state => state.activityBarCollapsed);
  const showSessionHistory = useViewStore(state => state.showSessionHistory);
  const showNotificationCenter = useViewStore(state => state.showNotificationCenter);
  const narrowTabId = useNarrowTabStore(state => state.narrowTabId);
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

  // 监听 polaris:open-settings 事件（从 ContextMeter 等组件触发）
  useEffect(() => {
    return eventBus.on('polaris:open-settings', ({ tab }) => {
      setSettingsInitialTab(tab)
      useOverlayStore.getState().setSettingsOpen(true)
    })
  }, [])

// [临时禁用] 进入小屏模式自动关闭左侧面板（最小化后恢复面板消失的根因嫌疑）。
  // 待用户实测确认后：若面板不再消失，再决定删除或保留（手机首屏需防抽屉盖聊天区）。
  // useEffect(() => {
  //   if (!isCompact || document.hidden) return;
  //   const timer = window.setTimeout(() => {
  //     if (useViewStore.getState().leftPanelType !== 'none') {
  //       closeLeftPanel();
  //     }
  //   }, 300);
  //   return () => window.clearTimeout(timer);
  // }, [isCompact, closeLeftPanel]);

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
    (!!activeLeftPanelContribution &&
      isPluginUiEnabled(pluginStates, activeLeftPanelContribution.pluginId));
  // [诊断] 临时：追踪 hasLeftPanel 从 true 变 false 的时刻
  const hasLeftPanelRef = useRef(hasLeftPanel);
  if (hasLeftPanelRef.current && !hasLeftPanel) {
    console.warn(`[PanelTrace] hasLeftPanel false → leftPanelType="${leftPanelType}" contribution=${!!activeLeftPanelContribution} pluginStates keys=${Object.keys(pluginStates).length}`, new Error().stack?.split('\n').slice(2, 6).join(' | '))
  }
  hasLeftPanelRef.current = hasLeftPanel;
  // 左面板关闭退场：hasLeftPanel true→false 时外壳淡出 150ms。
  // 注意：LeftPanel 本身始终渲染保活（内容组件不卸载），leaving 只控制外壳淡出，
  // 不再触发卸载——见渲染段注释。
  const prevHasLeftPanel = useRef(hasLeftPanel);
  useEffect(() => {
    if (prevHasLeftPanel.current && !hasLeftPanel) {
      setLeftPanelKept(true);
      const t = window.setTimeout(() => setLeftPanelKept(false), 150);
      prevHasLeftPanel.current = hasLeftPanel;
      return () => window.clearTimeout(t);
    }
    prevHasLeftPanel.current = hasLeftPanel;
  }, [hasLeftPanel]);
  const leftPanelLeaving = !hasLeftPanel && leftPanelKept;
  const hasCenterStage = !isCompact && hasOpenTabs;

  // 右侧面板填充模式：无编辑器时自适应填充，有编辑器时固定宽度
  const rightPanelFillRemaining = !hasCenterStage;

  // 左侧面板自适应填充剩余空间：AI 面板折叠 + 无编辑器打开时 flex-1 撑满，
  // 解决"关闭 AI 面板 + 无打开编辑器 → 左侧面板右侧空一半"问题。
  // 终端全屏模式优先级更高，由 fullscreen 分支单独处理。
  const leftPanelFillRemaining = !hasCenterStage && rightPanelCollapsed && !terminalFullscreen;

  // Git 域已整体出仓（2026-11-12，架构方案 C）：宿主不再持有 gitStore 与
  // file-system-change → status 刷新链路。分支徽章由 polaris-git 插件经 H7
  // fileExplorerToolbar 槽位注入，diff tab 刷新走 diffRefresh 槽位；两者数据
  // 均来自插件自带 service。

  // === 渲染 ===
  const loadingFallback = (
    <div className="flex items-center justify-center h-full text-text-muted">{t('status.loading')}</div>
  );

  // 左侧面板内容：始终挂载在 LeftPanel 内保活，isCompact 翻转仅切换外壳形态
  // （桌面停靠 ↔ 抽屉覆盖），内容组件不卸载不重建
  const leftPanelContent = (
    <LeftPanelContent
      currentType={leftPanelType}
      activePanelType={activeLeftPanelType}
      filesContent={<FileExplorer />}
      gitContent={
        <PluginSlotPlaceholder
          title={t('pluginSlotPlaceholder.gitTitle', {
            defaultValue: 'Git 与版本管理已迁移为插件',
          })}
          hint={t('pluginSlotPlaceholder.gitHint', {
            defaultValue:
              '安装并启用 polaris-git 插件后，此席位由插件面板接管（状态/差异/历史/分支与提交，引擎内置于插件）。插件管理：设置 → 插件。',
          })}
        />
      }
      browserContent={
        <PluginSlotPlaceholder
          title={t('pluginSlotPlaceholder.browserTitle', {
            defaultValue: '浏览器已迁移为插件',
          })}
          hint={t('pluginSlotPlaceholder.browserHint', {
            defaultValue:
              '安装并启用 browser-desk 插件后，此席位由插件面板接管（多窗口浏览、AI 搜索/阅读/交互，引擎驱动系统 Chrome）。插件管理：设置 → 插件。',
          })}
        />
      }
      translateContent={
        <PluginSlotPlaceholder
          title={t('pluginSlotPlaceholder.translateTitle', {
            defaultValue: '翻译已迁移为插件',
          })}
          hint={t('pluginSlotPlaceholder.translateHint', {
            defaultValue:
              '安装并启用 translate 插件后，此席位由插件面板接管（百度翻译工作台 + 划词翻译，凭证走插件配置）。插件管理：设置 → 插件。',
          })}
        />
      }
      terminalContent={<TerminalSlotEmpty />}
      developerContent={<Suspense fallback={loadingFallback}><DeveloperPanel fillRemaining /></Suspense>}
      aiConsoleContent={<SlotEmpty icon="📊" title="AI 执行台" description="集成机器人监控已迁移至 im-bridge 插件；安装启用后在此查看执行状态。" />}
      demoPluginContent={<Suspense fallback={loadingFallback}><DemoPluginPanel onSendToChat={sendMessage} /></Suspense>}
      onSendToChat={(msg: string) => { void sendMessage(msg) }}
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
          {/* 主布局常驻：对话网格（MultiSessionGrid/Virtuoso 实例）不随设置页开关卸载，
              避免冷启动闪白 + 滚动位置丢失。设置页以层叠方式覆盖在上。
              settingsRendering（含退场动画期）inert 禁用背后交互（Tab 聚焦/点击），
              防止焦点跳入聊天区；退场结束后才释放。 */}
          <div className="flex flex-1 overflow-hidden" inert={settingsRendering}>
            <ActivityBar
              onOpenSettings={() => useOverlayStore.getState().setSettingsOpen(true)}
              onToggleRightPanel={toggleRightPanel}
              rightPanelCollapsed={rightPanelCollapsed}
              forceCollapsed={isCompact}
              collapsed={activityBarCollapsed}
            />

            {/* 左侧面板始终渲染（从首次打开后保活）：isCompact 翻转（最小化/拖窄窗口）
                只切换形态（桌面停靠 ↔ 抽屉覆盖），不卸载内容组件——
                与 RightPanel/AI 对话的常驻保活一致，避免文件树/终端重建导致"刷新"。
                hasLeftPanel/leaving 仅控制外壳显隐，children 始终挂载。 */}
            <LeftPanel
              fillRemaining={leftPanelFillRemaining}
              fullscreen={terminalFullscreen}
              leaving={leftPanelLeaving}
              compact={isCompact}
              onClose={closeLeftPanel}
              topBar={isCompact ? undefined : <LeftPanelTabStrip activePanelType={activeLeftPanelType} />}
            >
              {leftPanelContent}
            </LeftPanel>

            {/* 小屏模式：tab 覆盖层 —— CenterStage 被 !isCompact 门控不渲染，
                窄窗口下打开文件/diff 由 NarrowTabOverlay 承接（按 tab.type 分流），
                与 LeftPanelDrawer 同构。关闭只清信号，不销毁 tab；
                窗口拖宽后 CenterStage 接管同一批 tab。 */}
            {isCompact && narrowTabId && (
              <Suspense fallback={null}>
                <NarrowTabOverlayLazy />
              </Suspense>
            )}

            {/* 终端全屏时让位，不渲染编辑器 */}
            {!isCompact && hasCenterStage && !terminalFullscreen && <CenterStage fillRemaining={!rightPanelCollapsed} />}

            {/* RightPanel 始终渲染（除终端全屏），折叠状态由 RightPanel 内部 hidden 处理，
                避免折叠/展开时多窗口消息组件卸载重建导致闪白+位置丢失 */}
            {(isCompact || !terminalFullscreen) && (
              <RightPanel fillRemaining={rightPanelFillRemaining} forceShow={isCompact}>
                {error && <ErrorBanner error={error} />}

                <MultiSessionGridLazy onEditMessage={handleEditMessage} />

                <ChatInput
                  onSend={sendMessage}
                  onInterrupt={interruptChat}
                  disabled={!currentWorkspace && !activeSessionIsFree}
                  isStreaming={isStreaming}
                  editMode={editMode}
                  onCancelEdit={handleCancelEdit}
                  onEditSend={handleEditSend}
                  statusBarSlot={
                    <ChatStatusBar embedded>
                      <MultiWindowMenu />
                      <NewSessionButton />
                      <CompactHandoffButton />
                    </ChatStatusBar>
                  }
                />
              </RightPanel>
            )}
          </div>

          {/* 设置页层叠覆盖（absolute inset-0，z-modal），主布局在下方常驻保活。
              退场动画期间 inert + aria-hidden，避免退场中的 SettingsPage 仍捕获交互。 */}
          {settingsRendering && (
            <div
              className={`absolute inset-0 z-modal flex flex-col ${showSettings ? 'animate-panel-in-fast' : 'animate-panel-out'}`}
              role="dialog"
              aria-modal="true"
              inert={!showSettings}
              aria-hidden={!showSettings}
            >
              <Suspense fallback={loadingFallback}>
                <SettingsPage
                  initialTab={settingsInitialTab as SettingsTabId | undefined}
                  onClose={handleCloseSettings}
                />
              </Suspense>
            </div>
          )}
        </div>

        {/* 压缩交接后台进度胶囊（右下角，不阻塞界面） */}
        <CompactHandoffProgress />

        {showCreateWorkspace && (
          <Suspense fallback={<div className="flex items-center justify-center text-text-muted">{t('status.loading')}</div>}>
            <CreateWorkspaceModal onClose={() => { setShowCreateWorkspace(false); useOverlayStore.getState().decrement(); }} />
          </Suspense>
        )}

        {/* Ctrl/Cmd+Shift+'+' 唤出：选择主工作区新建会话（引擎/供应商模型默认折叠，
            关联工作区在 QuickSwitch 面板/会话内管理，见 plans/create-session-modal-slimdown-spec.md） */}
        {showCreateSession && (
          <Suspense fallback={null}>
            <CreateSessionModal
              onClose={() => useOverlayStore.getState().setCreateSessionOpen(false)}
              onCreated={() => {
                // createSession 已切换活跃会话，派发聚焦输入框事件
                // eventBus 同步派发；ChatInput 监听器内 setTimeout(0) 推迟一拍确保重渲染完成
                eventBus.emit('chat:focus-input', undefined);
              }}
            />
          </Suspense>
        )}

        {showFileSearch && (
          <Suspense fallback={null}>
            <FileSearchModal onClose={() => useOverlayStore.getState().setFileSearchOpen(false)} />
          </Suspense>
        )}

        {/* 会话历史浮层（plans/session-history-plugin-prd.md P0-P4）：
            位置本体 = RightSlideOver + viewStore 开关，永不随插件变化；
            内容 = 已启用插件的 overlays[session-history] shadow 接管。
            P4：内置 SessionHistoryPanel 已拆除，未启用/禁用/卸载 →
            空态提示（重新启用插件或重装即可恢复，历史数据在宿主数据根不丢）。 */}
        {(showSessionHistory || sessionHistoryKept) && (
          <RightSlideOver
            open={showSessionHistory || sessionHistoryKept}
            exiting={!showSessionHistory && sessionHistoryKept}
            onExited={sessionHistoryExited}
          >
            <Suspense fallback={loadingFallback}>
              {(() => {
                const claim = pluginRegistry.getOverlayClaim('session-history');
                const enabled = claim ? isPluginUiEnabled(pluginStates, claim.pluginId) : false;
                return claim && enabled
                  ? (
                    <PluginPanelHost
                      panelType={claim.panelType}
                      onClose={closeSessionHistoryDrawer}
                    />
                  )
                  : (
                    <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
                      <p className="text-sm text-text-secondary">会话历史由 history-desk 插件提供</p>
                      <p className="text-xs text-text-tertiary">当前插件未启用。启用后此处恢复面板；历史数据不受影响。</p>
                    </div>
                  );
              })()}
            </Suspense>
          </RightSlideOver>
        )}

        {/* 全局消息中心：右侧滑出，复用会话历史面板的浮层范式 */}
        {(showNotificationCenter || notificationCenterKept) && (
          <RightSlideOver
            open={showNotificationCenter || notificationCenterKept}
            exiting={!showNotificationCenter && notificationCenterKept}
            onExited={notificationCenterExited}
          >
            <Suspense fallback={null}>
              <NotificationCenterPanel onClose={closeNotificationCenter} />
            </Suspense>
          </RightSlideOver>
        )}

        {/* 全局划词菜单已随 translate 域出仓（translate 插件承接） */}

        {/* 全局 Toast 通知：挂载在视图切换之外，经 Portal 渲染到 body，浮于所有面板/弹窗之上 */}
        <ToastContainer />

        {/* 全局权限审批卡（P1-g）：AI 高危动作（停插件服务/卸载插件）需用户确认 */}
        <PermissionPromptHost />

        {/* 全局阅读聚焦模式：L1 语义高亮 / L2 聚光灯遮罩，pointer-events:none 不阻断交互 */}
        <Suspense fallback={null}>
          <FocusOverlay />
        </Suspense>
      </Layout>
    </ErrorBoundary>
  );
}

export default App;
