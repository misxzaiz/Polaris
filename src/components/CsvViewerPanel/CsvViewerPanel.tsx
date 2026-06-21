import { useState, useCallback, useMemo } from 'react'

interface CsvData {
  headers: string[]
  rows: string[][]
}

function parseCsv(text: string, delimiter: string = ','): CsvData {
  const lines = text.trim().split('\n')
  if (lines.length === 0) return { headers: [], rows: [] }

  const headers = lines[0].split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ''))
  const rows = lines.slice(1).map((line) =>
    line.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, '')),
  )

  return { headers, rows }
}

const MOCK_CSV = `Name,Age,City,Score
Alice,28,Beijing,95
Bob,35,Shanghai,87
Charlie,22,Guangzhou,92
Diana,31,Shenzhen,88
Eve,26,Hangzhou,91`

export default function CsvViewerPanel({ pluginId }: { pluginId: string; onSendToChat?: (msg: string) => void }) {
  const [input, setInput] = useState(MOCK_CSV)
  const [delimiter, setDelimiter] = useState(',')
  const [sortColumn, setSortColumn] = useState<number | null>(null)
  const [sortAsc, setSortAsc] = useState(true)
  const [search, setSearch] = useState('')

  const data = useMemo<CsvData>(() => parseCsv(input, delimiter), [input, delimiter])

  const filteredRows = useMemo(() => {
    let rows = data.rows
    if (search) {
      const lower = search.toLowerCase()
      rows = rows.filter((row) => row.some((cell) => cell.toLowerCase().includes(lower)))
    }
    if (sortColumn !== null) {
      rows = [...rows].sort((a, b) => {
        const aVal = a[sortColumn] || ''
        const bVal = b[sortColumn] || ''
        const numA = parseFloat(aVal)
        const numB = parseFloat(bVal)
        if (!isNaN(numA) && !isNaN(numB)) {
          return sortAsc ? numA - numB : numB - numA
        }
        return sortAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
      })
    }
    return rows
  }, [data, search, sortColumn, sortAsc])

  const handleSort = useCallback(
    (col: number) => {
      if (sortColumn === col) {
        setSortAsc(!sortAsc)
      } else {
        setSortColumn(col)
        setSortAsc(true)
      }
    },
    [sortColumn, sortAsc],
  )

  const stats = useMemo(() => {
    return {
      rows: data.rows.length,
      cols: data.headers.length,
      cells: data.rows.length * data.headers.length,
    }
  }, [data])

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#E8E8EC' }}>CSV 查看</h3>
        <span style={{ fontSize: 10, color: '#71717A' }}>Plugin: {pluginId}</span>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 8 }}>
        <span style={{ fontSize: 10, color: '#71717A' }}>{stats.rows} 行</span>
        <span style={{ fontSize: 10, color: '#71717A' }}>{stats.cols} 列</span>
        {search && <span style={{ fontSize: 10, color: '#3B82F6' }}>筛选: {filteredRows.length} 行</span>}
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索..."
          style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid #3F3F46', background: '#18181B', color: '#E8E8EC', fontSize: 12, outline: 'none' }}
        />
        <select
          value={delimiter}
          onChange={(e) => setDelimiter(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #3F3F46', background: '#18181B', color: '#E8E8EC', fontSize: 12, outline: 'none' }}
        >
          <option value=",">逗号</option>
          <option value=";">分号</option>
          <option value="\t">Tab</option>
          <option value="|">管道</option>
        </select>
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflow: 'auto', borderRadius: 6, border: '1px solid #3F3F46' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ background: '#27272A' }}>
              {data.headers.map((header, i) => (
                <th
                  key={i}
                  onClick={() => handleSort(i)}
                  style={{
                    padding: '8px 12px',
                    textAlign: 'left',
                    fontWeight: 600,
                    color: '#E8E8EC',
                    borderBottom: '1px solid #3F3F46',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {header}
                  {sortColumn === i && (sortAsc ? ' ↑' : ' ↓')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row, i) => (
              <tr key={i} style={{ background: i % 2 === 0 ? '#18181B' : '#1A1A1E' }}>
                {row.map((cell, j) => (
                  <td
                    key={j}
                    style={{
                      padding: '6px 12px',
                      color: '#A1A1AA',
                      borderBottom: '1px solid #27272A',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Input */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11, color: '#71717A' }}>CSV 数据</span>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          style={{
            minHeight: 60,
            padding: 8,
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: '#18181B',
            color: '#E8E8EC',
            fontFamily: 'Consolas, Monaco, monospace',
            fontSize: 10,
            lineHeight: 1.4,
            resize: 'vertical',
            outline: 'none',
          }}
        />
      </div>
    </div>
  )
}
