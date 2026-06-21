/**
 * 响应表格视图
 *
 * 递归扫描 JSON 树，找出所有「数组路径」及其父对象路径，用户可在下拉中选择
 * 哪一条作为表格数据源。例如 {"data":{"list":[...]}} 会识别出 data（父对象）、
 * data.list（数组）两条路径。选中数组 → 多行表格；选中对象 → 单行表格。
 *
 * 表格布局：固定列宽 + 统一横向滚动容器，表头 sticky 纵向粘住、横向随容器同步滚动。
 * 大数组纵向用 react-virtuoso 虚拟化。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { TableVirtuoso } from 'react-virtuoso'
import { Check, TableProperties, ChevronDown, Database } from 'lucide-react'

interface FlatRow {
  [key: string]: unknown
}

/** 一条可表格化的路径 */
interface ArrayPath {
  path: string
  segments: (string | number)[]
  kind: 'array' | 'object'
  count: number
}

const INDEX_COL_WIDTH = 40
const COL_MIN_WIDTH = 120

function pathLabel(segments: (string | number)[]): string {
  if (segments.length === 0) return '$'
  return segments.map((s) => (typeof s === 'number' ? `[${s}]` : s)).join('.')
}

function collectPaths(data: unknown, segments: (string | number)[], acc: ArrayPath[]): void {
  if (Array.isArray(data)) {
    const objRows = data.filter((r) => r !== null && typeof r === 'object' && !Array.isArray(r)) as FlatRow[]
    if (objRows.length > 0) {
      acc.push({ path: pathLabel(segments), segments: [...segments], kind: 'array', count: objRows.length })
    }
    const sample = objRows[0]
    if (sample) collectIntoArrayElement(sample, segments, acc)
    return
  }
  if (data !== null && typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>)
    const hasArrayField = entries.some(([, v]) => Array.isArray(v))
    if (segments.length === 0 || hasArrayField) {
      acc.push({ path: pathLabel(segments), segments: [...segments], kind: 'object', count: 1 })
    }
    for (const [k, v] of entries) {
      collectPaths(v, [...segments, k], acc)
    }
  }
}

function collectIntoArrayElement(data: unknown, segments: (string | number)[], acc: ArrayPath[]): void {
  if (Array.isArray(data)) {
    const objRows = data.filter((r) => r !== null && typeof r === 'object' && !Array.isArray(r))
    if (objRows.length > 0) {
      acc.push({ path: pathLabel(segments), segments: [...segments], kind: 'array', count: objRows.length })
    }
    const sample = objRows[0]
    if (sample) collectIntoArrayElement(sample, segments, acc)
    return
  }
  if (data !== null && typeof data === 'object') {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      collectPaths(v, [...segments, k], acc)
    }
  }
}

function getByPath(root: unknown, segments: (string | number)[]): unknown {
  let cur: unknown = root
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg as string]
  }
  return cur
}

function rowsAtPath(data: unknown, path: ArrayPath | null): FlatRow[] {
  if (!path) return []
  const target = getByPath(data, path.segments)
  if (Array.isArray(target)) {
    return target.filter((r) => r !== null && typeof r === 'object' && !Array.isArray(r)) as FlatRow[]
  }
  if (target !== null && typeof target === 'object' && !Array.isArray(target)) {
    return [target as FlatRow]
  }
  return []
}

function cellPreview(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** 外部点击关闭 hook */
function useClickOutside<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])
  return ref
}

interface ResponseTableViewProps {
  data: unknown
}

