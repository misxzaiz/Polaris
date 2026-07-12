/**
 * TerminalPanel - 终端面板组件
 *
 * 使用 xterm.js 渲染终端界面
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal as XTerm } from 'xterm';
import type { ITheme } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { useTerminalStore } from '@/stores/terminalStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useViewStore } from '@/stores/viewStore';
import { useTerminalScriptStore } from '@/stores/terminalScriptStore';
import { useThemeStore, type Theme } from '@/stores/themeStore';
import { Plus, X, Terminal as TerminalIcon, Maximize2, Minimize2 } from 'lucide-react';
import { createLogger } from '@/utils/logger';
import { TerminalScriptPanel } from './TerminalScriptPanel';
import { TerminalQuickRunBar } from './TerminalQuickRunBar';
import { TerminalRunCommandModal } from './TerminalRunCommandModal';
import { TerminalTabContextMenu } from './TerminalTabContextMenu';
import 'xterm/css/xterm.css';

const log = createLogger('TerminalPanel');

/** 根据主题返回 xterm 终端配色 */
function getXtermTheme(theme: Theme): ITheme {
  if (theme === 'light') {
    return {
      background: '#ffffff',
      foreground: '#1e1e1e',
      cursor: '#1e1e1e',
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(0, 0, 0, 0.2)',
      black: '#000000',
      red: '#cd3131',
      green: '#107c10',
      yellow: '#b58900',
      blue: '#1f6feb',
      magenta: '#8250df',
      cyan: '#0598bc',
      white: '#5c5c5c',
      brightBlack: '#7a7a7a',
      brightRed: '#cd3131',
      brightGreen: '#14ce14',
      brightYellow: '#b89500',
      brightBlue: '#0451a5',
      brightMagenta: '#bc05bc',
      brightCyan: '#0598bc',
      brightWhite: '#1e1e1e',
    };
  }
  return {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#d4d4d4',
    cursorAccent: '#1e1e1e',
    selectionBackground: 'rgba(255, 255, 255, 0.3)',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#e5e5e5',
  };
}

interface TerminalInstanceProps {
  sessionId: string;
  isActive: boolean;
}

/** 单个终端实例 */
function TerminalInstance({ sessionId, isActive }: TerminalInstanceProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const write = useTerminalStore((state) => state.write);
  const resize = useTerminalStore((state) => state.resize);
  const theme = useThemeStore((state) => state.theme);

  // 初始化终端
  useEffect(() => {
    const container = terminalRef.current;
    if (!container || xtermRef.current) return;

    // 确保容器已渲染且有有效尺寸，避免 xterm.js RenderService 初始化竞态
    if (container.offsetWidth === 0 || container.offsetHeight === 0) {
      log.warn('Terminal container has zero dimensions, deferring initialization');
      return;
    }

    const xterm = new XTerm({
      theme: getXtermTheme(useThemeStore.getState().theme),
      fontFamily: 'Consolas, "SF Mono", Menlo, "DejaVu Sans Mono", "Courier New", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    xterm.loadAddon(fitAddon);
    xterm.loadAddon(webLinksAddon);
    xterm.open(container);

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    // 等待一帧确保 DOM 完全渲染后再 fit，避免 RenderService.dimensions 竞态
    requestAnimationFrame(() => {
      if (!fitAddonRef.current || !xtermRef.current) return;
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        resize(sessionId, dims.cols, dims.rows);
      }
    });

    // 监听用户输入
    xterm.onData((data) => {
      // 将输入编码为 base64 (支持 UTF-8)
      const encoder = new TextEncoder();
      const bytes = encoder.encode(data);
      const encoded = btoa(String.fromCharCode(...bytes));
      write(sessionId, encoded);
    });

    return () => {
      xterm.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId, write, resize]);

  // 监听终端输出
  useEffect(() => {
    const handleOutput = (e: CustomEvent<{ sessionId: string; data: string }>) => {
      if (e.detail.sessionId !== sessionId) return;

      const xterm = xtermRef.current;
      if (!xterm) return;

      try {
        // 解码 base64 数据为字节数组 (支持 UTF-8)
        const binary = atob(e.detail.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        xterm.write(bytes);
      } catch (err) {
        log.error('解码输出失败', err instanceof Error ? err : new Error(String(err)));
      }
    };

    window.addEventListener('terminal-output', handleOutput as EventListener);
    return () => {
      window.removeEventListener('terminal-output', handleOutput as EventListener);
    };
  }, [sessionId]);

  // 调整大小 - 使用 ResizeObserver 监听容器尺寸变化
  // 注意：移除 isActive 限制，让所有终端实例都能响应宽度变化
  useEffect(() => {
    const fitAddon = fitAddonRef.current;
    const xterm = xtermRef.current;
    const container = terminalRef.current;
    if (!fitAddon || !xterm || !container) return;

    const handleResize = () => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        resize(sessionId, dims.cols, dims.rows);
      }
    };

    // debounce：拖拽调宽时 ResizeObserver 高频回调，避免 fit + IPC 抖动闪烁
    let rafId = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleFit = () => {
      // rAF 保证 DOM 已更新；setTimeout 合并连续触发（100ms 内只执行最后一次）
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(handleResize, 100);
      });
    };

    // 使用 ResizeObserver 监听容器尺寸变化
    // 这样可以响应父容器宽度变化（如拖拽调整左侧面板宽度）
    const resizeObserver = new ResizeObserver(scheduleFit);

    resizeObserver.observe(container);

    // 初始调整（立即执行，无 debounce）
    requestAnimationFrame(handleResize);

    return () => {
      resizeObserver.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, resize]);

  // 激活时聚焦
  useEffect(() => {
    if (isActive && xtermRef.current) {
      xtermRef.current.focus();
    }
  }, [isActive]);

  // 主题变化时更新 xterm 配色
  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    xterm.options.theme = getXtermTheme(theme);
  }, [theme]);

  return (
    <div
      ref={terminalRef}
      className="w-full h-full"
      style={{ display: isActive ? 'block' : 'none' }}
    />
  );
}

