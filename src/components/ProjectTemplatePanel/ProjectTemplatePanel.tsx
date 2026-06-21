import { useState, useCallback } from 'react'
import { Play, RefreshCw, Copy, Download, Code2 } from 'lucide-react'

interface ProjectTemplatePanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface Template {
  id: string
  name: string
  description: string
  stack: string
  files: { name: string; content: string }[]
}

export function ProjectTemplatePanel({ pluginId, onSendToChat }: ProjectTemplatePanelProps) {
  const [projectName, setProjectName] = useState('')
  const [selectedStack, setSelectedStack] = useState('react')
  const [template, setTemplate] = useState<Template | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [selectedFile, setSelectedFile] = useState<{ name: string; content: string } | null>(null)

  const generateTemplate = useCallback(() => {
    if (!projectName.trim()) return

    setIsGenerating(true)

    // 模拟生成项目模板
    setTimeout(() => {
      const mockTemplate: Template = {
        id: 'template-1',
        name: projectName,
        description: `${projectName} 项目模板`,
        stack: selectedStack,
        files: [
          {
            name: 'package.json',
            content: `{
  "name": "${projectName}",
  "version": "1.0.0",
  "description": "${projectName} project",
  "main": "index.js",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.0.0",
    "vite": "^5.0.0"
  }
}`,
          },
          {
            name: 'src/App.tsx',
            content: `import { useState } from 'react'

function App() {
  const [count, setCount] = useState(0)

  return (
    <div className="App">
      <h1>${projectName}</h1>
      <button onClick={() => setCount(count + 1)}>
        Count: {count}
      </button>
    </div>
  )
}

export default App`,
          },
          {
            name: 'src/main.tsx',
            content: `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)`,
          },
          {
            name: 'index.html',
            content: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${projectName}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`,
          },
          {
            name: 'vite.config.ts',
            content: `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})`,
          },
        ],
      }

      setTemplate(mockTemplate)
      setSelectedFile(mockTemplate.files[0])
      setIsGenerating(false)
    }, 1000)
  }, [projectName, selectedStack])

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const handleSendToChat = () => {
    if (onSendToChat && template) {
      const message = `项目模板已生成：
项目名称: ${template.name}
技术栈: ${template.stack}
文件数量: ${template.files.length}

文件列表:
${template.files.map(f => `- ${f.name}`).join('\n')}`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={generateTemplate}
            disabled={isGenerating || !projectName.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isGenerating ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isGenerating ? '生成中...' : '生成模板'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          {template && (
            <button
              onClick={handleSendToChat}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-text-secondary bg-background-elevated border border-border rounded-md hover:bg-background-hover transition-colors"
            >
              <Download className="w-4 h-4" />
              导出
            </button>
          )}
        </div>
      </div>

      {/* 项目配置 */}
      <div className="p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="项目名称"
            className="flex-1 p-2 text-sm font-mono bg-background-elevated border border-border rounded-md text-text-primary placeholder-text-muted"
          />
          <select
            value={selectedStack}
            onChange={(e) => setSelectedStack(e.target.value)}
            className="px-2 py-2 text-sm bg-background-elevated border border-border rounded-md text-text-primary"
          >
            <option value="react">React</option>
            <option value="vue">Vue</option>
            <option value="angular">Angular</option>
            <option value="svelte">Svelte</option>
          </select>
        </div>
      </div>

      {/* 文件浏览器 */}
      <div className="flex-1 overflow-hidden flex">
        {/* 文件列表 */}
        <div className="w-1/3 border-r border-border overflow-y-auto">
          {template ? (
            <div className="space-y-1 p-2">
              {template.files.map((file) => (
                <button
                  key={file.name}
                  onClick={() => setSelectedFile(file)}
                  className={`w-full text-left p-2 text-xs font-mono rounded transition-colors ${
                    selectedFile?.name === file.name
                      ? 'bg-primary/10 text-primary'
                      : 'text-text-secondary hover:bg-background-hover'
                  }`}
                >
                  {file.name}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-text-muted text-sm">
              暂无文件
            </div>
          )}
        </div>

        {/* 文件内容 */}
        <div className="flex-1 overflow-auto p-3">
          {selectedFile ? (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-mono text-text-primary">{selectedFile.name}</span>
                <button
                  onClick={() => copyToClipboard(selectedFile.content)}
                  className="text-xs text-primary hover:text-primary/80"
                >
                  复制
                </button>
              </div>
              <pre className="text-xs font-mono text-text-secondary bg-background-elevated p-3 rounded-md overflow-x-auto">
                {selectedFile.content}
              </pre>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-text-muted text-sm">
              选择文件查看内容
            </div>
          )}
        </div>
      </div>
    </div>
  )
}