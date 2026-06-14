/**
 * 视图显示状态管理
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** 左侧面板类型（内置 + 外部插件动态注册） */
export type LeftPanelType = string

/** 小屏模式状态 */
export interface CompactModeState {
  isCompactMode: boolean;      // 是否处于小屏模式
  windowWidth: number;         // 窗口宽度
  windowHeight: number;        // 窗口高度
}

/** 视图状态 */
interface ViewState {
  showSidebar: boolean;
  showEditor: boolean;
  showDeveloperPanel: boolean;
  showGitPanel: boolean;      // Git 面板
  showSessionHistory: boolean; // 会话历史面板
  showNotificationCenter: boolean; // 消息中心面板
  sidebarWidth: number;      // 侧边栏宽度（像素）
  editorWidth: number;       // 编辑器宽度百分比（0-100）
  developerPanelWidth: number; // Developer 面板宽度（像素）
  gitPanelWidth: number;     // Git 面板宽度（像素）
  // 新布局相关状态
  leftPanelType: LeftPanelType;  // 左侧面板类型
  leftPanelWidth: number;        // 左侧面板宽度
  rightPanelWidth: number;       // 右侧 AI 面板宽度
  rightPanelCollapsed: boolean;  // 右侧面板是否折叠
  activityBarCollapsed: boolean; // ActivityBar 是否折叠（隐藏图标栏）
  terminalScriptPanelCollapsed: boolean; // 终端脚本面板是否折叠
  // 小屏模式状态
  compactMode: CompactModeState; // 小屏模式
  schedulerLogDrawerHeight: number; // 日志抽屉高度
  // 多会话窗口模式
  multiSessionMode: boolean;     // 是否开启多会话窗口模式
  multiSessionIds: string[];     // 多会话窗口中显示的会话 ID 列表（最多 16 个）
  multiSessionRows: 1 | 2;       // 行数配置：1 行或 2 行
  multiSessionCellWidth: number; // 每个格子的统一宽度（像素）
  expandSessionId: string | null; // 展开的会话 ID（全屏显示）
  pendingScrollToId: string | null; // 待滚动的会话 ID（一次性信号）
}

/** 视图操作 */
interface ViewActions {
  toggleSidebar: () => void;
  toggleEditor: () => void;
  toggleDeveloperPanel: () => void;
  toggleGitPanel: () => void;
  toggleSessionHistory: () => void;
  toggleNotificationCenter: () => void;
  setShowEditor: (show: boolean) => void;
  setAIOnlyMode: () => void;
  resetView: () => void;
  setSidebarWidth: (width: number) => void;
  setEditorWidth: (width: number) => void;
  setDeveloperPanelWidth: (width: number) => void;
  setGitPanelWidth: (width: number) => void;
  // 新布局相关操作
  setLeftPanelType: (type: LeftPanelType) => void;
  toggleLeftPanel: (type: LeftPanelType) => void; // 切换左侧面板,如果已显示则隐藏
  switchToLeftPanel: (type: LeftPanelType) => void; // VSCode 风格: 切换面板,不关闭当前
  closeLeftPanel: () => void; // 关闭左侧面板
  setLeftPanelWidth: (width: number) => void;
  setRightPanelWidth: (width: number) => void;
  toggleRightPanel: () => void;
  toggleActivityBar: () => void; // 切换 ActivityBar 折叠状态
  toggleTerminalScriptPanelCollapsed: () => void;
  setTerminalScriptPanelCollapsed: (collapsed: boolean) => void;
  // 小屏模式操作
  updateCompactMode: (state: Partial<CompactModeState>) => void;
  // 日志抽屉高度
  setSchedulerLogDrawerHeight: (height: number) => void;
  // 多会话窗口操作
  toggleMultiSessionMode: () => void;
  setMultiSessionIds: (ids: string[]) => void;
  addToMultiView: (sessionId: string) => void;
  removeFromMultiView: (sessionId: string) => void;
  setMultiSessionRows: (rows: 1 | 2) => void;
  setMultiSessionCellWidth: (width: number) => void;
  // 展开操作
  setExpandSessionId: (sessionId: string | null) => void;
  toggleExpandSession: (sessionId: string) => void;
  // 滚动信号
  requestScrollToSession: (sessionId: string) => void;
  clearScrollRequest: () => void;
}

