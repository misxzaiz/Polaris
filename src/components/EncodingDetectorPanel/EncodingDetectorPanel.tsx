import { useState, useCallback } from 'react'

type Encoding = 'utf-8' | 'ascii' | 'latin1' | 'gbk' | 'gb2312' | 'big5' | 'shift_jis'

const ENCODINGS: { value: Encoding; label: string; desc: string }[] = [
  { value: 'utf-8', label: 'UTF-8', desc: '通用编码' },
  { value: 'ascii', label: 'ASCII', desc: '基础英文' },
  { value: 'latin1', label: 'Latin-1', desc: '西欧语言' },
  { value: 'gbk', label: 'GBK', desc: '简体中文' },
  { value: 'gb2312', label: 'GB2312', desc: '简体中文(旧)' },
  { value: 'big5', label: 'Big5', desc: '繁体中文' },
  { value: 'shift_jis', label: 'Shift_JIS', desc: '日文' },
]

function detectEncoding(text: string): { encoding: string; confidence: number; details: string } {
  if (/^[\x00-\x7F]*$/.test(text)) {
    return { encoding: 'ASCII', confidence: 100, details: '仅包含 ASCII 字符' }
  }

  if (/^[\x00-\xFF]*$/.test(text)) {
    return { encoding: 'Latin-1', confidence: 90, details: '包含扩展 ASCII 字符' }
  }

  if (/[\u4e00-\u9fa5]/.test(text)) {
    return { encoding: 'UTF-8 (GBK/GB2312 compatible)', confidence: 95, details: '包含简体中文字符' }
  }

  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) {
    return { encoding: 'UTF-8 (Japanese compatible)', confidence: 90, details: '包含日文字符' }
  }

  return { encoding: 'UTF-8', confidence: 80, details: '默认 UTF-8 编码' }
}

function hexDump(text: string, bytesPerLine: number = 16): string {
  const bytes = new TextEncoder().encode(text)
  const lines: string[] = []

  for (let i = 0; i < bytes.length; i += bytesPerLine) {
    const slice = bytes.slice(i, i + bytesPerLine)
    const hex = Array.from(slice)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
      .padEnd(bytesPerLine * 3)
    const ascii = Array.from(slice)
      .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'))
      .join('')
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`)
  }

  return lines.join('\n')
}

const SAMPLE_TEXTS: { label: string; text: string }[] = [
  { label: '中文', text: '你好，世界！这是一段中文文本。' },
  { label: '英文', text: 'Hello, World! This is English text.' },
  { label: '日文', text: 'こんにちは世界！これは日本語のテキストです。' },
  { label: '混合', text: 'Hello 你好 こんにちは mixed content' },
]

export default function EncodingDetectorPanel({ pluginId }: { pluginId: string; onSendToChat?: (msg: string) => void }) {
  const [input, setInput] = useState('')
  const [detection, setDetection] = useState<{ encoding: string; confidence: number; details: string } | null>(null)
  const [hexView, setHexView] = useState('')
  const [showHex, setShowHex] = useState(false)

  const handleDetect = useCallback(() => {
    if (!input.trim()) return
    const result = detectEncoding(input)
    setDetection(result)
    setHexView(hexDump(input))
  }, [input])

  const handleSample = useCallback((text: string) => {
    setInput(text)
    setDetection(null)
    setHexView('')
  }, [])

  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 90) return '#22C55E'
    if (confidence >= 70) return '#F59E0B'
    return '#EF4444'
  }

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#E8E8EC' }}>编码检测</h3>
        <span style={{ fontSize: 10, color: '#71717A' }}>Plugin: {pluginId}</span>
      </div>

      {/* Sample Texts */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {SAMPLE_TEXTS.map((s) => (
          <button
            key={s.label}
            onClick={() => handleSample(s.text)}
            style={{
              padding: '3px 8px',
              borderRadius: 4,
              border: '1px solid #3F3F46',
              background: '#27272A',
              color: '#A1A1AA',
              fontSize: 10,
              cursor: 'pointer',
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Input */}
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="输入文本进行编码检测..."
        style={{
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

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={handleDetect}
          disabled={!input.trim()}
          style={{
            flex: 1,
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
          检测编码
        </button>
        <button
          onClick={() => setShowHex(!showHex)}
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: showHex ? '#3B82F6' : '#27272A',
            color: showHex ? '#fff' : '#A1A1AA',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          Hex 视图
        </button>
      </div>

      {/* Detection Result */}
      {detection && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 10, borderRadius: 6, background: '#27272A', border: '1px solid #3F3F46' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: '#71717A' }}>检测编码:</span>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#E8E8EC' }}>{detection.encoding}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: '#71717A' }}>置信度:</span>
            <div style={{ width: 100, height: 6, borderRadius: 3, background: '#3F3F46', overflow: 'hidden' }}>
              <div style={{ width: `${detection.confidence}%`, height: '100%', background: getConfidenceColor(detection.confidence) }} />
            </div>
            <span style={{ fontSize: 11, color: getConfidenceColor(detection.confidence) }}>{detection.confidence}%</span>
          </div>
          <div style={{ fontSize: 11, color: '#A1A1AA' }}>{detection.details}</div>
        </div>
      )}

      {/* Hex View */}
      {showHex && hexView && (
        <div style={{ flex: 1, overflow: 'auto' }}>
          <pre
            style={{
              margin: 0,
              padding: 10,
              borderRadius: 6,
              border: '1px solid #3F3F46',
              background: '#18181B',
              color: '#E8E8EC',
              fontFamily: 'Consolas, Monaco, monospace',
              fontSize: 11,
              lineHeight: 1.5,
              whiteSpace: 'pre',
            }}
          >
            {hexView}
          </pre>
        </div>
      )}

      {/* Supported Encodings */}
      <div style={{ padding: '6px 10px', borderRadius: 6, background: '#27272A', fontSize: 10, color: '#71717A' }}>
        支持检测: {ENCODINGS.map((e) => e.label).join(', ')}
      </div>
    </div>
  )
}
