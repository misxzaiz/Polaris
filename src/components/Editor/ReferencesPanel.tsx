/**
 * 查找引用结果面板（查应用）—— Shift+F12 / 索引导航触发。
 *
 * 数据来自 `lspUiStore.references`（LSP 模式与索引模式共用形态）。
 *
 * 生产级特性：
 * - 文件分组 + 折叠/展开（默认折叠超过 5 个文件时）
 * - 过滤器：路径正则、kind 过滤（call/type/new/...）、隐藏 generated/test
 * - 行号 + 该行预览（带语言提示色）
 * - 键盘：↑↓ 导航、Enter 跳转、Esc 关闭、空格折叠当前组
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Loader2, ChevronDown, ChevronRight, Filter } from 'lucide-react';
import { useLspUiStore, type ReferenceItem } from '@/stores/lspUiStore';
import { useFileEditorStore } from '@/stores/fileEditorStore';
import { createLogger } from '@/utils/logger';

const log = createLogger('ReferencesPanel');

const AUTO_COLLAPSE_THRESHOLD = 5;

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function compressPath(path: string): string {
  const norm = path.replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  if (parts.length <= 4) return norm;
  return '…/' + parts.slice(-4).join('/');
}

function isGenerated(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  return /\/generated|\/build\//.test(p);
}

function isTest(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  return /\/src\/test\/|\/test\//.test(p) || /Test\.java$|Tests\.java$/.test(p);
}

function refKindBadge(kind: string | undefined): { label: string; cls: string } | null {
  if (!kind) return null;
  switch (kind) {
    case 'call':
      return { label: 'call', cls: 'text-green-400 bg-green-400/10' };
    case 'type':
      return { label: 'type', cls: 'text-blue-400 bg-blue-400/10' };
    case 'new':
      return { label: 'new', cls: 'text-purple-400 bg-purple-400/10' };
    case 'field_read':
      return { label: 'read', cls: 'text-orange-400 bg-orange-400/10' };
    case 'field_write':
      return { label: 'write', cls: 'text-red-400 bg-red-400/10' };
    case 'import':
      return { label: 'import', cls: 'text-cyan-400 bg-cyan-400/10' };
    case 'throws':
      return { label: 'throws', cls: 'text-pink-400 bg-pink-400/10' };
    default:
      return null;
  }
}

interface FileGroup {
  path: string;
  items: ReferenceItem[];
}

interface InnerProps {
  symbol: string;
  loading: boolean;
  items: ReferenceItem[];
  error: string | null;
  truncated?: boolean;
  onClose: () => void;
}

function ReferencesPanelInner({ symbol, loading, items, error, truncated, onClose }: InnerProps) {
  const [pathFilter, setPathFilter] = useState('');
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [hideGenerated, setHideGenerated] = useState(true);
  const [hideTest, setHideTest] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 应用过滤
  const filtered = useMemo(() => {
    let out = items;
    if (pathFilter.trim()) {
      try {
        const re = new RegExp(pathFilter, 'i');
        out = out.filter((it) => re.test(it.path) || re.test(it.preview ?? ''));
      } catch {
        // 不是合法正则就当字面量子串
        const p = pathFilter.toLowerCase();
        out = out.filter(
          (it) =>
            it.path.toLowerCase().includes(p) || (it.preview ?? '').toLowerCase().includes(p),
        );
      }
    }
    if (kindFilter) {
      out = out.filter((it) => it.refKind === kindFilter);
    }
    if (hideGenerated) {
      out = out.filter((it) => !isGenerated(it.path));
    }
    if (hideTest) {
      out = out.filter((it) => !isTest(it.path));
    }
    return out;
  }, [items, pathFilter, kindFilter, hideGenerated, hideTest]);

  // 分组
  const groups: FileGroup[] = useMemo(() => {
    const map = new Map<string, ReferenceItem[]>();
    for (const it of filtered) {
      let arr = map.get(it.path);
      if (!arr) {
        arr = [];
        map.set(it.path, arr);
      }
      arr.push(it);
    }
    return Array.from(map.entries()).map(([path, items]) => ({ path, items }));
  }, [filtered]);

  // 自动折叠：文件数超过阈值时默认全折叠
  useEffect(() => {
    if (groups.length > AUTO_COLLAPSE_THRESHOLD) {
      setCollapsedGroups(new Set(groups.map((g) => g.path)));
    } else {
      setCollapsedGroups(new Set());
    }
  }, [groups.length]);

  // 是否有引用 kind 信息（决定是否显示 kind 过滤器）
  const availableKinds = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) if (it.refKind) set.add(it.refKind);
    return Array.from(set);
  }, [items]);

  // 平铺可见项（可见 = 所在组未折叠），用于键盘导航
  const visibleItems = useMemo(() => {
    const out: { item: ReferenceItem; key: string }[] = [];
    for (const g of groups) {
      if (collapsedGroups.has(g.path)) continue;
      g.items.forEach((it) => {
        out.push({ item: it, key: `${it.path}:${it.line}:${it.column}` });
      });
    }
    return out;
  }, [groups, collapsedGroups]);

  // 默认选中第一个可见项
  useEffect(() => {
    if (visibleItems.length === 0) {
      setSelectedKey(null);
      return;
    }
    if (!selectedKey || !visibleItems.some((v) => v.key === selectedKey)) {
      setSelectedKey(visibleItems[0].key);
    }
  }, [visibleItems, selectedKey]);

  // 选中项滚到视野
  useEffect(() => {
    if (!selectedKey) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-key="${selectedKey}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedKey]);

  function toggleGroup(path: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

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

  function moveSel(delta: number) {
    if (visibleItems.length === 0) return;
    const idx = visibleItems.findIndex((v) => v.key === selectedKey);
    const next = Math.max(0, Math.min(visibleItems.length - 1, idx + delta));
    setSelectedKey(visibleItems[next].key);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // 输入框中正在打字 → 仅响应 Esc
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' && e.key !== 'Escape') {
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveSel(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveSel(-1);
        break;
      case 'Enter': {
        e.preventDefault();
        const cur = visibleItems.find((v) => v.key === selectedKey);
        if (cur) void jumpTo(cur.item);
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
      className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 pt-[10vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-background-elevated rounded-lg w-full max-w-3xl border border-border shadow-glow overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col"
        style={{ maxHeight: '75vh' }}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
        ref={(el) => {
          el?.focus();
        }}
      >
        {/* 标题 */}
        <div className="px-3 py-1.5 border-b border-border flex items-center gap-2">
          <Search className="w-3 h-3 text-text-tertiary" />
          <span className="text-[11px] text-text-tertiary">查找引用</span>
          <span className="text-[11px] text-text-primary font-mono">「{symbol}」</span>
          {!loading && !error && (
            <span className="ml-auto text-[10px] text-text-tertiary font-mono">
              {filtered.length}/{items.length} · {groups.length}文件
              {truncated ? ' ⚠' : ''}
            </span>
          )}
        </div>

        {/* 过滤器 */}
        {!loading && !error && items.length > 0 && (
          <div className="px-3 py-1.5 border-b border-border/60 bg-background-surface/40 flex items-center gap-1.5 flex-wrap">
            <Filter className="w-3 h-3 text-text-tertiary" />
            <input
              type="text"
              value={pathFilter}
              onChange={(e) => setPathFilter(e.target.value)}
              placeholder="过滤..."
              className="flex-1 min-w-[140px] px-1.5 py-0.5 text-[10px] bg-background border border-border rounded focus:outline-none focus:border-primary"
            />
            {availableKinds.length > 0 && (
              <select
                value={kindFilter ?? ''}
                onChange={(e) => setKindFilter(e.target.value || null)}
                className="px-1.5 py-0.5 text-[10px] bg-background border border-border rounded"
              >
                <option value="">全部</option>
                {availableKinds.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            )}
            <label className="text-[9px] text-text-secondary flex items-center gap-0.5 cursor-pointer">
              <input
                type="checkbox"
                checked={hideGenerated}
                onChange={(e) => setHideGenerated(e.target.checked)}
                className="accent-primary w-3 h-3"
              />
              generated
            </label>
            <label className="text-[9px] text-text-secondary flex items-center gap-0.5 cursor-pointer">
              <input
                type="checkbox"
                checked={hideTest}
                onChange={(e) => setHideTest(e.target.checked)}
                className="accent-primary w-3 h-3"
              />
              test
            </label>
          </div>
        )}

        {/* 列表 */}
        <div ref={listRef} className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="py-6 flex items-center justify-center gap-2 text-text-tertiary text-xs">
              <Loader2 className="w-3 h-3 animate-spin" /> 扫描中…
            </div>
          ) : error ? (
            <div className="py-6 text-center text-xs">
              {error === 'no-workspace' ? (
                <span className="text-text-tertiary">索引模式需要先打开一个工作区</span>
              ) : (
                <span className="text-danger">查询失败：{error}</span>
              )}
            </div>
          ) : groups.length === 0 ? (
            <div className="py-6 text-center text-text-tertiary text-xs">
              {items.length === 0 ? '没有找到引用' : '过滤后无结果'}
            </div>
          ) : (
            groups.map((g) => {
              const collapsed = collapsedGroups.has(g.path);
              return (
                <div key={g.path}>
                  {/* 组头 */}
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.path)}
                    className="w-full flex items-center gap-1.5 px-3 py-1 bg-background-surface/60 border-y border-border/40 text-[10px] sticky top-0 hover:bg-background-surface/80"
                  >
                    {collapsed ? (
                      <ChevronRight className="w-3 h-3 text-text-tertiary" />
                    ) : (
                      <ChevronDown className="w-3 h-3 text-text-tertiary" />
                    )}
                    <span className="text-text-primary font-medium truncate">
                      {fileNameOf(g.path)}
                    </span>
                    <span className="text-text-tertiary truncate min-w-0 flex-1 text-left text-[9px]">
                      {compressPath(g.path)}
                    </span>
                    <span className="text-text-tertiary font-mono flex-shrink-0">
                      {g.items.length}
                    </span>
                  </button>

                  {/* 组内引用 */}
                  {!collapsed &&
                    g.items.map((it) => {
                      const key = `${it.path}:${it.line}:${it.column}`;
                      const selected = selectedKey === key;
                      const badge = refKindBadge(it.refKind);
                      return (
                        <button
                          key={key}
                          data-key={key}
                          className={`w-full flex items-center gap-2 px-3 text-left transition-colors min-h-[20px] ${
                            selected ? 'bg-primary/10' : 'hover:bg-background-hover'
                          }`}
                          onClick={() => void jumpTo(it)}
                          onMouseEnter={() => setSelectedKey(key)}
                        >
                          <span className="text-[9px] text-text-tertiary font-mono flex-shrink-0 w-10 text-right">
                            {it.line}:{it.column + 1}
                          </span>
                          {badge && (
                            <span
                              className={`text-[8px] font-mono px-1 rounded flex-shrink-0 ${badge.cls}`}
                            >
                              {badge.label}
                            </span>
                          )}
                          <span className="text-[10px] text-text-secondary font-mono truncate min-w-0 flex-1">
                            {it.preview ?? ''}
                          </span>
                        </button>
                      );
                    })}
                </div>
              );
            })
          )}
        </div>

        {/* 底部提示 */}
        <div className="px-3 py-1 border-t border-border text-[9px] text-text-tertiary flex items-center gap-2">
          <span>↑↓</span>
          <span>↵ 跳转</span>
          <span>Space 折叠</span>
          <span className="ml-auto">Esc</span>
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
