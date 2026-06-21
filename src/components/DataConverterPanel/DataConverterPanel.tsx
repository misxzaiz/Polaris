import { useState, useCallback } from 'react'

type ConvertFormat = 'json-to-csv' | 'csv-to-json' | 'json-to-yaml' | 'yaml-to-json' | 'json-to-xml' | 'xml-to-json'

function jsonToCsv(jsonStr: string): string {
  const data = JSON.parse(jsonStr)
  const arr = Array.isArray(data) ? data : [data]
  if (arr.length === 0) return ''
  const headers = Object.keys(arr[0])
  const rows = arr.map((item) => headers.map((h) => JSON.stringify(item[h] ?? '')).join(','))
  return [headers.join(','), ...rows].join('\n')
}

function csvToJson(csvStr: string): string {
  const lines = csvStr.trim().split('\n')
  const headers = lines[0].split(',').map((h) => h.trim())
  const data = lines.slice(1).map((line) => {
    const values = line.split(',')
    return headers.reduce((obj, h, i) => {
      let val: unknown = values[i]?.trim() ?? ''
      try { val = JSON.parse(val as string) } catch { /* keep as string */ }
      return { ...obj, [h]: val }
    }, {})
  })
  return JSON.stringify(data, null, 2)
}

function jsonToYaml(jsonStr: string): string {
  const data = JSON.parse(jsonStr)
  const yamlify = (obj: unknown, indent = 0): string => {
    const prefix = '  '.repeat(indent)
    if (obj === null) return 'null'
    if (typeof obj !== 'object') return String(obj)
    if (Array.isArray(obj)) return obj.map((item) => `${prefix}- ${yamlify(item, indent + 1).trim()}`).join('\n')
    return Object.entries(obj)
      .map(([k, v]) => {
        const val = typeof v === 'object' && v !== null ? `\n${yamlify(v, indent + 1)}` : ` ${yamlify(v)}`
        return `${prefix}${k}:${val}`
      })
      .join('\n')
  }
  return yamlify(data)
}

function yamlToJson(yamlStr: string): string {
  const result: Record<string, unknown> = {}
  yamlStr.split('\n').forEach((line) => {
    const match = line.trim().match(/^(\w[\w\s]*):\s*(.*)$/)
    if (match) {
      let val: unknown = match[2].trim()
      if (val === 'true') val = true
      else if (val === 'false') val = false
      else if (val === 'null') val = null
      else if (/^-?\d+$/.test(val as string)) val = parseInt(val as string)
      result[match[1].trim()] = val
    }
  })
  return JSON.stringify(result, null, 2)
}

