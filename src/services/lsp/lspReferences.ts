/**
 * 查找引用（查应用）——LSP 模式与索引模式统一入口。
 *
 * 结果通过 `lspUiStore` 喂给 ReferencesPanel 浮层展示，点击可跨文件跳转。
 *
 * - LSP 模式：发 `textDocument/references` 拿语义级 Location[]。
 * - 索引模式：调后端 `lsp_index_references`（walkdir+regex 全词匹配），零常驻进程。
 */

import type { LSPClient } from '@codemirror/lsp-client';
import type { EditorView } from '@codemirror/view';
import { useLspUiStore, type ReferenceItem } from '@/stores/lspUiStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useFileEditorStore } from '@/stores/fileEditorStore';
import { lspIndexReferences } from '@/services/tauri/lspService';
import { extensionsForLanguages } from './languageExtensions';
import { collectDirtyBuffers } from './dirtyBuffers';
import { createLogger } from '@/utils/logger';

const log = createLogger('LspReferences');

/** 索引模式后端默认上限（与 lsp_index.rs MAX_MATCHES 对齐，用于"可能截断"提示） */
const INDEX_MATCH_CAP = 2000;

interface LspPosition {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
interface LspLocation {
  uri: string;
  range: LspRange;
}

/** LSP 模式上下文 */
export interface LspRefCtx {
  mode: 'lsp';
  client: LSPClient;
  uri: string;
}
/** 索引模式上下文 */
export interface IndexRefCtx {
  mode: 'index';
  /** 该服务器声明支持的语言（用于推导扫描扩展名） */
  languages: string[];
}
export type RefCtx = LspRefCtx | IndexRefCtx;

/** file:///D:/a/b.ts → D:\a\b.ts（Windows 兼容） */
function uriToPath(uri: string): string {
  let p = uri;
  if (p.startsWith('file:///')) p = p.slice(8);
  else if (p.startsWith('file://')) p = p.slice(7);
  try {
    p = decodeURIComponent(p);
  } catch {
    /* ignore malformed escapes */
  }
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
  return p.replace(/\//g, '\\');
}

/** 取光标处的符号：优先用已选中文本，否则取光标所在单词 */
export function symbolAtCursor(view: EditorView): string {
  const sel = view.state.selection.main;
  if (!sel.empty) {
    const text = view.state.sliceDoc(sel.from, sel.to).trim();
    if (text && !/\s/.test(text)) return text;
  }
  const wordRange = view.state.wordAt(sel.head);
  if (!wordRange) return '';
  return view.state.sliceDoc(wordRange.from, wordRange.to);
}

function offsetToLspPosition(view: EditorView, offset: number): LspPosition {
  const line = view.state.doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

/** 把 LSP references 响应归一化为面板条目 */
function locationsToItems(result: LspLocation[] | null): ReferenceItem[] {
  if (!result || !Array.isArray(result)) return [];
  return result.map((loc) => ({
    path: uriToPath(loc.uri),
    line: loc.range.start.line + 1,
    column: loc.range.start.character,
  }));
}

function sortItems(items: ReferenceItem[]): ReferenceItem[] {
  return items.sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column,
  );
}

/**
 * 执行查找引用并把结果灌入 ReferencesPanel。
 * @returns 是否成功发起查询（取不到符号时返回 false）
 */
export async function runFindReferences(view: EditorView, ctx: RefCtx): Promise<boolean> {
  const symbol = symbolAtCursor(view);
  if (!symbol) return false;

  const ui = useLspUiStore.getState();
  ui.openReferences({ symbol, loading: true, items: [], error: null });

  try {
    if (ctx.mode === 'lsp') {
      const head = view.state.selection.main.head;
      const position = offsetToLspPosition(view, head);
      const result = await ctx.client.request<unknown, LspLocation[] | null>(
        'textDocument/references',
        {
          textDocument: { uri: ctx.uri },
          position,
          context: { includeDeclaration: true },
        },
      );
      const items = sortItems(locationsToItems(result));
      useLspUiStore.getState().updateReferences({ loading: false, items });
      log.debug('LSP references', { symbol, count: items.length });
    } else {
      const root = useWorkspaceStore.getState().getCurrentWorkspace()?.path;
      if (!root) {
        useLspUiStore.getState().updateReferences({
          loading: false,
          error: 'no-workspace',
        });
        return true;
      }
      const exts = extensionsForLanguages(ctx.languages);
      const currentFile = useFileEditorStore.getState().currentFile?.path;
      const dirty = collectDirtyBuffers();
      const matches = await lspIndexReferences(
        root,
        symbol,
        exts,
        currentFile,
        dirty.length ? dirty : undefined,
      );
      const items = sortItems(
        matches.map((m) => ({
          path: m.path,
          line: m.line,
          column: m.column,
          preview: m.preview,
          kind: m.kind,
          fqn: m.fqn,
          refKind: m.refKind,
        })),
      );
      useLspUiStore.getState().updateReferences({
        loading: false,
        items,
        truncated: matches.length >= INDEX_MATCH_CAP,
      });
      log.debug('Index references', { symbol, count: items.length });
    }
  } catch (err) {
    useLspUiStore.getState().updateReferences({
      loading: false,
      error: String(err),
    });
    log.warn('findReferences failed', { error: String(err) });
  }
  return true;
}
