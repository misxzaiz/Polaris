/**
 * 窄窗口编辑器覆盖层状态
 *
 * 设计原则：tab 状态层不感知宽度。本 store 是一个一次性信号，
 * 与 viewStore.pendingScrollToId 同构 —— 窄窗口（isCompact）下打开文件时
 * 由入口调用 open()，EditorOverlay 消费后渲染；关闭调用 close()。
 *
 * 窗口从窄拖宽：App.tsx 的 isCompact 变 false → 覆盖层分支不再命中 →
 * CenterStage 接管同一批 tab，narrowEditorFile 在此期间可保留或被清理，
 * 不影响宽窗口内联渲染。状态层与视图层解耦。
 *
 * 注意：本 store 不负责加载文件内容，文件加载仍由 fileEditorStore 完成。
 * 覆盖层复用 EditorPanel，EditorPanel 内部订阅 fileEditorStore.currentFile。
 */

import { create } from 'zustand';

interface NarrowEditorState {
  /** 当前在覆盖层中打开的文件路径；null 表示覆盖层关闭 */
  narrowEditorFile: string | null;
  /** 打开文件覆盖层（窄窗口专用） */
  openNarrowEditor: (filePath: string) => void;
  /** 关闭文件覆盖层 */
  closeNarrowEditor: () => void;
}

export const useNarrowEditorStore = create<NarrowEditorState>((set) => ({
  narrowEditorFile: null,

  openNarrowEditor: (filePath: string) => {
    set({ narrowEditorFile: filePath });
  },

  closeNarrowEditor: () => {
    set({ narrowEditorFile: null });
  },
}));
