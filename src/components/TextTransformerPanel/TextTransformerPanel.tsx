import { useState, useCallback } from 'react'

type TransformType =
  | 'upper'
  | 'lower'
  | 'capitalize'
  | 'camelCase'
  | 'snake_case'
  | 'kebab-case'
  | 'reverse'
  | 'trim'
  | 'removeDuplicateLines'
  | 'sortLines'
  | 'reverseLines'
  | 'countChars'
  | 'wordCount'

function transform(text: string, type: TransformType): string {
  switch (type) {
    case 'upper':
      return text.toUpperCase()
    case 'lower':
      return text.toLowerCase()
    case 'capitalize':
      return text.replace(/\b\w/g, (c) => c.toUpperCase())
    case 'camelCase':
      return text
        .replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase())
        .replace(/^[A-Z]/, (c) => c.toLowerCase())
    case 'snake_case':
      return text
        .replace(/([A-Z])/g, '_$1')
        .toLowerCase()
        .replace(/^_/, '')
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .replace(/_+/g, '_')
    case 'kebab-case':
      return text
        .replace(/([A-Z])/g, '-$1')
        .toLowerCase()
        .replace(/^-/, '')
        .replace(/[^a-zA-Z0-9-]/g, '-')
        .replace(/-+/g, '-')
    case 'reverse':
      return text.split('').reverse().join('')
    case 'trim':
      return text
        .split('\n')
        .map((l) => l.trim())
        .join('\n')
    case 'removeDuplicateLines':
      return [...new Set(text.split('\n'))].join('\n')
    case 'sortLines':
      return text.split('\n').sort().join('\n')
    case 'reverseLines':
      return text.split('\n').reverse().join('\n')
    case 'countChars':
      return `字符数: ${text.length}\n字节数: ${new TextEncoder().encode(text).length}\n行数: ${text.split('\n').length}\n单词数: ${text.split(/\s+/).filter(Boolean).length}`
    case 'wordCount': {
      const wordCounts = text
        .split(/\s+/)
        .filter(Boolean)
        .reduce(
          (acc, word) => {
            const lower = word.toLowerCase()
            acc[lower] = (acc[lower] || 0) + 1
            return acc
          },
          {} as Record<string, number>,
        )
      return Object.entries(wordCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([word, count]) => `${word}: ${count}`)
        .join('\n')
    }
    default:
      return text
  }
}

const TRANSFORMS: { value: TransformType; label: string; category: string }[] = [
  { value: 'upper', label: '转大写', category: '大小写' },
  { value: 'lower', label: '转小写', category: '大小写' },
  { value: 'capitalize', label: '首字母大写', category: '大小写' },
  { value: 'camelCase', label: '驼峰命名', category: '命名风格' },
  { value: 'snake_case', label: '蛇形命名', category: '命名风格' },
  { value: 'kebab-case', label: '短横线命名', category: '命名风格' },
  { value: 'reverse', label: '反转字符', category: '文本操作' },
  { value: 'trim', label: '去除空白', category: '文本操作' },
  { value: 'removeDuplicateLines', label: '去重行', category: '行操作' },
  { value: 'sortLines', label: '排序行', category: '行操作' },
  { value: 'reverseLines', label: '反转行', category: '行操作' },
  { value: 'countChars', label: '字符统计', category: '统计' },
  { value: 'wordCount', label: '词频统计', category: '统计' },
]

export default function TextTransformerPanel({ pluginId }: { pluginId: string; onSendToChat?: (msg: string) => void }) {
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [selectedTransform, setSelectedTransform] = useState<TransformType>('upper')
  const [copied, setCopied] = useState(false)

  const handleTransform = useCallback(() => {
    const result = transform(input, selectedTransform)
    setOutput(result)
  }, [input, selectedTransform])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(output)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [output])

  const handleSwap = useCallback(() => {
    setInput(output)
    setOutput('')
  }, [output])

  const handleClear = useCallback(() => {
    setInput('')
    setOutput('')
  }, [])

  const categories = [...new Set(TRANSFORMS.map((t) => t.category))]

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#E8E8EC' }}>文本转换</h3>
        <span style={{ fontSize: 10, color: '#71717A' }}>Plugin: {pluginId}</span>
      </div>

      {/* Transform Selector */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {categories.map((cat) => (
          <div key={cat}>
            <div style={{ fontSize: 10, color: '#71717A', marginBottom: 4 }}>{cat}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {TRANSFORMS.filter((t) => t.category === cat).map((t) => (
                <button
                  key={t.value}
                  onClick={() => setSelectedTransform(t.value)}
                  style={{
                    padding: '4px 8px',
                    borderRadius: 4,
                    border: '1px solid',
                    borderColor: selectedTransform === t.value ? '#3B82F6' : '#3F3F46',
                    background: selectedTransform === t.value ? '#3B82F6' : '#27272A',
                    color: selectedTransform === t.value ? '#fff' : '#A1A1AA',
                    fontSize: 10,
                    cursor: 'pointer',
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, color: '#71717A' }}>输入</span>
          {input && <span style={{ fontSize: 10, color: '#52525B' }}>{input.length} 字符</span>}
        </div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="输入要转换的文本..."
          style={{
            flex: 1,
            minHeight: 80,
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
          onClick={handleTransform}
          disabled={!input}
          style={{
            flex: 1,
            padding: '8px 12px',
            borderRadius: 6,
            border: 'none',
            background: input ? '#3B82F6' : '#3F3F46',
            color: input ? '#fff' : '#71717A',
            fontSize: 12,
            fontWeight: 500,
            cursor: input ? 'pointer' : 'not-allowed',
          }}
        >
          转换
        </button>
        {output && (
          <>
            <button onClick={handleCopy} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #3F3F46', background: copied ? '#22C55E' : '#27272A', color: copied ? '#fff' : '#A1A1AA', fontSize: 12, cursor: 'pointer' }}>
              {copied ? '已复制' : '复制'}
            </button>
            <button onClick={handleSwap} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #3F3F46', background: '#27272A', color: '#A1A1AA', fontSize: 12, cursor: 'pointer' }}>
              互换
            </button>
          </>
        )}
        <button onClick={handleClear} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #3F3F46', background: '#27272A', color: '#A1A1AA', fontSize: 12, cursor: 'pointer' }}>
          清空
        </button>
      </div>

      {/* Output */}
      {output && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, color: '#71717A' }}>输出</span>
            <span style={{ fontSize: 10, color: '#52525B' }}>{output.length} 字符</span>
          </div>
          <pre
            style={{
              flex: 1,
              minHeight: 80,
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
