/**
 * 文档符号面板（Go to Symbol） — Mod+Shift+O 触发。
 *
 * 调用 LSP `textDocument/documentSymbol` 拿到当前文件的符号树，
 * 展平后提供模糊搜索与键盘导航，选中后把编辑器光标滚动到目标位置。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import { Search } from 'lucide-react';
import { useLspUiStore } from '@/stores/lspUiStore';
import { createLogger } from '@/utils/logger';

const log = createLogger('SymbolPalette');

// --- LSP DocumentSymbol / SymbolInformation 类型（精简） ---

interface LspPosition {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}
interface LspSymbolInformation {
  name: string;
  kind: number;
  location: { uri: string; range: LspRange };
  containerName?: string;
}
type DocSymbolResult = LspDocumentSymbol[] | LspSymbolInformation[] | null;

/** 展平一个符号项（用于渲染和模糊匹配） */
interface FlatSymbol {
  name: string;
  detail: string;
  kind: number;
  range: LspRange;
  /** 用于缩进展示的层级（SymbolInformation 没有就全 0） */
  depth: number;
  /** 父符号名，展示为"二级标注" */
  parent: string | null;
}

/** SymbolKind 映射为单字符图标 + 颜色。参考 LSP 规范 SymbolKind 枚举。 */
const SYMBOL_KIND_META: Record<number, { label: string; color: string }> = {
  1: { label: 'File', color: '#8b949e' },
  2: { label: 'Mod', color: '#8b949e' },
  3: { label: 'NS', color: '#8b949e' },
  4: { label: 'Pkg', color: '#8b949e' },
  5: { label: 'C', color: '#ffa657' }, // Class
  6: { label: 'M', color: '#d2a8ff' }, // Method
  7: { label: 'P', color: '#79c0ff' }, // Property
  8: { label: 'F', color: '#79c0ff' }, // Field
  9: { label: 'Ctor', color: '#d2a8ff' },
  10: { label: 'E', color: '#ffa657' }, // Enum
  11: { label: 'I', color: '#ffa657' }, // Interface
  12: { label: 'ƒ', color: '#d2a8ff' }, // Function
  13: { label: 'V', color: '#e6edf3' }, // Variable
  14: { label: 'K', color: '#79c0ff' }, // Constant
  15: { label: 'S', color: '#a5d6ff' }, // String
  16: { label: '#', color: '#79c0ff' }, // Number
  17: { label: 'B', color: '#79c0ff' }, // Boolean
  18: { label: '[]', color: '#e6edf3' },
  19: { label: '{}', color: '#e6edf3' },
  20: { label: '●', color: '#79c0ff' }, // Key
  21: { label: '○', color: '#8b949e' }, // Null
  22: { label: 'EM', color: '#ffa657' },
  23: { label: 'St', color: '#ffa657' },
  24: { label: 'Ev', color: '#ff7b72' },
  25: { label: 'Op', color: '#ff7b72' },
  26: { label: 'T', color: '#ffa657' },
};

function kindMeta(kind: number) {
  return SYMBOL_KIND_META[kind] ?? { label: '?', color: '#8b949e' };
}

/** 把 DocumentSymbol 树展平成 FlatSymbol[] */
function flattenDocumentSymbols(
  items: LspDocumentSymbol[],
  depth = 0,
  parent: string | null = null,
): FlatSymbol[] {
  const out: FlatSymbol[] = [];
  for (const item of items) {
    out.push({
      name: item.name,
      detail: item.detail ?? '',
      kind: item.kind,
      range: item.selectionRange ?? item.range,
      depth,
      parent,
    });
    if (item.children && item.children.length > 0) {
      out.push(...flattenDocumentSymbols(item.children, depth + 1, item.name));
    }
  }
  return out;
}

/** 判断返回值是 DocumentSymbol[] 还是 SymbolInformation[] */
function isDocumentSymbols(r: DocSymbolResult): r is LspDocumentSymbol[] {
  return Array.isArray(r) && r.length > 0 && 'range' in r[0] && 'kind' in r[0] && !('location' in r[0]);
}

function normalize(result: DocSymbolResult): FlatSymbol[] {
  if (!result || !Array.isArray(result) || result.length === 0) return [];
  if (isDocumentSymbols(result)) {
    return flattenDocumentSymbols(result);
  }
  const sis = result as LspSymbolInformation[];
  return sis.map((s) => ({
    name: s.name,
    detail: s.containerName ?? '',
    kind: s.kind,
    range: s.location.range,
    depth: 0,
    parent: s.containerName ?? null,
  }));
}

/** 简单子序列匹配得分（越小越靠前）。不匹配返回 -1。 */
function fuzzyScore(text: string, query: string): number {
  if (!query) return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let ti = 0;
  let qi = 0;
  let lastMatch = -1;
  let gaps = 0;
  while (ti < t.length && qi < q.length) {
    if (t[ti] === q[qi]) {
      if (lastMatch !== -1 && ti !== lastMatch + 1) gaps += ti - lastMatch - 1;
      lastMatch = ti;
      qi++;
    }
    ti++;
  }
  if (qi < q.length) return -1;
  // 越靠前、越连续越好
  return lastMatch + gaps * 10 + (t.length - q.length);
}

