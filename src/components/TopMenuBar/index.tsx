/**
 * TopMenuBar Component
 *
 * 顶部菜单栏，包含：
 * - Logo/应用名称
 * - 拖拽区域
 * - ActivityBar 显示/隐藏按钮
 * - 右侧 AI 面板切换按钮
 * - 窗口置顶按钮
 * - 窗口控制按钮（最小化、最大化、关闭）
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Minus, Square, X, PanelRight, Pin, PanelLeftClose, PanelLeft, Settings, Grid2X2 } from 'lucide-react';
import { invoke } from '@/services/transport';
import { useViewStore } from '@/stores';
import * as tauri from '@/services/tauri';
import { isTauri } from '@/utils/platform';
import { WorkspaceQuickSwitch } from '../Workspace';
import { NotificationBell } from '../Notification';
import { createLogger } from '@/utils/logger';
import { ToolSwitcher } from '../Layout/ToolSwitcher';
import { useToolSwitcherItems } from '../Layout/toolSwitcherData';

const log = createLogger('TopMenuBar');

interface TopMenuBarProps {
  onToggleRightPanel?: () => void;
  rightPanelCollapsed?: boolean;
  isCompactMode?: boolean;
  onOpenSettings?: () => void;
}

export function TopMenuBar({ onToggleRightPanel, rightPanelCollapsed, isCompactMode, onOpenSettings }: TopMenuBarProps) {
  const { t } = useTranslation('common');
  const { activityBarCollapsed, toggleActivityBar } = useViewStore();
  const [isMaximized, setIsMaximized] = useState(false);
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false);
  const [isToolSwitcherOpen, setIsToolSwitcherOpen] = useState(false);
  const showTopToolSwitcher = activityBarCollapsed || isCompactMode;
  const { toolSwitcherItems, activePanelLabel, closeLeftPanel } = useToolSwitcherItems({
    onOpenSettings,
    onToggleRightPanel,
    rightPanelCollapsed,
  });

  useEffect(() => {
    if (!isTauri()) return;

    const checkMaximized = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const window = getCurrentWindow();
        const maximized = await window.isMaximized();
        setIsMaximized(maximized);
      } catch (error) {
        log.warn('Failed to check maximized state:', { error: String(error) });
      }
    };

    checkMaximized();

    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const window = getCurrentWindow();
      const unlisten = window.onResized(() => {
        checkMaximized();
      });
      return unlisten;
    }).catch(() => {});

    return () => {};
  }, []);

  // 同步置顶状态
  useEffect(() => {
    if (!isTauri()) return;

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
      <div data-tauri-drag-region className={`flex items-center ${isCompactMode ? 'px-2' : 'pl-4 pr-2'}`}>
        <div className="w-6 h-6 rounded bg-gradient-to-br from-primary to-primary-600 flex items-center justify-center shadow-glow" data-tauri-drag-region={false}>
          <span className="text-xs font-bold text-white">P</span>
        </div>
        {!isCompactMode && (
          <>
            <span className="text-sm font-medium text-text-primary ml-2" data-tauri-drag-region={false}>Polaris</span>
            {/* 分隔线 */}
            <div className="w-px h-4 bg-border-subtle mx-3" />
            {/* 工作区快速切换 - 仅正常模式显示 */}
            <WorkspaceQuickSwitch />
          </>
        )}

        {showTopToolSwitcher && (
          <button
            onClick={() => setIsToolSwitcherOpen((open) => !open)}
            className={`ml-2 flex h-7 items-center gap-1.5 rounded-md px-2 text-sm transition-colors ${
              isToolSwitcherOpen
                ? 'bg-primary/10 text-primary'
                : 'text-text-secondary hover:bg-background-hover hover:text-text-primary'
            }`}
            title={t('labels.toolSwitcher', { defaultValue: '工具切换器' })}
            aria-label={t('labels.toolSwitcher', { defaultValue: '工具切换器' })}
            aria-pressed={isToolSwitcherOpen}
            data-tauri-drag-region={false}
          >
            <Grid2X2 className="h-4 w-4" />
            {!isCompactMode && (
              <span>{t('labels.moreTools', { defaultValue: '工具' })}</span>
            )}
          </button>
        )}

        <ToolSwitcher
          isOpen={Boolean(showTopToolSwitcher && isToolSwitcherOpen)}
          items={toolSwitcherItems}
          placement="top"
          activePanelLabel={activePanelLabel}
          onCloseActivePanel={closeLeftPanel}
          onClose={() => setIsToolSwitcherOpen(false)}
        />
      </div>

      {/* 中间:可拖拽区域 (自动填充剩余空间) */}
      <div data-tauri-drag-region className={`flex-1 h-full${isTauri() ? ' cursor-move' : ''}`} />

      {/* 右侧:菜单 + 窗口控制 - 小屏模式下简化 */}
      <div className="flex items-center">
        {/* 小屏模式：显示置顶按钮和窗口控制按钮 */}
        {isCompactMode ? (
          <>
            {/* 消息中心入口 */}
            <NotificationBell />

            {/* 设置入口 */}
            {onOpenSettings && (
              <button
                onClick={onOpenSettings}
                className="p-1.5 rounded-md transition-colors text-text-tertiary hover:text-text-primary hover:bg-background-hover"
                title={t('settings.title')}
                data-tauri-drag-region={false}
              >
                <Settings className="w-4 h-4" />
              </button>
            )}

            {isTauri() && (
              <>
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
            )}
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

            {/* 消息中心入口 */}
            <NotificationBell />

            {/* 设置入口 */}
            {onOpenSettings && (
              <button
                onClick={onOpenSettings}
                className="p-1.5 rounded-md transition-colors text-text-tertiary hover:text-text-primary hover:bg-background-hover"
                title={t('settings.title')}
                data-tauri-drag-region={false}
              >
                <Settings className="w-4 h-4" />
              </button>
            )}

            {isTauri() && (
              <>
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
          </>
        )}
      </div>
    </div>
  );
}
