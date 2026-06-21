import { useState, useCallback, useMemo } from 'react'

interface Snippet {
  id: string
  name: string
  language: string
  code: string
  tags: string[]
  createdAt: number
}

const STORAGE_KEY = 'polaris-code-snippets'

const DEFAULT_SNIPPETS: Snippet[] = [
  {
    id: '1',
    name: 'React 组件模板',
    language: 'tsx',
    code: `import { useState } from 'react'\n\ninterface Props {\n  title: string\n}\n\nexport function MyComponent({ title }: Props) {\n  return (\n    <div>\n      <h1>{title}</h1>\n    </div>\n  )\n}`,
    tags: ['react', 'template'],
    createdAt: Date.now(),
  },
  {
    id: '2',
    name: 'API 请求模板',
    language: 'typescript',
    code: `async function fetchData<T>(url: string): Promise<T> {\n  const response = await fetch(url)\n  if (!response.ok) throw new Error('Network error')\n  return response.json()\n}`,
    tags: ['api', 'fetch'],
    createdAt: Date.now(),
  },
]

function loadSnippets(): Snippet[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY)
    return data ? JSON.parse(data) : DEFAULT_SNIPPETS
  } catch {
    return DEFAULT_SNIPPETS
  }
}

function saveSnippets(snippets: Snippet[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snippets))
}

const LANGUAGES = ['typescript', 'javascript', 'tsx', 'jsx', 'html', 'css', 'json', 'python', 'rust', 'go', 'sql', 'shell']

