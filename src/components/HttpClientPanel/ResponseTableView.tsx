/**
 * 响应表格视图
 *
 * 递归扫描 JSON 树，找出所有「数组路径」及其父对象路径，用户可在下拉中选择
 * 哪一条作为表格数据源。例如 {"data":{"list":[...]}} 会识别出 data（父对象）、
 * data.list（数组）两条路径。选中数组 → 多行表格；选中对象 → 单行表格（展示其字段）。
 * 抽取所选数据所有对象的 key 作为列集合，支持勾选列显示/隐藏。
 * 大数组用 react-virtuoso 虚拟化。
 */

import { useMemo, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { Check, TableProperties, ChevronDown, Database } from 'lucide-react'

interface FlatRow {
  [key: string]: unknown
}

/** 一条可表格化的路径 */
interface ArrayPath {
  /** 显示用的点分路径，如 data.list */
  path: string
  /** 嵌套键数组，用于取值 */
  segments: (string | number)[]
  /** 数据源类型：数组(多行) / 对象(单行) */
  kind: 'array' | 'object'
  /** 行数 */
  count: number
}

function pathLabel(segments: (string | number)[]): string {
  if (segments.length === 0) return '$'
  return segments.map((s) => (typeof s === 'number' ? `[${s}]` : s)).join('.')
}

/**
 * 递归收集可表格化路径：
 * - 数组（含对象元素）→ kind: array
 * - 对象且自身「含数组值字段」或为根对象 → kind: object（作为父路径暴露，便于选择 data 这类中间层）
 * 深度优先，保证父路径先于子路径出现。
 */
function collectPaths(data: unknown, segments: (string | number)[], acc: ArrayPath[]): void {
  if (Array.isArray(data)) {
    const objRows = data.filter((r) => r !== null && typeof r === 'object' && !Array.isArray(r)) as FlatRow[]
    if (objRows.length > 0) {
      acc.push({ path: pathLabel(segments), segments: [...segments], kind: 'array', count: objRows.length })
    }
    // 向数组首个对象元素内部继续找更深的数组；
    // 传入标记段避免把数组元素误当作"根对象"重复收集
    const sample = objRows[0]
    if (sample) collectIntoArrayElement(sample, segments, acc)
    return
  }
  if (data !== null && typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>)
    const hasArrayField = entries.some(([, v]) => Array.isArray(v))
    // 根对象 或 含数组值字段的对象 → 作为可选父路径（单行展示）
    if (segments.length === 0 || hasArrayField) {
      acc.push({ path: pathLabel(segments), segments: [...segments], kind: 'object', count: 1 })
    }
    for (const [k, v] of entries) {
      collectPaths(v, [...segments, k], acc)
    }
  }
}

/**
 * 进入数组元素内部继续找更深的数组路径。
 * 与 collectPaths 的区别：不把当前对象作为父路径收集（它已是某数组元素，单独作为单行无意义）。
 */
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

/** 按路径取值 */
function getByPath(root: unknown, segments: (string | number)[]): unknown {
  let cur: unknown = root
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg as string]
  }
  return cur
}

/** 把指定路径的数据规整为行 */
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
  const [showPathPicker, setShowPathPicker] = useState(false)
  // 路径变化或数据变化时夹取合法 index
  const pathIdx = Math.min(selectedPathIdx, Math.max(0, arrayPaths.length - 1))
  const activePath = arrayPaths[pathIdx] ?? null

  const rows = useMemo(() => rowsAtPath(data, activePath), [data, activePath])

  const allColumns = useMemo(() => {
    const set = new Set<string>()
    rows.forEach((r) => Object.keys(r).forEach((k) => set.add(k)))
    return Array.from(set)
  }, [rows])

  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [showColPicker, setShowColPicker] = useState(false)
  const columns = useMemo(() => allColumns.filter((c) => !hidden.has(c)), [allColumns, hidden])

  // 切换数据源路径时重置列隐藏状态
  const selectPath = (idx: number) => {
    setSelectedPathIdx(idx)
    setHidden(new Set())
    setShowPathPicker(false)
  }

  if (arrayPaths.length === 0) {
    return <div className="p-3 text-xs text-text-tertiary">无可表格化的数据（响应需为 JSON 对象或数组）</div>
  }

  const toggleCol = (c: string) => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })
  }

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-border shrink-0 gap-2">
        <div className="relative shrink-0">
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
            <div className="absolute left-0 top-full mt-1 z-10 bg-background-elevated border border-border rounded shadow-lg max-h-60 overflow-auto min-w-[180px]">
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
          <div className="relative">
            <button
              onClick={() => setShowColPicker((v) => !v)}
              className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded hover:bg-background-elevated text-text-secondary"
            >
              <TableProperties className="w-3 h-3" /> 列
            </button>
            {showColPicker && (
              <div className="absolute right-0 top-full mt-1 z-10 bg-background-elevated border border-border rounded shadow-lg max-h-60 overflow-auto min-w-[140px]">
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

      {/* 表头 */}
      <div className="flex border-b border-border shrink-0 bg-background-elevated/50">
        <div className="w-10 shrink-0 px-1 py-1 text-[10px] text-text-tertiary text-right border-r border-border">#</div>
        {columns.map((c) => (
          <div
            key={c}
            className="flex-1 min-w-[80px] px-2 py-1 text-[10px] font-medium text-text-secondary truncate border-r border-border last:border-r-0"
            title={c}
          >
            {c}
          </div>
        ))}
      </div>

      {/* 虚拟化行 */}
      <div className="flex-1 min-h-0">
        <Virtuoso
          totalCount={rows.length}
          fixedItemHeight={28}
          itemContent={(i) => {
            const row = rows[i]
            return (
              <div className="flex border-b border-border/50 hover:bg-background-elevated/30">
                <div className="w-10 shrink-0 px-1 py-1 text-[10px] text-text-tertiary text-right border-r border-border font-mono">
                  {i + 1}
                </div>
                {columns.map((c) => {
                  const val = cellPreview(row[c])
                  return (
                    <div
                      key={c}
                      className="flex-1 min-w-[80px] px-2 py-1 text-[11px] font-mono text-text-primary truncate border-r border-border/50 last:border-r-0"
                      title={val}
                    >
                      {val}
                    </div>
                  )
                })}
              </div>
            )
          }}
        />
      </div>
    </div>
  )
}
