import { useState, useCallback, useMemo } from 'react'

type RenamePattern = 'prefix' | 'suffix' | 'replace' | 'number' | 'date'

interface FileItem {
  original: string
  renamed: string
  selected: boolean
}

function applyRenamePattern(
  filename: string,
  pattern: RenamePattern,
  options: { find?: string; replace?: string; prefix?: string; suffix?: string; start?: number; date?: string },
  index: number,
): string {
  const ext = filename.includes('.') ? '.' + filename.split('.').pop() : ''
  const name = filename.slice(0, filename.length - ext.length)

  switch (pattern) {
    case 'prefix':
      return `${options.prefix || ''}${filename}`
    case 'suffix':
      return `${name}${options.suffix || ''}${ext}`
    case 'replace':
      if (!options.find) return filename
      return filename.split(options.find).join(options.replace || '')
    case 'number':
      const num = (options.start || 1) + index
      const padded = num.toString().padStart(3, '0')
      return `${options.prefix || ''}${padded}${options.suffix || ''}${ext}`
    case 'date':
      return `${options.date || new Date().toISOString().slice(0, 10)}_${filename}`
    default:
      return filename
  }
}

const MOCK_FILES = [
  'document.pdf',
  'image_001.png',
  'report_2024.xlsx',
  'photo (1).jpg',
  'screenshot.png',
  'notes.txt',
  'presentation.pptx',
  'data.csv',
  'backup_20240101.zip',
  'config.json',
]

