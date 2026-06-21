import { useState, useCallback } from 'react'
import { Play, RefreshCw, Copy, Download, BookOpen } from 'lucide-react'

interface ApiDocGeneratorPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface ApiEndpoint {
  method: string
  path: string
  description: string
  parameters: { name: string; type: string; required: boolean; description: string }[]
  response: string
}

interface ApiDoc {
  title: string
  version: string
  endpoints: ApiEndpoint[]
}

export function ApiDocGeneratorPanel({ pluginId, onSendToChat }: ApiDocGeneratorPanelProps) {
  const [code, setCode] = useState('')
  const [doc, setDoc] = useState<ApiDoc | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [selectedEndpoint, setSelectedEndpoint] = useState<ApiEndpoint | null>(null)
  const [format, setFormat] = useState<'markdown' | 'json' | 'yaml'>('markdown')

  const generateDoc = useCallback(() => {
    if (!code.trim()) return

    setIsGenerating(true)

    // 模拟生成API文档
    setTimeout(() => {
      const mockDoc: ApiDoc = {
        title: 'API Documentation',
        version: '1.0.0',
        endpoints: [
          {
            method: 'GET',
            path: '/api/users',
            description: '获取用户列表',
            parameters: [
              { name: 'page', type: 'number', required: false, description: '页码' },
              { name: 'limit', type: 'number', required: false, description: '每页数量' },
            ],
            response: '{ users: User[], total: number }',
          },
          {
            method: 'POST',
            path: '/api/users',
            description: '创建新用户',
            parameters: [
              { name: 'name', type: 'string', required: true, description: '用户名' },
              { name: 'email', type: 'string', required: true, description: '邮箱' },
            ],
            response: '{ user: User, message: string }',
          },
          {
            method: 'GET',
            path: '/api/users/:id',
            description: '获取用户详情',
            parameters: [
              { name: 'id', type: 'string', required: true, description: '用户ID' },
            ],
            response: '{ user: User }',
          },
          {
            method: 'PUT',
            path: '/api/users/:id',
            description: '更新用户信息',
            parameters: [
              { name: 'id', type: 'string', required: true, description: '用户ID' },
              { name: 'name', type: 'string', required: false, description: '用户名' },
              { name: 'email', type: 'string', required: false, description: '邮箱' },
            ],
            response: '{ user: User, message: string }',
          },
          {
            method: 'DELETE',
            path: '/api/users/:id',
            description: '删除用户',
            parameters: [
              { name: 'id', type: 'string', required: true, description: '用户ID' },
            ],
            response: '{ message: string }',
          },
        ],
      }

      setDoc(mockDoc)
      setIsGenerating(false)
    }, 1200)
  }, [code])

  const getMethodColor = (method: string) => {
    switch (method) {
      case 'GET':
        return 'bg-green-500/10 text-green-500 border-green-500/30'
      case 'POST':
        return 'bg-blue-500/10 text-blue-500 border-blue-500/30'
      case 'PUT':
        return 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30'
      case 'DELETE':
        return 'bg-red-500/10 text-red-500 border-red-500/30'
      default:
        return 'bg-gray-500/10 text-gray-500 border-gray-500/30'
    }
  }

  const generateMarkdown = () => {
    if (!doc) return ''

    let markdown = `# ${doc.title}\n\nVersion: ${doc.version}\n\n## Endpoints\n\n`

    doc.endpoints.forEach(endpoint => {
      markdown += `### ${endpoint.method} ${endpoint.path}\n\n`
      markdown += `${endpoint.description}\n\n`
      
      if (endpoint.parameters.length > 0) {
        markdown += `**Parameters:**\n\n`
        markdown += `| Name | Type | Required | Description |\n`
        markdown += `|------|------|----------|-------------|\n`
        endpoint.parameters.forEach(param => {
          markdown += `| ${param.name} | ${param.type} | ${param.required ? 'Yes' : 'No'} | ${param.description} |\n`
        })
        markdown += '\n'
      }

      markdown += `**Response:** \`${endpoint.response}\`\n\n`
      markdown += '---\n\n'
    })

    return markdown
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const handleSendToChat = () => {
    if (onSendToChat && doc) {
      const message = `API文档已生成：
标题: ${doc.title}
版本: ${doc.version}
端点数量: ${doc.endpoints.length}

端点列表:
${doc.endpoints.map(e => `- ${e.method} ${e.path}: ${e.description}`).join('\n')}`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={generateDoc}
            disabled={isGenerating || !code.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isGenerating ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isGenerating ? '生成中...' : '生成文档'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          {doc && (
            <>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as 'markdown' | 'json' | 'yaml')}
                className="px-2 py-1 text-sm bg-background-elevated border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary text-text-primary"
              >
                <option value="markdown">Markdown</option>
                <option value="json">JSON</option>
                <option value="yaml">YAML</option>
              </select>
              
              <button
                onClick={() => copyToClipboard(generateMarkdown())}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-text-secondary bg-background-elevated border border-border rounded-md hover:bg-background-hover transition-colors"
              >
                <Copy className="w-4 h-4" />
                复制
              </button>
              
              <button
                onClick={handleSendToChat}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-text-secondary bg-background-elevated border border-border rounded-md hover:bg-background-hover transition-colors"
              >
                <Download className="w-4 h-4" />
                发送
              </button>
            </>
          )}
        </div>
      </div>

      {/* 代码输入区 */}
      <div className="h-48 p-3 border-b border-border">
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="在此粘贴API代码，自动生成文档..."
          className="w-full h-full p-3 text-sm font-mono bg-background-elevated border border-border rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-muted"
        />
      </div>

      {/* 生成的文档 */}
      <div className="flex-1 overflow-y-auto p-3">
        {!doc ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <BookOpen className="w-12 h-12 text-text-muted mb-3" />
            <div className="text-text-muted text-sm">粘贴API代码并点击"生成文档"按钮</div>
            <div className="text-text-muted text-xs mt-1">支持RESTful API文档生成</div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-text-primary">
                <span className="font-medium">{doc.title}</span> v{doc.version}
              </div>
              <div className="text-xs text-text-muted">
                {doc.endpoints.length} 个端点
              </div>
            </div>
            
            {doc.endpoints.map((endpoint, index) => (
              <div
                key={index}
                className={`p-3 border rounded-md cursor-pointer transition-colors ${
                  selectedEndpoint === endpoint
                    ? 'bg-primary/10 border-primary/30'
                    : 'bg-background-elevated border-border hover:border-border-hover'
                }`}
                onClick={() => setSelectedEndpoint(endpoint)}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className={`px-2 py-0.5 text-xs font-medium rounded ${getMethodColor(endpoint.method)}`}>
                    {endpoint.method}
                  </span>
                  <span className="text-sm font-mono text-text-primary">{endpoint.path}</span>
                </div>
                <div className="text-xs text-text-muted">{endpoint.description}</div>
                
                {selectedEndpoint === endpoint && (
                  <div className="mt-3 space-y-2">
                    {endpoint.parameters.length > 0 && (
                      <div>
                        <div className="text-xs text-text-muted mb-1">参数</div>
                        <div className="space-y-1">
                          {endpoint.parameters.map((param, pIndex) => (
                            <div key={pIndex} className="flex items-center gap-2 text-xs">
                              <span className="font-mono text-text-primary">{param.name}</span>
                              <span className="text-text-muted">({param.type})</span>
                              {param.required && (
                                <span className="text-red-500 text-xs">必填</span>
                              )}
                              <span className="text-text-muted">- {param.description}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div>
                      <div className="text-xs text-text-muted mb-1">响应</div>
                      <pre className="text-xs font-mono text-text-secondary bg-background p-2 rounded">
                        {endpoint.response}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}