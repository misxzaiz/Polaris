import { useState, useCallback } from 'react'
import { Play, RefreshCw, Copy, Download, Terminal } from 'lucide-react'

interface DeployScriptGeneratorPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface DeployConfig {
  platform: string
  environment: string
  buildCommand: string
  deployCommand: string
}

export function DeployScriptGeneratorPanel({
  pluginId,
  onSendToChat,
}: DeployScriptGeneratorPanelProps) {
  const [config, setConfig] = useState<DeployConfig>({
    platform: 'docker',
    environment: 'production',
    buildCommand: 'npm run build',
    deployCommand: 'docker-compose up -d',
  })
  const [generatedScript, setGeneratedScript] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)

  const generateScript = useCallback(() => {
    setIsGenerating(true)

    // 模拟生成部署脚本
    setTimeout(() => {
      let script = ''

      if (config.platform === 'docker') {
        script = `#!/bin/bash
# Docker 部署脚本
# 环境: ${config.environment}

set -e

echo "开始部署..."

# 构建镜像
echo "构建 Docker 镜像..."
${config.buildCommand}

# 停止旧容器
echo "停止旧容器..."
docker-compose down

# 启动新容器
echo "启动新容器..."
${config.deployCommand}

# 清理未使用的镜像
echo "清理未使用的镜像..."
docker image prune -f

echo "部署完成！"
`
      } else if (config.platform === 'kubernetes') {
        script = `#!/bin/bash
# Kubernetes 部署脚本
# 环境: ${config.environment}

set -e

echo "开始部署到 Kubernetes..."

# 构建镜像
echo "构建 Docker 镜像..."
${config.buildCommand}

# 推送镜像到仓库
echo "推送镜像到仓库..."
docker push myregistry.com/myapp:latest

# 应用 Kubernetes 配置
echo "应用 Kubernetes 配置..."
kubectl apply -f k8s/

# 等待部署完成
echo "等待部署完成..."
kubectl rollout status deployment/myapp

echo "部署完成！"
`
      } else {
        script = `#!/bin/bash
# 部署脚本
# 环境: ${config.environment}

set -e

echo "开始部署..."

# 构建
echo "构建项目..."
${config.buildCommand}

# 部署
echo "部署项目..."
${config.deployCommand}

echo "部署完成！"
`
      }

      setGeneratedScript(script)
      setIsGenerating(false)
    }, 500)
  }, [config])

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const handleSendToChat = () => {
    if (onSendToChat && generatedScript) {
      const message = `部署脚本已生成：
平台: ${config.platform}
环境: ${config.environment}

脚本内容:
${generatedScript}`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={generateScript}
            disabled={isGenerating}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isGenerating ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isGenerating ? '生成中...' : '生成脚本'}
          </button>
        </div>

        <div className="flex items-center gap-2">
          {generatedScript && (
            <>
              <button
                onClick={() => copyToClipboard(generatedScript)}
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
                导出
              </button>
            </>
          )}
        </div>
      </div>

      {/* 配置区域 */}
      <div className="p-3 border-b border-border space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm text-text-primary mb-1 block">部署平台</label>
            <select
              value={config.platform}
              onChange={(e) => setConfig({ ...config, platform: e.target.value })}
              className="w-full p-2 text-sm bg-background-elevated border border-border rounded-md text-text-primary"
            >
              <option value="docker">Docker</option>
              <option value="kubernetes">Kubernetes</option>
              <option value="vercel">Vercel</option>
              <option value="netlify">Netlify</option>
              <option value="custom">自定义</option>
            </select>
          </div>
          <div>
            <label className="text-sm text-text-primary mb-1 block">环境</label>
            <select
              value={config.environment}
              onChange={(e) => setConfig({ ...config, environment: e.target.value })}
              className="w-full p-2 text-sm bg-background-elevated border border-border rounded-md text-text-primary"
            >
              <option value="development">开发环境</option>
              <option value="staging">预发布环境</option>
              <option value="production">生产环境</option>
            </select>
          </div>
        </div>

        <div>
          <label className="text-sm text-text-primary mb-1 block">构建命令</label>
          <input
            type="text"
            value={config.buildCommand}
            onChange={(e) => setConfig({ ...config, buildCommand: e.target.value })}
            className="w-full p-2 text-sm font-mono bg-background-elevated border border-border rounded-md text-text-primary"
          />
        </div>

        <div>
          <label className="text-sm text-text-primary mb-1 block">部署命令</label>
          <input
            type="text"
            value={config.deployCommand}
            onChange={(e) => setConfig({ ...config, deployCommand: e.target.value })}
            className="w-full p-2 text-sm font-mono bg-background-elevated border border-border rounded-md text-text-primary"
          />
        </div>
      </div>

      {/* 生成的脚本 */}
      <div className="flex-1 overflow-y-auto p-3">
        {generatedScript ? (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-text-primary">生成的部署脚本</span>
            </div>
            <pre className="p-3 text-xs font-mono bg-background-elevated border border-border rounded-md text-text-secondary overflow-x-auto whitespace-pre-wrap">
              {generatedScript}
            </pre>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Terminal className="w-12 h-12 text-text-muted mb-3" />
            <div className="text-text-muted text-sm">配置参数并点击"生成脚本"</div>
            <div className="text-text-muted text-xs mt-1">支持 Docker、Kubernetes 等多种部署方式</div>
          </div>
        )}
      </div>
    </div>
  )
}