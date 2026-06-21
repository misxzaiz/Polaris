import { useState, useCallback } from 'react'
import { Play, RefreshCw, Database, Table, Key, Relationship } from 'lucide-react'

interface DatabaseSchemaViewerPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface TableSchema {
  name: string
  columns: { name: string; type: string; nullable: boolean; isPrimaryKey: boolean }[]
  indexes: string[]
}

interface DatabaseSchema {
  tables: TableSchema[]
  relationships: { from: string; to: string; type: string }[]
}

export function DatabaseSchemaViewerPanel({ pluginId, onSendToChat }: DatabaseSchemaViewerPanelProps) {
  const [connectionString, setConnectionString] = useState('')
  const [schema, setSchema] = useState<DatabaseSchema | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [selectedTable, setSelectedTable] = useState<TableSchema | null>(null)

  const connectToDatabase = useCallback(() => {
    if (!connectionString.trim()) return

    setIsConnecting(true)

    // 模拟数据库连接
    setTimeout(() => {
      const mockSchema: DatabaseSchema = {
        tables: [
          {
            name: 'users',
            columns: [
              { name: 'id', type: 'INT', nullable: false, isPrimaryKey: true },
              { name: 'username', type: 'VARCHAR(50)', nullable: false, isPrimaryKey: false },
              { name: 'email', type: 'VARCHAR(100)', nullable: false, isPrimaryKey: false },
              { name: 'created_at', type: 'TIMESTAMP', nullable: false, isPrimaryKey: false },
            ],
            indexes: ['idx_users_email', 'idx_users_username'],
          },
          {
            name: 'posts',
            columns: [
              { name: 'id', type: 'INT', nullable: false, isPrimaryKey: true },
              { name: 'title', type: 'VARCHAR(200)', nullable: false, isPrimaryKey: false },
              { name: 'content', type: 'TEXT', nullable: true, isPrimaryKey: false },
              { name: 'user_id', type: 'INT', nullable: false, isPrimaryKey: false },
              { name: 'created_at', type: 'TIMESTAMP', nullable: false, isPrimaryKey: false },
            ],
            indexes: ['idx_posts_user_id', 'idx_posts_created_at'],
          },
          {
            name: 'comments',
            columns: [
              { name: 'id', type: 'INT', nullable: false, isPrimaryKey: true },
              { name: 'content', type: 'TEXT', nullable: false, isPrimaryKey: false },
              { name: 'post_id', type: 'INT', nullable: false, isPrimaryKey: false },
              { name: 'user_id', type: 'INT', nullable: false, isPrimaryKey: false },
              { name: 'created_at', type: 'TIMESTAMP', nullable: false, isPrimaryKey: false },
            ],
            indexes: ['idx_comments_post_id', 'idx_comments_user_id'],
          },
        ],
        relationships: [
          { from: 'posts.user_id', to: 'users.id', type: 'ONE_TO_MANY' },
          { from: 'comments.post_id', to: 'posts.id', type: 'ONE_TO_MANY' },
          { from: 'comments.user_id', to: 'users.id', type: 'ONE_TO_MANY' },
        ],
      }

      setSchema(mockSchema)
      setIsConnecting(false)
    }, 1500)
  }, [connectionString])

  const handleSendToChat = () => {
    if (onSendToChat && schema) {
      const message = `数据库Schema分析：
表数量: ${schema.tables.length}
关系数量: ${schema.relationships.length}

表列表:
${schema.tables.map(t => `- ${t.name}: ${t.columns.length} 列`).join('\n')}

关系:
${schema.relationships.map(r => `- ${r.from} → ${r.to} (${r.type})`).join('\n')}`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={connectToDatabase}
            disabled={isConnecting || !connectionString.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isConnecting ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Database className="w-4 h-4" />
            )}
            {isConnecting ? '连接中...' : '连接数据库'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          {schema && (
            <button
              onClick={handleSendToChat}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-text-secondary bg-background-elevated border border-border rounded-md hover:bg-background-hover transition-colors"
            >
              发送分析
            </button>
          )}
        </div>
      </div>

      {/* 连接字符串输入区 */}
      <div className="h-32 p-3 border-b border-border">
        <input
          type="text"
          value={connectionString}
          onChange={(e) => setConnectionString(e.target.value)}
          placeholder="输入数据库连接字符串..."
          className="w-full p-3 text-sm font-mono bg-background-elevated border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-muted"
        />
      </div>

      {/* Schema查看器 */}
      <div className="flex-1 overflow-y-auto p-3">
        {!schema ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Database className="w-12 h-12 text-text-muted mb-3" />
            <div className="text-text-muted text-sm">输入连接字符串并点击"连接数据库"按钮</div>
            <div className="text-text-muted text-xs mt-1">查看和分析数据库结构</div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* 表列表 */}
            <div className="space-y-2">
              <div className="text-sm text-text-primary mb-2">数据库表</div>
              {schema.tables.map((table) => (
                <div
                  key={table.name}
                  className={`p-3 border rounded-md cursor-pointer transition-colors ${
                    selectedTable?.name === table.name
                      ? 'bg-primary/10 border-primary/30'
                      : 'bg-background-elevated border-border hover:border-border-hover'
                  }`}
                  onClick={() => setSelectedTable(table)}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Table className="w-4 h-4 text-text-muted" />
                    <span className="text-sm font-medium text-text-primary">{table.name}</span>
                    <span className="text-xs text-text-muted">{table.columns.length} 列</span>
                  </div>
                  
                  {selectedTable?.name === table.name && (
                    <div className="mt-3 space-y-2">
                      <div className="text-xs text-text-muted mb-1">列信息</div>
                      <div className="space-y-1">
                        {table.columns.map((column) => (
                          <div key={column.name} className="flex items-center gap-2 text-xs">
                            {column.isPrimaryKey && <Key className="w-3 h-3 text-yellow-500" />}
                            <span className="font-mono text-text-primary">{column.name}</span>
                            <span className="text-text-muted">{column.type}</span>
                            {!column.nullable && <span className="text-red-500 text-xs">NOT NULL</span>}
                          </div>
                        ))}
                      </div>
                      
                      {table.indexes.length > 0 && (
                        <div className="mt-2">
                          <div className="text-xs text-text-muted mb-1">索引</div>
                          <div className="space-y-1">
                            {table.indexes.map((index) => (
                              <div key={index} className="text-xs text-text-secondary font-mono">
                                {index}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* 关系图 */}
            <div className="space-y-2">
              <div className="text-sm text-text-primary mb-2">表关系</div>
              {schema.relationships.map((relationship, index) => (
                <div
                  key={index}
                  className="p-2 bg-background-elevated border border-border rounded-md"
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-text-primary">{relationship.from}</span>
                    <Relationship className="w-3 h-3 text-text-muted" />
                    <span className="font-mono text-text-primary">{relationship.to}</span>
                    <span className="text-text-muted">({relationship.type})</span>
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