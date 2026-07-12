/**
 * 跳转定义多候选时的轻量浮窗（peek popover）。
 *
 * 设计目标（生产级）：
 * - 锚定在光标位置，下方/上方自动翻转，屏幕边缘不溢出
 * - 编辑器滚动 / 切换 tab → 立即关闭（避免锚点漂移）
 * - 第一行突出（按 import / package 排序后的最佳猜测）
 * - 键盘：↑↓ 导航，Enter 跳转，Esc 关闭，Tab 切换到全量 ReferencesPanel
 * - 默认显示前 8 条；超出时给"+N 全部"按钮
 * - kind 图标 + FQN 路径压缩显示
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, FileCode, ChevronRight } from 'lucide-react';
import {
  useLspUiStore,
  type DefinitionPeekContext,
  type ReferenceItem,
} from '@/stores/lspUiStore';
import { useFileEditorStore } from '@/stores/fileEditorStore';
import { createLogger } from '@/utils/logger';

const log = createLogger('DefinitionPeek');

const MAX_VISIBLE = 8;
const PEEK_WIDTH = 460;
const PEEK_MAX_HEIGHT = 300;

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** 把 src/main/java/com/foo/bar/Baz.java 压缩成 …/com/foo/bar/Baz.java */
function compressPath(path: string, maxLen = 50): string {
  const norm = path.replace(/\\/g, '/');
  if (norm.length <= maxLen) return norm;
  // 取最后两级目录 + 文件名
  const parts = norm.split('/').filter(Boolean);
  if (parts.length <= 3) return norm;
  return '…/' + parts.slice(-3).join('/');
}

/** kind → 单字符图标 + 颜色 class */
function kindBadge(kind: string | undefined) {
  switch (kind) {
    case 'class':
      return { ch: 'C', cls: 'text-blue-400 bg-blue-400/10' };
    case 'interface':
      return { ch: 'I', cls: 'text-purple-400 bg-purple-400/10' };
    case 'enum':
      return { ch: 'E', cls: 'text-yellow-400 bg-yellow-400/10' };
    case 'record':
      return { ch: 'R', cls: 'text-cyan-400 bg-cyan-400/10' };
    case 'annotation':
      return { ch: '@', cls: 'text-pink-400 bg-pink-400/10' };
    case 'method':
      return { ch: 'm', cls: 'text-green-400 bg-green-400/10' };
    case 'constructor':
      return { ch: 'c', cls: 'text-green-500 bg-green-500/10' };
    case 'field':
      return { ch: 'f', cls: 'text-orange-400 bg-orange-400/10' };
    case 'enum_constant':
      return { ch: 'k', cls: 'text-yellow-300 bg-yellow-300/10' };
    default:
      return { ch: '·', cls: 'text-text-tertiary bg-text-tertiary/10' };
  }
}

interface InnerProps {
  ctx: DefinitionPeekContext;
}