export default function CodeSnippetPanel({ pluginId }: { pluginId: string; onSendToChat?: (msg: string) => void }) {
  const [snippets, setSnippets] = useState<Snippet[]>(loadSnippets)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editLanguage, setEditLanguage] = useState('typescript')
  const [editCode, setEditCode] = useState('')
  const [editTags, setEditTags] = useState('')
  const [search, setSearch] = useState('')
  const [copied, setCopied] = useState(false)

  const selected = useMemo(() => snippets.find((s) => s.id === selectedId), [snippets, selectedId])

  const filtered = useMemo(() => {
    if (!search) return snippets
    const lower = search.toLowerCase()
    return snippets.filter(
      (s) =>
        s.name.toLowerCase().includes(lower) ||
        s.language.toLowerCase().includes(lower) ||
        s.tags.some((t) => t.toLowerCase().includes(lower)),
    )
  }, [snippets, search])

  const handleNew = useCallback(() => {
    setSelectedId(null)
    setIsEditing(true)
    setEditName('')
    setEditLanguage('typescript')
    setEditCode('')
    setEditTags('')
  }, [])

  const handleEdit = useCallback((snippet?: Snippet) => {
    if (snippet) {
      setSelectedId(snippet.id)
      setEditName(snippet.name)
      setEditLanguage(snippet.language)
      setEditCode(snippet.code)
      setEditTags(snippet.tags.join(', '))
    }
    setIsEditing(true)
  }, [])

  const handleSave = useCallback(() => {
    if (!editName.trim() || !editCode.trim()) return

    if (selectedId) {
      setSnippets((prev) => {
        const updated = prev.map((s) =>
          s.id === selectedId
            ? { ...s, name: editName, language: editLanguage, code: editCode, tags: editTags.split(',').map((t) => t.trim()).filter(Boolean) }
            : s,
        )
        saveSnippets(updated)
        return updated
      })
    } else {
      const newSnippet: Snippet = {
        id: Date.now().toString(),
        name: editName,
        language: editLanguage,
        code: editCode,
        tags: editTags.split(',').map((t) => t.trim()).filter(Boolean),
        createdAt: Date.now(),
      }
      setSnippets((prev) => {
        const updated = [newSnippet, ...prev]
        saveSnippets(updated)
        return updated
      })
      setSelectedId(newSnippet.id)
    }
    setIsEditing(false)
  }, [selectedId, editName, editLanguage, editCode, editTags])

  const handleDelete = useCallback(
    (id: string) => {
      setSnippets((prev) => {
        const updated = prev.filter((s) => s.id !== id)
        saveSnippets(updated)
        return updated
      })
      if (selectedId === id) setSelectedId(null)
    },
    [selectedId],
  )

  const handleCopy = useCallback(() => {
    if (selected) {
      navigator.clipboard.writeText(selected.code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }, [selected])

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#E8E8EC' }}>代码片段</h3>
        <span style={{ fontSize: 10, color: '#71717A' }}>Plugin: {pluginId}</span>
      </div>

      {/* Search & New */}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索..."
          style={{
            flex: 1,
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: '#18181B',
            color: '#E8E8EC',
            fontSize: 12,
            outline: 'none',
          }}
        />
        <button
          onClick={handleNew}
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            border: 'none',
            background: '#3B82F6',
            color: '#fff',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          新建
        </button>
      </div>

      {/* Editor */}
      {isEditing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderRadius: 6, background: '#27272A', border: '1px solid #3F3F46' }}>
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            placeholder="片段名称"
            style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #3F3F46', background: '#18181B', color: '#E8E8EC', fontSize: 12, outline: 'none' }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <select
              value={editLanguage}
              onChange={(e) => setEditLanguage(e.target.value)}
              style={{ flex: 1, padding: '6px 10px', borderRadius: 4, border: '1px solid #3F3F46', background: '#18181B', color: '#E8E8EC', fontSize: 12, outline: 'none' }}
            >
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
            <input
              type="text"
              value={editTags}
              onChange={(e) => setEditTags(e.target.value)}
              placeholder="标签 (逗号分隔)"
              style={{ flex: 2, padding: '6px 10px', borderRadius: 4, border: '1px solid #3F3F46', background: '#18181B', color: '#E8E8EC', fontSize: 12, outline: 'none' }}
            />
          </div>
          <textarea
            value={editCode}
            onChange={(e) => setEditCode(e.target.value)}
            placeholder="粘贴代码..."
            style={{ minHeight: 120, padding: 10, borderRadius: 4, border: '1px solid #3F3F46', background: '#18181B', color: '#E8E8EC', fontFamily: 'Consolas, Monaco, "Courier New", monospace', fontSize: 11, lineHeight: 1.5, resize: 'vertical', outline: 'none' }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={handleSave} style={{ flex: 1, padding: '6px 12px', borderRadius: 4, border: 'none', background: '#22C55E', color: '#fff', fontSize: 12, cursor: 'pointer' }}>
              保存
            </button>
            <button onClick={() => setIsEditing(false)} style={{ padding: '6px 12px', borderRadius: 4, border: '1px solid #3F3F46', background: '#27272A', color: '#A1A1AA', fontSize: 12, cursor: 'pointer' }}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* Snippet List */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, overflow: 'auto' }}>
        {filtered.map((snippet) => (
          <div
            key={snippet.id}
            onClick={() => setSelectedId(snippet.id)}
            style={{
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid',
              borderColor: selectedId === snippet.id ? '#3B82F6' : '#3F3F46',
              background: selectedId === snippet.id ? '#3B82F620' : '#18181B',
              cursor: 'pointer',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, fontWeight: 500, color: '#E8E8EC' }}>{snippet.name}</span>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  onClick={(e) => { e.stopPropagation(); handleEdit(snippet) }}
                  style={{ padding: '2px 6px', borderRadius: 3, border: '1px solid #3F3F46', background: '#27272A', color: '#A1A1AA', fontSize: 9, cursor: 'pointer' }}
                >
                  编辑
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(snippet.id) }}
                  style={{ padding: '2px 6px', borderRadius: 3, border: '1px solid #EF4444', background: '#EF444420', color: '#EF4444', fontSize: 9, cursor: 'pointer' }}
                >
                  删除
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
              <span style={{ padding: '1px 6px', borderRadius: 3, background: '#27272A', color: '#3B82F6', fontSize: 9 }}>{snippet.language}</span>
              {snippet.tags.slice(0, 3).map((tag) => (
                <span key={tag} style={{ padding: '1px 6px', borderRadius: 3, background: '#27272A', color: '#71717A', fontSize: 9 }}>{tag}</span>
              ))}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: 20, color: '#52525B', fontSize: 12 }}>
            {search ? '没有匹配的片段' : '暂无代码片段'}
          </div>
        )}
      </div>

      {/* Selected Snippet Preview */}
      {selected && !isEditing && (
        <div style={{ borderTop: '1px solid #27272A', paddingTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: '#71717A' }}>{selected.name}</span>
            <button
              onClick={handleCopy}
              style={{
                padding: '4px 8px',
                borderRadius: 4,
                border: '1px solid #3F3F46',
                background: copied ? '#22C55E' : '#27272A',
                color: copied ? '#fff' : '#A1A1AA',
                fontSize: 10,
                cursor: 'pointer',
              }}
            >
              {copied ? '已复制' : '复制代码'}
            </button>
          </div>
          <pre
            style={{
              margin: 0,
              padding: 10,
              borderRadius: 6,
              border: '1px solid #3F3F46',
              background: '#18181B',
              color: '#E8E8EC',
              fontFamily: 'Consolas, Monaco, "Courier New", monospace',
              fontSize: 11,
              lineHeight: 1.5,
              overflow: 'auto',
              maxHeight: 150,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {selected.code}
          </pre>
        </div>
      )}
    </div>
  )
}
