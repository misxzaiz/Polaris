/**
 * JSON 树查看器
 *
 * 节点级折叠 + 点击叶子复制 JSONPath + 高亮 key/value。
 * 默认全部折叠（仅根容器可展开），提供「展开全部 / 折叠全部」控制。
 * 自研递归组件，不引入新依赖。
 */

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Copy, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'

type NodeKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'

interface JsonNode {
  key: string
  value: unknown
  path: string
  kind: NodeKind
}

/** 全局展开/折叠信号：变化时所有 Row 重置 open 状态 */
interface ExpandSignal {
  version: number
  open: boolean
  /** 展开全部时最大展开深度，超过此深度的节点保持折叠，避免同步挂载海量节点卡死 */
  maxExpandDepth: number
}
const ExpandContext = createContext<ExpandSignal>({ version: 0, open: false, maxExpandDepth: Infinity })

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
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const signal = useContext(ExpandContext)
  const isContainer = node.kind === 'object' || node.kind === 'array'

  // 全局展开/折叠信号变化时重置本节点 open。
  // 展开全部时，超过 maxExpandDepth 的节点保持折叠，避免同步挂载海量节点卡死主线程。
  useEffect(() => {
    if (signal.open && depth >= signal.maxExpandDepth) {
      setOpen(false)
    } else {
      setOpen(signal.open)
    }
  }, [signal.version]) // eslint-disable-line react-hooks/exhaustive-deps

  const kids = useMemo(
    () => (isContainer ? childrenOf(node.value, node.path) : []),
    [isContainer, node.value, node.path],
  )
  const count = kids.length

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

/** 展开全部时的最大深度，超过此深度的节点保持折叠，避免同步挂载海量节点卡死 */
const MAX_EXPAND_DEPTH = 4

export function JsonTreeView({ data }: JsonTreeViewProps) {
  const [signal, setSignal] = useState<ExpandSignal>({ version: 0, open: false, maxExpandDepth: MAX_EXPAND_DEPTH })

  const root: JsonNode = {
    key: '$',
    value: data,
    path: '$',
    kind: kindOf(data),
  }

  const expandAll = () => setSignal((s) => ({ version: s.version + 1, open: true, maxExpandDepth: MAX_EXPAND_DEPTH }))
  const collapseAll = () => setSignal((s) => ({ version: s.version + 1, open: false, maxExpandDepth: MAX_EXPAND_DEPTH }))

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏 */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border shrink-0">
        <button
          onClick={expandAll}
          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded hover:bg-background-elevated text-text-secondary hover:text-text-primary"
          title="展开全部"
        >
          <ChevronsUpDown className="w-3 h-3" /> 展开全部
        </button>
        <button
          onClick={collapseAll}
          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded hover:bg-background-elevated text-text-secondary hover:text-text-primary"
          title="折叠全部"
        >
          <ChevronsDownUp className="w-3 h-3" /> 折叠全部
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-2 text-[11px] font-mono">
        <ExpandContext.Provider value={signal}>
          <Row node={root} depth={0} />
        </ExpandContext.Provider>
      </div>
    </div>
  )
}
