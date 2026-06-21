/**
 * JSON 树查看器
 *
 * 节点级折叠 + 点击叶子复制 JSONPath + 高亮 key/value。
 * 自研递归组件，不引入新依赖。大数组用展开/折叠控制，不做虚拟化（树天然懒展开）。
 */

import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Copy } from 'lucide-react'

type NodeKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'

interface JsonNode {
  key: string
  value: unknown
  path: string
  kind: NodeKind
}

function kindOf(v: unknown): NodeKind {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v as NodeKind
}

function childrenOf(value: unknown, path: string): JsonNode[] {
  if (Array.isArray(value)) {
    return value.map((v, i) => ({
      key: String(i),
      value: v,
      path: `${path}[${i}]`,
      kind: kindOf(v),
    }))
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([k, v]) => ({
      key: k,
      value: v,
      path: /^[\w$]+$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`,
      kind: kindOf(v),
    }))
  }
  return []
}

function scalarClass(kind: NodeKind): string {
  switch (kind) {
    case 'string':
      return 'text-green-400'
    case 'number':
      return 'text-blue-400'
    case 'boolean':
      return 'text-purple-400'
    case 'null':
      return 'text-text-tertiary italic'
    default:
      return ''
  }
}

function scalarPreview(value: unknown, kind: NodeKind): string {
  if (kind === 'string') return JSON.stringify(value)
  if (kind === 'null') return 'null'
  return String(value)
}

const TYPE_BADGE = {
  object: 'text-yellow-400',
  array: 'text-orange-400',
} as const

function Row({ node, depth }: { node: JsonNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1)
  const [copied, setCopied] = useState(false)
  const isContainer = node.kind === 'object' || node.kind === 'array'
  const kids = useMemo(
    () => (isContainer ? childrenOf(node.value, node.path) : []),
    [isContainer, node.value, node.path],
  )
  const count = isContainer ? (node.kind === 'array' ? (node.value as unknown[]).length : Object.keys(node.value as object).length) : 0

  const copyPath = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(node.path || '$')
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* ignore */
    }
  }

  return (
    <div>
      <div
        className="flex items-start gap-1 py-0.5 hover:bg-background-elevated/60 rounded px-0.5 -mx-0.5 group cursor-default"
        style={{ paddingLeft: `${depth * 14}px` }}
        onClick={() => isContainer && setOpen((v) => !v)}
      >
        <span className="w-3 shrink-0 mt-0.5">
          {isContainer &&
            (open ? <ChevronDown className="w-3 h-3 text-text-tertiary" /> : <ChevronRight className="w-3 h-3 text-text-tertiary" />)}
        </span>

        {/* key */}
        <span className="text-text-secondary font-mono text-[11px]">{node.key}</span>

        {isContainer ? (
          <>
            <span className={`text-[10px] ${TYPE_BADGE[node.kind as 'object' | 'array']}`}>
              {node.kind === 'array' ? `[${count}]` : `{${count}}`}
            </span>
            {!open && (
              <span className="text-text-tertiary font-mono text-[11px]">
                {node.kind === 'array' ? '[ … ]' : '{ … }'}
              </span>
            )}
          </>
        ) : (
          <span className={`font-mono text-[11px] break-all ${scalarClass(node.kind)}`}>
            : {scalarPreview(node.value, node.kind)}
          </span>
        )}

        <button
          onClick={copyPath}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-background-hover text-text-tertiary hover:text-text-primary transition-all shrink-0 ml-auto"
          title="复制 JSONPath"
        >
          {copied ? <span className="text-[9px] text-green-400">已复制</span> : <Copy className="w-3 h-3" />}
        </button>
      </div>

      {isContainer && open && (
        <div>
          {kids.length === 0 ? (
            <div className="text-text-tertiary italic text-[11px]" style={{ paddingLeft: `${(depth + 1) * 14}px` }}>
              {node.kind === 'array' ? '(空数组)' : '(空对象)'}
            </div>
          ) : (
            kids.map((c, i) => <Row key={i} node={c} depth={depth + 1} />)
          )}
        </div>
      )}
    </div>
  )
}

interface JsonTreeViewProps {
  data: unknown
}

export function JsonTreeView({ data }: JsonTreeViewProps) {
  const root: JsonNode = {
    key: '$',
    value: data,
    path: '$',
    kind: kindOf(data),
  }
  return (
    <div className="p-2 overflow-auto h-full text-[11px] font-mono">
      <Row node={root} depth={0} />
    </div>
  )
}
