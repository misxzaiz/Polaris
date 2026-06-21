import { useState, useCallback } from 'react'
import { Play, RefreshCw, Terminal, Container, Image } from 'lucide-react'

interface DockerManagerPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface Container {
  id: string
  name: string
  image: string
  status: 'running' | 'stopped' | 'paused'
  ports: string[]
}

interface Image {
  id: string
  name: string
  tag: string
  size: string
}

export function DockerManagerPanel({ pluginId, onSendToChat }: DockerManagerPanelProps) {
  const [containers, setContainers] = useState<Container[]>([])
  const [images, setImages] = useState<Image[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'containers' | 'images'>('containers')

  const loadDockerData = useCallback(() => {
    setIsLoading(true)

    // 模拟Docker数据加载
    setTimeout(() => {
      const mockContainers: Container[] = [
        {
          id: 'abc123',
          name: 'web-app',
          image: 'nginx:latest',
          status: 'running',
          ports: ['80:80', '443:443'],
        },
        {
          id: 'def456',
          name: 'database',
          image: 'postgres:13',
          status: 'running',
          ports: ['5432:5432'],
        },
        {
          id: 'ghi789',
          name: 'redis-cache',
          image: 'redis:6',
          status: 'stopped',
          ports: ['6379:6379'],
        },
      ]

      const mockImages: Image[] = [
        {
          id: 'img1',
          name: 'nginx',
          tag: 'latest',
          size: '133MB',
        },
        {
          id: 'img2',
          name: 'postgres',
          tag: '13',
          size: '312MB',
        },
        {
          id: 'img3',
          name: 'redis',
          tag: '6',
          size: '104MB',
        },
        {
          id: 'img4',
          name: 'node',
          tag: '16-alpine',
          size: '112MB',
        },
      ]

      setContainers(mockContainers)
      setImages(mockImages)
      setIsLoading(false)
    }, 1000)
  }, [])

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running':
        return 'bg-green-500/10 text-green-500 border-green-500/30'
      case 'stopped':
        return 'bg-red-500/10 text-red-500 border-red-500/30'
      case 'paused':
        return 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30'
      default:
        return 'bg-gray-500/10 text-gray-500 border-gray-500/30'
    }
  }

  const handleSendToChat = () => {
    if (onSendToChat) {
      const message = `Docker状态：
容器数量: ${containers.length}
- 运行中: ${containers.filter(c => c.status === 'running').length}
- 已停止: ${containers.filter(c => c.status === 'stopped').length}

镜像数量: ${images.length}
总大小: ${images.reduce((sum, img) => sum + parseInt(img.size), 0)}MB`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={loadDockerData}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isLoading ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isLoading ? '加载中...' : '刷新数据'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          <button
            onClick={handleSendToChat}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-text-secondary bg-background-elevated border border-border rounded-md hover:bg-background-hover transition-colors"
          >
            发送状态
          </button>
        </div>
      </div>

      {/* 标签页 */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setActiveTab('containers')}
          className={`flex-1 px-3 py-2 text-sm ${
            activeTab === 'containers' ? 'text-primary border-b-2 border-primary' : 'text-text-muted'
          }`}
        >
          容器
        </button>
        <button
          onClick={() => setActiveTab('images')}
          className={`flex-1 px-3 py-2 text-sm ${
            activeTab === 'images' ? 'text-primary border-b-2 border-primary' : 'text-text-muted'
          }`}
        >
          镜像
        </button>
      </div>

      {/* 内容区域 */}
      <div className="flex-1 overflow-y-auto p-3">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-text-muted text-sm">加载Docker数据...</div>
          </div>
        ) : (
          <>
            {activeTab === 'containers' && (
              <div className="space-y-3">
                {containers.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-center">
                    <Container className="w-12 h-12 text-text-muted mb-3" />
                    <div className="text-text-muted text-sm">点击"刷新数据"加载容器列表</div>
                  </div>
                ) : (
                  containers.map((container) => (
                    <div
                      key={container.id}
                      className={`p-3 border rounded-md ${getStatusColor(container.status)}`}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm font-medium text-text-primary">{container.name}</div>
                          <div className="text-xs text-text-muted">{container.image}</div>
                        </div>
                        <div className="text-xs text-text-muted">{container.status}</div>
                      </div>
                      {container.ports.length > 0 && (
                        <div className="mt-2 text-xs text-text-muted">
                          端口: {container.ports.join(', ')}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}

            {activeTab === 'images' && (
              <div className="space-y-3">
                {images.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-center">
                    <Image className="w-12 h-12 text-text-muted mb-3" />
                    <div className="text-text-muted text-sm">点击"刷新数据"加载镜像列表</div>
                  </div>
                ) : (
                  images.map((image) => (
                    <div
                      key={image.id}
                      className="p-3 bg-background-elevated border border-border rounded-md"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm font-medium text-text-primary">{image.name}</div>
                          <div className="text-xs text-text-muted">Tag: {image.tag}</div>
                        </div>
                        <div className="text-xs text-text-muted">{image.size}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}