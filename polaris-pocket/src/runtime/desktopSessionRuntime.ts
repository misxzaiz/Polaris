/**
 * desktopSessionRuntime — Pocket 桌面会话运行时
 *
 * 全局 Zustand store，管理连接到桌面端后的会话状态。
 * 功能：
 * - 单次 WS 订阅，按 sessionId 路由事件到对应会话
 * - 多会话并行（最多 MAX_POCKET_TABS 个）
 * - applyAIEvent 纯函数归约
 * - 会话管理（打开/关闭/切换）
 */
import { create } from 'zustand';
import { onEvent, disconnect } from '../services/desktopTransport';
import { getSessionHistory } from '../services/desktopClient';
import { applyAIEvent } from './applyAIEvent';
import {
  MAX_POCKET_TABS,
  createEmptySessionState,
  fromPocketContextId,
  toPocketContextId,
  type ChatMessage,
  type PocketAIEvent,
  type SessionRuntimeState,
} from './types';

// ============================================================================
// Store 类型
// ============================================================================

interface DesktopSessionRuntimeState {
  sessions: Record<string, SessionRuntimeState>;
  tabOrder: string[];
  activeSessionId: string | null;
  initialized: boolean;
  initError: string | null;
}

interface DesktopSessionRuntimeActions {
  ensureInitialized: () => Promise<void>;
  openSession: (meta: {
    id: string;
    title: string;
    engineId: string;
    projectPath?: string;
    messages?: ChatMessage[];
  }) => { ok: true } | { ok: false; reason: string };
  closeSession: (sessionId: string) => void;
  setActiveSession: (sessionId: string | null) => void;
  clearActive: () => void;
  setInput: (sessionId: string, input: string) => void;
  sendMessage: (sessionId: string, text: string) => Promise<void>;
  interrupt: (sessionId: string) => Promise<void>;
  answerQuestion: (sessionId: string, selected: string[], declined: boolean) => Promise<void>;
  respondPlan: (sessionId: string, approve: boolean) => Promise<void>;
  respondPermission: (sessionId: string, approve: boolean) => Promise<void>;
  setMessages: (sessionId: string, messages: ChatMessage[]) => void;
  routeEvent: (contextId: string | undefined, event: PocketAIEvent) => void;
  reset: () => void;
}

export type DesktopSessionRuntimeStore = DesktopSessionRuntimeState & DesktopSessionRuntimeActions;

// ============================================================================
// 内部
// ============================================================================

let unlistenGlobal: (() => void) | null = null;
let initPromise: Promise<void> | null = null;

function pickEvictCandidate(
  tabOrder: string[],
  sessions: Record<string, SessionRuntimeState>,
): string | null {
  const ranked = tabOrder
    .map((id) => sessions[id])
    .filter((s): s is SessionRuntimeState => !!s)
    .filter((s) => s.status === 'idle' || s.status === 'error')
    .sort((a, b) => {
      const rank = (st: string) => (st === 'idle' ? 0 : 1);
      const r = rank(a.status) - rank(b.status);
      if (r !== 0) return r;
      return a.lastAccessedAt - b.lastAccessedAt;
    });
  return ranked[0]?.id ?? null;
}

function parseRoutedPayload(raw: unknown): { contextId?: string; payload: unknown } {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { payload: raw };
    }
  }
  if (data && typeof data === 'object' && 'payload' in data) {
    const obj = data as { contextId?: string; payload: unknown };
    let payload = obj.payload;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        // keep string
      }
    }
    return { contextId: obj.contextId, payload };
  }
  return { payload: data };
}

// ============================================================================
// Store
// ============================================================================

