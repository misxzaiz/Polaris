/**
 * 终端状态管理
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { TerminalSession, TerminalOutputEvent, TerminalExitEvent } from '@/types/terminal';

interface TerminalState {
  /** 所有会话 */
  sessions: TerminalSession[];
  /** 当前活跃会话 ID */
  activeSessionId: string | null;
  /** 是否正在加载 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;
}

interface TerminalActions {
  /** 创建新会话 */
  createSession: (name?: string, cwd?: string) => Promise<TerminalSession>;
  /** 关闭会话 */
  closeSession: (sessionId: string) => Promise<void>;
  /** 写入数据 */
  write: (sessionId: string, data: string) => Promise<void>;
  /** 调整大小 */
  resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
  /** 切换活跃会话 */
  setActiveSession: (sessionId: string | null) => void;
  /** 刷新会话列表 */
  refreshSessions: () => Promise<void>;
  /** 初始化事件监听 */
  initEventListeners: () => () => void;
  /** 设置错误 */
  setError: (error: string | null) => void;
}

export type TerminalStore = TerminalState & TerminalActions;

export const useTerminalStore = create<TerminalStore>((set) => ({
  sessions: [],
  activeSessionId: null,
  loading: false,
  error: null,

  createSession: async (name?: string, cwd?: string) => {
    try {
      set({ loading: true, error: null });
      const session = await invoke<TerminalSession>('terminal_create', {
        name,
        cwd,
        cols: 80,
        rows: 24,
      });
      set((state) => ({
        sessions: [...state.sessions, session],
        activeSessionId: session.id,
        loading: false,
      }));
      return session;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      set({ error, loading: false });
      throw e;
    }
  },

  closeSession: async (sessionId: string) => {
    try {
      await invoke('terminal_close', { sessionId });
      set((state) => ({
        sessions: state.sessions.filter((s) => s.id !== sessionId),
        activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId,
      }));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      set({ error });
      throw e;
    }
  },

  write: async (sessionId: string, data: string) => {
    try {
      await invoke('terminal_write', { sessionId, data });
    } catch (e) {
      console.error('[Terminal] 写入失败:', e);
    }
  },

  resize: async (sessionId: string, cols: number, rows: number) => {
    try {
      await invoke('terminal_resize', { sessionId, cols, rows });
    } catch (e) {
      console.error('[Terminal] 调整大小失败:', e);
    }
  },

  setActiveSession: (sessionId: string | null) => {
    set({ activeSessionId: sessionId });
  },

  refreshSessions: async () => {
    try {
      const sessions = await invoke<TerminalSession[]>('terminal_list');
      set({ sessions });
    } catch (e) {
      console.error('[Terminal] 获取会话列表失败:', e);
    }
  },

  initEventListeners: () => {
    // 监听终端输出
    const unlistenOutput = listen<TerminalOutputEvent>('terminal:output', (event) => {
      const { sessionId, data } = event.payload;
      // 触发自定义事件，由终端组件处理
      window.dispatchEvent(new CustomEvent('terminal-output', {
        detail: { sessionId, data },
      }));
    });

    // 监听终端退出
    const unlistenExit = listen<TerminalExitEvent>('terminal:exit', (event) => {
      const { sessionId } = event.payload;
      set((state) => ({
        sessions: state.sessions.filter((s) => s.id !== sessionId),
        activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId,
      }));
    });

    // 返回清理函数
    return () => {
      unlistenOutput.then((fn) => fn());
      unlistenExit.then((fn) => fn());
    };
  },

  setError: (error: string | null) => {
    set({ error });
  },
}));
