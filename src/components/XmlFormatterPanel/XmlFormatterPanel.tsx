import { useState, useCallback } from 'react'

type FormatMode = 'format' | 'minify' | 'validate' | 'escape'

function formatXml(xml: string, indent: number): string {
  let formatted = ''
  let indentLevel = 0
  const lines = xml.replace(/>\s*</g, '>\n<').split('\n')

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith('</')) {
      indentLevel = Math.max(0, indentLevel - 1)
    }

    formatted += ' '.repeat(indentLevel * indent) + trimmed + '\n'

    if (trimmed.startsWith('<') && !trimmed.startsWith('</') && !trimmed.endsWith('/>') && !trimmed.includes('</')) {
      indentLevel++
    }
  }

  return formatted.trim()
}

function minifyXml(xml: string): string {
  return xml.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim()
}

function validateXml(xml: string): { valid: boolean; error?: string } {
  try {
    const stack: string[] = []
    const tagRegex = /<\/?(\w+)[^>]*>/g
    let match: RegExpExecArray | null

    while ((match = tagRegex.exec(xml)) !== null) {
      const tag = match[0]
      const tagName = match[1]

      if (tag.startsWith('</')) {
        if (stack.length === 0) {
          return { valid: false, error: `多余的结束标签: </${tagName}>` }
        }
        if (stack[stack.length - 1] !== tagName) {
          return { valid: false, error: `标签不匹配: 期望 </${stack[stack.length - 1]}>` }
        }
        stack.pop()
      } else if (!tag.endsWith('/>')) {
        stack.push(tagName)
      }
    }

    if (stack.length > 0) {
      return { valid: false, error: `未闭合的标签: <${stack[stack.length - 1]}>` }
    }

    return { valid: true }
  } catch (e) {
    return { valid: false, error: (e as Error).message }
  }
}

function escapeXml(xml: string): string {
  return xml
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export default function XmlFormatterPanel({ pluginId }: { pluginId: string; onSendToChat?: (msg: string) => void }) {
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [mode, setMode] = useState<FormatMode>('format')
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null)

  const handleProcess = useCallback(() => {
    setResult(null)
    setOutput('')

    if (!input.trim()) {
      setResult({ success: false, message: '请输入 XML 内容' })
      return
    }

    switch (mode) {
      case 'format':
        try {
          setOutput(formatXml(input, 2))
          setResult({ success: true, message: '格式化完成' })
        } catch (e) {
          setResult({ success: false, message: (e as Error).message })
        }
        break
      case 'minify':
        setOutput(minifyXml(input))
        setResult({ success: true, message: '压缩完成' })
        break
      case 'validate':
        const validation = validateXml(input)
        setResult({ success: validation.valid, message: validation.valid ? '✓ 有效的 XML' : validation.error || '验证失败' })
        break
      case 'escape':
        setOutput(escapeXml(input))
        setResult({ success: true, message: '转义完成' })
        break
    }
  }, [input, mode])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(output)
  }, [output])

  const modes: { value: FormatMode; label: string }[] = [
    { value: 'format', label: '格式化' },
    { value: 'minify', label: '压缩' },
    { value: 'validate', label: '验证' },
    { value: 'escape', label: '转义' },
  ]

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#E8E8EC' }}>XML 工具</h3>
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
          <span style={{ fontSize: 11, color: '#71717A' }}>XML 输入</span>
          {input && <span style={{ fontSize: 10, color: '#52525B' }}>{input.split('\n').length} 行</span>}
        </div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="输入 XML 内容..."
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
