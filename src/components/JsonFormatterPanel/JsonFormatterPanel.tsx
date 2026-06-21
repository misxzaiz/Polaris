import { useState, useCallback } from 'react'

type FormatMode = 'format' | 'minify' | 'validate' | 'escape' | 'unescape'

interface FormatResult {
  success: boolean
  output: string
  error?: string
  stats?: {
    lines: number
    size: number
    keys?: number
  }
}

function formatJSON(input: string, mode: FormatMode, indent: number): FormatResult {
  try {
    const trimmed = input.trim()
    if (!trimmed) {
      return { success: false, output: '', error: '输入为空' }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (e) {
      const match = (e as Error).message.match(/position (\d+)/)
      const pos = match ? parseInt(match[1]) : -1
      return {
        success: false,
        output: '',
        error: `JSON 解析错误: ${(e as Error).message}${pos >= 0 ? ` (位置: ${pos})` : ''}`,
      }
    }

    const countKeys = (obj: unknown): number => {
      if (typeof obj !== 'object' || obj === null) return 0
      if (Array.isArray(obj)) return obj.reduce((sum, item) => sum + countKeys(item), 0)
      return Object.keys(obj as Record<string, unknown>).reduce(
        (sum, key) => sum + 1 + countKeys((obj as Record<string, unknown>)[key]),
        0,
      )
    }

    const keys = countKeys(parsed)

    switch (mode) {
      case 'format': {
        const output = JSON.stringify(parsed, null, indent)
        return {
          success: true,
          output,
          stats: {
            lines: output.split('\n').length,
            size: new TextEncoder().encode(output).length,
            keys,
          },
        }
      }
      case 'minify': {
        const output = JSON.stringify(parsed)
        return {
          success: true,
          output,
          stats: {
            lines: 1,
            size: new TextEncoder().encode(output).length,
            keys,
          },
        }
      }
      case 'validate':
        return {
          success: true,
          output: '✓ 有效的 JSON',
          stats: {
            lines: 1,
            size: new TextEncoder().encode(JSON.stringify(parsed)).length,
            keys,
          },
        }
      case 'escape': {
        const output = JSON.stringify(JSON.stringify(parsed))
        return {
          success: true,
          output,
          stats: {
            lines: 1,
            size: new TextEncoder().encode(output).length,
          },
        }
      }
      case 'unescape': {
        const unescaped = JSON.parse(trimmed)
        if (typeof unescaped !== 'string') {
          return { success: false, output: '', error: '输入不是字符串' }
        }
        const output = JSON.stringify(JSON.parse(unescaped), null, indent)
        return {
          success: true,
          output,
          stats: {
            lines: output.split('\n').length,
            size: new TextEncoder().encode(output).length,
          },
        }
      }
      default:
        return { success: false, output: '', error: '未知模式' }
    }
  } catch (e) {
    return { success: false, output: '', error: (e as Error).message }
  }
}

function countLines(str: string): number {
  return str.split('\n').length
}

export default function JsonFormatterPanel({ pluginId }: { pluginId: string; onSendToChat?: (msg: string) => void }) {
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [mode, setMode] = useState<FormatMode>('format')
  const [indent, setIndent] = useState(2)
  const [result, setResult] = useState<FormatResult | null>(null)
  const [history, setHistory] = useState<string[]>([])

  const handleFormat = useCallback(() => {
    const res = formatJSON(input, mode, indent)
    setResult(res)
    if (res.success && mode !== 'validate') {
      setOutput(res.output)
      setHistory((prev) => {
        const newHistory = [input.slice(0, 50), ...prev.filter((h) => h !== input.slice(0, 50))]
        return newHistory.slice(0, 10)
      })
    }
  }, [input, mode, indent])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(output)
  }, [output])

  const handleClear = useCallback(() => {
    setInput('')
    setOutput('')
    setResult(null)
  }, [])

  const handleSwap = useCallback(() => {
    setInput(output)
    setOutput('')
    setResult(null)
  }, [output])

  const modes: { value: FormatMode; label: string; desc: string }[] = [
    { value: 'format', label: '格式化', desc: '美化 JSON' },
    { value: 'minify', label: '压缩', desc: '压缩为一行' },
    { value: 'validate', label: '校验', desc: '验证格式' },
    { value: 'escape', label: '转义', desc: 'JSON 转义字符串' },
    { value: 'unescape', label: '反转义', desc: '还原转义字符串' },
  ]

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#E8E8EC' }}>JSON 工具</h3>
        <span style={{ fontSize: 10, color: '#71717A' }}>Plugin: {pluginId}</span>
      </div>

      {/* Mode Selector */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {modes.map((m) => (
          <button
            key={m.value}
            onClick={() => setMode(m.value)}
            title={m.desc}
            style={{
              padding: '4px 8px',
              borderRadius: 4,
              border: '1px solid',
              borderColor: mode === m.value ? '#3B82F6' : '#3F3F46',
              background: mode === m.value ? '#3B82F6' : '#27272A',
              color: mode === m.value ? '#fff' : '#A1A1AA',
              fontSize: 11,
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Indent Selector */}
      {mode === 'format' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: '#71717A' }}>缩进:</span>
          {[2, 4].map((n) => (
            <button
              key={n}
              onClick={() => setIndent(n)}
              style={{
                padding: '2px 8px',
                borderRadius: 4,
                border: '1px solid',
                borderColor: indent === n ? '#3B82F6' : '#3F3F46',
                background: indent === n ? '#3B82F6' : '#27272A',
                color: indent === n ? '#fff' : '#A1A1AA',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              {n} 空格
            </button>
          ))}
        </div>
      )}

      {/* Action Buttons */}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={handleFormat}
          disabled={!input.trim()}
          style={{
            flex: 1,
            padding: '6px 12px',
            borderRadius: 6,
            border: 'none',
            background: input.trim() ? '#3B82F6' : '#3F3F46',
            color: input.trim() ? '#fff' : '#71717A',
            fontSize: 12,
            fontWeight: 500,
            cursor: input.trim() ? 'pointer' : 'not-allowed',
          }}
        >
          执行
        </button>
        <button onClick={handleClear} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #3F3F46', background: '#27272A', color: '#A1A1AA', fontSize: 12, cursor: 'pointer' }}>
          清空
        </button>
        {output && (
          <>
            <button onClick={handleCopy} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #3F3F46', background: '#27272A', color: '#A1A1AA', fontSize: 12, cursor: 'pointer' }}>
              复制
            </button>
            <button onClick={handleSwap} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #3F3F46', background: '#27272A', color: '#A1A1AA', fontSize: 12, cursor: 'pointer' }}>
              互换
            </button>
          </>
        )}
      </div>

      {/* Input */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, color: '#71717A' }}>输入</span>
          {input && <span style={{ fontSize: 10, color: '#52525B' }}>{countLines(input)} 行</span>}
        </div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='粘贴 JSON...\n\n支持:\n• 格式化美化\n• 压缩为一行\n• 校验格式\n• 转义/反转义'
          style={{
            flex: 1,
            minHeight: 120,
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

      {/* Result Status */}
      {result && (
        <div
          style={{
            padding: '6px 10px',
            borderRadius: 6,
            background: result.success ? '#1A2E1A' : '#2E1A1A',
            border: `1px solid ${result.success ? '#22C55E' : '#EF4444'}`,
            fontSize: 11,
            color: result.success ? '#22C55E' : '#EF4444',
          }}
        >
          {result.error || result.output}
          {result.stats && (
            <span style={{ marginLeft: 8, color: '#71717A' }}>
              {result.stats.keys !== undefined && `${result.stats.keys} 键 · `}
              {result.stats.lines} 行 · {(result.stats.size / 1024).toFixed(1)} KB
            </span>
          )}
        </div>
      )}

      {/* Output */}
      {output && mode !== 'validate' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, color: '#71717A' }}>输出</span>
            <span style={{ fontSize: 10, color: '#52525B' }}>{countLines(output)} 行</span>
          </div>
          <pre
            style={{
              flex: 1,
              minHeight: 100,
              margin: 0,
              padding: 10,
              borderRadius: 6,
              border: '1px solid #3F3F46',
              background: '#18181B',
              color: '#E8E8EC',
              fontFamily: 'Consolas, Monaco, "Courier New", monospace',
              fontSize: 12,
              lineHeight: 1.5,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {output}
          </pre>
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <div style={{ borderTop: '1px solid #27272A', paddingTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 10, color: '#52525B' }}>最近输入</span>
            <button onClick={() => setHistory([])} style={{ border: 'none', background: 'none', color: '#52525B', fontSize: 10, cursor: 'pointer' }}>
              清除
            </button>
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {history.map((h, i) => (
              <button
                key={i}
                onClick={() => setInput(h)}
                style={{
                  padding: '2px 6px',
                  borderRadius: 4,
                  border: '1px solid #27272A',
                  background: '#18181B',
                  color: '#71717A',
                  fontSize: 10,
                  cursor: 'pointer',
                  maxWidth: 120,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {h}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
