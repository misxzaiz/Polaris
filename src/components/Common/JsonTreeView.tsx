/**
 * JSON 树形视图
 *
 * 用户任务驱动设计：
 * - 看详情：层级折叠，默认展开前 2 层；折叠态显示类型徽章 + 前 N 项值预览。
 * - 找字段：大 JSON（节点 > 50 或字符 > 2000）时自动出现搜索框。
 * - 复制：内置复制按钮（格式化后的 JSON）。
 *
 * 视觉规则：
 * - 数组索引不加引号（0: 而非 "0":），符合 JSON 习惯。
 * - 长字符串（> 120 字符）截断 + 点击展开原值。
 * - 整行可点击折叠/展开，hover 高亮整行。
 * - 缩进参考线用 border/subtle 淡化，避免深层糊成一片。
 */

import { memo, useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { clsx } from 'clsx';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Search,
  ChevronUp,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { copyToClipboard } from '@/utils/clipboard';

export interface JsonTreeViewProps {
  /** 待展示的内容。字符串会尝试 JSON.parse；对象/数组直接渲染。 */
  data: unknown;
  /** 默认展开深度，默认 2。 */
  defaultDepth?: number;
  /** 折叠态下显示的最大子项预览数，默认 3。 */
  previewCount?: number;
  /** 额外类名。 */
  className?: string;
}

interface NodeProps {
  value: unknown;
  keyName: string | null;
  depth: number;
  defaultDepth: number;
  previewCount: number;
  /** 搜索高亮：匹配的路径集合（用 normalized path 字符串表示）。 */
  matchedPaths?: Set<string>;
  /** 当前跳转命中的路径。 */
  currentPath?: string;
  /** 当前路径前缀（用于子节点构造 path）。 */
  pathPrefix: string;
  /** 滚动到当前命中节点。 */
  onCurrentRef?: (el: HTMLDivElement | null) => void;
}

// ---- 工具函数 ----

function isExpandable(value: unknown): value is Record<string, unknown> | unknown[] {
  if (value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return false;
}

function sizeOf(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>).length;
  return 0;
}

/** 是否为纯数字字符串（数组索引）。 */
function isIndexKey(key: string): boolean {
  return /^\d+$/.test(key);
}

/** 统计 JSON 总节点数与序列化字符数，用于判断是否触发搜索。 */
function measureJson(value: unknown): { nodes: number; chars: number } {
  let nodes = 0;
  let chars = 0;
  const walk = (v: unknown) => {
    nodes++;
    if (nodes > 10000) return; // 防止极端大对象卡死统计
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
    } else if (v && typeof v === 'object') {
      for (const [, item] of Object.entries(v as Record<string, unknown>)) walk(item);
    } else if (typeof v === 'string') {
      chars += v.length;
    }
  };
  walk(value);
  return { nodes, chars };
}

// ---- 标量值渲染 ----

const LONG_STRING_THRESHOLD = 120;

const ScalarValue = memo(function ScalarValue({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState(false);

  if (value === null) {
    return <span className="text-text-muted italic">null</span>;
  }
  if (typeof value === 'string') {
    const isLong = value.length > LONG_STRING_THRESHOLD;
    const display = isLong && !expanded ? value.slice(0, LONG_STRING_THRESHOLD) : value;
    const escaped = display.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    return (
      <span>
        <span className="text-success">"{escaped}"</span>
        {isLong && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className="ml-1 text-text-muted hover:text-primary text-[10px] underline-offset-2 hover:underline"
          >
            {expanded ? '…收起' : `…+${value.length - LONG_STRING_THRESHOLD}`}
          </button>
        )}
      </span>
    );
  }
  if (typeof value === 'number') {
    return <span className="text-warning">{String(value)}</span>;
  }
  if (typeof value === 'boolean') {
    return <span className="text-primary">{String(value)}</span>;
  }
  return <span className="text-text-secondary">{String(value)}</span>;
});

// ---- 折叠态预览 ----

