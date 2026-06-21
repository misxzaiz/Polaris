import { useState, useCallback } from 'react'

interface TreeNode {
  key: string
  value: unknown
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'
  expanded?: boolean
  children?: TreeNode[]
}

function buildTree(data: unknown, key: string = 'root'): TreeNode {
  if (data === null) return { key, value: null, type: 'null' }
  if (Array.isArray(data)) {
    return {
      key,
      value: data,
      type: 'array',
      expanded: true,
      children: data.map((item, i) => buildTree(item, `[${i}]`)),
    }
  }
  if (typeof data === 'object') {
    return {
      key,
      value: data,
      type: 'object',
      expanded: true,
      children: Object.entries(data).map(([k, v]) => buildTree(v, k)),
    }
  }
  return { key, value: data, type: typeof data as 'string' | 'number' | 'boolean' }
}

const MOCK_JSON = `{
  "name": "Polaris",
  "version": "10.0.2",
  "description": "AI-powered development environment",
  "features": ["Code Editor", "Terminal", "AI Chat", "Git Integration"],
  "config": {
    "theme": "dark",
    "language": "zh-CN",
    "plugins": {
      "enabled": true,
      "count": 30
    }
  },
  "authors": [
    {"name": "Alice", "role": "Developer"},
    {"name": "Bob", "role": "Designer"}
  ]
}`

function TreeNodeComponent({ node, depth = 0 }: { node: TreeNode; depth?: number }) {
  const [expanded, setExpanded] = useState(node.expanded)

  const toggle = () => setExpanded(!expanded)

  const getValueColor = () => {
    switch (node.type) {
      case 'string': return '#22C55E'
      case 'number': return '#3B82F6'
      case 'boolean': return '#F59E0B'
      case 'null': return '#71717A'
      default: return '#E8E8EC'
    }
  }

  const formatValue = (val: unknown): string => {
    if (val === null) return 'null'
    if (typeof val === 'string') return `"${val}"`
    return String(val)
  }

  const hasChildren = node.type === 'object' || node.type === 'array'

  return (
    <div style={{ fontFamily: 'Consolas, Monaco, monospace', fontSize: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 0',
          paddingLeft: depth * 16,
          cursor: hasChildren ? 'pointer' : 'default',
          userSelect: 'none',
        }}
        onClick={toggle}
      >
        {hasChildren ? (
          <span style={{ width: 12, color: '#71717A', fontSize: 10 }}>{expanded ? '▼' : '▶'}</span>
        ) : (
          <span style={{ width: 12 }} />
        )}
        <span style={{ color: '#A78BFA' }}>{node.key}</span>
        <span style={{ color: '#71717A' }}>: </span>
        {hasChildren ? (
          <span style={{ color: '#71717A', fontSize: 10 }}>
            {node.type === 'array' ? `[${node.children?.length}]` : `{${node.children?.length}}`}
          </span>
        ) : (
          <span style={{ color: getValueColor() }}>{formatValue(node.value)}</span>
        )}
      </div>
      {hasChildren && expanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNodeComponent key={child.key} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function JsonTreePanel({ pluginId }: { pluginId: string; onSendToChat?: (msg: string) => void }) {
  const [input, setInput] = useState(MOCK_JSON)
  const [tree, setTree] = useState<TreeNode | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleParse = useCallback(() => {
    try {
      const data = JSON.parse(input)
      setTree(buildTree(data))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
      setTree(null)
    }
  }, [input])

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#E8E8EC' }}>JSON 树形</h3>
        <span style={{ fontSize: 10, color: '#71717A' }}>Plugin: {pluginId}</span>
      </div>

      {/* Input */}
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="粘贴 JSON 数据..."
        style={{
          minHeight: 100,
          padding: 10,
          borderRadius: 6,
          border: '1px solid #3F3F46',
          background: '#18181B',
          color: '#E8E8EC',
          fontFamily: 'Consolas, Monaco, monospace',
          fontSize: 12,
          lineHeight: 1.5,
          resize: 'vertical',
          outline: 'none',
        }}
      />

      <button
        onClick={handleParse}
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
        解析为树形
      </button>

      {error && (
        <div style={{ padding: '8px 10px', borderRadius: 6, background: '#2E1A1A', border: '1px solid #EF4444', fontSize: 11, color: '#EF4444' }}>
          {error}
        </div>
      )}

      {/* Tree View */}
      {tree && (
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: 10,
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: '#18181B',
          }}
        >
          <TreeNodeComponent node={tree} />
        </div>
      )}
    </div>
  )
}