function PeekInner({ ctx }: InnerProps) {
  const close = useLspUiStore((s) => s.closeDefinitionPeek);
  const promote = useLspUiStore((s) => s.promoteDefinitionPeekToReferences);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { items, symbol, anchor } = ctx;
  const visible = items.slice(0, MAX_VISIBLE);
  const remaining = Math.max(0, items.length - MAX_VISIBLE);

  // 计算位置（下方/上方翻转 + 屏幕边缘约束）
  const placement = useMemo(() => {
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const want = Math.min(PEEK_MAX_HEIGHT, 56 + visible.length * 36 + (remaining > 0 ? 28 : 0));
    let top = anchor.y + 6;
    let placeAbove = false;
    if (top + want > winH - 16 && anchor.y - want - 6 > 16) {
      // 上方放
      top = anchor.y - want - 6 - anchor.lineHeight;
      placeAbove = true;
    }
    let left = anchor.x;
    if (left + PEEK_WIDTH > winW - 16) {
      left = Math.max(16, winW - PEEK_WIDTH - 16);
    }
    return { top, left, placeAbove };
  }, [anchor, visible.length, remaining]);

  // 自动聚焦容器以便接收键盘
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  // 选中项滚动到视野
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-peek-idx="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // 编辑器滚动 / 鼠标点击其它区域 / 切 tab → 关闭
  useEffect(() => {
    function onDocScroll(e: Event) {
      const t = e.target as Node | null;
      if (t && containerRef.current?.contains(t)) return;
      // 编辑器滚动会冒泡到 document 的捕获阶段
      close();
    }
    function onClickOutside(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        close();
      }
    }
    document.addEventListener('scroll', onDocScroll, true);
    document.addEventListener('mousedown', onClickOutside, true);
    return () => {
      document.removeEventListener('scroll', onDocScroll, true);
      document.removeEventListener('mousedown', onClickOutside, true);
    };
  }, [close]);

  async function jump(item: ReferenceItem) {
    try {
      await useFileEditorStore
        .getState()
        .openFileAtPosition(item.path, fileNameOf(item.path), item.line, item.column);
    } catch (err) {
      log.warn('peek jump failed', { error: String(err) });
    }
    close();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, visible.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter': {
        e.preventDefault();
        const it = visible[selectedIndex];
        if (it) void jump(it);
        break;
      }
      case 'Tab':
        e.preventDefault();
        promote();
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
    }
  }

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        top: placement.top,
        left: placement.left,
        width: PEEK_WIDTH,
        zIndex: 60,
      }}
      className="bg-background-elevated rounded-lg border border-border shadow-glow overflow-hidden animate-in fade-in zoom-in-95 duration-100"
    >
      {/* 头部 */}
      <div className="px-3 py-1.5 border-b border-border text-[10px] text-text-tertiary uppercase tracking-wide flex items-center gap-2">
        <FileCode className="w-3 h-3" />
        <span>跳转定义</span>
        <span className="text-text-primary font-mono normal-case">「{symbol}」</span>
        <span className="ml-auto normal-case text-text-tertiary">
          {items.length} 候选
        </span>
      </div>

      {/* 列表 */}
      <div ref={listRef} className="max-h-[260px] overflow-y-auto">
        {visible.map((it, idx) => {
          const selected = idx === selectedIndex;
          const isFirst = idx === 0;
          const badge = kindBadge(it.kind);
          return (
            <button
              key={`${it.path}:${it.line}:${it.column}:${idx}`}
              data-peek-idx={idx}
              onClick={() => void jump(it)}
              onMouseEnter={() => setSelectedIndex(idx)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                selected ? 'bg-primary/15' : 'hover:bg-background-hover'
              } ${isFirst ? 'border-l-2 border-primary' : ''}`}
              title={it.path}
            >
              {/* kind 图标 */}
              <span
                className={`flex-shrink-0 w-4 h-4 rounded text-[10px] font-mono font-bold flex items-center justify-center ${badge.cls}`}
              >
                {badge.ch}
              </span>
              {/* 主信息：FQN 或 文件名 */}
              <span className="flex-1 min-w-0 flex flex-col">
                <span className="text-xs text-text-primary font-mono truncate">
                  {it.fqn ?? `${fileNameOf(it.path)}`}
                </span>
                <span className="text-[10px] text-text-tertiary truncate">
                  {compressPath(it.path)}:{it.line}
                </span>
              </span>
            </button>
          );
        })}

        {remaining > 0 && (
          <button
            onClick={() => promote()}
            className="w-full flex items-center justify-center gap-2 px-3 py-1.5 text-[11px] text-text-secondary hover:bg-background-hover border-t border-border/40"
          >
            <span>还有 {remaining} 个候选 — 查看全部</span>
            <ChevronRight className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* 底部提示 */}
      <div className="px-3 py-1 border-t border-border text-[10px] text-text-tertiary flex items-center gap-3">
        <span>↑↓ 导航</span>
        <span>
          <CornerDownLeft className="inline w-2.5 h-2.5" /> 跳转
        </span>
        <span>Tab 全部</span>
        <span>Esc 关闭</span>
      </div>
    </div>
  );
}

/** 顶层容器：订阅 store，条件渲染。在 App 根部挂载一次即可。 */
export function DefinitionPeek() {
  const ctx = useLspUiStore((s) => s.definitionPeek);
  if (!ctx) return null;
  return <PeekInner ctx={ctx} />;
}
