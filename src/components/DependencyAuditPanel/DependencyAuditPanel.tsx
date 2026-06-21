import { useState, useCallback } from 'react'
import { Play, RefreshCw, AlertTriangle, CheckCircle, ExternalLink } from 'lucide-react'

interface DependencyAuditPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface Dependency {
  name: string
  version: string
  latestVersion: string
  vulnerabilities: Vulnerability[]
  status: 'safe' | 'vulnerable' | 'outdated'
}

interface Vulnerability {
  id: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  title: string
  description: string
  recommendation: string
  cve?: string
}

export function DependencyAuditPanel({ pluginId, onSendToChat }: DependencyAuditPanelProps) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _pluginId = pluginId
  const [dependencies, setDependencies] = useState<Dependency[]>([])
  const [isAuditing, setIsAuditing] = useState(false)
  const [selectedDependency, setSelectedDependency] = useState<Dependency | null>(null)
  const [filter, setFilter] = useState<string>('all')

  const runAudit = useCallback(() => {
    setIsAuditing(true)

    // 模拟依赖审计
    setTimeout(() => {
      const mockDependencies: Dependency[] = [
        {
          name: 'lodash',
          version: '4.17.20',
          latestVersion: '4.17.21',
          vulnerabilities: [
            {
              id: 'vuln-1',
              severity: 'high',
              title: '原型污染漏洞',
              description: 'lodash版本存在原型污染安全漏洞',
              recommendation: '更新到4.17.21或更高版本',
              cve: 'CVE-2021-23337',
            },
          ],
          status: 'vulnerable',
        },
        {
          name: 'axios',
          version: '0.21.1',
          latestVersion: '1.6.0',
          vulnerabilities: [
            {
              id: 'vuln-2',
              severity: 'medium',
              title: 'SSRF漏洞',
              description: 'axios版本存在服务器端请求伪造漏洞',
              recommendation: '更新到1.6.0或更高版本',
              cve: 'CVE-2023-45857',
            },
          ],
          status: 'vulnerable',
        },
        {
          name: 'express',
          version: '4.18.2',
          latestVersion: '4.18.2',
          vulnerabilities: [],
          status: 'safe',
        },
        {
          name: 'react',
          version: '17.0.2',
          latestVersion: '18.2.0',
          vulnerabilities: [],
          status: 'outdated',
        },
        {
          name: 'webpack',
          version: '5.88.0',
          latestVersion: '5.89.0',
          vulnerabilities: [],
          status: 'outdated',
        },
        {
          name: 'minimist',
          version: '1.2.5',
          latestVersion: '1.2.8',
          vulnerabilities: [
            {
              id: 'vuln-3',
              severity: 'critical',
              title: '原型污染漏洞',
              description: 'minimist版本存在严重的原型污染安全漏洞',
              recommendation: '立即更新到1.2.8或更高版本',
              cve: 'CVE-2021-44906',
            },
          ],
          status: 'vulnerable',
        },
      ]

      setDependencies(mockDependencies)
      setIsAuditing(false)
    }, 1500)
  }, [])

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'critical':
      case 'high':
        return <AlertTriangle className="w-4 h-4 text-red-500" />
      case 'medium':
        return <AlertTriangle className="w-4 h-4 text-yellow-500" />
      default:
        return <CheckCircle className="w-4 h-4 text-green-500" />
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'vulnerable':
        return 'bg-red-500/10 text-red-500 border-red-500/30'
      case 'outdated':
        return 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30'
      default:
        return 'bg-green-500/10 text-green-500 border-green-500/30'
    }
  }

  const filteredDependencies = filter === 'all'
    ? dependencies
    : dependencies.filter(d => d.status === filter)

  const handleSendToChat = () => {
    if (onSendToChat && dependencies.length > 0) {
      const vulnerable = dependencies.filter(d => d.status === 'vulnerable').length
      const outdated = dependencies.filter(d => d.status === 'outdated').length
      const safe = dependencies.filter(d => d.status === 'safe').length

      const message = `依赖审计报告：
总依赖数: ${dependencies.length}

安全状态：
- 安全: ${safe}
- 有漏洞: ${vulnerable}
- 过时: ${outdated}

建议: ${vulnerable > 0 ? '存在安全漏洞依赖，建议立即更新' : 
  outdated > 0 ? '部分依赖过时，建议更新到最新版本' : 
  '所有依赖都是最新的'}` 
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={runAudit}
            disabled={isAuditing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isAuditing ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isAuditing ? '审计中...' : '运行审计'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="px-2 py-1 text-sm bg-background-elevated border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary text-text-primary"
          >
            <option value="all">全部</option>
            <option value="vulnerable">有漏洞</option>
            <option value="outdated">过时</option>
            <option value="safe">安全</option>
          </select>
          
          {dependencies.length > 0 && (
            <button
              onClick={handleSendToChat}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-text-secondary bg-background-elevated border border-border rounded-md hover:bg-background-hover transition-colors"
            >
              发送报告
            </button>
          )}
        </div>
      </div>

      {/* 审计结果 */}
      <div className="flex-1 overflow-y-auto p-3">
        {filteredDependencies.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <CheckCircle className="w-12 h-12 text-text-muted mb-3" />
            <div className="text-text-muted text-sm">点击"运行审计"按钮</div>
            <div className="text-text-muted text-xs mt-1">检查项目依赖的安全问题</div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-text-primary">
                发现 <span className="font-medium">{filteredDependencies.length}</span> 个依赖
              </div>
            </div>
            
            {filteredDependencies.map((dependency) => (
              <div
                key={dependency.name}
                className={`p-3 border rounded-md cursor-pointer transition-colors ${
                  selectedDependency?.name === dependency.name
                    ? 'bg-primary/10 border-primary/30'
                    : getStatusColor(dependency.status)
                }`}
                onClick={() => setSelectedDependency(dependency)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {getSeverityIcon(dependency.vulnerabilities.length > 0 ? dependency.vulnerabilities[0].severity : 'low')}
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary">{dependency.name}</span>
                        <span className="text-xs text-text-muted">{dependency.version}</span>
                        {dependency.status === 'outdated' && (
                          <span className="text-xs text-yellow-500">→ {dependency.latestVersion}</span>
                        )}
                      </div>
                      {dependency.vulnerabilities.length > 0 && (
                        <div className="text-xs text-text-muted mt-1">
                          {dependency.vulnerabilities.length} 个安全漏洞
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      window.open(`https://www.npmjs.com/package/${dependency.name}`, '_blank')
                    }}
                    className="p-1 text-text-muted hover:text-text-primary hover:bg-background-hover rounded transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </button>
                </div>
                
                {selectedDependency?.name === dependency.name && dependency.vulnerabilities.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {dependency.vulnerabilities.map((vuln) => (
                      <div key={vuln.id} className="p-2 bg-background rounded-md">
                        <div className="flex items-center gap-2 mb-1">
                          {getSeverityIcon(vuln.severity)}
                          <span className="text-xs font-medium text-text-primary">{vuln.title}</span>
                          {vuln.cve && (
                            <span className="text-xs text-text-muted">({vuln.cve})</span>
                          )}
                        </div>
                        <div className="text-xs text-text-muted">{vuln.description}</div>
                        <div className="text-xs text-text-secondary mt-1">建议: {vuln.recommendation}</div>
                      </div>
                    ))}
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