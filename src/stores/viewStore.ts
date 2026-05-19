/**
 * 视图显示状态管理
 *
 * 注意: 布局相关字段 (leftPanelType / rightPanelCollapsed / activityBarCollapsed 等)
 * 已迁移到 layoutStore。本 store 仅保留与布局无关的视图态:
 * - compactMode (小屏检测)
 * - multiSessionMode 系列 (多会话窗口)
 * - schedulerLogDrawerHeight (日志抽屉)
 * - showDeveloperPanel/showGitPanel/showSessionHistory (杂项弹层)
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** 小屏模式状态 */
export interface CompactModeState {
  isCompactMode: boolean;
  windowWidth: number;
  windowHeight: number;
}

interface ViewState {
  showSessionHistory: boolean;
  compactMode: CompactModeState;
  schedulerLogDrawerHeight: number;
  // 多会话窗口模式
  multiSessionMode: boolean;
  multiSessionIds: string[];
  multiSessionRows: 1 | 2;
  multiSessionCellWidth: number;
  expandSessionId: string | null;
  pendingScrollToId: string | null;
  // 终端脚本面板折叠 (Terminal 模块内部使用)
  terminalScriptPanelCollapsed: boolean;
}

interface ViewActions {
  toggleSessionHistory: () => void;
  updateCompactMode: (state: Partial<CompactModeState>) => void;
  setSchedulerLogDrawerHeight: (height: number) => void;
  toggleMultiSessionMode: () => void;
  setMultiSessionIds: (ids: string[]) => void;
  addToMultiView: (sessionId: string) => void;
  removeFromMultiView: (sessionId: string) => void;
  setMultiSessionRows: (rows: 1 | 2) => void;
  setMultiSessionCellWidth: (width: number) => void;
  setExpandSessionId: (sessionId: string | null) => void;
  toggleExpandSession: (sessionId: string) => void;
  requestScrollToSession: (sessionId: string) => void;
  clearScrollRequest: () => void;
  toggleTerminalScriptPanelCollapsed: () => void;
  setTerminalScriptPanelCollapsed: (collapsed: boolean) => void;
}

export type ViewStore = ViewState & ViewActions;

export const useViewStore = create<ViewStore>()(
  persist(
    (set) => ({
      showSessionHistory: false,
      compactMode: {
        isCompactMode: false,
        windowWidth: 1200,
        windowHeight: 800,
      },
      schedulerLogDrawerHeight: 128,
      multiSessionMode: false,
      multiSessionIds: [],
      multiSessionRows: 1,
      multiSessionCellWidth: 350,
      expandSessionId: null,
      pendingScrollToId: null,
      terminalScriptPanelCollapsed: true,

      toggleSessionHistory: () =>
        set((state) => ({ showSessionHistory: !state.showSessionHistory })),

      updateCompactMode: (newState) =>
        set((state) => ({ compactMode: { ...state.compactMode, ...newState } })),

      setSchedulerLogDrawerHeight: (height) => set({ schedulerLogDrawerHeight: height }),

      toggleMultiSessionMode: () =>
        set((state) => ({
          multiSessionMode: !state.multiSessionMode,
          multiSessionIds:
            !state.multiSessionMode && state.multiSessionIds.length === 0
              ? []
              : state.multiSessionIds,
        })),

      setMultiSessionIds: (ids) => set({ multiSessionIds: ids }),

      addToMultiView: (sessionId) =>
        set((state) => {
          if (state.multiSessionIds.includes(sessionId)) return state;
          let newIds = [...state.multiSessionIds, sessionId];
          if (newIds.length > 16) newIds = newIds.slice(-16);
          return { multiSessionIds: newIds };
        }),

      removeFromMultiView: (sessionId) =>
        set((state) => ({
          multiSessionIds: state.multiSessionIds.filter((id) => id !== sessionId),
          expandSessionId:
            state.expandSessionId === sessionId ? null : state.expandSessionId,
        })),

      setMultiSessionRows: (rows) => set({ multiSessionRows: rows }),
      setMultiSessionCellWidth: (width) => set({ multiSessionCellWidth: width }),
      setExpandSessionId: (sessionId) => set({ expandSessionId: sessionId }),
      toggleExpandSession: (sessionId) =>
        set((state) => ({
          expandSessionId: state.expandSessionId === sessionId ? null : sessionId,
        })),
      requestScrollToSession: (sessionId) => set({ pendingScrollToId: sessionId }),
      clearScrollRequest: () => set({ pendingScrollToId: null }),

      toggleTerminalScriptPanelCollapsed: () =>
        set((state) => ({
          terminalScriptPanelCollapsed: !state.terminalScriptPanelCollapsed,
        })),
      setTerminalScriptPanelCollapsed: (collapsed) =>
        set({ terminalScriptPanelCollapsed: collapsed }),
    }),
    {
      name: 'view-store',
      partialize: (state) => {
        const { pendingScrollToId: _pendingScrollToId, ...rest } = state;
        return rest;
      },
    }
  )
);
