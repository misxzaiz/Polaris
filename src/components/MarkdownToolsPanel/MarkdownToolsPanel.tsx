import { useState, useCallback } from 'react'

type ToolMode = 'preview' | 'cheatsheet' | 'convert'

const CHEATSHEET = `# Markdown 速查表

## 标题
# H1
## H2
### H3
#### H4

## 文本
**粗体** *斜体* ~~删除线~~

## 列表
- 无序列表
1. 有序列表
- [ ] 待办事项

## 链接和图片
[链接文字](URL)
![图片描述](图片URL)

## 代码
\`行内代码\`
\`\`\`javascript
// 代码块
function hello() {
  return 'world'
}
\`\`\`

## 引用
> 引用文本

## 表格
| 列1 | 列2 |
|-----|-----|
| A   | B   |

## 分割线
---

## 转义
\\*转义特殊字符\\*`

function simpleMarkdownToHtml(md: string): string {
  let html = md
    .replace(/^### (.*$)/gm, '<h3>$1</h3>')
    .replace(/^## (.*$)/gm, '<h2>$1</h2>')
    .replace(/^# (.*$)/gm, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/~~(.*?)~~/g, '<del>$1</del>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>')
    .replace(/^> (.*$)/gm, '<blockquote>$1</blockquote>')
    .replace(/^- (.*$)/gm, '<li>$1</li>')
    .replace(/^---$/gm, '<hr>')
    .replace(/\n\n/g, '</p><p>')
  return `<p>${html}</p>`
}

export default function MarkdownToolsPanel({ pluginId }: { pluginId: string; onSendToChat?: (msg: string) => void }) {
  const [mode, setMode] = useState<ToolMode>('preview')
  const [input, setInput] = useState('')
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback((text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [])

  const handleInsertSnippet = useCallback((snippet: string) => {
    setInput((prev) => prev + '\n' + snippet)
    setMode('preview')
  }, [])

  const modes: { value: ToolMode; label: string }[] = [
    { value: 'preview', label: '预览' },
    { value: 'cheatsheet', label: '速查表' },
  ]

  const snippets = [
    { label: '标题', value: '## ' },
    { label: '粗体', value: '**文本**' },
    { label: '斜体', value: '*文本*' },
    { label: '链接', value: '[文本](URL)' },
    { label: '图片', value: '![描述](URL)' },
    { label: '代码', value: '`代码`' },
    { label: '列表', value: '- 列表项' },
    { label: '引用', value: '> 引用' },
    { label: '表格', value: '| 列1 | 列2 |\n|-----|-----|\n| A   | B   |' },
  ]

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#E8E8EC' }}>Markdown 工具</h3>
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

      {/* Quick Insert */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {snippets.map((s) => (
          <button
            key={s.label}
            onClick={() => handleInsertSnippet(s.value)}
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

      {/* Content */}
      {mode === 'preview' ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, color: '#71717A' }}>Markdown 源码</span>
            {input && (
              <button
                onClick={() => handleCopy(input)}
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
            )}
          </div>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入 Markdown 内容..."
            style={{
              flex: 1,
              minHeight: 150,
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
          {input && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, color: '#71717A' }}>预览</span>
              <div
                style={{
                  padding: 10,
                  borderRadius: 6,
                  border: '1px solid #3F3F46',
                  background: '#18181B',
                  fontSize: 12,
                  lineHeight: 1.6,
                  color: '#E8E8EC',
                  maxHeight: 200,
                  overflow: 'auto',
                }}
                dangerouslySetInnerHTML={{ __html: simpleMarkdownToHtml(input) }}
              />
            </div>
          )}
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            padding: 12,
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: '#18181B',
            color: '#E8E8EC',
            fontFamily: 'Consolas, Monaco, "Courier New", monospace',
            fontSize: 11,
            lineHeight: 1.5,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
          }}
        >
          {CHEATSHEET}
        </div>
      )}
    </div>
  )
}
