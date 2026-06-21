import { useState, useCallback } from 'react'
import { Play, RefreshCw, Search, Copy, Filter } from 'lucide-react'

interface CodeSearchPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface SearchResult {
  file: string
  line: number
  content: string
  match: string
}

export function CodeSearchPanel({ pluginId, onSendToChat }: CodeSearchPanelProps) {
  const [query, setQuery] = useState('')
  const [isRegex, setIsRegex] = useState(false)
  const [results, setResults] = useState<SearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [selectedResult, setSelectedResult] = useState<SearchResult | null>(null)

  const searchCode = useCallback(() => {
    if (!query.trim()) return

    setIsSearching(true)

    // 模拟代码搜索
    setTimeout(() => {
      const mockResults: SearchResult[] = [
        {
          file: 'src/App.tsx',
          line: 15,
          content: 'function App() {',
          match: 'App',
        },
        {
          file: 'src/components/Header.tsx',
          line: 8,
          content: 'export default function Header() {',
          match: 'function',
        },
        {
          file: 'src/utils/helpers.ts',
          line: 23,
          content: 'export const formatDate = (date: Date) => {',
          match: 'export',
        },
        {
          file: 'src/types/index.ts',
          line: 5,
          content: 'export interface User {',
          match: 'interface',
        },
      ]

      setResults(mockResults)
      setIsSearching(false)
    }, 800)
  }, [query, isRegex])

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const handleSendToChat = () => {
    if (onSendToChat && results.length > 0) {
      const message = `代码搜索结果：
查询: ${query}
结果数量: ${results.length}

文件分布:
${[...new Set(results.map(r => r.file))].map(file => `- ${file}: ${results.filter(r => r.file === file).length} 个匹配`).join('\n')}`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 搜索栏 */}
      <div className="p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索代码..."
              className="w-full pl-8 pr-3 py-2 text-sm bg-background-elevated border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-muted"
              onKeyDown={(e) => e.key === 'Enter' && searchCode()}
            />
          </div>
          <label className="flex items-center gap-1 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={isRegex}
              onChange={(e) => setIsRegex(e.target.checked)}
              className="rounded"
            />
            正则
          </label>
          <button
            onClick={searchCode}
            disabled={isSearching || !query.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isSearching ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
            搜索
          </button>
        </div>
      </div>

      {/* 搜索结果 */}
      <div className="flex-1 overflow-y-auto p-3">
        {results.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Search className="w-12 h-12 text-text-muted mb-3" />
            <div className="text-text-muted text-sm">输入搜索关键词并点击搜索</div>
            <div className="text-text-muted text-xs mt-1">支持正则表达式搜索</div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-text-primary">
                找到 <span className="font-medium">{results.length}</span> 个匹配
              </div>
              <button
                onClick={handleSendToChat}
                className="text-xs text-primary hover:text-primary/80"
              >
                发送结果
              </button>
            </div>
            
            {results.map((result, index) => (
              <div
                key={index}
                className={`p-2 border rounded-md cursor-pointer transition-colors ${
                  selectedResult === result
                    ? 'bg-primary/10 border-primary/30'
                    : 'bg-background-elevated border-border hover:border-border-hover'
                }`}
                onClick={() => setSelectedResult(result)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-muted">{result.file}:{result.line}</span>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      copyToClipboard(result.content)
                    }}
                    className="p-1 text-text-muted hover:text-text-primary hover:bg-background-hover rounded transition-colors"
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                </div>
                <pre className="text-xs font-mono text-text-secondary mt-1 overflow-x-auto">
                  {result.content}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}