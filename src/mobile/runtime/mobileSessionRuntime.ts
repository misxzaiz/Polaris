/**
 * MobileSessionRuntime — 移动端多会话并行运行时
 *
 * 设计：
 * - 全局唯一 chat-event 订阅（不绑组件生命周期）
 * - 按 contextId `mobile-${sessionId}` 路由事件
 * - UI 可卸载；关 Tab 才 dispose
 * - 与桌面 sessionStoreManager 解耦，保持 companion 轻量
 */

import { create } from 'zustand';
import type { AIEvent } from '@/ai-runtime/event';
import type { ChatMessage } from '@/types';
import { invoke, listen } from '@/services/transport';
import { applyAIEvent } from './applyAIEvent';
import {
  MAX_MOBILE_TABS,
  createEmptySessionState,
  fromMobileContextId,
  toMobileContextId,
  type MobileSessionMeta,
  type MobileSessionStatus,
  type SessionRuntimeState,
} from './types';

// ============================================================================
// 类型
// ============================================================================

interface MobileSessionRuntimeState {
  /** sessionId → 运行时状态 */
  sessions: Record<string, SessionRuntimeState>;
  /** Tab 顺序（最多 MAX_MOBILE_TABS） */
  tabOrder: string[];
  /** 当前激活会话 */
  activeSessionId: string | null;
  /** 全局 listen 是否已建立 */
  initialized: boolean;
  /** 初始化错误（可选展示） */
  initError: string | null;
}

interface MobileSessionRuntimeActions {
  /** 确保全局 WS 订阅已建立（幂等） */
  ensureInitialized: () => Promise<void>;
  /** 打开/钉住会话；已存在则仅激活 */
  openSession: (meta: MobileSessionMeta) => { ok: true } | { ok: false; reason: string };
  /** 关闭会话并释放状态 */
  closeSession: (sessionId: string) => void;
  /** 切换激活会话（不 dispose） */
  setActiveSession: (sessionId: string | null) => void;
  /** 清空激活（回列表），保留 Tab */
  clearActive: () => void;
  /** 更新输入草稿 */
  setInput: (sessionId: string, input: string) => void;
  /** 发送消息（continue_chat） */
  sendMessage: (sessionId: string, text: string) => Promise<void>;
  /** 中断生成 */
  interrupt: (sessionId: string) => Promise<void>;
  /** 回答 question */
  answerQuestion: (sessionId: string, selected: string[], declined: boolean) => Promise<void>;
  /** 批准/拒绝 plan */
  respondPlan: (sessionId: string, approve: boolean) => Promise<void>;
  /** 权限响应（Phase 1 仍用文本回退，与现网一致） */
  respondPermission: (sessionId: string, approve: boolean) => Promise<void>;
  /** 用历史消息覆盖（result 后刷新 / 外部加载） */
  setMessages: (sessionId: string, messages: ChatMessage[]) => void;
  /** 路由入口（测试可直接调） */
  routeEvent: (contextId: string | undefined, event: AIEvent) => void;
  /** 测试/卸载：重置全部 */
  reset: () => void;
}

export type MobileSessionRuntimeStore = MobileSessionRuntimeState & MobileSessionRuntimeActions;

// ============================================================================
// 内部
// ============================================================================

let unlistenGlobal: (() => void) | null = null;
let initPromise: Promise<void> | null = null;

/** 历史刷新回调：由 UI 层注入（避免 Runtime 依赖 history service） */
type HistoryRefresher = (session: SessionRuntimeState) => Promise<ChatMessage[] | null>;
let historyRefresher: HistoryRefresher | null = null;

