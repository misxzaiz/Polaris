import { useState, useCallback, useEffect, useRef } from 'react'
import { RefreshCw, ZoomIn, ZoomOut, Maximize } from 'lucide-react'

interface DependencyGraphPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface DependencyNode {
  id: string
  name: string
  type: 'file' | 'module' | 'package'
  dependencies: string[]
  dependents: string[]
}

interface GraphData {
  nodes: DependencyNode[]
  edges: { source: string; target: string }[]
}

export function DependencyGraphPanel({ pluginId, onSendToChat }: DependencyGraphPanelProps) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _pluginId = pluginId
  const [graphData, setGraphData] = useState<GraphData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [selectedNode, setSelectedNode] = useState<DependencyNode | null>(null)
  const [zoom, setZoom] = useState(1)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const generateMockData = useCallback(() => {
    setIsLoading(true)
    
    setTimeout(() => {
      const mockNodes: DependencyNode[] = [
        { id: 'app', name: 'App.tsx', type: 'file', dependencies: ['router', 'store'], dependents: [] },
        { id: 'router', name: 'router.ts', type: 'file', dependencies: ['routes'], dependents: ['app'] },
        { id: 'store', name: 'store.ts', type: 'file', dependencies: ['actions', 'reducers'], dependents: ['app'] },
        { id: 'routes', name: 'routes.ts', type: 'file', dependencies: ['pages'], dependents: ['router'] },
        { id: 'actions', name: 'actions.ts', type: 'file', dependencies: ['api'], dependents: ['store'] },
        { id: 'reducers', name: 'reducers.ts', type: 'file', dependencies: [], dependents: ['store'] },
        { id: 'pages', name: 'pages/', type: 'module', dependencies: ['components'], dependents: ['routes'] },
        { id: 'components', name: 'components/', type: 'module', dependencies: ['utils'], dependents: ['pages'] },
        { id: 'api', name: 'api.ts', type: 'file', dependencies: ['utils'], dependents: ['actions'] },
        { id: 'utils', name: 'utils/', type: 'module', dependencies: [], dependents: ['components', 'api'] },
      ]

      const mockEdges: { source: string; target: string }[] = [
        { source: 'app', target: 'router' },
        { source: 'app', target: 'store' },
        { source: 'router', target: 'routes' },
        { source: 'store', target: 'actions' },
        { source: 'store', target: 'reducers' },
        { source: 'routes', target: 'pages' },
        { source: 'actions', target: 'api' },
        { source: 'pages', target: 'components' },
        { source: 'components', target: 'utils' },
        { source: 'api', target: 'utils' },
      ]

      setGraphData({ nodes: mockNodes, edges: mockEdges })
      setIsLoading(false)
    }, 1000)
  }, [])

  useEffect(() => {
    generateMockData()
  }, [generateMockData])

  const drawGraph = useCallback(() => {
    if (!graphData || !canvasRef.current) return

    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const width = canvas.width
    const height = canvas.height

    ctx.clearRect(0, 0, width, height)
    ctx.save()
    ctx.scale(zoom, zoom)

    // 计算节点位置
    const nodePositions: { [key: string]: { x: number; y: number } } = {}
    const nodesPerRow = Math.ceil(Math.sqrt(graphData.nodes.length))
    const nodeSpacing = 120

    graphData.nodes.forEach((node, index) => {
      const row = Math.floor(index / nodesPerRow)
      const col = index % nodesPerRow
      nodePositions[node.id] = {
        x: 100 + col * nodeSpacing,
        y: 100 + row * nodeSpacing,
      }
    })

    // 绘制边
    ctx.strokeStyle = '#6B7280'
    ctx.lineWidth = 1
    graphData.edges.forEach(edge => {
      const sourcePos = nodePositions[edge.source]
      const targetPos = nodePositions[edge.target]
      if (sourcePos && targetPos) {
        ctx.beginPath()
        ctx.moveTo(sourcePos.x, sourcePos.y)
        ctx.lineTo(targetPos.x, targetPos.y)
        ctx.stroke()
      }
    })

    // 绘制节点
    graphData.nodes.forEach(node => {
      const pos = nodePositions[node.id]
      if (!pos) return

      const isSelected = selectedNode?.id === node.id
      const nodeSize = 40

      // 节点背景
      ctx.fillStyle = isSelected ? '#3B82F6' : '#374151'
      ctx.beginPath()
      ctx.arc(pos.x, pos.y, nodeSize / 2, 0, Math.PI * 2)
      ctx.fill()

      // 节点边框
      ctx.strokeStyle = isSelected ? '#60A5FA' : '#4B5563'
      ctx.lineWidth = isSelected ? 2 : 1
      ctx.stroke()

      // 节点文本
      ctx.fillStyle = '#F9FAFB'
      ctx.font = '10px Arial'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(node.name, pos.x, pos.y)
    })

    ctx.restore()
  }, [graphData, zoom, selectedNode])

  useEffect(() => {
    drawGraph()
  }, [drawGraph])

  const handleCanvasClick = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!graphData || !canvasRef.current) return

    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    const x = (event.clientX - rect.left) / zoom
    const y = (event.clientY - rect.top) / zoom

    // 查找点击的节点
    const nodesPerRow = Math.ceil(Math.sqrt(graphData.nodes.length))
    const nodeSpacing = 120

    for (let i = 0; i < graphData.nodes.length; i++) {
      const node = graphData.nodes[i]
      const row = Math.floor(i / nodesPerRow)
      const col = i % nodesPerRow
      const nodeX = 100 + col * nodeSpacing
      const nodeY = 100 + row * nodeSpacing

      const distance = Math.sqrt((x - nodeX) ** 2 + (y - nodeY) ** 2)
      if (distance < 20) {
        setSelectedNode(node)
        return
      }
    }

    setSelectedNode(null)
  }, [graphData, zoom])

  const handleZoomIn = () => setZoom(prev => Math.min(prev + 0.2, 3))
  const handleZoomOut = () => setZoom(prev => Math.max(prev - 0.2, 0.5))
  const handleResetZoom = () => setZoom(1)

  const handleSendToChat = () => {
    if (onSendToChat && graphData) {
      const message = `依赖关系分析：
节点数量: ${graphData.nodes.length}
边数量: ${graphData.edges.length}

关键模块:
${graphData.nodes
  .filter(node => node.dependencies.length > 2 || node.dependents.length > 2)
  .map(node => `${node.name}: ${node.dependencies.length}个依赖, ${node.dependents.length}个被依赖`)
  .join('\n')}

建议: ${graphData.nodes.some(node => node.dependencies.length > 5) ? '存在循环依赖或过度耦合，建议重构' : '依赖关系健康'}`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={generateMockData}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-text-secondary bg-background-elevated border border-border rounded-md hover:bg-background-hover disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>
        
        <div className="flex items-center gap-1">
          <button
            onClick={handleZoomOut}
            className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-md transition-colors"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-xs text-text-muted px-2">{Math.round(zoom * 100)}%</span>
          <button
            onClick={handleZoomIn}
            className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-md transition-colors"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            onClick={handleResetZoom}
            className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-md transition-colors"
          >
            <Maximize className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 图表区域 */}
      <div className="flex-1 overflow-hidden relative">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-text-muted text-sm">加载依赖数据...</div>
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            width={800}
            height={600}
            onClick={handleCanvasClick}
            className="w-full h-full cursor-pointer"
          />
        )}
      </div>

      {/* 节点详情 */}
      {selectedNode && (
        <div className="border-t border-border p-3 bg-background-elevated">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-text-primary">{selectedNode.name}</h3>
            <button
              onClick={() => setSelectedNode(null)}
              className="text-xs text-text-muted hover:text-text-primary"
            >
              关闭
            </button>
          </div>
          
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <div className="text-text-muted mb-1">类型</div>
              <div className="text-text-primary">{selectedNode.type}</div>
            </div>
            <div>
              <div className="text-text-muted mb-1">依赖数</div>
              <div className="text-text-primary">{selectedNode.dependencies.length}</div>
            </div>
            <div>
              <div className="text-text-muted mb-1">被依赖数</div>
              <div className="text-text-primary">{selectedNode.dependents.length}</div>
            </div>
            <div>
              <div className="text-text-muted mb-1">健康度</div>
              <div className={`${
                selectedNode.dependencies.length > 5 ? 'text-red-500' : 
                selectedNode.dependencies.length > 3 ? 'text-yellow-500' : 'text-green-500'
              }`}>
                {selectedNode.dependencies.length > 5 ? '高耦合' : 
                 selectedNode.dependencies.length > 3 ? '中等' : '低耦合'}
              </div>
            </div>
          </div>

          {selectedNode.dependencies.length > 0 && (
            <div className="mt-2">
              <div className="text-xs text-text-muted mb-1">依赖项</div>
              <div className="flex flex-wrap gap-1">
                {selectedNode.dependencies.map(dep => (
                  <span key={dep} className="px-1.5 py-0.5 text-xs bg-background rounded text-text-secondary">
                    {dep}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="mt-3">
            <button
              onClick={handleSendToChat}
              className="w-full px-3 py-1.5 text-xs font-medium text-white bg-primary rounded-md hover:bg-primary/90 transition-colors"
            >
              发送到聊天
            </button>
          </div>
        </div>
      )}
    </div>
  )
}