/**
 * JSON 树形视图
 *
 * 用途：在工具调用面板中格式化展示 JSON 结构化输出/输入，支持层级折叠。
 *
 * 设计要点：
 * - 优先将字符串解析为 JSON；解析失败时降级为纯文本 pre 渲染。
 * - 节点可逐个折叠/展开；默认展开前 `defaultDepth` 层，更深层默认折叠。
 * - 顶部提供"全部展开/全部折叠"与"复制"按钮。
 * - 大数组/大对象在折叠态显示长度摘要，避免一屏塞满。
 */

import { memo, useMemo, useState, useCallback } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { copyToClipboard } from '@/utils/clipboard';

export interface JsonTreeViewProps {
  /** 待展示的内容。字符串会尝试 JSON.parse；对象/数组直接渲染。 */
  data: unknown;
  /** 顶部标签（如"输出结果"）。 */
  label?: string;
  /** 默认展开深度，默认 2。 */
  defaultDepth?: number;
  /** 折叠态下显示的最大子项预览数，默认 5。 */
  previewCount?: number;
  /** 额外类名。 */
  className?: string;
}

interface NodeProps {
  /** 当前节点值。 */
  value: unknown;
  /** 节点 key（根节点为 null）。 */
  keyName: string | null;
  /** 当前深度。 */
  depth: number;
  /** 默认展开深度。 */
  defaultDepth: number;
  /** 折叠态预览子项数。 */
  previewCount: number;
}

// 判断是否为"复杂"值（对象或数组），需要可折叠。
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

/** 渲染单个标量值（string/number/bool/null）。 */
function ScalarValue({ value }: { value: unknown }) {
  if (value === null) {
    return <span className="text-text-muted italic">null</span>;
  }
  if (typeof value === 'string') {
    return <span className="text-success">"{value}"</span>;
  }
  if (typeof value === 'number') {
    return <span className="text-warning">{String(value)}</span>;
  }
  if (typeof value === 'boolean') {
    return <span className="text-primary">{String(value)}</span>;
  }
  return <span className="text-text-secondary">{String(value)}</span>;
}

/** 折叠态预览：把前 N 个子项渲染成单行摘要。 */
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

  return (
    <span className="text-text-muted">
      {'{ '}
      {items.map((item, idx) => (
        <span key={item.k}>
          {idx > 0 && <span>, </span>}
          <span className="text-primary">{item.k}:</span>{' '}
          {isExpandable(item.v) ? (
            <span className="text-text-tertiary">
              {Array.isArray(item.v) ? `[…${sizeOf(item.v)}]` : `{…${sizeOf(item.v)}}`}
            </span>
          ) : (
            <ScalarValue value={item.v} />
          )}
        </span>
      ))}
      {hidden > 0 && <span className="text-text-tertiary"> … +{hidden}</span>}
      {' }'}
    </span>
  );
}

const TreeNode = memo(function TreeNode({ value, keyName, depth, defaultDepth, previewCount }: NodeProps) {
  const expandable = isExpandable(value);
  // 默认展开深度内的节点初始展开；超出则折叠。
  const [expanded, setExpanded] = useState(depth < defaultDepth);

  // entries 必须在 early return 之前计算，避免违反 hooks 规则。
  const isArray = Array.isArray(value);
  const entries = useMemo(() => {
    if (isArray) return (value as unknown[]).map((v, i) => ({ k: String(i), v }));
    return Object.entries(value as Record<string, unknown>).map(([k, v]) => ({ k, v }));
  }, [value, isArray]);

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded((v) => !v);
  }, []);

  // 标量：直接渲染为一行。
  if (!expandable) {
    return (
      <div className="flex items-start gap-1.5 py-0.5 font-mono text-xs leading-relaxed">
        {keyName !== null && (
          <>
            <span className="text-primary">"{keyName}"</span>
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
        className="flex items-start gap-1.5 py-0.5 cursor-pointer hover:bg-background-hover/30 rounded"
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
              <span className="text-primary">"{keyName}"</span>
              <span className="text-text-muted">:</span>{' '}
            </>
          )}
          {expanded ? (
            <span className="text-text-muted">
              {openBracket}
            </span>
          ) : (
            <>
              <span className="text-text-muted">{openBracket} </span>
              <CollapsedPreview value={value} previewCount={previewCount} />
              <span className="text-text-muted"> {closeBracket}</span>
              <span className="text-text-tertiary ml-1">({total})</span>
            </>
          )}
        </div>
      </div>

      {expanded && (
        <>
          <div className="pl-4 border-l border-border/40 ml-1.5">
            {entries.map((entry) => (
              <TreeNode
                key={entry.k}
                value={entry.v}
                keyName={entry.k}
                depth={depth + 1}
                defaultDepth={defaultDepth}
                previewCount={previewCount}
              />
            ))}
          </div>
          <div className="pl-4 py-0.5 text-text-muted">{closeBracket}</div>
        </>
      )}
    </div>
  );
});

/**
 * 尝试把任意输入规整为 { value, isJson }。
 * - 对象/数组：直接返回。
 * - 字符串：尝试 JSON.parse；失败则返回原始字符串（标记为非 JSON）。
 */
function normalizeData(data: unknown): { value: unknown; isJson: boolean } {
  if (data === null || data === undefined) return { value: data, isJson: false };
  if (typeof data === 'object') return { value: data, isJson: true };

  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return { value: data, isJson: false };
    // 快速判定：只对看起来像 JSON 的字符串尝试解析，避免对普通文本无谓报错。
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

export const JsonTreeView = memo(function JsonTreeView({
  data,
  label,
  defaultDepth = 2,
  previewCount = 5,
  className,
}: JsonTreeViewProps) {
  const { t } = useTranslation('chat');
  const { value, isJson } = useMemo(() => normalizeData(data), [data]);
  const [copied, setCopied] = useState(false);
  // 全展开/全折叠通过修改一个"代际 key"实现：用 key 重挂载子树，并以新的 defaultDepth 重新初始化。
  // 这是最简单可靠的方式：避免在 TreeNode 内部维护受控展开状态带来的复杂度。
  const [depthOverride, setDepthOverride] = useState<number | null>(null);
  const [gen, setGen] = useState(0);

  const effectiveDepth = depthOverride ?? defaultDepth;

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

  const showTree = isJson && isExpandable(value);

  return (
    <div className={clsx('rounded bg-background-surface p-2.5', className)}>
      {/* 顶部条：标签 + 操作按钮 */}
      <div className="flex items-center gap-1.5 mb-1.5">
        {label && (
          <span className="text-xs text-text-muted">{label}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {showTree && (
            <>
              <button
                onClick={expandAll}
                className="text-primary hover:text-primary-hover text-xs"
              >
                {t('tool.expandAll')}
              </button>
              <button
                onClick={collapseAll}
                className="text-primary hover:text-primary-hover text-xs"
              >
                {t('tool.collapse')}
              </button>
            </>
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

      {showTree ? (
        <div className="overflow-x-auto">
          <TreeNode
            key={gen}
            value={value}
            keyName={null}
            depth={0}
            defaultDepth={effectiveDepth}
            previewCount={previewCount}
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
