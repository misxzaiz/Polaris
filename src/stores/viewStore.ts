/**
 * 视图显示状态管理
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** 左侧面板类型 */
export type LeftPanelType = 'files' | 'git' | 'todo' | 'translate' | 'scheduler' | 'terminal' | 'tools' | 'developer' | 'none';

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
  showToolPanel: boolean;
  showDeveloperPanel: boolean;
  showGitPanel: boolean;      // Git 面板
  showSessionHistory: boolean; // 会话历史面板
  sidebarWidth: number;      // 侧边栏宽度（像素）
  editorWidth: number;       // 编辑器宽度百分比（0-100）
  toolPanelWidth: number;    // 工具面板宽度（像素）
  developerPanelWidth: number; // Developer 面板宽度（像素）
  gitPanelWidth: number;     // Git 面板宽度（像素）
  // 新布局相关状态
  leftPanelType: LeftPanelType;  // 左侧面板类型
  leftPanelWidth: number;        // 左侧面板宽度
  rightPanelWidth: number;       // 右侧 AI 面板宽度
  rightPanelCollapsed: boolean;  // 右侧面板是否折叠
  // 小屏模式状态
  compactMode: CompactModeState; // 小屏模式
}

/** 视图操作 */
interface ViewActions {
  toggleSidebar: () => void;
  toggleEditor: () => void;
  toggleToolPanel: () => void;
  toggleDeveloperPanel: () => void;
  toggleGitPanel: () => void;
  toggleSessionHistory: () => void;
  setShowEditor: (show: boolean) => void;
  setAIOnlyMode: () => void;
  resetView: () => void;
  setSidebarWidth: (width: number) => void;
  setEditorWidth: (width: number) => void;
  setToolPanelWidth: (width: number) => void;
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
  // 小屏模式操作
  updateCompactMode: (state: Partial<CompactModeState>) => void;
}

/** 完整的 View Store 类型 */
export type ViewStore = ViewState & ViewActions;

export const useViewStore = create<ViewStore>()(
  persist(
    (set) => ({
      // 初始状态
      showSidebar: true,
      showEditor: false,
      showToolPanel: true,
      showDeveloperPanel: false,  // 默认关闭 Developer 面板
      showGitPanel: false,       // 默认关闭 Git 面板
      showSessionHistory: false,  // 默认关闭会话历史面板
      sidebarWidth: 240,
      editorWidth: 50,
      toolPanelWidth: 320,
      developerPanelWidth: 400,
      gitPanelWidth: 320,
      // 新布局初始状态
      leftPanelType: 'files' as LeftPanelType,  // 默认显示文件浏览器
      leftPanelWidth: 280,        // 左侧面板默认宽度
      rightPanelWidth: 400,       // 右侧 AI 面板默认宽度
      rightPanelCollapsed: false, // 右侧面板默认不折叠
      // 小屏模式初始状态
      compactMode: {
        isCompactMode: false,
        windowWidth: 1200,
        windowHeight: 800,
      },

      // 切换侧边栏
      toggleSidebar: () => set((state) => ({ showSidebar: !state.showSidebar })),

      // 切换编辑器
      toggleEditor: () => set((state) => ({ showEditor: !state.showEditor })),

      // 设置编辑器显示状态
      setShowEditor: (show: boolean) => set({ showEditor: show }),

      // 切换工具面板
      toggleToolPanel: () => set((state) => ({ showToolPanel: !state.showToolPanel })),

      // 切换 Developer 面板
      toggleDeveloperPanel: () => set((state) => ({ showDeveloperPanel: !state.showDeveloperPanel })),

      // 切换 Git 面板
      toggleGitPanel: () => set((state) => ({ showGitPanel: !state.showGitPanel })),

      // 切换会话历史面板
      toggleSessionHistory: () => set((state) => ({ showSessionHistory: !state.showSessionHistory })),

      // 仅 AI 对话模式
      setAIOnlyMode: () => set({
        showSidebar: false,
        showEditor: false,
        showToolPanel: false,
        showDeveloperPanel: false,
      }),

      // 重置视图
      resetView: () => set({
        showSidebar: true,
        showEditor: false,
        showToolPanel: true,
        showDeveloperPanel: false,
      }),

      // 设置侧边栏宽度
      setSidebarWidth: (width: number) => set({ sidebarWidth: width }),

      // 设置编辑器宽度百分比
      setEditorWidth: (width: number) => set({ editorWidth: width }),

      // 设置工具面板宽度
      setToolPanelWidth: (width: number) => set({ toolPanelWidth: width }),

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

      // 更新小屏模式状态
      updateCompactMode: (newState: Partial<CompactModeState>) => set((state) => ({
        compactMode: { ...state.compactMode, ...newState },
      })),
    }),
    {
      name: 'view-store',
    }
  )
);
