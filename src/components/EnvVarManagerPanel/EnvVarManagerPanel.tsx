import { useState, useCallback } from 'react'
import { Play, RefreshCw, Plus, Trash2, Copy, Download } from 'lucide-react'

interface EnvVarManagerPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface EnvVar {
  id: string
  name: string
  value: string
  environment: 'development' | 'production' | 'test'
  isSecret: boolean
}

export function EnvVarManagerPanel({ pluginId, onSendToChat }: EnvVarManagerPanelProps) {
  const [envVars, setEnvVars] = useState<EnvVar[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [newVar, setNewVar] = useState({ name: '', value: '', environment: 'development' as const, isSecret: false })
  const [showValues, setShowValues] = useState<boolean[]>([])
  const [activeTab, setActiveTab] = useState<'development' | 'production' | 'test'>('development')

  const loadEnvVars = useCallback(() => {
    setIsLoading(true)

    // 模拟加载环境变量
    setTimeout(() => {
      const mockEnvVars: EnvVar[] = [
        {
          id: 'env-1',
          name: 'NODE_ENV',
          value: 'development',
          environment: 'development',
          isSecret: false,
        },
        {
          id: 'env-2',
          name: 'API_KEY',
          value: 'sk-1234567890abcdef',
          environment: 'development',
          isSecret: true,
        },
        {
          id: 'env-3',
          name: 'DATABASE_URL',
          value: 'postgresql://localhost:5432/mydb',
          environment: 'development',
          isSecret: false,
        },
        {
          id: 'env-4',
          name: 'NODE_ENV',
          value: 'production',
          environment: 'production',
          isSecret: false,
        },
        {
          id: 'env-5',
          name: 'API_KEY',
          value: 'sk-production-key-1234567890',
          environment: 'production',
          isSecret: true,
        },
      ]

      setEnvVars(mockEnvVars)
      setShowValues(new Array(mockEnvVars.length).fill(false))
      setIsLoading(false)
    }, 1000)
  }, [])

  const addEnvVar = () => {
    if (!newVar.name.trim() || !newVar.value.trim()) return

    const newEnvVar: EnvVar = {
      id: `env-${Date.now()}`,
      ...newVar,
    }

    setEnvVars([...envVars, newEnvVar])
    setNewVar({ name: '', value: '', environment: 'development', isSecret: false })
  }

  const removeEnvVar = (id: string) => {
    setEnvVars(envVars.filter(env => env.id !== id))
  }

  const toggleShowValue = (index: number) => {
    setShowValues(prev => {
      const newValues = [...prev]
      newValues[index] = !newValues[index]
      return newValues
    })
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const filteredEnvVars = envVars.filter(env => env.environment === activeTab)

  const handleSendToChat = () => {
    if (onSendToChat) {
      const message = `环境变量配置：
总变量数: ${envVars.length}

按环境：
- 开发环境: ${envVars.filter(e => e.environment === 'development').length}
- 生产环境: ${envVars.filter(e => e.environment === 'production').length}
- 测试环境: ${envVars.filter(e => e.environment === 'test').length}

敏感变量: ${envVars.filter(e => e.isSecret).length}`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={loadEnvVars}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isLoading ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isLoading ? '加载中...' : '刷新'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          <button
            onClick={handleSendToChat}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-text-secondary bg-background-elevated border border-border rounded-md hover:bg-background-hover transition-colors"
          >
            <Download className="w-4 h-4" />
            导出
          </button>
        </div>
      </div>

      {/* 环境标签页 */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setActiveTab('development')}
          className={`flex-1 px-3 py-2 text-sm ${
            activeTab === 'development' ? 'text-primary border-b-2 border-primary' : 'text-text-muted'
          }`}
        >
          开发环境
        </button>
        <button
          onClick={() => setActiveTab('production')}
          className={`flex-1 px-3 py-2 text-sm ${
            activeTab === 'production' ? 'text-primary border-b-2 border-primary' : 'text-text-muted'
          }`}
        >
          生产环境
        </button>
        <button
          onClick={() => setActiveTab('test')}
          className={`flex-1 px-3 py-2 text-sm ${
            activeTab === 'test' ? 'text-primary border-b-2 border-primary' : 'text-text-muted'
          }`}
        >
          测试环境
        </button>
      </div>

      {/* 添加新变量 */}
      <div className="p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newVar.name}
            onChange={(e) => setNewVar({ ...newVar, name: e.target.value })}
            placeholder="变量名"
            className="flex-1 p-2 text-sm font-mono bg-background-elevated border border-border rounded-md text-text-primary placeholder-text-muted"
          />
          <input
            type="text"
            value={newVar.value}
            onChange={(e) => setNewVar({ ...newVar, value: e.target.value })}
            placeholder="值"
            className="flex-1 p-2 text-sm font-mono bg-background-elevated border border-border rounded-md text-text-primary placeholder-text-muted"
          />
          <label className="flex items-center gap-1 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={newVar.isSecret}
              onChange={(e) => setNewVar({ ...newVar, isSecret: e.target.checked })}
              className="rounded"
            />
            敏感
          </label>
          <button
            onClick={addEnvVar}
            disabled={!newVar.name.trim() || !newVar.value.trim()}
            className="p-2 text-primary hover:text-primary/80 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 变量列表 */}
      <div className="flex-1 overflow-y-auto p-3">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-text-muted text-sm">加载环境变量...</div>
          </div>
        ) : filteredEnvVars.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-text-muted text-sm">暂无环境变量</div>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredEnvVars.map((envVar, index) => (
              <div
                key={envVar.id}
                className="flex items-center gap-2 p-2 bg-background-elevated border border-border rounded-md"
              >
                <div className="flex-1">
                  <div className="text-sm font-mono text-text-primary">{envVar.name}</div>
                  <div className="text-xs text-text-muted">
                    {envVar.isSecret ? '••••••••' : showValues[index] ? envVar.value : '••••••••'}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => toggleShowValue(index)}
                    className="p-1 text-text-muted hover:text-text-primary hover:bg-background-hover rounded transition-colors"
                  >
                    <span className="text-xs">{showValues[index] ? '隐藏' : '显示'}</span>
                  </button>
                  <button
                    onClick={() => copyToClipboard(envVar.value)}
                    className="p-1 text-text-muted hover:text-text-primary hover:bg-background-hover rounded transition-colors"
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => removeEnvVar(envVar.id)}
                    className="p-1 text-red-500 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}