import { useState, useCallback } from 'react'
import { Play, RefreshCw, Download, BarChart3 } from 'lucide-react'

interface TestCoveragePanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface CoverageData {
  file: string
  lines: { total: number; covered: number; percentage: number }
  branches: { total: number; covered: number; percentage: number }
  functions: { total: number; covered: number; percentage: number }
}

interface CoverageReport {
  timestamp: string
  totalCoverage: number
  files: CoverageData[]
}

export function TestCoveragePanel({ pluginId, onSendToChat }: TestCoveragePanelProps) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _pluginId = pluginId
  const [report, setReport] = useState<CoverageReport | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [selectedFile, setSelectedFile] = useState<CoverageData | null>(null)

  const generateReport = useCallback(() => {
    setIsGenerating(true)

    // 模拟生成覆盖率报告
    setTimeout(() => {
      const mockReport: CoverageReport = {
        timestamp: new Date().toISOString(),
        totalCoverage: 78.5,
        files: [
          {
            file: 'src/utils/helpers.ts',
            lines: { total: 150, covered: 140, percentage: 93.3 },
            branches: { total: 20, covered: 18, percentage: 90.0 },
            functions: { total: 15, covered: 14, percentage: 93.3 },
          },
          {
            file: 'src/components/Button.tsx',
            lines: { total: 80, covered: 70, percentage: 87.5 },
            branches: { total: 12, covered: 10, percentage: 83.3 },
            functions: { total: 8, covered: 7, percentage: 87.5 },
          },
          {
            file: 'src/services/api.ts',
            lines: { total: 200, covered: 150, percentage: 75.0 },
            branches: { total: 30, covered: 20, percentage: 66.7 },
            functions: { total: 25, covered: 18, percentage: 72.0 },
          },
          {
            file: 'src/store/reducer.ts',
            lines: { total: 120, covered: 80, percentage: 66.7 },
            branches: { total: 18, covered: 10, percentage: 55.6 },
            functions: { total: 12, covered: 8, percentage: 66.7 },
          },
          {
            file: 'src/pages/Home.tsx',
            lines: { total: 100, covered: 60, percentage: 60.0 },
            branches: { total: 15, covered: 8, percentage: 53.3 },
            functions: { total: 10, covered: 6, percentage: 60.0 },
          },
        ],
      }

      setReport(mockReport)
      setIsGenerating(false)
    }, 1500)
  }, [])

  const handleSendToChat = () => {
    if (onSendToChat && report) {
      const lowCoverageFiles = report.files.filter(f => f.lines.percentage < 70)
      const message = `测试覆盖率报告：
总覆盖率: ${report.totalCoverage.toFixed(1)}%
文件数量: ${report.files.length}

低覆盖率文件 (< 70%):
${lowCoverageFiles.map(f => `${f.file}: ${f.lines.percentage.toFixed(1)}%`).join('\n')}

建议: ${lowCoverageFiles.length > 0 ? `${lowCoverageFiles.length}个文件覆盖率较低，建议增加测试用例` : '测试覆盖率良好'}` 
      onSendToChat(message)
    }
  }

  const getCoverageColor = (percentage: number) => {
    if (percentage >= 80) return 'text-green-500'
    if (percentage >= 60) return 'text-yellow-500'
    return 'text-red-500'
  }

  const getCoverageBg = (percentage: number) => {
    if (percentage >= 80) return 'bg-green-500'
    if (percentage >= 60) return 'bg-yellow-500'
    return 'bg-red-500'
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={generateReport}
            disabled={isGenerating}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isGenerating ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isGenerating ? '生成中...' : '生成报告'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          {report && (
            <button
              onClick={handleSendToChat}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-text-secondary bg-background-elevated border border-border rounded-md hover:bg-background-hover transition-colors"
            >
              <Download className="w-4 h-4" />
              发送报告
            </button>
          )}
        </div>
      </div>

      {/* 覆盖率概览 */}
      {report && (
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-text-primary">覆盖率概览</h3>
            <span className="text-xs text-text-muted">{report.timestamp}</span>
          </div>
          
          <div className="grid grid-cols-3 gap-4">
            <div className="p-3 bg-background-elevated border border-border rounded-md">
              <div className="text-xs text-text-muted mb-1">总覆盖率</div>
              <div className={`text-2xl font-bold ${getCoverageColor(report.totalCoverage)}`}>
                {report.totalCoverage.toFixed(1)}%
              </div>
            </div>
            
            <div className="p-3 bg-background-elevated border border-border rounded-md">
              <div className="text-xs text-text-muted mb-1">文件数量</div>
              <div className="text-2xl font-bold text-text-primary">{report.files.length}</div>
            </div>
            
            <div className="p-3 bg-background-elevated border border-border rounded-md">
              <div className="text-xs text-text-muted mb-1">低覆盖率文件</div>
              <div className="text-2xl font-bold text-red-500">
                {report.files.filter(f => f.lines.percentage < 70).length}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 文件覆盖率详情 */}
      <div className="flex-1 overflow-y-auto p-3">
        {!report ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <BarChart3 className="w-12 h-12 text-text-muted mb-3" />
            <div className="text-text-muted text-sm">点击"生成报告"按钮</div>
            <div className="text-text-muted text-xs mt-1">分析项目的测试覆盖率</div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-sm text-text-primary mb-2">文件覆盖率详情</div>
            
            {report.files.map((file, index) => (
              <div
                key={index}
                className={`p-3 border rounded-md cursor-pointer transition-colors ${
                  selectedFile?.file === file.file
                    ? 'bg-primary/10 border-primary/30'
                    : 'bg-background-elevated border-border hover:border-border-hover'
                }`}
                onClick={() => setSelectedFile(file)}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-medium text-text-primary">{file.file}</div>
                  <div className={`text-sm font-bold ${getCoverageColor(file.lines.percentage)}`}>
                    {file.lines.percentage.toFixed(1)}%
                  </div>
                </div>
                
                <div className="space-y-2">
                  {/* 行覆盖率 */}
                  <div>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-text-muted">行覆盖率</span>
                      <span className="text-text-secondary">{file.lines.covered}/{file.lines.total}</span>
                    </div>
                    <div className="w-full h-2 bg-background rounded-full overflow-hidden">
                      <div
                        className={`h-full ${getCoverageBg(file.lines.percentage)}`}
                        style={{ width: `${file.lines.percentage}%` }}
                      />
                    </div>
                  </div>
                  
                  {/* 分支覆盖率 */}
                  <div>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-text-muted">分支覆盖率</span>
                      <span className="text-text-secondary">{file.branches.covered}/{file.branches.total}</span>
                    </div>
                    <div className="w-full h-2 bg-background rounded-full overflow-hidden">
                      <div
                        className={`h-full ${getCoverageBg(file.branches.percentage)}`}
                        style={{ width: `${file.branches.percentage}%` }}
                      />
                    </div>
                  </div>
                  
                  {/* 函数覆盖率 */}
                  <div>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-text-muted">函数覆盖率</span>
                      <span className="text-text-secondary">{file.functions.covered}/{file.functions.total}</span>
                    </div>
                    <div className="w-full h-2 bg-background rounded-full overflow-hidden">
                      <div
                        className={`h-full ${getCoverageBg(file.functions.percentage)}`}
                        style={{ width: `${file.functions.percentage}%` }}
                      />
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