function SymbolPaletteInner({
  view,
  client,
  uri,
  onClose,
}: {
  view: EditorView;
  client: import('@codemirror/lsp-client').LSPClient;
  uri: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [symbols, setSymbols] = useState<FlatSymbol[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 拉取符号
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await client.request<unknown, DocSymbolResult>(
          'textDocument/documentSymbol',
          { textDocument: { uri } },
        );
        if (cancelled) return;
        const flat = normalize(result);
        setSymbols(flat);
        setLoading(false);
        log.debug('documentSymbol loaded', { uri, count: flat.length });
      } catch (err) {
        if (cancelled) return;
        setError(String(err));
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [client, uri]);

  // 过滤 + 排序
  const filtered = useMemo(() => {
    if (!query.trim()) return symbols;
    const scored: Array<{ sym: FlatSymbol; score: number }> = [];
    for (const sym of symbols) {
      const s = fuzzyScore(sym.name, query);
      if (s >= 0) scored.push({ sym, score: s });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map((x) => x.sym);
  }, [symbols, query]);

  // 聚焦输入
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 选中项滚动
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // query 变化时重置选中
  useEffect(() => { setSelectedIndex(0); }, [query]);

  function jumpToSymbol(sym: FlatSymbol) {
    const doc = view.state.doc;
    const targetLine = sym.range.start.line + 1;
    const targetCol = sym.range.start.character;
    if (targetLine < 1 || targetLine > doc.lines) return;
    const line = doc.line(targetLine);
    const anchor = Math.min(line.from + targetCol, line.to);
    view.dispatch({
      selection: { anchor },
      effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
    });
    view.focus();
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter': {
        e.preventDefault();
        const sym = filtered[selectedIndex];
        if (sym) jumpToSymbol(sym);
        break;
      }
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 pt-[12vh]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-background-elevated rounded-xl w-full max-w-xl border border-border shadow-glow overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        onKeyDown={handleKeyDown}
      >
        {/* 标题 */}
        <div className="px-4 py-2 border-b border-border text-[11px] text-text-tertiary uppercase tracking-wide">
          Go to Symbol
        </div>

        {/* 搜索输入框 */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Search className="w-4 h-4 text-text-tertiary flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索当前文件的符号..."
            className="flex-1 bg-transparent text-text-primary placeholder:text-text-tertiary focus:outline-none text-sm"
            spellCheck={false}
          />
          <kbd className="text-[10px] text-text-tertiary bg-background-surface px-1.5 py-0.5 rounded border border-border font-mono">Esc</kbd>
        </div>

        {/* 列表 */}
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto">
          {loading ? (
            <div className="py-8 text-center text-text-tertiary text-sm">加载中…</div>
          ) : error ? (
            <div className="py-8 text-center text-danger text-sm">请求失败：{error}</div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-text-tertiary text-sm">
              {symbols.length === 0 ? '当前文件没有可用的符号' : '没有匹配的符号'}
            </div>
          ) : (
            filtered.map((sym, idx) => {
              const meta = kindMeta(sym.kind);
              const selected = idx === selectedIndex;
              return (
                <div
                  key={`${sym.name}-${sym.range.start.line}-${sym.range.start.character}-${idx}`}
                  data-index={idx}
                  className={`flex items-center gap-2 px-4 py-1.5 cursor-pointer transition-colors ${
                    selected
                      ? 'bg-primary/10 text-text-primary'
                      : 'text-text-primary hover:bg-background-hover'
                  }`}
                  onClick={() => jumpToSymbol(sym)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  style={{ paddingLeft: 16 + sym.depth * 12 }}
                >
                  <span
                    className="inline-flex items-center justify-center w-5 h-5 text-[10px] font-mono rounded border border-border bg-background-surface flex-shrink-0"
                    style={{ color: meta.color }}
                    title={meta.label}
                  >
                    {meta.label}
                  </span>
                  <span className="text-sm truncate flex-shrink-0 font-medium">{sym.name}</span>
                  {sym.detail && (
                    <span className="text-xs text-text-tertiary truncate min-w-0">{sym.detail}</span>
                  )}
                  <span className="ml-auto text-[10px] text-text-tertiary font-mono flex-shrink-0">
                    :{sym.range.start.line + 1}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {/* 底部提示 */}
        <div className="px-4 py-1.5 border-t border-border text-[10px] text-text-tertiary flex items-center gap-3">
          <span>↑↓ 导航</span>
          <span>↵ 跳转</span>
          <span>Esc 关闭</span>
          {!loading && (
            <span className="ml-auto">{filtered.length} / {symbols.length}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 顶层容器：订阅 store，条件渲染内部组件。在 App 根部挂载一次即可。
 */
export function SymbolPalette() {
  const ctx = useLspUiStore((s) => s.symbolPalette);
  const close = useLspUiStore((s) => s.closeSymbolPalette);
  if (!ctx) return null;
  return <SymbolPaletteInner view={ctx.view} client={ctx.client} uri={ctx.uri} onClose={close} />;
}
