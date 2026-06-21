import { useState, useCallback } from 'react'
import { Play, RefreshCw, Trash2, Eye } from 'lucide-react'

interface DeadCodeDetectorPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface DeadCodeItem {
  id: string
  type: 'function' | 'variable' | 'import' | 'class' | 'interface'
  name: string
  file: string
  line: number
  reason: string
  severity: 'error' | 'warning' | 'info'
}

export function DeadCodeDetectorPanel({ pluginId, onSendToChat }: DeadCodeDetectorPanelProps) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _pluginId = pluginId
  const [code, setCode] = useState('')
  const [results, setResults] = useState<DeadCodeItem[]>([])
  const [isScanning, setIsScanning] = useState(false)
  const [selectedItems, setSelectedItems] = useState<string[]>([])

  const scanCode = useCallback(() => {
    if (!code.trim()) return

    setIsScanning(true)

    // 模拟死代码检测
    setTimeout(() => {
      const lines = code.split('\n')
      const deadCodeItems: DeadCodeItem[] = []

      // 简单检测未使用的函数
      const functionRegex = /function\s+(\w+)/g
      const usedFunctions = new Set<string>()
      const definedFunctions = new Map<string, number>()

      // 收集所有函数定义
      lines.forEach((line, index) => {
        const match = line.match(functionRegex)
        if (match) {
          match.forEach(m => {
            const funcName = m.replace('function ', '')
            definedFunctions.set(funcName, index + 1)
          })
        }
      })

      // 检查函数使用情况
      code.replace(functionRegex, '').split(/\s+/).forEach(word => {
        if (word) usedFunctions.add(word)
      })

      // 找出未使用的函数
      definedFunctions.forEach((lineNum, funcName) => {
        if (!usedFunctions.has(funcName)) {
          deadCodeItems.push({
            id: `func-${funcName}`,
            type: 'function',
            name: funcName,
            file: 'current-file',
            line: lineNum,
            reason: '函数未被调用',
            severity: 'warning',
          })
        }
      })

      // 检测未使用的变量
      const variableRegex = /(?:const|let|var)\s+(\w+)/g
      const usedVariables = new Set<string>()
      const definedVariables = new Map<string, number>()

      lines.forEach((line, index) => {
        const matches = line.matchAll(variableRegex)
        for (const match of matches) {
          const varName = match[1]
          definedVariables.set(varName, index + 1)
        }
      })

      // 检查变量使用情况
      code.replace(variableRegex, '').split(/\s+/).forEach(word => {
        if (word) usedVariables.add(word)
      })

      definedVariables.forEach((lineNum, varName) => {
        if (!usedVariables.has(varName)) {
          deadCodeItems.push({
            id: `var-${varName}`,
            type: 'variable',
            name: varName,
            file: 'current-file',
            line: lineNum,
            reason: '变量未被使用',
            severity: 'info',
          })
        }
      })

      // 检测未使用的导入
      const importRegex = /import\s+.*?from\s+['"]([^'"]+)['"]/g
      lines.forEach((line, index) => {
        const match = line.match(importRegex)
        if (match) {
          deadCodeItems.push({
            id: `import-${index}`,
            type: 'import',
            name: match[0].substring(0, 50) + '...',
            file: 'current-file',
            line: index + 1,
            reason: '导入可能未被使用',
            severity: 'info',
          })
        }
      })

      setResults(deadCodeItems)
      setIsScanning(false)
    }, 800)
  }, [code])

  const toggleItemSelection = (itemId: string) => {
    setSelectedItems(prev => 
      prev.includes(itemId) 
        ? prev.filter(id => id !== itemId)
        : [...prev, itemId]
    )
  }

  const selectAll = () => {
    setSelectedItems(results.map(item => item.id))
  }

  const deselectAll = () => {
    setSelectedItems([])
  }

  const handleRemoveSelected = () => {
    if (selectedItems.length === 0) return

    const removedItems = results.filter(item => selectedItems.includes(item.id))
    setResults(prev => prev.filter(item => !selectedItems.includes(item.id)))
    setSelectedItems([])

    if (onSendToChat) {
      const message = `已标记移除 ${removedItems.length} 个死代码项：
${removedItems.map(item => `${item.type}: ${item.name} (${item.file}:${item.line})`).join('\n')}`
      onSendToChat(message)
    }
  }

  const handleSendToChat = () => {
    if (onSendToChat && results.length > 0) {
      const message = `死代码检测结果：
发现 ${results.length} 个潜在死代码项

按类型统计：
- 函数: ${results.filter(r => r.type === 'function').length}
- 变量: ${results.filter(r => r.type === 'variable').length}
- 导入: ${results.filter(r => r.type === 'import').length}
- 类: ${results.filter(r => r.type === 'class').length}
- 接口: ${results.filter(r => r.type === 'interface').length}

建议: ${results.filter(r => r.severity === 'error').length > 0 ? '存在严重死代码问题，建议立即清理' : 
  results.filter(r => r.severity === 'warning').length > 5 ? '死代码较多，建议定期清理' : 
  '代码库相对干净'}`
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
              <Play className="w-4 h-4" />
            )}
            {isScanning ? '扫描中...' : '扫描'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          <button
            onClick={selectAll}
            className="px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-background-hover rounded transition-colors"
          >
            全选
          </button>
          <button
            onClick={deselectAll}
            className="px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-background-hover rounded transition-colors"
          >
            取消全选
          </button>
          <button
            onClick={handleRemoveSelected}
            disabled={selectedItems.length === 0}
            className="flex items-center gap-1 px-2 py-1 text-xs text-red-500 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Trash2 className="w-3 h-3" />
            移除选中 ({selectedItems.length})
          </button>
        </div>
      </div>

      {/* 代码输入区 */}
      <div className="h-48 p-3 border-b border-border">
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="在此粘贴代码进行死代码检测..."
          className="w-full h-full p-3 text-sm font-mono bg-background-elevated border border-border rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-muted"
        />
      </div>

      {/* 检测结果 */}
      <div className="flex-1 overflow-y-auto p-3">
        {results.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-text-muted text-sm">粘贴代码并点击"扫描"按钮</div>
            <div className="text-text-muted text-xs mt-1">检测未使用的函数、变量、导入等</div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm text-text-primary">
                发现 <span className="font-medium">{results.length}</span> 个死代码项
              </div>
              <button
                onClick={handleSendToChat}
                className="text-xs text-primary hover:text-primary/80"
              >
                发送报告到聊天
              </button>
            </div>
            
            {results.map((item) => (
              <div
                key={item.id}
                className={`p-3 border rounded-md cursor-pointer transition-colors ${
                  selectedItems.includes(item.id)
                    ? 'bg-primary/10 border-primary/30'
                    : 'bg-background-elevated border-border hover:border-border-hover'
                }`}
                onClick={() => toggleItemSelection(item.id)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedItems.includes(item.id)}
                      onChange={() => toggleItemSelection(item.id)}
                      className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary">{item.name}</span>
                        <span className={`px-1.5 py-0.5 text-xs rounded ${
                          item.severity === 'error' ? 'bg-red-500/10 text-red-500' :
                          item.severity === 'warning' ? 'bg-yellow-500/10 text-yellow-500' :
                          'bg-blue-500/10 text-blue-500'
                        }`}>
                          {item.severity}
                        </span>
                        <span className="px-1.5 py-0.5 text-xs bg-background rounded text-text-muted">
                          {item.type}
                        </span>
                      </div>
                      <div className="text-xs text-text-muted mt-1">
                        {item.file}:{item.line} - {item.reason}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      // 预览功能
                    }}
                    className="p-1 text-text-muted hover:text-text-primary hover:bg-background-hover rounded transition-colors"
                  >
                    <Eye className="w-4 h-4" />
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