function CollapsedPreview({ value, previewCount }: { value: unknown; previewCount: number }) {
  const items: { k: string; v: unknown }[] = useMemo(() => {
    if (Array.isArray(value)) {
      return value.slice(0, previewCount).map((v, i) => ({ k: String(i), v }));
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      return entries.slice(0, previewCount).map(([k, v]) => ({ k, v }));
    }
    return [];
  }, [value, previewCount]);

  const total = sizeOf(value);
  const hidden = total - items.length;
  const isArray = Array.isArray(value);

  return (
    <span className="text-text-muted">
      {isArray ? '[' : '{ '}
      {items.map((item, idx) => (
        <span key={item.k}>
          {idx > 0 && <span>, </span>}
          {!isArray && (
            <>
              <span className="text-primary">{item.k}</span>
              <span>:</span>{' '}
            </>
          )}
          {isExpandable(item.v) ? (
            <span className="text-text-tertiary">
              {Array.isArray(item.v) ? `[${sizeOf(item.v)}]` : `{${sizeOf(item.v)}}`}
            </span>
          ) : typeof item.v === 'string' && item.v.length > LONG_STRING_THRESHOLD ? (
            <span className="text-success">"{item.v.slice(0, 30)}…"</span>
          ) : (
            <ScalarValue value={item.v} />
          )}
        </span>
      ))}
      {hidden > 0 && <span className="text-text-tertiary"> … +{hidden}</span>}
      {isArray ? ' ]' : ' }'}
    </span>
  );
}

// ---- 节点 ----

const TreeNode = memo(function TreeNode({
  value,
  keyName,
  depth,
  defaultDepth,
  previewCount,
  matchedPaths,
  currentPath,
  pathPrefix,
  onCurrentRef,
}: NodeProps) {
  const expandable = isExpandable(value);
  // 默认展开深度内的节点初始展开；超出则折叠。
  // 若有搜索匹配，默认展开命中路径上的节点。
  const isOnMatchedPath = matchedPaths
    ? [...matchedPaths].some((p) => p === pathPrefix || p.startsWith(pathPrefix + '.') || p.startsWith(pathPrefix + '['))
    : false;
  const [expanded, setExpanded] = useState(
    depth < defaultDepth || isOnMatchedPath
  );

  const isArray = Array.isArray(value);
  const entries = useMemo(() => {
    if (isArray) return (value as unknown[]).map((v, i) => ({ k: String(i), v }));
    return Object.entries(value as Record<string, unknown>).map(([k, v]) => ({ k, v }));
  }, [value, isArray]);

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded((v) => !v);
  }, []);

  const isCurrent = currentPath === pathPrefix;

  // 标量：直接渲染为一行。
  if (!expandable) {
    return (
      <div
        ref={isCurrent ? onCurrentRef : undefined}
        className={clsx(
          'flex items-start gap-1.5 py-0.5 px-1 rounded font-mono text-xs leading-relaxed',
          isCurrent && 'bg-warning/20 ring-1 ring-warning/40',
          matchedPaths?.has(pathPrefix) && !isCurrent && 'bg-warning/10'
        )}
      >
        {keyName !== null && (
          <>
            <span className="text-primary">
              {isIndexKey(keyName) ? keyName : `"${keyName}"`}
            </span>
            <span className="text-text-muted">:</span>
          </>
        )}
        <ScalarValue value={value} />
      </div>
    );
  }

  const openBracket = isArray ? '[' : '{';
  const closeBracket = isArray ? ']' : '}';
  const total = sizeOf(value);

  return (
    <div className="font-mono text-xs leading-relaxed">
      <div
        ref={isCurrent ? onCurrentRef : undefined}
        className={clsx(
          'flex items-start gap-1.5 py-0.5 px-1 rounded cursor-pointer hover:bg-background-hover/40',
          isCurrent && 'bg-warning/20 ring-1 ring-warning/40',
          matchedPaths?.has(pathPrefix) && !isCurrent && 'bg-warning/10'
        )}
        onClick={toggle}
        role="button"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 mt-0.5 shrink-0 text-text-muted" />
        ) : (
          <ChevronRight className="w-3 h-3 mt-0.5 shrink-0 text-text-muted" />
        )}
        <div className="min-w-0 flex-1">
          {keyName !== null && (
            <>
              <span className="text-primary">
                {isIndexKey(keyName) ? keyName : `"${keyName}"`}
              </span>
              <span className="text-text-muted">:</span>{' '}
            </>
          )}
          {expanded ? (
            <span className="text-text-muted">{openBracket}</span>
          ) : (
            <>
              <span className="text-text-muted">{openBracket === '[' ? '[' : '{ '}</span>
              <CollapsedPreview value={value} previewCount={previewCount} />
              <span className="text-text-muted">{closeBracket === ']' ? ' ]' : ' }'}</span>
              <span className="text-text-tertiary ml-1.5 text-[10px]">
                {isArray ? `[${total}]` : `{${total}}`}
              </span>
            </>
          )}
        </div>
      </div>

      {expanded && (
        <>
          <div className="pl-3 ml-1 border-l border-border/subtle">
            {entries.map((entry) => {
              const childPath = isArray
                ? `${pathPrefix}[${entry.k}]`
                : (pathPrefix ? `${pathPrefix}.` : '') + entry.k;
              return (
                <TreeNode
                  key={entry.k}
                  value={entry.v}
                  keyName={entry.k}
                  depth={depth + 1}
                  defaultDepth={defaultDepth}
                  previewCount={previewCount}
                  matchedPaths={matchedPaths}
                  currentPath={currentPath}
                  pathPrefix={childPath}
                  onCurrentRef={onCurrentRef}
                />
              );
            })}
          </div>
          <div className="pl-3 ml-1 py-0.5 text-text-muted">{closeBracket}</div>
        </>
      )}
    </div>
  );
});

