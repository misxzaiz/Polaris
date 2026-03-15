/**
 * TerminalPanel - 终端面板组件
 *
 * 使用 xterm.js 渲染终端界面
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { useTerminalStore } from '@/stores/terminalStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { Plus, X, Terminal as TerminalIcon } from 'lucide-react';
import 'xterm/css/xterm.css';

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

  // 初始化终端
  useEffect(() => {
    if (!terminalRef.current || xtermRef.current) return;

    const xterm = new XTerm({
      theme: {
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
      },
      fontFamily: 'Consolas, "Courier New", monospace',
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
    xterm.open(terminalRef.current);

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    // 初始调整大小
    setTimeout(() => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        resize(sessionId, dims.cols, dims.rows);
      }
    }, 100);

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
        console.error('[Terminal] 解码输出失败:', err);
      }
    };

    window.addEventListener('terminal-output', handleOutput as EventListener);
    return () => {
      window.removeEventListener('terminal-output', handleOutput as EventListener);
    };
  }, [sessionId]);

  // 调整大小 - 使用 ResizeObserver 监听容器尺寸变化
  useEffect(() => {
    if (!isActive) return;

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

    // 使用 ResizeObserver 监听容器尺寸变化
    // 这样可以响应父容器宽度变化（如拖拽调整左侧面板宽度）
    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });

    resizeObserver.observe(container);

    // 初始调整
    setTimeout(handleResize, 50);

    return () => {
      resizeObserver.disconnect();
    };
  }, [sessionId, isActive, resize]);

  // 激活时聚焦
  useEffect(() => {
    if (isActive && xtermRef.current) {
      xtermRef.current.focus();
    }
  }, [isActive]);

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

  // 获取当前工作区路径
  const currentWorkspace = getCurrentWorkspace();
  const cwd = currentWorkspace?.path;

  // 初始化事件监听
  useEffect(() => {
    const cleanup = initEventListeners();
    return cleanup;
  }, [initEventListeners]);

  // 自动创建第一个会话
  useEffect(() => {
    if (!initialized && sessions.length === 0) {
      setInitialized(true);
      createSession(undefined, cwd || undefined).catch(console.error);
    }
  }, [initialized, sessions.length, createSession, cwd]);

  // 创建新终端
  const handleCreate = useCallback(() => {
    createSession(undefined, cwd || undefined).catch(console.error);
  }, [createSession, cwd]);

  // 关闭终端
  const handleClose = useCallback((sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    closeSession(sessionId).catch(console.error);
  }, [closeSession]);

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e]">
      {/* 标签栏 */}
      <div className="flex items-center h-9 bg-[#252526] border-b border-[#3c3c3c] shrink-0">
        {/* 终端标签 */}
        <div className="flex-1 flex items-center overflow-x-auto">
          {sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => setActiveSession(session.id)}
              className={`
                flex items-center gap-1.5 px-3 h-full min-w-[100px] max-w-[200px]
                cursor-pointer border-r border-[#3c3c3c]
                ${activeSessionId === session.id
                  ? 'bg-[#1e1e1e] text-text-primary'
                  : 'bg-[#2d2d2d] text-text-secondary hover:bg-[#2a2a2a]'
                }
              `}
            >
              <TerminalIcon size={14} className="shrink-0" />
              <span className="flex-1 truncate text-sm">{session.name}</span>
              <button
                onClick={(e) => handleClose(session.id, e)}
                className="p-0.5 rounded hover:bg-[#3c3c3c] shrink-0"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>

        {/* 新建按钮 */}
        <button
          onClick={handleCreate}
          className="flex items-center justify-center w-9 h-9 text-text-secondary hover:text-text-primary hover:bg-[#3c3c3c] shrink-0"
          title="新建终端"
        >
          <Plus size={16} />
        </button>
      </div>

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
    </div>
  );
}

export default TerminalPanel;
