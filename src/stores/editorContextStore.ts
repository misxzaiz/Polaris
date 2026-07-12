/**
 * 编辑器上下文 Store
 *
 * 存储当前编辑器的选区上下文（文件路径、行列号范围），
 * 供全局右键菜单（SelectionContextMenu）读取，生成结构化引用。
 */

import { create } from 'zustand';

export interface EditorSelectionContext {
  /** 文件绝对路径 */
  filePath: string | null;
  /** 文件相对路径（相对于工作区） */
  relativePath: string | null;
  /** 选区起始行号（1-indexed） */
  lineStart: number;
  /** 选区结束行号（1-indexed） */
  lineEnd: number;
  /** 选区起始列号（1-indexed） */
  columnStart: number;
  /** 选区结束列号（1-indexed） */
  columnEnd: number;
}

interface EditorContextState {
  /** 当前编辑器选区上下文 */
  selectionContext: EditorSelectionContext | null;

  /** 更新选区上下文 */
  setSelectionContext: (ctx: EditorSelectionContext) => void;

  /** 清空上下文 */
  clearSelectionContext: () => void;
}

export const useEditorContextStore = create<EditorContextState>((set) => ({
  selectionContext: null,

  setSelectionContext: (ctx) => set({ selectionContext: ctx }),

  clearSelectionContext: () => set({ selectionContext: null }),
}));
