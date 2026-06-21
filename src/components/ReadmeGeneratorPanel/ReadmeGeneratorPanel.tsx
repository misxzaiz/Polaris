import { useState, useCallback } from 'react'
import { Play, RefreshCw, Copy, Download, BookOpen } from 'lucide-react'

interface ReadmeGeneratorPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface ProjectInfo {
  name: string
  description: string
  version: string
  author: string
  license: string
  features: string[]
  installation: string[]
  usage: string[]
}

export function ReadmeGeneratorPanel({ pluginId, onSendToChat }: ReadmeGeneratorPanelProps) {
  const [projectInfo, setProjectInfo] = useState('')
  const [readme, setReadme] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [template, setTemplate] = useState<'basic' | 'detailed' | 'minimal'>('basic')

  const generateReadme = useCallback(() => {
    if (!projectInfo.trim()) return

    setIsGenerating(true)

    // 模拟生成README
    setTimeout(() => {
      const mockReadme = `# My Project

A brief description of what this project does and who it's based on.

## Features

- Feature 1: Description of feature 1
- Feature 2: Description of feature 2
- Feature 3: Description of feature 3

## Installation

\`\`\`bash
npm install my-project
\`\`\`

## Usage

\`\`\`javascript
import { myFunction } from 'my-project';

const result = myFunction();
console.log(result);
\`\`\`

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| option1 | string | 'default' | Description of option1 |
| option2 | number | 42 | Description of option2 |

## API Reference

### myFunction(param1, param2)

Description of the function.

**Parameters:**
- \`param1\` (string): Description of param1
- \`param2\` (number): Description of param2

**Returns:**
- \`Result\`: Description of the return value

## Contributing

Contributions are always welcome!

1. Fork the Project
2. Create your Feature Branch (\`git checkout -b feature/AmazingFeature\`)
3. Commit your Changes (\`git commit -m 'Add some AmazingFeature'\`)
4. Push to the Branch (\`git push origin feature/AmazingFeature\`)
5. Open a Pull Request

## License

Distributed under the MIT License. See \`LICENSE\` for more information.

## Contact

Your Name - @your_twitter - your.email@example.com

Project Link: [https://github.com/yourusername/my-project](https://github.com/yourusername/my-project)`

      setReadme(mockReadme)
      setIsGenerating(false)
    }, 1000)
  }, [projectInfo, template])

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const handleSendToChat = () => {
    if (onSendToChat && readme) {
      const message = `README已生成：
长度: ${readme.length} 字符
行数: ${readme.split('\n').length} 行

内容预览:
${readme.substring(0, 200)}...`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={generateReadme}
            disabled={isGenerating || !projectInfo.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isGenerating ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isGenerating ? '生成中...' : '生成README'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          {readme && (
            <>
              <select
                value={template}
                onChange={(e) => setTemplate(e.target.value as 'basic' | 'detailed' | 'minimal')}
                className="px-2 py-1 text-sm bg-background-elevated border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary text-text-primary"
              >
                <option value="basic">基本模板</option>
                <option value="detailed">详细模板</option>
                <option value="minimal">简洁模板</option>
              </select>
              
              <button
                onClick={() => copyToClipboard(readme)}
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

      {/* 项目信息输入区 */}
      <div className="h-48 p-3 border-b border-border">
        <textarea
          value={projectInfo}
          onChange={(e) => setProjectInfo(e.target.value)}
          placeholder="描述你的项目信息，自动生成README..."
          className="w-full h-full p-3 text-sm font-mono bg-background-elevated border border-border rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-muted"
        />
      </div>

      {/* 生成的README */}
      <div className="flex-1 overflow-y-auto p-3">
        {!readme ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <BookOpen className="w-12 h-12 text-text-muted mb-3" />
            <div className="text-text-muted text-sm">描述项目信息并点击"生成README"按钮</div>
            <div className="text-text-muted text-xs mt-1">支持多种README模板</div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-text-primary">
                <span className="font-medium">README.md</span>
              </div>
              <div className="text-xs text-text-muted">
                {readme.split('\n').length} 行
              </div>
            </div>
            
            <div className="p-3 bg-background-elevated border border-border rounded-md">
              <pre className="text-xs font-mono text-text-secondary whitespace-pre-wrap overflow-x-auto">
                {readme}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}