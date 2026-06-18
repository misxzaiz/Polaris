/**
 * 查找引用结果面板（查应用）—— Shift+F12 触发。
 *
 * 数据来自 `lspUiStore.references`（LSP 模式与索引模式共用形态）。
 * 列表按文件分组，点击条目通过 `fileEditorStore.openFileAtPosition` 跨文件跳转。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { useLspUiStore, type ReferenceItem } from '@/stores/lspUiStore';
import { useFileEditorStore } from '@/stores/fileEditorStore';
import { createLogger } from '@/utils/logger';

const log = createLogger('ReferencesPanel');

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function ReferencesPanelInner({
  symbol,
  loading,
  items,
  error,
  truncated,
  onClose,
}: {
  symbol: string;
  loading: boolean;
  items: ReferenceItem[];
  error: string | null;
  truncated?: boolean;
  onClose: () => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // items 已在 service 层按 path/line 排序；这里仅计算分组边界用于渲染
  const groupedFlags = useMemo(() => {
    const flags: boolean[] = [];
    let prevPath = '';
    for (const it of items) {
      flags.push(it.path !== prevPath);
      prevPath = it.path;
    }
    return flags;
  }, [items]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  async function jumpTo(item: ReferenceItem) {
    try {
      await useFileEditorStore
        .getState()
        .openFileAtPosition(item.path, fileNameOf(item.path), item.line, item.column);
    } catch (err) {
      log.warn('jump to reference failed', { error: String(err) });
    }
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter': {
        e.preventDefault();
        const it = items[selectedIndex];
        if (it) void jumpTo(it);
        break;
      }
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  }

  const fileCount = useMemo(() => new Set(items.map((i) => i.path)).size, [items]);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 pt-[12vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-background-elevated rounded-xl w-full max-w-2xl border border-border shadow-glow overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        onKeyDown={handleKeyDown}
        tabIndex={-1}
        ref={(el) => { el?.focus(); }}
      >
        {/* 标题 */}
        <div className="px-4 py-2 border-b border-border text-[11px] text-text-tertiary uppercase tracking-wide flex items-center gap-2">
          <Search className="w-3.5 h-3.5" />
          <span>查找引用</span>
          <span className="text-text-primary font-mono normal-case">「{symbol}」</span>
          {!loading && !error && (
            <span className="ml-auto normal-case">
              {items.length} 处 · {fileCount} 文件{truncated ? ' （已截断）' : ''}
            </span>
          )}
        </div>

        {/* 列表 */}
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="py-10 flex items-center justify-center gap-2 text-text-tertiary text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> 扫描中…
            </div>
          ) : error ? (
            <div className="py-10 text-center text-sm">
              {error === 'no-workspace' ? (
                <span className="text-text-tertiary">索引模式需要先打开一个工作区</span>
              ) : (
                <span className="text-danger">查询失败：{error}</span>
              )}
            </div>
          ) : items.length === 0 ? (
            <div className="py-10 text-center text-text-tertiary text-sm">没有找到引用</div>
          ) : (
            items.map((it, idx) => {
              const isNewGroup = groupedFlags[idx];
              const selected = idx === selectedIndex;
              return (
                <div key={`${it.path}:${it.line}:${it.column}:${idx}`}>
                  {isNewGroup && (
                    <div className="flex items-center gap-2 px-4 py-1 bg-background-surface/60 border-y border-border/40 text-[11px] sticky top-0">
                      <span className="text-text-primary font-medium truncate">{fileNameOf(it.path)}</span>
                      <span className="text-text-tertiary truncate min-w-0">{it.path}</span>
                    </div>
                  )}
                  <button
                    data-index={idx}
                    className={`w-full flex items-center gap-3 px-4 py-1.5 text-left transition-colors ${
                      selected ? 'bg-primary/10' : 'hover:bg-background-hover'
                    }`}
                    onClick={() => void jumpTo(it)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    <span className="text-[10px] text-text-tertiary font-mono flex-shrink-0 w-16 text-right">
                      {it.line}:{it.column + 1}
                    </span>
                    <span className="text-xs text-text-secondary font-mono truncate min-w-0">
                      {it.preview ?? ''}
                    </span>
                  </button>
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
        </div>
      </div>
    </div>
  );
}

/** 顶层容器：订阅 store，条件渲染。在 App 根部挂载一次即可。 */
export function ReferencesPanel() {
  const ctx = useLspUiStore((s) => s.references);
  const close = useLspUiStore((s) => s.closeReferences);
  if (!ctx) return null;
  return (
    <ReferencesPanelInner
      symbol={ctx.symbol}
      loading={ctx.loading}
      items={ctx.items}
      error={ctx.error}
      truncated={ctx.truncated}
      onClose={close}
    />
  );
}