/** 终端面板 */
export function TerminalPanel() {
  const sessions = useTerminalStore((state) => state.sessions);
  const activeSessionId = useTerminalStore((state) => state.activeSessionId);
  const createSession = useTerminalStore((state) => state.createSession);
  const closeSession = useTerminalStore((state) => state.closeSession);
  const setActiveSession = useTerminalStore((state) => state.setActiveSession);
  const initEventListeners = useTerminalStore((state) => state.initEventListeners);
  const getCurrentWorkspace = useWorkspaceStore((state) => state.getCurrentWorkspace);
  const [initialized, setInitialized] = useState(false);
  const [showRunner, setShowRunner] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState<{ visible: boolean; x: number; y: number; sessionId: string | null }>({
    visible: false,
    x: 0,
    y: 0,
    sessionId: null,
  });
  const terminalScriptPanelCollapsed = useViewStore((state) => state.terminalScriptPanelCollapsed);
  const toggleTerminalScriptPanelCollapsed = useViewStore((state) => state.toggleTerminalScriptPanelCollapsed);
  const terminalFullscreen = useViewStore((state) => state.terminalFullscreen);
  const toggleTerminalFullscreen = useViewStore((state) => state.toggleTerminalFullscreen);
  const scripts = useTerminalScriptStore((state) => state.scripts);
  const runScript = useTerminalScriptStore((state) => state.runScript);
  const stopScript = useTerminalScriptStore((state) => state.stopScript);

  // 获取当前工作区路径
  const currentWorkspace = getCurrentWorkspace();
  const cwd = currentWorkspace?.path;
  const contextSession = sessions.find((session) => session.id === tabContextMenu.sessionId) ?? null;
  const contextScript = contextSession?.scriptId
    ? scripts.find((script) => script.id === contextSession.scriptId)
    : null;

  // 初始化事件监听
  useEffect(() => {
    const cleanup = initEventListeners();
    return cleanup;
  }, [initEventListeners]);

  useEffect(() => {
    const handleOpenRunner = () => setShowRunner(true);
    window.addEventListener('terminal:open-runner', handleOpenRunner);
    return () => window.removeEventListener('terminal:open-runner', handleOpenRunner);
  }, []);

  // 自动创建第一个会话
  useEffect(() => {
    if (!initialized && sessions.length === 0) {
      setInitialized(true);
      createSession(undefined, cwd || undefined).catch((e) => log.error('Failed to create session', e instanceof Error ? e : new Error(String(e))));
    }
  }, [initialized, sessions.length, createSession, cwd]);

  // 创建新终端
  const handleCreate = useCallback(() => {
    createSession(undefined, cwd || undefined).catch((e) => log.error('Failed to create session', e instanceof Error ? e : new Error(String(e))));
  }, [createSession, cwd]);

  // 关闭终端
  const handleClose = useCallback((sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    closeSession(sessionId).catch((e) => log.error('Failed to close session', e instanceof Error ? e : new Error(String(e))));
  }, [closeSession]);

  const handleCloseContextSession = useCallback(() => {
    if (!contextSession) return;
    closeSession(contextSession.id).catch((e) => log.error('Failed to close session', e instanceof Error ? e : new Error(String(e))));
  }, [closeSession, contextSession]);

  // ESC 退出终端全屏
  useEffect(() => {
    if (!terminalFullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        toggleTerminalFullscreen();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [terminalFullscreen, toggleTerminalFullscreen]);

  return (
    <div className="flex flex-col h-full bg-background-base">
      <TerminalQuickRunBar
        collapsed={terminalScriptPanelCollapsed}
        onToggleCollapsed={toggleTerminalScriptPanelCollapsed}
        onOpenRunner={() => setShowRunner(true)}
      />
      {!terminalScriptPanelCollapsed && <TerminalScriptPanel workspacePath={cwd || null} />}

      {/* 标签栏 */}
      <div className="flex items-center h-9 bg-background-elevated border-b border-border shrink-0">
        {/* 终端标签 */}
        <div className="flex-1 flex items-center overflow-x-auto">
          {sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => setActiveSession(session.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setActiveSession(session.id);
                setTabContextMenu({ visible: true, x: e.clientX, y: e.clientY, sessionId: session.id });
              }}
              className={`
                flex items-center gap-1.5 px-3 h-full min-w-[100px] max-w-[200px]
                cursor-pointer border-r border-border
                ${activeSessionId === session.id
                  ? 'bg-background-base text-text-primary'
                  : 'bg-background-surface text-text-secondary hover:bg-background-hover'
                }
              `}
            >
              <TerminalIcon size={14} className="shrink-0" />
              <span className="flex-1 truncate text-sm">{session.name}</span>
              <button
                onClick={(e) => handleClose(session.id, e)}
                className="p-0.5 rounded hover:bg-background-hover shrink-0"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>

        {/* 新建按钮 */}
        <button
          onClick={handleCreate}
          className="flex items-center justify-center w-9 h-9 text-text-secondary hover:text-text-primary hover:bg-background-hover shrink-0"
          title="新建终端"
        >
          <Plus size={16} />
        </button>

        {/* 全屏切换按钮（方案 B1）：撑满除 ActivityBar 外全部横向空间，ESC 退出 */}
        <button
          onClick={toggleTerminalFullscreen}
          className={`flex items-center justify-center w-9 h-9 shrink-0 transition-colors ${
            terminalFullscreen
              ? 'text-primary bg-background-hover'
              : 'text-text-secondary hover:text-text-primary hover:bg-background-hover'
          }`}
          title={terminalFullscreen ? '退出全屏 (Esc)' : '终端全屏'}
        >
          {terminalFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>

      <TerminalTabContextMenu
        visible={tabContextMenu.visible}
        x={tabContextMenu.x}
        y={tabContextMenu.y}
        session={contextSession}
        command={contextScript?.command}
        onClose={() => setTabContextMenu((state) => ({ ...state, visible: false }))}
        onCloseSession={handleCloseContextSession}
        onStopScript={contextScript ? () => stopScript(contextScript.id) : undefined}
        onRerunScript={contextScript ? () => runScript(contextScript.id) : undefined}
      />

      {/* 终端内容区 */}
      <div className="flex-1 relative overflow-hidden">
        {sessions.length === 0 ? (
          <div className="flex items-center justify-center h-full text-text-secondary">
            <div className="text-center">
              <TerminalIcon size={48} className="mx-auto mb-3 opacity-50" />
              <p className="text-sm">点击 + 创建新终端</p>
            </div>
          </div>
        ) : (
          sessions.map((session) => (
            <TerminalInstance
              key={session.id}
              sessionId={session.id}
              isActive={activeSessionId === session.id}
            />
          ))
        )}
      </div>

      {showRunner && (
        <TerminalRunCommandModal
          workspacePath={cwd || null}
          onClose={() => setShowRunner(false)}
        />
      )}
    </div>
  );
}

export default TerminalPanel;
