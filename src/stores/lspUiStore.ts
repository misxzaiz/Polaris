/**
 * LSP 相关的 UI 状态（轻量）。
 *
 * 放 Symbol Palette 与 References Panel 的开关 + 关联上下文。
 */

import { create } from 'zustand';
import type { LSPClient } from '@codemirror/lsp-client';
import type { EditorView } from '@codemirror/view';

interface SymbolPaletteContext {
  view: EditorView;
  client: LSPClient;
  uri: string;
}

/** 引用结果中的一条（LSP 模式与索引模式统一形态） */
export interface ReferenceItem {
  /** 本地文件路径 */
  path: string;
  /** 行号（1-based） */
  line: number;
  /** 列号（0-based） */
  column: number;
  /** 该行预览文本（索引模式有；LSP 模式可能为空） */
  preview?: string;
}

/** References 面板上下文 */
export interface ReferencesContext {
  /** 被查询的符号名 */
  symbol: string;
  /** 是否加载中 */
  loading: boolean;
  /** 结果列表 */
  items: ReferenceItem[];
  /** 错误信息（查询失败时） */
  error: string | null;
  /** 结果是否可能被截断（达到上限） */
  truncated?: boolean;
}

interface LspUiState {
  symbolPalette: SymbolPaletteContext | null;
  openSymbolPalette: (ctx: SymbolPaletteContext) => void;
  closeSymbolPalette: () => void;

  references: ReferencesContext | null;
  /** 打开 References 面板（通常先以 loading 态打开，再回填结果） */
  openReferences: (ctx: ReferencesContext) => void;
  /** 更新当前 References 面板内容（保持打开） */
  updateReferences: (patch: Partial<ReferencesContext>) => void;
  closeReferences: () => void;
}

export const useLspUiStore = create<LspUiState>((set) => ({
  symbolPalette: null,
  openSymbolPalette: (ctx) => set({ symbolPalette: ctx }),
  closeSymbolPalette: () => set({ symbolPalette: null }),

  references: null,
  openReferences: (ctx) => set({ references: ctx }),
  updateReferences: (patch) =>
    set((state) =>
      state.references ? { references: { ...state.references, ...patch } } : {},
    ),
  closeReferences: () => set({ references: null }),
}));