export default function BatchRenamePanel({ pluginId }: { pluginId: string; onSendToChat?: (msg: string) => void }) {
  const [files, setFiles] = useState<string[]>(MOCK_FILES)
  const [pattern, setPattern] = useState<RenamePattern>('prefix')
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [prefix, setPrefix] = useState('')
  const [suffix, setSuffix] = useState('')
  const [startNum, setStartNum] = useState(1)
  const [dateStr, setDateStr] = useState(new Date().toISOString().slice(0, 10))
  const [newFileName, setNewFileName] = useState('')
  const [copied, setCopied] = useState(false)

  const renamedFiles = useMemo<FileItem[]>(() => {
    return files.map((file, i) => ({
      original: file,
      renamed: applyRenamePattern(file, pattern, { find, replace, prefix, suffix, start: startNum, date: dateStr }, i),
      selected: true,
    }))
  }, [files, pattern, find, replace, prefix, suffix, startNum, dateStr])

  const handleAddFile = useCallback(() => {
    if (!newFileName.trim()) return
    setFiles((prev) => [...prev, newFileName.trim()])
    setNewFileName('')
  }, [newFileName])

  const handleRemoveFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const handleCopy = useCallback(() => {
    const text = renamedFiles.filter((f) => f.selected).map((f) => f.renamed).join('\n')
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [renamedFiles])

  const patterns: { value: RenamePattern; label: string }[] = [
    { value: 'prefix', label: '添加前缀' },
    { value: 'suffix', label: '添加后缀' },
    { value: 'replace', label: '查找替换' },
    { value: 'number', label: '序号命名' },
    { value: 'date', label: '日期命名' },
  ]

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#E8E8EC' }}>批量重命名</h3>
        <span style={{ fontSize: 10, color: '#71717A' }}>Plugin: {pluginId}</span>
      </div>

      {/* Pattern Selector */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {patterns.map((p) => (
          <button
            key={p.value}
            onClick={() => setPattern(p.value)}
            style={{
              padding: '4px 10px',
              borderRadius: 4,
              border: '1px solid',
              borderColor: pattern === p.value ? '#3B82F6' : '#3F3F46',
              background: pattern === p.value ? '#3B82F6' : '#27272A',
              color: pattern === p.value ? '#fff' : '#A1A1AA',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Pattern Options */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 8, borderRadius: 6, background: '#27272A', border: '1px solid #3F3F46' }}>
        {pattern === 'prefix' && (
          <input
            type="text"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="输入前缀..."
            style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #3F3F46', background: '#18181B', color: '#E8E8EC', fontSize: 12, outline: 'none' }}
          />
        )}
        {pattern === 'suffix' && (
          <input
            type="text"
            value={suffix}
            onChange={(e) => setSuffix(e.target.value)}
            placeholder="输入后缀..."
            style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #3F3F46', background: '#18181B', color: '#E8E8EC', fontSize: 12, outline: 'none' }}
          />
        )}
        {pattern === 'replace' && (
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="text"
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder="查找..."
              style={{ flex: 1, padding: '6px 10px', borderRadius: 4, border: '1px solid #3F3F46', background: '#18181B', color: '#E8E8EC', fontSize: 12, outline: 'none' }}
            />
            <input
              type="text"
              value={replace}
              onChange={(e) => setReplace(e.target.value)}
              placeholder="替换为..."
              style={{ flex: 1, padding: '6px 10px', borderRadius: 4, border: '1px solid #3F3F46', background: '#18181B', color: '#E8E8EC', fontSize: 12, outline: 'none' }}
            />
          </div>
        )}
        {pattern === 'number' && (
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="text"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="前缀..."
              style={{ flex: 1, padding: '6px 10px', borderRadius: 4, border: '1px solid #3F3F46', background: '#18181B', color: '#E8E8EC', fontSize: 12, outline: 'none' }}
            />
            <input
              type="number"
              value={startNum}
              onChange={(e) => setStartNum(parseInt(e.target.value) || 1)}
              placeholder="起始号"
              style={{ width: 80, padding: '6px 10px', borderRadius: 4, border: '1px solid #3F3F46', background: '#18181B', color: '#E8E8EC', fontSize: 12, outline: 'none' }}
            />
            <input
              type="text"
              value={suffix}
              onChange={(e) => setSuffix(e.target.value)}
              placeholder="后缀..."
              style={{ flex: 1, padding: '6px 10px', borderRadius: 4, border: '1px solid #3F3F46', background: '#18181B', color: '#E8E8EC', fontSize: 12, outline: 'none' }}
            />
          </div>
        )}
        {pattern === 'date' && (
          <input
            type="date"
            value={dateStr}
            onChange={(e) => setDateStr(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #3F3F46', background: '#18181B', color: '#E8E8EC', fontSize: 12, outline: 'none' }}
          />
        )}
      </div>

      {/* Add File */}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={newFileName}
          onChange={(e) => setNewFileName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAddFile()}
          placeholder="添加文件名..."
          style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid #3F3F46', background: '#18181B', color: '#E8E8EC', fontSize: 12, outline: 'none' }}
        />
        <button onClick={handleAddFile} disabled={!newFileName.trim()} style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: newFileName.trim() ? '#3B82F6' : '#3F3F46', color: newFileName.trim() ? '#fff' : '#71717A', fontSize: 12, cursor: newFileName.trim() ? 'pointer' : 'not-allowed' }}>
          添加
        </button>
      </div>

      {/* File List */}
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {renamedFiles.map((file, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              borderRadius: 4,
              background: '#18181B',
              border: '1px solid #27272A',
            }}
          >
            <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: '#EF4444', textDecoration: 'line-through', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '40%' }}>
                {file.original}
              </span>
              <span style={{ color: '#71717A' }}>→</span>
              <span style={{ fontSize: 11, color: '#22C55E', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {file.renamed}
              </span>
            </div>
            <button
              onClick={() => handleRemoveFile(i)}
              style={{
                padding: '2px 6px',
                borderRadius: 3,
                border: '1px solid #EF444440',
                background: 'transparent',
                color: '#EF4444',
                fontSize: 9,
                cursor: 'pointer',
              }}
            >
              删除
            </button>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={handleCopy}
          disabled={renamedFiles.length === 0}
          style={{
            flex: 1,
            padding: '8px 12px',
            borderRadius: 6,
            border: 'none',
            background: renamedFiles.length > 0 ? '#22C55E' : '#3F3F46',
            color: renamedFiles.length > 0 ? '#fff' : '#71717A',
            fontSize: 12,
            fontWeight: 500,
            cursor: renamedFiles.length > 0 ? 'pointer' : 'not-allowed',
          }}
        >
          {copied ? '已复制' : '复制重命名结果'}
        </button>
      </div>
    </div>
  )
}
