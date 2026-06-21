import { useState, useCallback } from 'react'
import { Play, RefreshCw, Copy, Download, Terminal } from 'lucide-react'

interface QueryBuilderPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface QueryCondition {
  field: string
  operator: string
  value: string
  logic: 'AND' | 'OR'
}

export function QueryBuilderPanel({ pluginId, onSendToChat }: QueryBuilderPanelProps) {
  const [table, setTable] = useState('')
  const [columns, setColumns] = useState('*')
  const [conditions, setConditions] = useState<QueryCondition[]>([])
  const [generatedQuery, setGeneratedQuery] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)

  const addCondition = () => {
    setConditions([...conditions, { field: '', operator: '=', value: '', logic: 'AND' }])
  }

  const updateCondition = (index: number, updates: Partial<QueryCondition>) => {
    const newConditions = [...conditions]
    newConditions[index] = { ...newConditions[index], ...updates }
    setConditions(newConditions)
  }

  const removeCondition = (index: number) => {
    setConditions(conditions.filter((_, i) => i !== index))
  }

  const generateQuery = useCallback(() => {
    if (!table.trim()) return

    setIsGenerating(true)

    setTimeout(() => {
      let query = `SELECT ${columns} FROM ${table}`
      
      if (conditions.length > 0) {
        const conditionStrings = conditions.map((condition, index) => {
          if (index === 0) {
            return `${condition.field} ${condition.operator} '${condition.value}'`
          }
          return `${condition.logic} ${condition.field} ${condition.operator} '${condition.value}'`
        })
        query += ` WHERE ${conditionStrings.join(' ')}`
      }

      setGeneratedQuery(query)
      setIsGenerating(false)
    }, 500)
  }, [table, columns, conditions])

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const handleSendToChat = () => {
    if (onSendToChat && generatedQuery) {
      const message = `生成的SQL查询：
${generatedQuery}

说明：这是一个可视化构建的SQL查询语句。`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={generateQuery}
            disabled={isGenerating || !table.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isGenerating ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isGenerating ? '生成中...' : '生成查询'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          {generatedQuery && (
            <>
              <button
                onClick={() => copyToClipboard(generatedQuery)}
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

      {/* 查询构建器 */}
      <div className="flex-1 overflow-y-auto p-3">
        <div className="space-y-4">
          {/* 表名 */}
          <div>
            <label className="text-sm text-text-primary mb-2 block">表名</label>
            <input
              type="text"
              value={table}
              onChange={(e) => setTable(e.target.value)}
              placeholder="输入表名..."
              className="w-full p-2 text-sm font-mono bg-background-elevated border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-muted"
            />
          </div>

          {/* 列选择 */}
          <div>
            <label className="text-sm text-text-primary mb-2 block">列</label>
            <input
              type="text"
              value={columns}
              onChange={(e) => setColumns(e.target.value)}
              placeholder="* (所有列) 或列名列表..."
              className="w-full p-2 text-sm font-mono bg-background-elevated border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-muted"
            />
          </div>

          {/* 条件构建 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-text-primary">条件</label>
              <button
                onClick={addCondition}
                className="text-xs text-primary hover:text-primary/80"
              >
                + 添加条件
              </button>
            </div>
            
            {conditions.map((condition, index) => (
              <div key={index} className="flex items-center gap-2 mb-2">
                {index > 0 && (
                  <select
                    value={condition.logic}
                    onChange={(e) => updateCondition(index, { logic: e.target.value as 'AND' | 'OR' })}
                    className="px-2 py-1 text-xs bg-background-elevated border border-border rounded-md text-text-primary"
                  >
                    <option value="AND">AND</option>
                    <option value="OR">OR</option>
                  </select>
                )}
                <input
                  type="text"
                  value={condition.field}
                  onChange={(e) => updateCondition(index, { field: e.target.value })}
                  placeholder="字段名"
                  className="flex-1 p-1 text-xs font-mono bg-background-elevated border border-border rounded-md text-text-primary placeholder-text-muted"
                />
                <select
                  value={condition.operator}
                  onChange={(e) => updateCondition(index, { operator: e.target.value })}
                  className="px-2 py-1 text-xs bg-background-elevated border border-border rounded-md text-text-primary"
                >
                  <option value="=">=</option>
                  <option value="!=">!=</option>
                  <option value=">">{'>'}</option>
                  <option value="<">{'<'}</option>
                  <option value=">=">{'>='}</option>
                  <option value="<=">{'<='}</option>
                  <option value="LIKE">LIKE</option>
                  <option value="IN">IN</option>
                </select>
                <input
                  type="text"
                  value={condition.value}
                  onChange={(e) => updateCondition(index, { value: e.target.value })}
                  placeholder="值"
                  className="flex-1 p-1 text-xs font-mono bg-background-elevated border border-border rounded-md text-text-primary placeholder-text-muted"
                />
                <button
                  onClick={() => removeCondition(index)}
                  className="text-red-500 hover:text-red-400 text-xs"
                >
                  删除
                </button>
              </div>
            ))}
          </div>

          {/* 生成的查询 */}
          {generatedQuery && (
            <div>
              <label className="text-sm text-text-primary mb-2 block">生成的SQL查询</label>
              <pre className="p-3 text-xs font-mono bg-background-elevated border border-border rounded-md text-text-secondary overflow-x-auto">
                {generatedQuery}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}