// ---- 数据规整 ----

function normalizeData(data: unknown): { value: unknown; isJson: boolean } {
  if (data === null || data === undefined) return { value: data, isJson: false };
  if (typeof data === 'object') return { value: data, isJson: true };

  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return { value: data, isJson: false };
    const looksLikeJson =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'));
    if (looksLikeJson) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null) {
          return { value: parsed, isJson: true };
        }
      } catch {
        // 解析失败，降级为纯文本。
      }
    }
    return { value: data, isJson: false };
  }

  return { value: data, isJson: false };
}

// ---- 搜索：在 value 中查找匹配 key/value，返回路径集合 ----

function searchJson(value: unknown, query: string, prefix: string, results: string[]): void {
  if (!query) return;
  const q = query.toLowerCase();
  const walk = (v: unknown, path: string) => {
    if (results.length > 500) return; // 上限保护
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const childPath = `${path}[${i}]`;
        walk(v[i], childPath);
      }
    } else if (v && typeof v === 'object') {
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        const childPath = path ? `${path}.${k}` : k;
        if (k.toLowerCase().includes(q)) {
          results.push(childPath);
        }
        // 字符串值也参与匹配
        if (typeof item === 'string' && item.toLowerCase().includes(q)) {
          results.push(childPath);
        }
        walk(item, childPath);
      }
    }
  };
  walk(value, prefix);
}

// ---- 主组件 ----

