import { useState, useCallback } from 'react'

type FormatMode = 'format' | 'validate' | 'toJson' | 'fromJson'

function formatYaml(input: string, indent: number): string {
  const lines = input.split('\n')
  const result: string[] = []
  let indentLevel = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      result.push(line)
      continue
    }

    if (trimmed.endsWith(':')) {
      result.push(' '.repeat(indentLevel * indent) + trimmed)
      indentLevel++
    } else if (trimmed.startsWith('- ')) {
      result.push(' '.repeat((indentLevel - 1) * indent) + trimmed)
    } else if (trimmed.includes(': ')) {
      result.push(' '.repeat(indentLevel * indent) + trimmed)
    } else {
      result.push(' '.repeat(indentLevel * indent) + trimmed)
    }
  }

  return result.join('\n')
}

function validateYaml(input: string): { valid: boolean; error?: string } {
  try {
    const lines = input.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.includes('\t')) {
        return { valid: false, error: `第 ${i + 1} 行: YAML 不允许使用 Tab 缩进` }
      }
    }
    return { valid: true }
  } catch (e) {
    return { valid: false, error: (e as Error).message }
  }
}

function yamlToJson(input: string): string {
  const lines = input.split('\n')
  const result: Record<string, unknown> = {}
  let currentKey = ''

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const match = trimmed.match(/^(\w[\w\s]*):\s*(.*)$/)
    if (match) {
      const [, key, value] = match
      currentKey = key.trim()
      if (value) {
        result[currentKey] = parseYamlValue(value)
      } else {
        result[currentKey] = {}
      }
    }
  }

  return JSON.stringify(result, null, 2)
}

function parseYamlValue(value: string): unknown {
  const trimmed = value.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null' || trimmed === '~') return null
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed)
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed)
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export default function YamlValidatorPanel({ pluginId }: { pluginId: string; onSendToChat?: (msg: string) => void }) {
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [mode, setMode] = useState<FormatMode>('format')
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null)

  const handleProcess = useCallback(() => {
    setResult(null)
    setOutput('')

    if (!input.trim()) {
      setResult({ success: false, message: '请输入 YAML 内容' })
      return
    }

    switch (mode) {
      case 'format':
        try {
          const formatted = formatYaml(input, 2)
          setOutput(formatted)
          setResult({ success: true, message: '格式化完成' })
        } catch (e) {
          setResult({ success: false, message: (e as Error).message })
        }
        break
      case 'validate':
        const validation = validateYaml(input)
        setResult({ success: validation.valid, message: validation.valid ? '✓ 有效的 YAML' : validation.error || '验证失败' })
        break
      case 'toJson':
        try {
          const json = yamlToJson(input)
          setOutput(json)
          setResult({ success: true, message: '转换为 JSON 完成' })
        } catch (e) {
          setResult({ success: false, message: (e as Error).message })
        }
        break
      case 'fromJson':
        try {
          const obj = JSON.parse(input)
          const yaml = Object.entries(obj)
            .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
            .join('\n')
          setOutput(yaml)
          setResult({ success: true, message: '转换为 YAML 完成' })
        } catch (e) {
          setResult({ success: false, message: '无效的 JSON: ' + (e as Error).message })
        }
        break
    }
  }, [input, mode])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(output)
  }, [output])

  const modes: { value: FormatMode; label: string }[] = [
    { value: 'format', label: '格式化' },
    { value: 'validate', label: '验证' },
    { value: 'toJson', label: '→ JSON' },
    { value: 'fromJson', label: '← JSON' },
  ]

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#E8E8EC' }}>YAML 工具</h3>
        <span style={{ fontSize: 10, color: '#71717A' }}>Plugin: {pluginId}</span>
      </div>

      {/* Mode Selector */}
      <div style={{ display: 'flex', gap: 4 }}>
        {modes.map((m) => (
          <button
            key={m.value}
            onClick={() => setMode(m.value)}
            style={{
              flex: 1,
              padding: '5px 8px',
              borderRadius: 4,
              border: '1px solid',
              borderColor: mode === m.value ? '#3B82F6' : '#3F3F46',
              background: mode === m.value ? '#3B82F6' : '#27272A',
              color: mode === m.value ? '#fff' : '#A1A1AA',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Input */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, color: '#71717A' }}>
            {mode === 'fromJson' ? 'JSON 输入' : 'YAML 输入'}
          </span>
          {input && <span style={{ fontSize: 10, color: '#52525B' }}>{input.split('\n').length} 行</span>}
        </div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={mode === 'fromJson' ? '输入 JSON...' : '输入 YAML...'}
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

      {/* Action Buttons */}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={handleProcess}
          disabled={!input.trim()}
          style={{
            flex: 1,
            padding: '7px 12px',
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
        {output && (
          <button onClick={handleCopy} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #3F3F46', background: '#27272A', color: '#A1A1AA', fontSize: 12, cursor: 'pointer' }}>
            复制
          </button>
        )}
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
          {result.message}
        </div>
      )}

      {/* Output */}
      {output && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, color: '#71717A' }}>输出</span>
            <span style={{ fontSize: 10, color: '#52525B' }}>{output.split('\n').length} 行</span>
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
    </div>
  )
}