export function setMobileHistoryRefresher(fn: HistoryRefresher | null) {
  historyRefresher = fn;
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

function isAIEvent(value: unknown): value is AIEvent {
  return !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string';
}

function pickEvictCandidate(
  tabOrder: string[],
  sessions: Record<string, SessionRuntimeState>,
): string | null {
  // 优先淘汰 idle，其次 error；禁止自动淘汰 running/waiting
  const ranked = tabOrder
    .map((id) => sessions[id])
    .filter((s): s is SessionRuntimeState => !!s)
    .filter((s) => s.status === 'idle' || s.status === 'error')
    .sort((a, b) => {
      const rank = (st: MobileSessionStatus) => (st === 'idle' ? 0 : 1);
      const r = rank(a.status) - rank(b.status);
      if (r !== 0) return r;
      return a.lastAccessedAt - b.lastAccessedAt;
    });
  return ranked[0]?.id ?? null;
}

// ============================================================================
// Store
// ============================================================================

export const useMobileSessionRuntime = create<MobileSessionRuntimeStore>((set, get) => ({
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
        unlistenGlobal = await listen<unknown>('chat-event', (raw) => {
          const { contextId, payload } = parseRoutedPayload(raw);
          if (!isAIEvent(payload)) return;
          get().routeEvent(contextId, payload);
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
            // 不覆盖已有 messages/流状态
            title: meta.title || state.sessions[meta.id].title,
            projectPath: meta.projectPath ?? state.sessions[meta.id].projectPath,
          },
        },
      });
      return { ok: true };
    }

    let tabOrder = [...state.tabOrder];
    let sessions = { ...state.sessions };

    if (tabOrder.length >= MAX_MOBILE_TABS) {
      const evictId = pickEvictCandidate(tabOrder, sessions);
      if (!evictId) {
        return {
          ok: false,
          reason: `已达上限 ${MAX_MOBILE_TABS} 个会话，且均在运行/等待确认，请先关闭空闲会话`,
        };
      }
      tabOrder = tabOrder.filter((id) => id !== evictId);
      delete sessions[evictId];
    }

    const next = createEmptySessionState(meta);
    sessions[meta.id] = next;
    tabOrder = [...tabOrder, meta.id];

    set({
      sessions,
      tabOrder,
      activeSessionId: meta.id,
    });
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

    set({
      sessions: nextSessions,
      tabOrder: nextOrder,
      activeSessionId: nextActive,
    });
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
        [sessionId]: {
          ...session,
          messages,
          partial: null,
        },
      },
    });
  },

  sendMessage: async (sessionId, text) => {
    const session = get().sessions[sessionId];
    if (!session) return;
    const trimmed = text.trim();
    if (!trimmed || session.sending) return;

    const userMessage: ChatMessage = {
      id: `mobile-user-${Date.now()}`,
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
      await invoke('continue_chat', {
        sessionId,
        message: trimmed,
        options: {
          engineId: session.engineId,
          workDir: session.projectPath,
          contextId: toMobileContextId(sessionId),
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
      if (declined) {
        await invoke('answer_question', {
          sessionId,
          callId,
          answer: { declined: true },
        });
      } else {
        await invoke('answer_question', {
          sessionId,
          callId,
          answer: { selected },
        });
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
      // 等待后续 question_answered / error
    }
  },

  respondPlan: async (sessionId, approve) => {
    const session = get().sessions[sessionId];
    if (!session?.pendingCard?.planId) return;
    const planId = session.pendingCard.planId;
    try {
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
    // Phase 1：与现网一致，文本回退；Phase 2 再接正式 API
    const session = get().sessions[sessionId];
    if (!session) return;

    const text = approve ? '批准' : '拒绝';
    const userMessage: ChatMessage = {
      id: `mobile-perm-${Date.now()}`,
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
      await invoke('continue_chat', {
        sessionId,
        message: text,
        options: {
          engineId: session.engineId,
          workDir: session.projectPath,
          contextId: toMobileContextId(sessionId),
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
      event && typeof event === 'object' && 'sessionId' in event && typeof (event as { sessionId?: unknown }).sessionId === 'string'
        ? (event as { sessionId: string }).sessionId
        : undefined;

    // 1) contextId mobile-${id}
    let targetId = fromMobileContextId(contextId);

    // 2) payload.sessionId 若正好是已打开的前端 id
    if (!targetId && eventSessionId && state.sessions[eventSessionId]) {
      targetId = eventSessionId;
    }

    // 3) 仅当唯一 running 会话时，允许无 contextId 的事件落入（弱兜底）
    if (!targetId) {
      const running = state.tabOrder.filter((id) => state.sessions[id]?.sending);
      if (running.length === 1) targetId = running[0];
    }

    if (!targetId) return;
    const session = state.sessions[targetId];
    if (!session) return;

    const { state: next, shouldRefreshHistory } = applyAIEvent(session, event);
    set({
      sessions: {
        ...get().sessions,
        [targetId]: next,
      },
    });

    if (shouldRefreshHistory && historyRefresher) {
      const snapshot = next;
      void historyRefresher(snapshot).then((messages) => {
        if (!messages || messages.length === 0) return;
        const current = get().sessions[targetId];
        if (!current) return;
        // 若刷新返回期间又有新的 streaming partial，不要覆盖
        if (current.partial || current.sending) return;
        get().setMessages(targetId, messages);
      });
    }
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
// Selectors / hooks helpers
// ============================================================================

export function selectTabSessions(state: MobileSessionRuntimeStore): SessionRuntimeState[] {
  return state.tabOrder
    .map((id) => state.sessions[id])
    .filter((s): s is SessionRuntimeState => !!s);
}

export function selectActiveSession(state: MobileSessionRuntimeStore): SessionRuntimeState | null {
  if (!state.activeSessionId) return null;
  return state.sessions[state.activeSessionId] ?? null;
}

export function selectWaitingCount(state: MobileSessionRuntimeStore): number {
  return Object.values(state.sessions).filter((s) => s.status === 'waiting').length;
}