export const JsonTreeView = memo(function JsonTreeView({
  data,
  defaultDepth = 2,
  previewCount = 3,
  className,
}: JsonTreeViewProps) {
  const { t } = useTranslation('chat');
  const { value, isJson } = useMemo(() => normalizeData(data), [data]);
  const [copied, setCopied] = useState(false);
  const [depthOverride, setDepthOverride] = useState<number | null>(null);
  const [gen, setGen] = useState(0);

  // 搜索状态
  const [query, setQuery] = useState('');
  const [matchedPaths, setMatchedPaths] = useState<Set<string>>(new Set());
  const [currentMatchIdx, setCurrentMatchIdx] = useState(-1);
  const currentRef = useRef<HTMLDivElement | null>(null);

  const effectiveDepth = depthOverride ?? defaultDepth;

  const measure = useMemo(() => (isJson ? measureJson(value) : { nodes: 0, chars: 0 }), [value, isJson]);
  const showSearch = isJson && (measure.nodes > 50 || measure.chars > 2000);

  const copyText = useMemo(() => {
    if (isJson) return JSON.stringify(value, null, 2);
    if (typeof value === 'string') return value;
    return String(value ?? '');
  }, [value, isJson]);

  const handleCopy = useCallback(async () => {
    await copyToClipboard(copyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [copyText]);

  const expandAll = useCallback(() => {
    setDepthOverride(Infinity);
    setGen((g) => g + 1);
  }, []);

  const collapseAll = useCallback(() => {
    setDepthOverride(0);
    setGen((g) => g + 1);
  }, []);

  // 搜索：query 变化时重新计算匹配路径。
  useEffect(() => {
    if (!isJson || !query.trim()) {
      setMatchedPaths(new Set());
      setCurrentMatchIdx(-1);
      return;
    }
    const results: string[] = [];
    searchJson(value, query.trim(), '', results);
    setMatchedPaths(new Set(results));
    setCurrentMatchIdx(results.length > 0 ? 0 : -1);
  }, [query, value, isJson]);

  // 当有匹配时，强制展开命中路径（通过重挂载 + 把默认深度设为 Infinity，
  // 但仅在有 query 时这样做，避免无谓全展开）。
  const searchActive = query.trim() !== '' && matchedPaths.size > 0;
  const renderDepth = searchActive ? Infinity : effectiveDepth;

  // 当前命中路径。
  const matchedArr = searchActive ? [...matchedPaths] : [];
  const currentPath = matchedArr.length > 0 ? matchedArr[Math.max(0, Math.min(currentMatchIdx, matchedArr.length - 1))] : undefined;

  // 跳转当前命中节点时滚动到视图。
  useEffect(() => {
    if (currentRef.current) {
      currentRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [currentPath]);

  const goToMatch = useCallback((dir: 1 | -1) => {
    setCurrentMatchIdx((idx) => {
      if (matchedArr.length === 0) return -1;
      const next = (idx + dir + matchedArr.length) % matchedArr.length;
      return next;
    });
  }, [matchedArr.length]);

  const showTree = isJson && isExpandable(value);

  return (
    <div className={clsx('rounded', className)}>
      {/* 顶部条：操作按钮（无自带背景，融入外层） */}
      {showTree && (
        <div className="flex items-center gap-2 mb-1.5">
          <button
            onClick={expandAll}
            className="text-primary hover:text-primary-hover text-xs"
          >
            {t('tool.expandAll')}
          </button>
          <span className="text-text-tertiary">·</span>
          <button
            onClick={collapseAll}
            className="text-primary hover:text-primary-hover text-xs"
          >
            {t('tool.collapse')}
          </button>
          <div className="ml-auto flex items-center gap-2">
            {showSearch && (
              <div className="flex items-center gap-1">
                <div className="relative">
                  <Search className="w-3 h-3 absolute left-1.5 top-1/2 -translate-y-1/2 text-text-muted" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('tool.searchInJson')}
                    className="pl-6 pr-1 py-0.5 text-xs bg-background-surface rounded border border-border focus:border-primary/50 outline-none w-32"
                  />
                </div>
                {searchActive && (
                  <>
                    <button onClick={() => goToMatch(-1)} className="text-text-muted hover:text-primary">
                      <ChevronUp className="w-3.5 h-3.5" />
                    </button>
                    <span className="text-[10px] text-text-tertiary tabular-nums">
                      {t('tool.matchCount', { current: currentMatchIdx + 1, total: matchedArr.length })}
                    </span>
                    <button onClick={() => goToMatch(1)} className="text-text-muted hover:text-primary">
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
                {query.trim() && !searchActive && (
                  <span className="text-[10px] text-text-tertiary">{t('tool.noMatch')}</span>
                )}
              </div>
            )}
            <button
              onClick={handleCopy}
              className={clsx(
                'flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors',
                copied
                  ? 'text-success bg-success/10'
                  : 'text-primary hover:text-primary-hover'
              )}
            >
              {copied ? (
                <>
                  <Check className="w-3 h-3" />
                  {t('tool.copied')}
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  {t('tool.copyOutput')}
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {showTree ? (
        <div className="overflow-x-auto">
          <TreeNode
            key={gen + ':' + (searchActive ? 'search' : 'normal')}
            value={value}
            keyName={null}
            depth={0}
            defaultDepth={renderDepth}
            previewCount={previewCount}
            matchedPaths={searchActive ? matchedPaths : undefined}
            currentPath={currentPath}
            pathPrefix=""
            onCurrentRef={(el) => {
              currentRef.current = el;
            }}
          />
        </div>
      ) : (
        <pre className="text-xs text-text-secondary font-mono whitespace-pre-wrap break-all max-h-96 overflow-y-auto">
          {typeof value === 'string' ? value : String(value ?? '')}
        </pre>
      )}
    </div>
  );
});
