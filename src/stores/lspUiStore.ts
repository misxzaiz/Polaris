/**
 * LSP 相关的 UI 状态（轻量）。
 *
 * 放：
 * - Symbol Palette（Mod-Shift-O 文档符号）
 * - References Panel（Shift+F12 / 索引模式查应用 全量列表）
 * - Definition Peek（Ctrl+Click / 跳定义快捷键 多候选时贴光标浮窗）
 * - Index Status（索引引擎状态指示器订阅源）
 */

import { create } from 'zustand';
import type { LSPClient } from '@codemirror/lsp-client';
import type { EditorView } from '@codemirror/view';
import type { IndexStatus } from '@/services/tauri/lspService';

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
  /** 符号种类（class/interface/method/...） */
  kind?: string;
  /** 完整限定名 */
  fqn?: string;
  /** 引用种类（call/type/new/...）；查应用结果用 */
  refKind?: string;
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

/** Definition Peek 浮窗上下文 */
export interface DefinitionPeekContext {
  /** 被查询的符号名 */
  symbol: string;
  /** 候选定义（已按相关度排序，第一项是最佳猜测） */
  items: ReferenceItem[];
  /** 屏幕坐标锚点（来自 view.coordsAtPos） */
  anchor: { x: number; y: number; lineHeight: number };
}

interface LspUiState {
  symbolPalette: SymbolPaletteContext | null;
  openSymbolPalette: (ctx: SymbolPaletteContext) => void;
  closeSymbolPalette: () => void;

  references: ReferencesContext | null;
  openReferences: (ctx: ReferencesContext) => void;
  updateReferences: (patch: Partial<ReferencesContext>) => void;
  closeReferences: () => void;

  definitionPeek: DefinitionPeekContext | null;
  openDefinitionPeek: (ctx: DefinitionPeekContext) => void;
  closeDefinitionPeek: () => void;
  /** 把 peek 升级为 References 全量面板（peek → panel）。Tab 键触发。 */
  promoteDefinitionPeekToReferences: () => void;

  /** 索引引擎状态（每 workspace 一个，按 workspace 路径作为 key） */
  indexStatuses: Record<string, IndexStatus>;
  setIndexStatus: (status: IndexStatus) => void;
  clearIndexStatus: (workspace: string) => void;
}

export const useLspUiStore = create<LspUiState>((set, get) => ({
  symbolPalette: null,
  openSymbolPalette: (ctx) => set({ symbolPalette: ctx }),
  closeSymbolPalette: () => set({ symbolPalette: null }),

  references: null,
  openReferences: (ctx) => set({ references: ctx, definitionPeek: null }),
  updateReferences: (patch) =>
    set((state) =>
      state.references ? { references: { ...state.references, ...patch } } : {},
    ),
  closeReferences: () => set({ references: null }),

  definitionPeek: null,
  openDefinitionPeek: (ctx) => set({ definitionPeek: ctx, references: null }),
  closeDefinitionPeek: () => set({ definitionPeek: null }),
  promoteDefinitionPeekToReferences: () => {
    const peek = get().definitionPeek;
    if (!peek) return;
    set({
      definitionPeek: null,
      references: {
        symbol: peek.symbol,
        loading: false,
        items: peek.items,
        error: null,
      },
    });
  },

  indexStatuses: {},
  setIndexStatus: (status) =>
    set((state) => {
      if (!status.workspace) return {};
      return {
        indexStatuses: { ...state.indexStatuses, [status.workspace]: status },
      };
    }),
  clearIndexStatus: (workspace) =>
    set((state) => {
      const next = { ...state.indexStatuses };
      delete next[workspace];
      return { indexStatuses: next };
    }),
}));
