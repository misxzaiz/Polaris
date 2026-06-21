import { useState, useCallback } from 'react'
import { RefreshCw, Eye, EyeOff, AlertTriangle, Shield } from 'lucide-react'

interface SecretScannerPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface Secret {
  id: string
  type: string
  value: string
  maskedValue: string
  line: number
  severity: 'critical' | 'high' | 'medium'
  description: string
}

export function SecretScannerPanel({ pluginId, onSendToChat }: SecretScannerPanelProps) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _pluginId = pluginId
  const [code, setCode] = useState('')
  const [secrets, setSecrets] = useState<Secret[]>([])
  const [isScanning, setIsScanning] = useState(false)
  const [selectedSecret, setSelectedSecret] = useState<Secret | null>(null)
  const [showValues, setShowValues] = useState<boolean[]>([])

  const scanCode = useCallback(() => {
    if (!code.trim()) return

    setIsScanning(true)

    // 模拟密钥扫描
    setTimeout(() => {
      const mockSecrets: Secret[] = [
        {
          id: 'secret-1',
          type: 'API Key',
          value: 'sk-1234567890abcdef1234567890abcdef',
          maskedValue: 'sk-****...****def',
          line: 5,
          severity: 'critical',
          description: '检测到OpenAI API密钥',
        },
        {
          id: 'secret-2',
          type: 'Password',
          value: 'password123',
          maskedValue: '****',
          line: 12,
          severity: 'high',
          description: '检测到硬编码密码',
        },
        {
          id: 'secret-3',
          type: 'AWS Key',
          value: 'AKIAIOSFODNN7EXAMPLE',
          maskedValue: 'AKIA****...****MPLE',
          line: 20,
          severity: 'critical',
          description: '检测到AWS访问密钥',
        },
        {
          id: 'secret-4',
          type: 'Private Key',
          value: '-----BEGIN RSA PRIVATE KEY-----',
          maskedValue: '-----BEGIN ****-----',
          line: 30,
          severity: 'critical',
          description: '检测到RSA私钥',
        },
        {
          id: 'secret-5',
          type: 'Token',
          value: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',
          maskedValue: 'ghp_****...****def',
          line: 40,
          severity: 'high',
          description: '检测到GitHub个人访问令牌',
        },
      ]

      setSecrets(mockSecrets)
      setShowValues(new Array(mockSecrets.length).fill(false))
      setIsScanning(false)
    }, 1000)
  }, [code])

  const toggleShowValue = (index: number) => {
    setShowValues(prev => {
      const newValues = [...prev]
      newValues[index] = !newValues[index]
      return newValues
    })
  }

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical':
        return 'bg-red-500/10 text-red-500 border-red-500/30'
      case 'high':
        return 'bg-orange-500/10 text-orange-500 border-orange-500/30'
      default:
        return 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30'
    }
  }

  const handleSendToChat = () => {
    if (onSendToChat && secrets.length > 0) {
      const critical = secrets.filter(s => s.severity === 'critical').length
      const high = secrets.filter(s => s.severity === 'high').length

      const message = `密钥扫描报告：
发现 ${secrets.length} 个敏感信息

按严重程度：
- 严重 (Critical): ${critical}
- 高危 (High): ${high}

建议: ${critical > 0 ? '存在严重安全风险，建议立即处理' : 
  '建议将敏感信息移至环境变量或密钥管理服务'}`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={scanCode}
            disabled={isScanning || !code.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isScanning ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Shield className="w-4 h-4" />
            )}
            {isScanning ? '扫描中...' : '扫描密钥'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          {secrets.length > 0 && (
            <button
              onClick={handleSendToChat}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-text-secondary bg-background-elevated border border-border rounded-md hover:bg-background-hover transition-colors"
            >
              发送报告
            </button>
          )}
        </div>
      </div>

      {/* 代码输入区 */}
      <div className="h-48 p-3 border-b border-border">
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="在此粘贴代码进行密钥扫描..."
          className="w-full h-full p-3 text-sm font-mono bg-background-elevated border border-border rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-muted"
        />
      </div>

      {/* 扫描结果 */}
      <div className="flex-1 overflow-y-auto p-3">
        {secrets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Shield className="w-12 h-12 text-text-muted mb-3" />
            <div className="text-text-muted text-sm">粘贴代码并点击"扫描密钥"按钮</div>
            <div className="text-text-muted text-xs mt-1">检测API密钥、密码、私钥等敏感信息</div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-text-primary">
                发现 <span className="font-medium">{secrets.length}</span> 个敏感信息
              </div>
            </div>
            
            {secrets.map((secret, index) => (
              <div
                key={secret.id}
                className={`p-3 border rounded-md cursor-pointer transition-colors ${
                  selectedSecret?.id === secret.id
                    ? 'bg-primary/10 border-primary/30'
                    : getSeverityColor(secret.severity)
                }`}
                onClick={() => setSelectedSecret(secret)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5" />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary">{secret.type}</span>
                        <span className="text-xs text-text-muted">行 {secret.line}</span>
                      </div>
                      <div className="text-xs text-text-muted mt-1">{secret.description}</div>
                      <div className="flex items-center gap-2 mt-2">
                        <code className="text-xs font-mono bg-background px-1.5 py-0.5 rounded">
                          {showValues[index] ? secret.value : secret.maskedValue}
                        </code>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleShowValue(index)
                          }}
                          className="p-1 text-text-muted hover:text-text-primary hover:bg-background-hover rounded transition-colors"
                        >
                          {showValues[index] ? (
                            <EyeOff className="w-3 h-3" />
                          ) : (
                            <Eye className="w-3 h-3" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}