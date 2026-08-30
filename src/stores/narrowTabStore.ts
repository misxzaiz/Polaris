/**
 * 窄窗口 Tab 覆盖层状态
 *
 * 设计原则：tab 状态层不感知宽度。本 store 是一个一次性信号，
 * 与 viewStore.pendingScrollToId 同构 —— 窄窗口（isCompact）下产生 tab 的动作
 * （file:opened / onOpenDiffInTab）由入口调用 open(tabId)，NarrowTabOverlay
 * 消费后按 tab.type 分流渲染；关闭调用 close()。
 *
 * 信号载体是 tabId 而非内容数据：覆盖层 = CenterStage 的窄窗口替身，
 * 从 tabStore 按 tabId 取 Tab 再分流渲染（editor → EditorPanel，
 * diff → DiffViewer）。将来 preview / git 工作台 tab 想进窄窗口，只需在此
 * 分流处加分支，无需新增第二套同构机制。
 *
 * 窗口从窄拖宽：App.tsx 的 isCompact 变 false → 覆盖层分支不再命中 →
 * CenterStage 接管同一批 tab（含 diff），信号可保留或被清理，
 * 不影响宽窗口内联渲染。状态层与视图层解耦。
 *
 * 注意：本 store 不负责加载数据。文件内容仍由 fileEditorStore 完成，
 * diff 数据随 tab.diffData 存于 tabStore。
 */

import { create } from 'zustand';

interface NarrowTabState {
  /** 当前在覆盖层中打开的 tabId；null 表示覆盖层关闭 */
  narrowTabId: string | null;
  /** 打开 tab 覆盖层（窄窗口专用） */
  openNarrowTab: (tabId: string) => void;
  /** 关闭 tab 覆盖层 */
  closeNarrowTab: () => void;
}

export const useNarrowTabStore = create<NarrowTabState>((set) => ({
  narrowTabId: null,

  openNarrowTab: (tabId: string) => {
    set({ narrowTabId: tabId });
  },

  closeNarrowTab: () => {
    set({ narrowTabId: null });
  },
}));
