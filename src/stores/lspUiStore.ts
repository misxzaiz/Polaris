/**
 * LSP 相关的 UI 状态（轻量）。
 *
 * 目前只放 Symbol Palette 的开关 + 关联上下文，将来可扩展 Problems 面板等。
 */

import { create } from 'zustand';
import type { LSPClient } from '@codemirror/lsp-client';
import type { EditorView } from '@codemirror/view';

interface SymbolPaletteContext {
  view: EditorView;
  client: LSPClient;
  uri: string;
}

interface LspUiState {
  symbolPalette: SymbolPaletteContext | null;
  openSymbolPalette: (ctx: SymbolPaletteContext) => void;
  closeSymbolPalette: () => void;
}

export const useLspUiStore = create<LspUiState>((set) => ({
  symbolPalette: null,
  openSymbolPalette: (ctx) => set({ symbolPalette: ctx }),
  closeSymbolPalette: () => set({ symbolPalette: null }),
}));