export function ResponseTableView({ data }: ResponseTableViewProps) {
  const arrayPaths = useMemo(() => {
    const acc: ArrayPath[] = []
    collectPaths(data, [], acc)
    return acc
  }, [data])

  const [selectedPathIdx, setSelectedPathIdx] = useState(0)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [showPathPicker, setShowPathPicker] = useState(false)
  const [showColPicker, setShowColPicker] = useState(false)

  // 数据源（data）变化时重置选择与列隐藏
  useEffect(() => {
    setSelectedPathIdx(0)
    setHidden(new Set())
    setShowPathPicker(false)
    setShowColPicker(false)
  }, [data])

  const pathIdx = Math.min(selectedPathIdx, Math.max(0, arrayPaths.length - 1))
  const activePath = arrayPaths[pathIdx] ?? null

  const rows = useMemo(() => rowsAtPath(data, activePath), [data, activePath])

  const allColumns = useMemo(() => {
    const set = new Set<string>()
    rows.forEach((r) => Object.keys(r).forEach((k) => set.add(k)))
    return Array.from(set)
  }, [rows])

  const columns = useMemo(() => allColumns.filter((c) => !hidden.has(c)), [allColumns, hidden])

  const pathPickerRef = useClickOutside<HTMLDivElement>(() => setShowPathPicker(false))
  const colPickerRef = useClickOutside<HTMLDivElement>(() => setShowColPicker(false))

  const selectPath = (idx: number) => {
    setSelectedPathIdx(idx)
    setHidden(new Set())
    setShowPathPicker(false)
  }

  const toggleCol = (c: string) => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })
  }

  if (arrayPaths.length === 0) {
    return <div className="p-3 text-xs text-text-tertiary">无可表格化的数据（响应需为 JSON 对象或数组）</div>
  }

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-border shrink-0 gap-2">
        <div className="relative shrink-0" ref={pathPickerRef}>
          <button
            onClick={() => setShowPathPicker((v) => !v)}
            className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded hover:bg-background-elevated text-text-secondary max-w-[180px]"
            title="选择数据源路径"
          >
            <Database className="w-3 h-3 shrink-0" />
            <span className="truncate font-mono">{activePath?.path ?? '$'}</span>
            <span className="text-text-tertiary shrink-0">[{activePath?.kind === 'array' ? `${rows.length}` : 'obj'}]</span>
            <ChevronDown className="w-3 h-3 shrink-0" />
          </button>
          {showPathPicker && (
            <div className="absolute left-0 top-full mt-1 z-20 bg-background-elevated border border-border rounded shadow-lg max-h-60 overflow-auto min-w-[180px]">
              {arrayPaths.map((p, i) => (
                <button
                  key={`${p.path}-${i}`}
                  onClick={() => selectPath(i)}
                  className={`flex items-center justify-between w-full px-2 py-1 text-[11px] text-left hover:bg-background-hover ${
                    i === pathIdx ? 'text-primary' : 'text-text-primary'
                  }`}
                >
                  <span className="truncate font-mono">{p.path}</span>
                  <span className="text-text-tertiary shrink-0 ml-2 text-[9px]">
                    {p.kind === 'array' ? `数组×${p.count}` : '对象'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-text-tertiary">{rows.length} 行 × {columns.length} 列</span>
          <div className="relative" ref={colPickerRef}>
            <button
              onClick={() => setShowColPicker((v) => !v)}
              className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded hover:bg-background-elevated text-text-secondary"
            >
              <TableProperties className="w-3 h-3" /> 列
            </button>
            {showColPicker && (
              <div className="absolute right-0 top-full mt-1 z-20 bg-background-elevated border border-border rounded shadow-lg max-h-60 overflow-auto min-w-[140px]">
                {allColumns.map((c) => (
                  <button
                    key={c}
                    onClick={() => toggleCol(c)}
                    className="flex items-center gap-2 w-full px-2 py-1 text-[11px] text-left hover:bg-background-hover text-text-primary"
                  >
                    <span className={`w-3 ${!hidden.has(c) ? 'text-primary' : 'text-transparent'}`}>
                      <Check className="w-3 h-3" />
                    </span>
                    <span className="truncate font-mono">{c}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 表格区：TableVirtuoso 渲染真实 <table>，粘性表头 + 纵向虚拟化，横向由表宽自然滚动且表头同步 */}
      <div className="flex-1 min-h-0">
        <TableVirtuoso
          totalCount={rows.length}
          fixedItemHeight={28}
          className="h-full"
          style={{ height: '100%', overflowX: 'auto', overflowY: 'auto' }}
          fixedHeaderContent={() => (
            <>
              <th
                className="sticky left-0 z-10 bg-background-elevated px-1 py-1 text-[10px] text-text-tertiary text-right border-r border-b border-border font-mono"
                style={{ width: INDEX_COL_WIDTH, minWidth: INDEX_COL_WIDTH }}
              >
                #
              </th>
              {columns.map((c) => (
                <th
                  key={c}
                  className="bg-background-elevated px-2 py-1 text-[10px] font-medium text-text-secondary truncate border-r border-b border-border last:border-r-0"
                  style={{ width: COL_MIN_WIDTH, minWidth: COL_MIN_WIDTH }}
                  title={c}
                >
                  {c}
                </th>
              ))}
            </>
          )}
          itemContent={(i) => {
            const row = rows[i]
            return (
              <>
                <td
                  className="sticky left-0 bg-background px-1 py-1 text-[10px] text-text-tertiary text-right border-r border-border/50 font-mono"
                  style={{ width: INDEX_COL_WIDTH, minWidth: INDEX_COL_WIDTH }}
                >
                  {i + 1}
                </td>
                {columns.map((c) => {
                  const val = cellPreview(row[c])
                  return (
                    <td
                      key={c}
                      className="px-2 py-1 text-[11px] font-mono text-text-primary truncate border-r border-border/50 last:border-r-0"
                      style={{ width: COL_MIN_WIDTH, minWidth: COL_MIN_WIDTH }}
                      title={val}
                    >
                      {val}
                    </td>
                  )
                })}
              </>
            )
          }}
        />
      </div>
    </div>
  )
}