export const useDesktopSessionRuntime = create<DesktopSessionRuntimeStore>((set, get) => ({
  sessions: {},
  tabOrder: [],
  activeSessionId: null,
  initialized: false,
  initError: null,

  ensureInitialized: async () => {
    if (get().initialized) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        unlistenGlobal = onEvent('chat-event', (raw) => {
          const { contextId, payload } = parseRoutedPayload(raw);
          if (!payload || typeof payload !== 'object') return;
          const event = payload as PocketAIEvent;
          if (!event.type) return;
          get().routeEvent(contextId, event);
        });
        set({ initialized: true, initError: null });
      } catch (err) {
        set({
          initError: err instanceof Error ? err.message : String(err),
        });
      } finally {
        initPromise = null;
      }
    })();

    return initPromise;
  },

  openSession: (meta) => {
    const state = get();
    void state.ensureInitialized();

    if (state.sessions[meta.id]) {
      set({
        activeSessionId: meta.id,
        sessions: {
          ...state.sessions,
          [meta.id]: {
            ...state.sessions[meta.id],
            lastAccessedAt: Date.now(),
            title: meta.title || state.sessions[meta.id].title,
            projectPath: meta.projectPath ?? state.sessions[meta.id].projectPath,
          },
        },
      });
      return { ok: true };
    }

    let tabOrder = [...state.tabOrder];
    let sessions = { ...state.sessions };

    if (tabOrder.length >= MAX_POCKET_TABS) {
      const evictId = pickEvictCandidate(tabOrder, sessions);
      if (!evictId) {
        return {
          ok: false,
          reason: `已达上限 ${MAX_POCKET_TABS} 个会话，请先关闭空闲会话`,
        };
      }
      tabOrder = tabOrder.filter((id) => id !== evictId);
      delete sessions[evictId];
    }

    const next = createEmptySessionState(meta);
    sessions[meta.id] = next;
    tabOrder = [...tabOrder, meta.id];

    set({ sessions, tabOrder, activeSessionId: meta.id });
    return { ok: true };
  },

  closeSession: (sessionId) => {
    const { sessions, tabOrder, activeSessionId } = get();
    if (!sessions[sessionId]) return;

    const nextSessions = { ...sessions };
    delete nextSessions[sessionId];
    const nextOrder = tabOrder.filter((id) => id !== sessionId);
    const nextActive =
      activeSessionId === sessionId
        ? (nextOrder.length > 0 ? nextOrder[nextOrder.length - 1] : null)
        : activeSessionId;

    set({ sessions: nextSessions, tabOrder: nextOrder, activeSessionId: nextActive });
  },

  setActiveSession: (sessionId) => {
    if (sessionId === null) {
      set({ activeSessionId: null });
      return;
    }
    const session = get().sessions[sessionId];
    if (!session) return;
    set({
      activeSessionId: sessionId,
      sessions: {
        ...get().sessions,
        [sessionId]: { ...session, lastAccessedAt: Date.now() },
      },
    });
  },

  clearActive: () => set({ activeSessionId: null }),

  setInput: (sessionId, input) => {
    const session = get().sessions[sessionId];
    if (!session) return;
    set({
      sessions: {
        ...get().sessions,
        [sessionId]: { ...session, input },
      },
    });
  },

  setMessages: (sessionId, messages) => {
    const session = get().sessions[sessionId];
    if (!session) return;
    set({
      sessions: {
        ...get().sessions,
        [sessionId]: { ...session, messages, partial: null },
      },
    });
  },

  sendMessage: async (sessionId, text) => {
    const session = get().sessions[sessionId];
    if (!session) return;
    const trimmed = text.trim();
    if (!trimmed || session.sending) return;

    const userMessage: ChatMessage = {
      id: `pocket-user-${Date.now()}`,
      type: 'user',
      content: trimmed,
      timestamp: new Date().toISOString(),
    };

    set({
      sessions: {
        ...get().sessions,
        [sessionId]: {
          ...session,
          messages: [...session.messages, userMessage],
          input: '',
          sending: true,
          error: null,
          status: 'running',
          lastAccessedAt: Date.now(),
        },
      },
    });

    try {
      const { invoke } = await import('../services/desktopClient');
      await invoke('continue_chat', {
        sessionId,
        message: trimmed,
        options: {
          engineId: session.engineId,
          workDir: session.projectPath,
          contextId: toPocketContextId(sessionId),
        },
      });
    } catch (err) {
      const current = get().sessions[sessionId];
      if (!current) return;
      set({
        sessions: {
          ...get().sessions,
          [sessionId]: {
            ...current,
            sending: false,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          },
        },
      });
    }
  },

  interrupt: async (sessionId) => {
    const session = get().sessions[sessionId];
    if (!session) return;
    try {
      const { invoke } = await import('../services/desktopClient');
      await invoke('interrupt_chat', { sessionId });
      const current = get().sessions[sessionId];
      if (!current) return;
      set({
        sessions: {
          ...get().sessions,
          [sessionId]: {
            ...current,
            sending: false,
            status: current.pendingCard ? 'waiting' : 'idle',
          },
        },
      });
    } catch (err) {
      const current = get().sessions[sessionId];
      if (!current) return;
      set({
        sessions: {
          ...get().sessions,
          [sessionId]: {
            ...current,
            error: err instanceof Error ? err.message : String(err),
            status: 'error',
          },
        },
      });
    }
  },

  answerQuestion: async (sessionId, selected, declined) => {
    const session = get().sessions[sessionId];
    if (!session?.pendingCard?.questionId) return;
    const callId = session.pendingCard.questionId;
    try {
      const { invoke } = await import('../services/desktopClient');
      if (declined) {
        await invoke('answer_question', { sessionId, callId, answer: { declined: true } });
      } else {
        await invoke('answer_question', { sessionId, callId, answer: { selected } });
      }
      const current = get().sessions[sessionId];
      if (!current) return;
      set({
        sessions: {
          ...get().sessions,
          [sessionId]: {
            ...current,
            pendingCard: null,
            status: current.sending ? 'running' : 'idle',
          },
        },
      });
    } catch {
      // 等待后续事件
    }
  },

  respondPlan: async (sessionId, approve) => {
    const session = get().sessions[sessionId];
    if (!session?.pendingCard?.planId) return;
    const planId = session.pendingCard.planId;
    try {
      const { invoke } = await import('../services/desktopClient');
      if (approve) {
        await invoke('approve_plan', { sessionId, planId });
      } else {
        await invoke('reject_plan', { sessionId, planId });
      }
      const current = get().sessions[sessionId];
      if (!current) return;
      set({
        sessions: {
          ...get().sessions,
          [sessionId]: {
            ...current,
            pendingCard: null,
            status: current.sending ? 'running' : 'idle',
          },
        },
      });
    } catch (err) {
      const current = get().sessions[sessionId];
      if (!current) return;
      set({
        sessions: {
          ...get().sessions,
          [sessionId]: {
            ...current,
            sending: false,
            error: err instanceof Error ? err.message : String(err),
            status: 'error',
          },
        },
      });
    }
  },

  respondPermission: async (sessionId, approve) => {
    const session = get().sessions[sessionId];
    if (!session) return;

    const text = approve ? '批准' : '拒绝';
    const userMessage: ChatMessage = {
      id: `pocket-perm-${Date.now()}`,
      type: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };

    set({
      sessions: {
        ...get().sessions,
        [sessionId]: {
          ...session,
          pendingCard: null,
          messages: [...session.messages, userMessage],
          sending: true,
          status: 'running',
          error: null,
        },
      },
    });

    try {
      const { invoke } = await import('../services/desktopClient');
      await invoke('continue_chat', {
        sessionId,
        message: text,
        options: {
          engineId: session.engineId,
          workDir: session.projectPath,
          contextId: toPocketContextId(sessionId),
        },
      });
    } catch (err) {
      const current = get().sessions[sessionId];
      if (!current) return;
      set({
        sessions: {
          ...get().sessions,
          [sessionId]: {
            ...current,
            sending: false,
            error: err instanceof Error ? err.message : String(err),
            status: 'error',
          },
        },
      });
    }
  },

  routeEvent: (contextId, event) => {
    const state = get();
    const eventSessionId =
      event && typeof event === 'object' && 'sessionId' in event && typeof (event as { sessionId: unknown }).sessionId === 'string'
        ? (event as { sessionId: string }).sessionId
        : undefined;

    // 1) contextId pocket-{id}
    let targetId = fromPocketContextId(contextId);

    // 2) payload.sessionId 如果正好是已打开的会话
    if (!targetId && eventSessionId && state.sessions[eventSessionId]) {
      targetId = eventSessionId;
    }

    // 3) 仅当唯一 running 会话时，兜底
    if (!targetId) {
      const running = state.tabOrder.filter((id) => state.sessions[id]?.sending);
      if (running.length === 1) targetId = running[0];
    }

    if (!targetId) return;
    const session = state.sessions[targetId];
    if (!session) return;

    const { state: next } = applyAIEvent(session, event);
    set({
      sessions: {
        ...get().sessions,
        [targetId]: next,
      },
    });
  },

  reset: () => {
    if (unlistenGlobal) {
      unlistenGlobal();
      unlistenGlobal = null;
    }
    initPromise = null;
    set({
      sessions: {},
      tabOrder: [],
      activeSessionId: null,
      initialized: false,
      initError: null,
    });
  },
}));

// ============================================================================
// Selectors
// ============================================================================

export function selectActiveSession(state: DesktopSessionRuntimeStore): SessionRuntimeState | null {
  if (!state.activeSessionId) return null;
  return state.sessions[state.activeSessionId] ?? null;
}

export function selectTabSessions(state: DesktopSessionRuntimeStore): SessionRuntimeState[] {
  return state.tabOrder
    .map((id) => state.sessions[id])
    .filter((s): s is SessionRuntimeState => !!s);
}