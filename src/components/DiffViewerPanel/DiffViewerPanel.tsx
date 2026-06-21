import { useState, useCallback } from 'react'

interface DiffLine {
  type: 'added' | 'removed' | 'unchanged'
  content: string
  lineNum?: number
}

function computeDiff(original: string, modified: string): DiffLine[] {
  const origLines = original.split('\n')
  const modLines = modified.split('\n')
  const result: DiffLine[] = []

  let origIdx = 0
  let modIdx = 0

  while (origIdx < origLines.length || modIdx < modLines.length) {
    if (origIdx >= origLines.length) {
      result.push({ type: 'added', content: modLines[modIdx], lineNum: modIdx + 1 })
      modIdx++
    } else if (modIdx >= modLines.length) {
      result.push({ type: 'removed', content: origLines[origIdx], lineNum: origIdx + 1 })
      origIdx++
    } else if (origLines[origIdx] === modLines[modIdx]) {
      result.push({ type: 'unchanged', content: origLines[origIdx], lineNum: origIdx + 1 })
      origIdx++
      modIdx++
    } else {
      let foundInMod = -1
      for (let i = modIdx; i < Math.min(modIdx + 5, modLines.length); i++) {
        if (modLines[i] === origLines[origIdx]) {
          foundInMod = i
          break
        }
      }

      let foundInOrig = -1
      for (let i = origIdx; i < Math.min(origIdx + 5, origLines.length); i++) {
        if (origLines[i] === modLines[modIdx]) {
          foundInOrig = i
          break
        }
      }

      if (foundInMod >= 0 && (foundInOrig < 0 || foundInMod - modIdx <= foundInOrig - origIdx)) {
        while (modIdx < foundInMod) {
          result.push({ type: 'added', content: modLines[modIdx], lineNum: modIdx + 1 })
          modIdx++
        }
      } else if (foundInOrig >= 0) {
        while (origIdx < foundInOrig) {
          result.push({ type: 'removed', content: origLines[origIdx], lineNum: origIdx + 1 })
          origIdx++
        }
      } else {
        result.push({ type: 'removed', content: origLines[origIdx], lineNum: origIdx + 1 })
        result.push({ type: 'added', content: modLines[modIdx], lineNum: modIdx + 1 })
        origIdx++
        modIdx++
      }
    }
  }

  return result
}

export default function DiffViewerPanel({ pluginId }: { pluginId: string; onSendToChat?: (msg: string) => void }) {
  const [original, setOriginal] = useState('')
  const [modified, setModified] = useState('')
  const [diff, setDiff] = useState<DiffLine[]>([])
  const [showUnchanged, setShowUnchanged] = useState(true)

  const handleCompare = useCallback(() => {
    const result = computeDiff(original, modified)
    setDiff(result)
  }, [original, modified])

  const filteredDiff = showUnchanged ? diff : diff.filter((d) => d.type !== 'unchanged')

  const stats = {
    added: diff.filter((d) => d.type === 'added').length,
    removed: diff.filter((d) => d.type === 'removed').length,
    unchanged: diff.filter((d) => d.type === 'unchanged').length,
  }

  const handleCopy = useCallback(() => {
    const text = filteredDiff
      .map((d) => {
        const prefix = d.type === 'added' ? '+' : d.type === 'removed' ? '-' : ' '
        return `${prefix} ${d.content}`
      })
      .join('\n')
    navigator.clipboard.writeText(text)
  }, [filteredDiff])

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#E8E8EC' }}>差异查看</h3>
        <span style={{ fontSize: 10, color: '#71717A' }}>Plugin: {pluginId}</span>
      </div>

      {/* Input Panels */}
      <div style={{ display: 'flex', gap: 8, flex: 1 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, color: '#EF4444' }}>原始</span>
            {original && <span style={{ fontSize: 10, color: '#52525B' }}>{original.split('\n').length} 行</span>}
          </div>
          <textarea
            value={original}
            onChange={(e) => setOriginal(e.target.value)}
            placeholder="原始文本..."
            style={{
              flex: 1,
              minHeight: 100,
              padding: 10,
              borderRadius: 6,
              border: '1px solid #3F3F46',
              background: '#18181B',
              color: '#E8E8EC',
              fontFamily: 'Consolas, Monaco, "Courier New", monospace',
              fontSize: 12,
              lineHeight: 1.5,
              resize: 'none',
              outline: 'none',
            }}
          />
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, color: '#22C55E' }}>修改后</span>
            {modified && <span style={{ fontSize: 10, color: '#52525B' }}>{modified.split('\n').length} 行</span>}
          </div>
          <textarea
            value={modified}
            onChange={(e) => setModified(e.target.value)}
            placeholder="修改后的文本..."
            style={{
              flex: 1,
              minHeight: 100,
              padding: 10,
              borderRadius: 6,
              border: '1px solid #3F3F46',
              background: '#18181B',
              color: '#E8E8EC',
              fontFamily: 'Consolas, Monaco, "Courier New", monospace',
              fontSize: 12,
              lineHeight: 1.5,
              resize: 'none',
              outline: 'none',
            }}
          />
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={handleCompare}
          disabled={!original && !modified}
          style={{
            flex: 1,
            padding: '8px 12px',
            borderRadius: 6,
            border: 'none',
            background: original || modified ? '#3B82F6' : '#3F3F46',
            color: original || modified ? '#fff' : '#71717A',
            fontSize: 12,
            fontWeight: 500,
            cursor: original || modified ? 'pointer' : 'not-allowed',
          }}
        >
          比较
        </button>
        {diff.length > 0 && (
          <>
            <button
              onClick={() => setShowUnchanged(!showUnchanged)}
              style={{
                padding: '6px 10px',
                borderRadius: 6,
                border: '1px solid #3F3F46',
                background: showUnchanged ? '#3B82F6' : '#27272A',
                color: showUnchanged ? '#fff' : '#A1A1AA',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              {showUnchanged ? '隐藏相同' : '显示相同'}
            </button>
            <button onClick={handleCopy} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #3F3F46', background: '#27272A', color: '#A1A1AA', fontSize: 11, cursor: 'pointer' }}>
              复制
            </button>
          </>
        )}
      </div>

      {/* Stats */}
      {diff.length > 0 && (
        <div style={{ display: 'flex', gap: 8, padding: '6px 10px', borderRadius: 6, background: '#27272A' }}>
          <span style={{ fontSize: 11, color: '#22C55E' }}>+{stats.added} 新增</span>
          <span style={{ fontSize: 11, color: '#EF4444' }}>-{stats.removed} 删除</span>
          <span style={{ fontSize: 11, color: '#71717A' }}>/ {stats.unchanged} 未变</span>
        </div>
      )}

      {/* Diff Result */}
      {diff.length > 0 && (
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: 10,
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: '#18181B',
            fontFamily: 'Consolas, Monaco, "Courier New", monospace',
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {filteredDiff.map((line, i) => (
            <div
              key={i}
              style={{
                padding: '2px 8px',
                background:
                  line.type === 'added'
                    ? '#22C55E20'
                    : line.type === 'removed'
                      ? '#EF444420'
                      : 'transparent',
                borderLeft: `3px solid ${
                  line.type === 'added' ? '#22C55E' : line.type === 'removed' ? '#EF4444' : 'transparent'
                }`,
                color: line.type === 'added' ? '#22C55E' : line.type === 'removed' ? '#EF4444' : '#A1A1AA',
              }}
            >
              <span style={{ color: '#52525B', marginRight: 8, userSelect: 'none' }}>
                {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
              </span>
              {line.content || ' '}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
