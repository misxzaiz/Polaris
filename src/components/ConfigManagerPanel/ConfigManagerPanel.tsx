import { useState, useCallback } from 'react'
import { Play, RefreshCw, Settings, Copy, Download, Plus, Trash2 } from 'lucide-react'

interface ConfigManagerPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface ConfigItem {
  key: string
  value: string
  type: 'string' | 'number' | 'boolean' | 'json'
  description?: string
}

export function ConfigManagerPanel({ pluginId, onSendToChat }: ConfigManagerPanelProps) {
  const [configs, setConfigs] = useState<ConfigItem[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [newConfig, setNewConfig] = useState({ key: '', value: '', type: 'string' as const, description: '' })
  const [selectedConfig, setSelectedConfig] = useState<ConfigItem | null>(null)
  const [activeTab, setActiveTab] = useState<'view' | 'edit'>('view')

  const loadConfigs = useCallback(() => {
    setIsLoading(true)

    // 模拟加载配置
    setTimeout(() => {
      const mockConfigs: ConfigItem[] = [
        {
          key: 'APP_NAME',
          value: 'Polaris',
          type: 'string',
          description: '应用名称',
        },
        {
          key: 'APP_VERSION',
          value: '1.0.0',
          type: 'string',
          description: '应用版本',
        },
        {
          key: 'DEBUG_MODE',
          value: 'true',
          type: 'boolean',
          description: '调试模式',
        },
        {
          key: 'MAX_CONNECTIONS',
          value: '100',
          type: 'number',
          description: '最大连接数',
        },
        {
          key: 'API_CONFIG',
          value: '{"timeout": 5000, "retries": 3}',
          type: 'json',
          description: 'API配置',
        },
      ]

      setConfigs(mockConfigs)
      setIsLoading(false)
    }, 800)
  }, [])

  const addConfig = () => {
    if (!newConfig.key.trim() || !newConfig.value.trim()) return

    setConfigs([...configs, newConfig])
    setNewConfig({ key: '', value: '', type: 'string', description: '' })
  }

  const removeConfig = (key: string) => {
    setConfigs(configs.filter((c) => c.key !== key))
  }

  const updateConfig = (key: string, updates: Partial<ConfigItem>) => {
    setConfigs(
      configs.map((c) => (c.key === key ? { ...c, ...updates } : c))
    )
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const handleSendToChat = () => {
    if (onSendToChat && configs.length > 0) {
      const message = `配置管理：
总配置项: ${configs.length}

配置列表:
${configs.map((c) => `- ${c.key}: ${c.value} (${c.type})`).join('\n')}`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={loadConfigs}
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
            disabled={configs.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-text-secondary bg-background-elevated border border-border rounded-md hover:bg-background-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Download className="w-4 h-4" />
            导出
          </button>
        </div>
      </div>

      {/* 标签页 */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setActiveTab('view')}
          className={`flex-1 px-3 py-2 text-sm ${
            activeTab === 'view' ? 'text-primary border-b-2 border-primary' : 'text-text-muted'
          }`}
        >
          查看
        </button>
        <button
          onClick={() => setActiveTab('edit')}
          className={`flex-1 px-3 py-2 text-sm ${
            activeTab === 'edit' ? 'text-primary border-b-2 border-primary' : 'text-text-muted'
          }`}
        >
          编辑
        </button>
      </div>

      {/* 内容区域 */}
      <div className="flex-1 overflow-y-auto p-3">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-text-muted text-sm">加载配置...</div>
          </div>
        ) : activeTab === 'view' ? (
          <div className="space-y-2">
            {configs.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <Settings className="w-12 h-12 text-text-muted mb-3" />
                <div className="text-text-muted text-sm">暂无配置项</div>
              </div>
            ) : (
              configs.map((config) => (
                <div
                  key={config.key}
                  className={`p-3 border rounded-md cursor-pointer transition-colors ${
                    selectedConfig?.key === config.key
                      ? 'bg-primary/10 border-primary/30'
                      : 'bg-background-elevated border-border hover:border-border-hover'
                  }`}
                  onClick={() => setSelectedConfig(config)}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-text-primary">{config.key}</div>
                      <div className="text-xs text-text-muted mt-1">
                        {config.value} ({config.type})
                      </div>
                      {config.description && (
                        <div className="text-xs text-text-muted mt-1">{config.description}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          copyToClipboard(config.value)
                        }}
                        className="p-1 text-text-muted hover:text-text-primary hover:bg-background-hover rounded transition-colors"
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          removeConfig(config.key)
                        }}
                        className="p-1 text-red-500 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {/* 添加新配置 */}
            <div className="p-3 bg-background-elevated border border-border rounded-md">
              <div className="text-sm font-medium text-text-primary mb-2">添加配置</div>
              <div className="space-y-2">
                <input
                  type="text"
                  value={newConfig.key}
                  onChange={(e) => setNewConfig({ ...newConfig, key: e.target.value })}
                  placeholder="配置键"
                  className="w-full p-2 text-sm font-mono bg-background border border-border rounded-md text-text-primary placeholder-text-muted"
                />
                <input
                  type="text"
                  value={newConfig.value}
                  onChange={(e) => setNewConfig({ ...newConfig, value: e.target.value })}
                  placeholder="配置值"
                  className="w-full p-2 text-sm font-mono bg-background border border-border rounded-md text-text-primary placeholder-text-muted"
                />
                <div className="flex gap-2">
                  <select
                    value={newConfig.type}
                    onChange={(e) =>
                      setNewConfig({ ...newConfig, type: e.target.value as ConfigItem['type'] })
                    }
                    className="px-2 py-1 text-sm bg-background border border-border rounded-md text-text-primary"
                  >
                    <option value="string">字符串</option>
                    <option value="number">数字</option>
                    <option value="boolean">布尔值</option>
                    <option value="json">JSON</option>
                  </select>
                  <input
                    type="text"
                    value={newConfig.description}
                    onChange={(e) => setNewConfig({ ...newConfig, description: e.target.value })}
                    placeholder="描述（可选）"
                    className="flex-1 p-2 text-sm bg-background border border-border rounded-md text-text-primary placeholder-text-muted"
                  />
                </div>
                <button
                  onClick={addConfig}
                  disabled={!newConfig.key.trim() || !newConfig.value.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  添加
                </button>
              </div>
            </div>

            {/* 配置列表 */}
            <div className="space-y-2">
              {configs.map((config) => (
                <div
                  key={config.key}
                  className="p-3 bg-background-elevated border border-border rounded-md"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-text-primary">{config.key}</div>
                      <div className="text-xs text-text-muted mt-1">
                        {config.value} ({config.type})
                      </div>
                      {config.description && (
                        <div className="text-xs text-text-muted mt-1">{config.description}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => copyToClipboard(config.value)}
                        className="p-1 text-text-muted hover:text-text-primary hover:bg-background-hover rounded transition-colors"
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => removeConfig(config.key)}
                        className="p-1 text-red-500 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}