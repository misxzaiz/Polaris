import { useState, useCallback } from 'react'
import { Play, RefreshCw, Copy, Download, GitPullRequest } from 'lucide-react'

interface ChangelogGeneratorPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface GitCommit {
  hash: string
  message: string
  author: string
  date: string
  type: 'feat' | 'fix' | 'docs' | 'style' | 'refactor' | 'test' | 'chore'
}

interface Changelog {
  version: string
  date: string
  commits: GitCommit[]
}

export function ChangelogGeneratorPanel({ pluginId, onSendToChat }: ChangelogGeneratorPanelProps) {
  const [commits, setCommits] = useState('')
  const [changelog, setChangelog] = useState<Changelog | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [format, setFormat] = useState<'markdown' | 'json'>('markdown')

  const generateChangelog = useCallback(() => {
    if (!commits.trim()) return

    setIsGenerating(true)

    // 模拟生成更新日志
    setTimeout(() => {
      const mockChangelog: Changelog = {
        version: '1.2.0',
        date: new Date().toISOString().split('T')[0],
        commits: [
          {
            hash: 'a1b2c3d',
            message: 'feat: 添加用户认证功能',
            author: 'John Doe',
            date: '2026-06-21',
            type: 'feat',
          },
          {
            hash: 'e4f5g6h',
            message: 'fix: 修复登录页面样式问题',
            author: 'Jane Smith',
            date: '2026-06-20',
            type: 'fix',
          },
          {
            hash: 'i7j8k9l',
            message: 'docs: 更新API文档',
            author: 'John Doe',
            date: '2026-06-19',
            type: 'docs',
          },
          {
            hash: 'm0n1o2p',
            message: 'refactor: 优化数据库查询',
            author: 'Bob Johnson',
            date: '2026-06-18',
            type: 'refactor',
          },
          {
            hash: 'q3r4s5t',
            message: 'test: 添加单元测试',
            author: 'Jane Smith',
            date: '2026-06-17',
            type: 'test',
          },
          {
            hash: 'u6v7w8x',
            message: 'chore: 更新依赖版本',
            author: 'Bob Johnson',
            date: '2026-06-16',
            type: 'chore',
          },
        ],
      }

      setChangelog(mockChangelog)
      setIsGenerating(false)
    }, 1000)
  }, [commits])

  const generateMarkdown = () => {
    if (!changelog) return ''

    let markdown = `# Changelog\n\n`
    markdown += `## [${changelog.version}] - ${changelog.date}\n\n`

    const groupedCommits = {
      feat: changelog.commits.filter(c => c.type === 'feat'),
      fix: changelog.commits.filter(c => c.type === 'fix'),
      docs: changelog.commits.filter(c => c.type === 'docs'),
      refactor: changelog.commits.filter(c => c.type === 'refactor'),
      test: changelog.commits.filter(c => c.type === 'test'),
      chore: changelog.commits.filter(c => c.type === 'chore'),
    }

    if (groupedCommits.feat.length > 0) {
      markdown += `### Features\n\n`
      groupedCommits.feat.forEach(commit => {
        markdown += `- ${commit.message} (${commit.hash})\n`
      })
      markdown += '\n'
    }

    if (groupedCommits.fix.length > 0) {
      markdown += `### Bug Fixes\n\n`
      groupedCommits.fix.forEach(commit => {
        markdown += `- ${commit.message} (${commit.hash})\n`
      })
      markdown += '\n'
    }

    if (groupedCommits.docs.length > 0) {
      markdown += `### Documentation\n\n`
      groupedCommits.docs.forEach(commit => {
        markdown += `- ${commit.message} (${commit.hash})\n`
      })
      markdown += '\n'
    }

    if (groupedCommits.refactor.length > 0) {
      markdown += `### Refactoring\n\n`
      groupedCommits.refactor.forEach(commit => {
        markdown += `- ${commit.message} (${commit.hash})\n`
      })
      markdown += '\n'
    }

    if (groupedCommits.test.length > 0) {
      markdown += `### Tests\n\n`
      groupedCommits.test.forEach(commit => {
        markdown += `- ${commit.message} (${commit.hash})\n`
      })
      markdown += '\n'
    }

    if (groupedCommits.chore.length > 0) {
      markdown += `### Chores\n\n`
      groupedCommits.chore.forEach(commit => {
        markdown += `- ${commit.message} (${commit.hash})\n`
      })
      markdown += '\n'
    }

    return markdown
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const handleSendToChat = () => {
    if (onSendToChat && changelog) {
      const message = `更新日志已生成：
版本: ${changelog.version}
日期: ${changelog.date}
提交数量: ${changelog.commits.length}

提交类型统计:
- 功能 (feat): ${changelog.commits.filter(c => c.type === 'feat').length}
- 修复 (fix): ${changelog.commits.filter(c => c.type === 'fix').length}
- 文档 (docs): ${changelog.commits.filter(c => c.type === 'docs').length}
- 重构 (refactor): ${changelog.commits.filter(c => c.type === 'refactor').length}
- 测试 (test): ${changelog.commits.filter(c => c.type === 'test').length}
- 杂项 (chore): ${changelog.commits.filter(c => c.type === 'chore').length}`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={generateChangelog}
            disabled={isGenerating || !commits.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isGenerating ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isGenerating ? '生成中...' : '生成日志'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          {changelog && (
            <>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as 'markdown' | 'json')}
                className="px-2 py-1 text-sm bg-background-elevated border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary text-text-primary"
              >
                <option value="markdown">Markdown</option>
                <option value="json">JSON</option>
              </select>
              
              <button
                onClick={() => copyToClipboard(generateMarkdown())}
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

      {/* 提交输入区 */}
      <div className="h-48 p-3 border-b border-border">
        <textarea
          value={commits}
          onChange={(e) => setCommits(e.target.value)}
          placeholder="在此粘贴Git提交记录，自动生成更新日志..."
          className="w-full h-full p-3 text-sm font-mono bg-background-elevated border border-border rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-muted"
        />
      </div>

      {/* 生成的日志 */}
      <div className="flex-1 overflow-y-auto p-3">
        {!changelog ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <GitPullRequest className="w-12 h-12 text-text-muted mb-3" />
            <div className="text-text-muted text-sm">粘贴Git提交记录并点击"生成日志"按钮</div>
            <div className="text-text-muted text-xs mt-1">支持Conventional Commits格式</div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-text-primary">
                <span className="font-medium">v{changelog.version}</span> - {changelog.date}
              </div>
              <div className="text-xs text-text-muted">
                {changelog.commits.length} 个提交
              </div>
            </div>
            
            <div className="p-3 bg-background-elevated border border-border rounded-md">
              <pre className="text-xs font-mono text-text-secondary whitespace-pre-wrap">
                {generateMarkdown()}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}