/** 完整的 View Store 类型 */
export type ViewStore = ViewState & ViewActions;

export const useViewStore = create<ViewStore>()(
  persist(
    (set) => ({
      // 初始状态
      showSidebar: true,
      showEditor: false,
      showDeveloperPanel: false,  // 默认关闭 Developer 面板
      showGitPanel: false,       // 默认关闭 Git 面板
      showSessionHistory: false,  // 默认关闭会话历史面板
      showNotificationCenter: false, // 默认关闭消息中心面板
      sidebarWidth: 240,
      editorWidth: 50,
      developerPanelWidth: 400,
      gitPanelWidth: 320,
      // 新布局初始状态
      leftPanelType: 'files' as LeftPanelType,  // 默认显示文件浏览器
      leftPanelWidth: 280,        // 左侧面板默认宽度
      rightPanelWidth: 400,       // 右侧 AI 面板默认宽度
      rightPanelCollapsed: false, // 右侧面板默认不折叠
      activityBarCollapsed: false, // ActivityBar 默认不折叠
      terminalScriptPanelCollapsed: true, // 终端脚本默认紧凑显示
      // 小屏模式初始状态
      compactMode: {
        isCompactMode: false,
        windowWidth: 1200,
        windowHeight: 800,
      },
      schedulerLogDrawerHeight: 128, // 默认 128px
      // 多会话窗口初始状态
      multiSessionMode: false,      // 默认单会话模式
      multiSessionIds: [],          // 默认空列表
      multiSessionRows: 1,          // 默认 1 行
      multiSessionCellWidth: 350,   // 默认格子宽度 350px
      expandSessionId: null,        // 默认无展开会话
      pendingScrollToId: null,      // 默认无待滚动会话

      // 切换侧边栏
      toggleSidebar: () => set((state) => ({ showSidebar: !state.showSidebar })),

      // 切换编辑器
      toggleEditor: () => set((state) => ({ showEditor: !state.showEditor })),

      // 设置编辑器显示状态
      setShowEditor: (show: boolean) => set({ showEditor: show }),

      // 切换 Developer 面板
      toggleDeveloperPanel: () => set((state) => ({ showDeveloperPanel: !state.showDeveloperPanel })),

      // 切换 Git 面板
      toggleGitPanel: () => set((state) => ({ showGitPanel: !state.showGitPanel })),

      // 切换会话历史面板
      toggleSessionHistory: () => set((state) => ({ showSessionHistory: !state.showSessionHistory })),

      // 切换消息中心面板
      toggleNotificationCenter: () => set((state) => ({ showNotificationCenter: !state.showNotificationCenter })),

      // 仅 AI 对话模式
      setAIOnlyMode: () => set({
        showSidebar: false,
        showEditor: false,
        showDeveloperPanel: false,
      }),

      // 重置视图
      resetView: () => set({
        showSidebar: true,
        showEditor: false,
        showDeveloperPanel: false,
      }),

      // 设置侧边栏宽度
      setSidebarWidth: (width: number) => set({ sidebarWidth: width }),

      // 设置编辑器宽度百分比
      setEditorWidth: (width: number) => set({ editorWidth: width }),

      // 设置 Developer 面板宽度
      setDeveloperPanelWidth: (width: number) => set({ developerPanelWidth: width }),

      // 设置 Git 面板宽度
      setGitPanelWidth: (width: number) => set({ gitPanelWidth: width }),

      // === 新布局相关操作 ===

      // 设置左侧面板类型
      setLeftPanelType: (type: LeftPanelType) => set({ leftPanelType: type }),

      // 切换左侧面板 (智能切换: 如果点击的是当前面板则隐藏, 否则显示该面板)
      toggleLeftPanel: (type: LeftPanelType) => set((state) => {
        if (state.leftPanelType === type) {
          // 如果点击的是当前面板,则隐藏
          return { leftPanelType: 'none' };
        } else {
          // 否则切换到该面板
          return { leftPanelType: type };
        }
      }),

      // VSCode 风格: 切换到指定面板,如果已经是该面板则不做操作
      switchToLeftPanel: (type: LeftPanelType) => set((state) => {
        if (state.leftPanelType !== type) {
          return { leftPanelType: type };
        }
        // 如果已经是该面板,不做任何操作
        return {};
      }),

      // 关闭左侧面板
      closeLeftPanel: () => set({ leftPanelType: 'none' }),

      // 设置左侧面板宽度
      setLeftPanelWidth: (width: number) => set({ leftPanelWidth: width }),

      // 设置右侧面板宽度
      setRightPanelWidth: (width: number) => set({ rightPanelWidth: width }),

      // 切换右侧面板折叠状态
      toggleRightPanel: () => set((state) => ({ rightPanelCollapsed: !state.rightPanelCollapsed })),

      // 切换 ActivityBar 折叠状态
      toggleActivityBar: () => set((state) => ({ activityBarCollapsed: !state.activityBarCollapsed })),

      // 切换终端脚本面板折叠状态
      toggleTerminalScriptPanelCollapsed: () => set((state) => ({
        terminalScriptPanelCollapsed: !state.terminalScriptPanelCollapsed,
      })),

      setTerminalScriptPanelCollapsed: (collapsed: boolean) => set({
        terminalScriptPanelCollapsed: collapsed,
      }),

      // 更新小屏模式状态
      updateCompactMode: (newState: Partial<CompactModeState>) => set((state) => ({
        compactMode: { ...state.compactMode, ...newState },
      })),

      // 设置日志抽屉高度
      setSchedulerLogDrawerHeight: (height: number) => set({ schedulerLogDrawerHeight: height }),

      // === 多会话窗口操作 ===

      // 切换多会话窗口模式
      toggleMultiSessionMode: () => set((state) => ({
        multiSessionMode: !state.multiSessionMode,
        // 开启时，如果列表为空则默认显示当前活跃会话
        multiSessionIds: !state.multiSessionMode && state.multiSessionIds.length === 0
          ? [] // 由外部负责填充当前活跃会话
          : state.multiSessionIds
      })),

      // 设置多会话窗口中的会话列表
      setMultiSessionIds: (ids: string[]) => set({ multiSessionIds: ids }),

      // 添加会话到多窗口视图（最多 16 个，超出时移除最早的）
      addToMultiView: (sessionId: string) => set((state) => {
        if (state.multiSessionIds.includes(sessionId)) return state;
        let newIds = [...state.multiSessionIds, sessionId];
        if (newIds.length > 16) {
          newIds = newIds.slice(-16); // 保留最新的 16 个
        }
        return { multiSessionIds: newIds };
      }),

      // 从多窗口视图移除会话
      removeFromMultiView: (sessionId: string) => set((state) => ({
        multiSessionIds: state.multiSessionIds.filter(id => id !== sessionId),
        // 如果移除的是展开的会话，清除展开状态
        expandSessionId: state.expandSessionId === sessionId ? null : state.expandSessionId
      })),

      // 设置行数配置
      setMultiSessionRows: (rows: 1 | 2) => set({ multiSessionRows: rows }),

      // 设置格子宽度
      setMultiSessionCellWidth: (width: number) => set({ multiSessionCellWidth: width }),

      // 设置展开的会话
      setExpandSessionId: (sessionId: string | null) => set({ expandSessionId: sessionId }),

      // 切换会话展开状态
      toggleExpandSession: (sessionId: string) => set((state) => ({
        expandSessionId: state.expandSessionId === sessionId ? null : sessionId
      })),

      // 请求滚动到指定会话（一次性信号，由 MultiSessionGrid 消费后清空）
      requestScrollToSession: (sessionId: string) => set({ pendingScrollToId: sessionId }),
      clearScrollRequest: () => set({ pendingScrollToId: null }),
    }),
    {
      name: 'view-store',
      partialize: (state) => {
        const { pendingScrollToId: _pendingScrollToId, ...rest } = state;
        return rest;
      },
      // 兼容旧持久化值：移除 ComicStudio 面板后，将遗留的面板类型回退到文件浏览器
      onRehydrateStorage: () => (state) => {
        if (state && (state.leftPanelType as string) === 'comicStudio') {
          state.leftPanelType = 'files';
        }
      },
    }
  )
);
