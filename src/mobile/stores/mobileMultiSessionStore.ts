/**
 * mobileMultiSessionStore — 移动端多会话 Tab 条状态
 *
 * 对应桌面端 useViewStore 的 multiSessionIds / expandSessionId 子集，
 * 但保持移动端轻量、独立，不引入桌面端无关字段。
 *
 * 语义：
 * - sessionIds：钉在 Tab 条上的会话（最多 8 个，超出自动淘汰最早的）
 * - activeSessionId：当前主视图显示的会话
 * - activeSession 存原始 detail（含历史消息），供 MobileChatSession 首次渲染
 *
 * 持久化：仅内存，App 重启后清空（与桌面端多窗口一致）。
 * 会话流状态由 useMobileSession 的模块级缓存独立保留。
 */

import { create } from 'zustand';
import type { MobileSessionDetail } from '../MobileSessions';
import { disposeSessionState } from '../hooks/useMobileSession';

const MAX_TABS = 8;

interface MobileMultiSessionState {
  /** Tab 条上的会话详情（保留 detail 以便首次渲染拿历史消息） */
  sessions: MobileSessionDetail[];
  /** 当前激活的会话 ID */
  activeSessionId: string | null;

  /** 添加会话到 Tab 条（已存在则仅激活） */
  addSession: (session: MobileSessionDetail) => void;
  /** 移除会话 */
  removeSession: (sessionId: string) => void;
  /** 设置激活会话 */
  setActiveSession: (sessionId: string) => void;
  /** 清空激活态（回到会话列表），保留 Tab 条 */
  clearActive: () => void;
  /** 清空全部 */
  clear: () => void;
}

export const useMobileMultiSessionStore = create<MobileMultiSessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,

  addSession: (session) => {
    const { sessions } = get();
    const exists = sessions.find(s => s.id === session.id);
    if (exists) {
      // 已存在：激活即可，不替换（避免覆盖已有流式状态对应的 detail）
      set({ activeSessionId: session.id });
      return;
    }
    // 新增：超限淘汰最早的
    const next = sessions.length >= MAX_TABS ? [...sessions.slice(1), session] : [...sessions, session];
    set({ sessions: next, activeSessionId: session.id });
  },

  removeSession: (sessionId) => {
    const { sessions, activeSessionId } = get();
    const next = sessions.filter(s => s.id !== sessionId);
    // 移除的是当前激活会话 → 切到末尾（或置空）
    const nextActive = activeSessionId === sessionId
      ? (next.length > 0 ? next[next.length - 1].id : null)
      : activeSessionId;
    set({ sessions: next, activeSessionId: nextActive });
    // 同步清理会话流缓存，避免内存泄漏与"关闭→重开"竞态
    disposeSessionState(sessionId);
  },

  setActiveSession: (sessionId) => {
    const { sessions } = get();
    if (sessions.find(s => s.id === sessionId)) {
      set({ activeSessionId: sessionId });
    }
  },

  clearActive: () => {
    set({ activeSessionId: null });
  },

  clear: () => {
    const { sessions } = get();
    sessions.forEach(s => disposeSessionState(s.id));
    set({ sessions: [], activeSessionId: null });
  },
}));