function jsonToXml(jsonStr: string): string {
  const data = JSON.parse(jsonStr)
  const toXml = (obj: unknown, tag = 'root'): string => {
    if (obj === null) return `<${tag}/>`
    if (typeof obj !== 'object') return `<${tag}>${obj}</${tag}>`
    if (Array.isArray(obj)) return obj.map((item) => toXml(item, tag)).join('\n')
    return `<${tag}>${Object.entries(obj).map(([k, v]) => toXml(v, k)).join('\n')}</${tag}>`
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${toXml(data)}`
}

function xmlToJson(xmlStr: string): string {
  const result: Record<string, unknown> = {}
  const tagRegex = /<(\w+)(?:\s[^>]*)?>([^<]*)<\/\1>/g
  let match: RegExpExecArray | null
  while ((match = tagRegex.exec(xmlStr)) !== null) {
    let val: unknown = match[2].trim()
    if (val === 'true') val = true
    else if (val === 'false') val = false
    else if (val === 'null') val = null
    else if (/^-?\d+$/.test(val as string)) val = parseInt(val as string)
    result[match[1]] = val
  }
  return JSON.stringify(result, null, 2)
}

const CONVERSIONS: { value: ConvertFormat; label: string; from: string; to: string }[] = [
  { value: 'json-to-csv', label: 'JSON → CSV', from: 'JSON', to: 'CSV' },
  { value: 'csv-to-json', label: 'CSV → JSON', from: 'CSV', to: 'JSON' },
  { value: 'json-to-yaml', label: 'JSON → YAML', from: 'JSON', to: 'YAML' },
  { value: 'yaml-to-json', label: 'YAML → JSON', from: 'YAML', to: 'JSON' },
  { value: 'json-to-xml', label: 'JSON → XML', from: 'JSON', to: 'XML' },
  { value: 'xml-to-json', label: 'XML → JSON', from: 'XML', to: 'JSON' },
]

export default function DataConverterPanel({ pluginId }: { pluginId: string; onSendToChat?: (msg: string) => void }) {
  const [format, setFormat] = useState<ConvertFormat>('json-to-csv')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const handleConvert = useCallback(() => {
    setError(null)
    setOutput('')
    if (!input.trim()) {
      setError('请输入数据')
      return
    }
    try {
      let result = ''
      switch (format) {
        case 'json-to-csv': result = jsonToCsv(input); break
        case 'csv-to-json': result = csvToJson(input); break
        case 'json-to-yaml': result = jsonToYaml(input); break
        case 'yaml-to-json': result = yamlToJson(input); break
        case 'json-to-xml': result = jsonToXml(input); break
        case 'xml-to-json': result = xmlToJson(input); break
      }
      setOutput(result)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [input, format])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(output)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [output])

  const currentConversion = CONVERSIONS.find((c) => c.value === format)!

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#E8E8EC' }}>数据转换</h3>
        <span style={{ fontSize: 10, color: '#71717A' }}>Plugin: {pluginId}</span>
      </div>

      {/* Format Selector */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {CONVERSIONS.map((c) => (
          <button
            key={c.value}
            onClick={() => setFormat(c.value)}
            style={{
              padding: '4px 10px',
              borderRadius: 4,
              border: '1px solid',
              borderColor: format === c.value ? '#3B82F6' : '#3F3F46',
              background: format === c.value ? '#3B82F6' : '#27272A',
              color: format === c.value ? '#fff' : '#A1A1AA',
              fontSize: 10,
              cursor: 'pointer',
            }}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* Input */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, color: '#71717A' }}>{currentConversion.from} 输入</span>
        </div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`输入 ${currentConversion.from} 数据...`}
          style={{
            flex: 1,
            minHeight: 80,
            padding: 10,
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: '#18181B',
            color: '#E8E8EC',
            fontFamily: 'Consolas, Monaco, monospace',
            fontSize: 12,
            lineHeight: 1.5,
            resize: 'none',
            outline: 'none',
          }}
        />
      </div>

      {/* Action */}
      <button
        onClick={handleConvert}
        disabled={!input.trim()}
        style={{
          padding: '8px 12px',
          borderRadius: 6,
          border: 'none',
          background: input.trim() ? '#3B82F6' : '#3F3F46',
          color: input.trim() ? '#fff' : '#71717A',
          fontSize: 12,
          fontWeight: 500,
          cursor: input.trim() ? 'pointer' : 'not-allowed',
        }}
      >
        转换
      </button>

      {error && (
        <div style={{ padding: '6px 10px', borderRadius: 6, background: '#2E1A1A', border: '1px solid #EF4444', fontSize: 11, color: '#EF4444' }}>
          {error}
        </div>
      )}

      {/* Output */}
      {output && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, color: '#71717A' }}>{currentConversion.to} 输出</span>
            <button
              onClick={handleCopy}
              style={{
                padding: '2px 8px',
                borderRadius: 4,
                border: '1px solid #3F3F46',
                background: copied ? '#22C55E' : '#27272A',
                color: copied ? '#fff' : '#A1A1AA',
                fontSize: 10,
                cursor: 'pointer',
              }}
            >
              {copied ? '已复制' : '复制'}
            </button>
          </div>
          <pre
            style={{
              flex: 1,
              margin: 0,
              padding: 10,
              borderRadius: 6,
              border: '1px solid #3F3F46',
              background: '#18181B',
              color: '#E8E8EC',
              fontFamily: 'Consolas, Monaco, monospace',
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
