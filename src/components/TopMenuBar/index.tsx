/**
 * TopMenuBar Component
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Minus, Square, X, Clock, Download, PanelRight, Pin, PanelLeftClose, PanelLeft } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useViewStore } from '../../stores';
import { useActiveSessionMessages, useActiveSessionStreaming } from '../../stores/conversationStore/useActiveSession';
import * as tauri from '../../services/tauri';
import { exportToMarkdown, generateFileName } from '../../services/chatExport';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createLogger } from '../../utils/logger';

const log = createLogger('TopMenuBar');

// 检测是否在 Tauri 环境中运行
const isTauriEnv = typeof window !== 'undefined' && '__TAURI__' in window;

interface TopMenuBarProps {
  onNewConversation: () => void;
  onToggleRightPanel?: () => void;
  rightPanelCollapsed?: boolean;
  isCompactMode?: boolean;
}

export function TopMenuBar({ onNewConversation, onToggleRightPanel, rightPanelCollapsed, isCompactMode }: TopMenuBarProps) {
  const { t } = useTranslation('common');
  const { toggleSessionHistory, activityBarCollapsed, toggleActivityBar } = useViewStore();
  const [showNewChatConfirm, setShowNewChatConfirm] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false);
  const { messages } = useActiveSessionMessages();
  const isStreaming = useActiveSessionStreaming();

  useEffect(() => {
    if (!isTauriEnv) return;

    const checkMaximized = async () => {
      try {
        const window = getCurrentWindow();
        const maximized = await window.isMaximized();
        setIsMaximized(maximized);
      } catch (error) {
        log.warn('Failed to check maximized state:', { error: String(error) });
      }
    };

    checkMaximized();

    const window = getCurrentWindow();
    const unlisten = window.onResized(() => {
      checkMaximized();
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, []);

  // 同步置顶状态
  useEffect(() => {
    if (!isTauriEnv) return;

    const syncOnTopState = async () => {
      try {
        const onTop = await invoke<boolean>('is_always_on_top');
        setIsAlwaysOnTop(onTop);
      } catch (error) {
        log.warn('Failed to get always on top state:', { error: String(error) });
      }
    };
    syncOnTopState();
  }, []);

  const handleExportChat = async () => {
    if (messages.length === 0) {
      return;
    }

    setIsExporting(true);
    try {
      const content = exportToMarkdown(messages);
      const fileName = generateFileName('md');
      const filePath = await tauri.saveChatToFile(content, fileName);

      if (filePath) {
        log.info('导出聊天成功', { path: filePath });
      }
    } catch (error) {
      log.error('导出聊天失败', error instanceof Error ? error : new Error(String(error)));
    } finally {
      setIsExporting(false);
    }
  };

  const handleNewConversation = () => {
    if (messages.length > 0) {
      setShowNewChatConfirm(true);
    } else {
      onNewConversation();
    }
  };

  const confirmNewChat = () => {
    onNewConversation();
    setShowNewChatConfirm(false);
  };

  // 切换窗口置顶状态
  const handleToggleAlwaysOnTop = async () => {
    try {
      const newOnTop = !isAlwaysOnTop;
      await invoke('set_always_on_top', { alwaysOnTop: newOnTop });
      setIsAlwaysOnTop(newOnTop);
      log.info(`窗口置顶: ${newOnTop}`);
    } catch (error) {
      log.error('切换置顶失败', error instanceof Error ? error : new Error(String(error)));
    }
  };

  return (
    <div className="flex items-center h-10 bg-background-elevated border-b border-border shrink-0">
      {/* 左侧:Logo/应用名称 - 小屏模式下更紧凑 */}
      <div data-tauri-drag-region className={`flex items-center gap-2 ${isCompactMode ? 'px-2' : 'px-4'}`}>
        <div className="w-6 h-6 rounded bg-gradient-to-br from-primary to-primary-600 flex items-center justify-center shadow-glow" data-tauri-drag-region={false}>
          <span className="text-xs font-bold text-white">P</span>
        </div>
        {!isCompactMode && <span className="text-sm font-medium text-text-primary">Polaris</span>}
      </div>

      {/* 中间:可拖拽区域 (自动填充剩余空间) */}
      <div data-tauri-drag-region className="flex-1 h-full cursor-move" />

      {/* 右侧:菜单 + 窗口控制 - 小屏模式下简化 */}
      <div className="flex items-center">
        {/* 小屏模式：显示置顶按钮和窗口控制按钮 */}
        {isCompactMode ? (
          <>
            {/* 新建对话按钮 */}
            <button
              onClick={handleNewConversation}
              disabled={isStreaming}
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors disabled:opacity-50"
              title={t('menu.newChat')}
              data-tauri-drag-region={false}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            </button>

            {/* 会话历史按钮 */}
            <button
              onClick={toggleSessionHistory}
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors"
              title={t('menu.sessionHistory')}
              data-tauri-drag-region={false}
            >
              <Clock className="w-4 h-4" />
            </button>

            {/* 窗口置顶按钮 */}
            <button
              onClick={handleToggleAlwaysOnTop}
              className={`p-1.5 rounded-md transition-colors ${
                isAlwaysOnTop
                  ? 'text-primary bg-primary/10 hover:bg-primary/20'
                  : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
              }`}
              title={isAlwaysOnTop ? t('window.alwaysOnTop') : t('window.alwaysOnTopHint')}
              data-tauri-drag-region={false}
            >
              <Pin className="w-4 h-4" />
            </button>

            {/* 分隔线 */}
            <div data-tauri-drag-region className="w-px h-4 bg-border-subtle mx-1" />

            {/* 窗口控制 */}
            <div className="flex items-center">
              <button
                onClick={() => tauri.minimizeWindow()}
                className="px-2 py-2 hover:bg-background-hover transition-colors text-text-secondary hover:text-text-primary"
                title={t('window.minimize')}
                data-tauri-drag-region={false}
              >
                <Minus className="w-4 h-4" />
              </button>
              <button
                onClick={() => tauri.toggleMaximizeWindow()}
                className="px-2 py-2 hover:bg-background-hover transition-colors text-text-secondary hover:text-text-primary"
                title={isMaximized ? t('window.restore') : t('window.maximize')}
                data-tauri-drag-region={false}
              >
                <Square className="w-4 h-4" />
              </button>
              <button
                onClick={() => tauri.closeWindow()}
                className="px-2 py-2 hover:bg-red-500 hover:text-white transition-colors text-text-secondary"
                title={t('window.close')}
                data-tauri-drag-region={false}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </>
        ) : (
          <>
            {/* 正常模式：完整菜单 */}

            {/* ActivityBar 显示/隐藏按钮 */}
            <button
              onClick={toggleActivityBar}
              className={`p-1.5 rounded-md transition-colors ${
                activityBarCollapsed
                  ? 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
                  : 'text-primary bg-primary/10 hover:bg-primary/20'
              }`}
              title={activityBarCollapsed ? t('labels.showActivityBar') : t('labels.hideActivityBar')}
              data-tauri-drag-region={false}
            >
              {activityBarCollapsed ? <PanelLeft className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
            </button>

            {/* 右侧 AI 面板切换按钮 */}
            <button
              onClick={onToggleRightPanel}
              className={`p-1.5 rounded-md transition-colors ${
                rightPanelCollapsed
                  ? 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
                  : 'text-primary bg-primary/10 hover:bg-primary/20'
              }`}
              title={rightPanelCollapsed ? t('labels.showAIPanel') : t('labels.hideAIPanel')}
              data-tauri-drag-region={false}
            >
              <PanelRight className="w-4 h-4" />
            </button>

            <button
              onClick={handleExportChat}
              disabled={messages.length === 0 || isExporting}
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={t('menu.exportChat')}
              data-tauri-drag-region={false}
            >
              {isExporting ? (
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16 2l4 4-4 4" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20 6h-4" />
                </svg>
              ) : (
                <Download className="w-4 h-4" />
              )}
            </button>

            <button
              onClick={toggleSessionHistory}
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors"
              title={t('menu.sessionHistory')}
              data-tauri-drag-region={false}
            >
              <Clock className="w-4 h-4" />
            </button>

            <button
              onClick={handleNewConversation}
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors"
              title={t('menu.newChat')}
              data-tauri-drag-region={false}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            </button>

            {/* 窗口置顶按钮 */}
            <button
              onClick={handleToggleAlwaysOnTop}
              className={`p-1.5 rounded-md transition-colors ${
                isAlwaysOnTop
                  ? 'text-primary bg-primary/10 hover:bg-primary/20'
                  : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
              }`}
              title={isAlwaysOnTop ? t('window.alwaysOnTop') : t('window.alwaysOnTopHint')}
              data-tauri-drag-region={false}
            >
              <Pin className="w-4 h-4" />
            </button>

            {/* 分隔线 */}
            <div data-tauri-drag-region className="w-px h-4 bg-border-subtle mx-1" />

            <div className="flex items-center">
              <button
                onClick={() => tauri.minimizeWindow()}
                className="px-3 py-2 hover:bg-background-hover transition-colors text-text-secondary hover:text-text-primary"
                title={t('window.minimize')}
                data-tauri-drag-region={false}
              >
                <Minus className="w-4 h-4" />
              </button>
              <button
                onClick={() => tauri.toggleMaximizeWindow()}
                className="px-3 py-2 hover:bg-background-hover transition-colors text-text-secondary hover:text-text-primary"
                title={isMaximized ? t('window.restore') : t('window.maximize')}
                data-tauri-drag-region={false}
              >
                <Square className="w-4 h-4" />
              </button>
              <button
                onClick={() => tauri.closeWindow()}
                className="px-3 py-2 hover:bg-red-500 hover:text-white transition-colors text-text-secondary"
                title={t('window.close')}
                data-tauri-drag-region={false}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </>
        )}
      </div>

      {/* 新对话确认对话框 */}
      {showNewChatConfirm && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-50"
            onClick={() => setShowNewChatConfirm(false)}
          />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-80 bg-background-elevated rounded-xl border border-border shadow-xl p-5">
            <h3 className="text-base font-semibold text-text-primary mb-2">
              {t('messages.confirmNewChat')}
            </h3>
            <p className="text-sm text-text-secondary mb-5">
              {t('messages.confirmNewChatMessage', { count: messages.length })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowNewChatConfirm(false)}
                className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors"
              >
                {t('buttons.cancel')}
              </button>
              <button
                onClick={confirmNewChat}
                className="px-3 py-1.5 text-sm bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors"
              >
                {t('buttons.confirm')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
