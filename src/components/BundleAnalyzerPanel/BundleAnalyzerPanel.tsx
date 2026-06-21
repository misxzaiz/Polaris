import { useState, useCallback } from 'react'
import { Play, RefreshCw, Package } from 'lucide-react'

interface BundleAnalyzerPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface BundleModule {
  name: string
  size: number
  gzipSize: number
  percentage: number
}

interface BundleAnalysis {
  totalSize: number
  totalGzipSize: number
  modules: BundleModule[]
  chunks: { name: string; size: number; gzipSize: number }[]
}

export function BundleAnalyzerPanel({ pluginId, onSendToChat }: BundleAnalyzerPanelProps) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _pluginId = pluginId
  const [analysis, setAnalysis] = useState<BundleAnalysis | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [selectedModule, setSelectedModule] = useState<BundleModule | null>(null)
  const [view, setView] = useState<'modules' | 'chunks'>('modules')

  const analyzeBundle = useCallback(() => {
    setIsAnalyzing(true)

    // 模拟包分析
    setTimeout(() => {
      const mockAnalysis: BundleAnalysis = {
        totalSize: 245000,
        totalGzipSize: 78000,
        modules: [
          { name: 'node_modules/react', size: 42000, gzipSize: 13000, percentage: 17.1 },
          { name: 'node_modules/react-dom', size: 38000, gzipSize: 12000, percentage: 15.5 },
          { name: 'node_modules/lodash', size: 28000, gzipSize: 9500, percentage: 11.4 },
          { name: 'node_modules/moment', size: 22000, gzipSize: 7200, percentage: 9.0 },
          { name: 'node_modules/axios', size: 15000, gzipSize: 5100, percentage: 6.1 },
          { name: 'src/components/App', size: 12000, gzipSize: 3800, percentage: 4.9 },
          { name: 'src/utils/helpers', size: 8500, gzipSize: 2800, percentage: 3.5 },
          { name: 'src/store/reducer', size: 7200, gzipSize: 2400, percentage: 2.9 },
          { name: 'src/pages/Home', size: 6800, gzipSize: 2200, percentage: 2.8 },
          { name: 'src/components/Button', size: 4200, gzipSize: 1400, percentage: 1.7 },
        ],
        chunks: [
          { name: 'main', size: 180000, gzipSize: 58000 },
          { name: 'vendor', size: 55000, gzipSize: 18000 },
          { name: 'runtime', size: 10000, gzipSize: 3200 },
        ],
      }

      setAnalysis(mockAnalysis)
      setIsAnalyzing(false)
    }, 1200)
  }, [])

  const formatSize = (bytes: number) => {
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
    }
    if (bytes >= 1024) {
      return `${(bytes / 1024).toFixed(2)} KB`
    }
    return `${bytes} B`
  }

  const getSizeColor = (percentage: number) => {
    if (percentage >= 15) return 'text-red-500'
    if (percentage >= 10) return 'text-yellow-500'
    return 'text-green-500'
  }

  const handleSendToChat = () => {
    if (onSendToChat && analysis) {
      const largeModules = analysis.modules.filter(m => m.percentage > 10)
      const message = `包大小分析报告：
总大小: ${formatSize(analysis.totalSize)}
压缩后: ${formatSize(analysis.totalGzipSize)}
压缩率: ${Math.round((1 - analysis.totalGzipSize / analysis.totalSize) * 100)}%

大型模块 (>10%):
${largeModules.map(m => `${m.name}: ${m.percentage.toFixed(1)}% (${formatSize(m.size)})`).join('\n')}

建议: ${largeModules.length > 0 ? '存在大型依赖，考虑使用轻量级替代方案或代码分割' : 
  '包大小控制良好'}`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={analyzeBundle}
            disabled={isAnalyzing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isAnalyzing ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isAnalyzing ? '分析中...' : '分析包大小'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          {analysis && (
            <div className="flex items-center bg-background-elevated border border-border rounded-md">
              <button
                onClick={() => setView('modules')}
                className={`px-2 py-1 text-xs ${
                  view === 'modules' ? 'bg-primary text-white' : 'text-text-secondary'
                }`}
              >
                模块
              </button>
              <button
                onClick={() => setView('chunks')}
                className={`px-2 py-1 text-xs ${
                  view === 'chunks' ? 'bg-primary text-white' : 'text-text-secondary'
                }`}
              >
                块
              </button>
            </div>
          )}
          
          {analysis && (
            <button
              onClick={handleSendToChat}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-text-secondary bg-background-elevated border border-border rounded-md hover:bg-background-hover transition-colors"
            >
              发送报告
            </button>
          )}
        </div>
      </div>

      {/* 分析结果 */}
      <div className="flex-1 overflow-y-auto p-3">
        {!analysis ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Package className="w-12 h-12 text-text-muted mb-3" />
            <div className="text-text-muted text-sm">点击"分析包大小"按钮</div>
            <div className="text-text-muted text-xs mt-1">分析前端包大小和组成</div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* 概览 */}
            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 bg-background-elevated border border-border rounded-md">
                <div className="text-xs text-text-muted mb-1">总大小</div>
                <div className="text-lg font-bold text-text-primary">{formatSize(analysis.totalSize)}</div>
              </div>
              <div className="p-3 bg-background-elevated border border-border rounded-md">
                <div className="text-xs text-text-muted mb-1">压缩后</div>
                <div className="text-lg font-bold text-green-500">{formatSize(analysis.totalGzipSize)}</div>
              </div>
              <div className="p-3 bg-background-elevated border border-border rounded-md">
                <div className="text-xs text-text-muted mb-1">压缩率</div>
                <div className="text-lg font-bold text-blue-500">
                  {Math.round((1 - analysis.totalGzipSize / analysis.totalSize) * 100)}%
                </div>
              </div>
            </div>

            {/* 模块/块列表 */}
            {view === 'modules' ? (
              <div className="space-y-2">
                <div className="text-sm text-text-primary mb-2">模块大小</div>
                {analysis.modules.map((module, index) => (
                  <div
                    key={index}
                    className={`p-2 border rounded-md cursor-pointer transition-colors ${
                      selectedModule?.name === module.name
                        ? 'bg-primary/10 border-primary/30'
                        : 'bg-background-elevated border-border hover:border-border-hover'
                    }`}
                    onClick={() => setSelectedModule(module)}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-text-primary font-medium truncate">{module.name}</span>
                      <span className={`text-xs font-bold ${getSizeColor(module.percentage)}`}>
                        {module.percentage.toFixed(1)}%
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-text-muted">
                      <span>{formatSize(module.size)}</span>
                      <span>gzip: {formatSize(module.gzipSize)}</span>
                    </div>
                    <div className="w-full h-1.5 bg-background rounded-full mt-1 overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full"
                        style={{ width: `${module.percentage}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-sm text-text-primary mb-2">代码块</div>
                {analysis.chunks.map((chunk, index) => (
                  <div
                    key={index}
                    className="p-2 bg-background-elevated border border-border rounded-md"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-text-primary font-medium">{chunk.name}</span>
                      <span className="text-xs text-text-muted">{formatSize(chunk.size)}</span>
                    </div>
                    <div className="w-full h-1.5 bg-background rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full"
                        style={{ width: `${(chunk.size / analysis.totalSize) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}