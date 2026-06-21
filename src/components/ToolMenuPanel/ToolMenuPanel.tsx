import { useState } from 'react'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'

interface ToolItem {
  id: string
  name: string
  description: string
  icon: string
  category: string
  action?: () => void
}

interface ToolCategory {
  id: string
  name: string
  icon: string
  tools: ToolItem[]
}

interface ToolMenuPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

const toolCategories: ToolCategory[] = [
  {
    id: 'code-analysis',
    name: '代码分析',
    icon: 'Code2',
    tools: [
      {
        id: 'complexity-analyzer',
        name: '代码复杂度分析',
        description: '分析代码圈复杂度、认知复杂度',
        icon: 'Activity',
        category: 'code-analysis',
      },
      {
        id: 'dependency-graph',
        name: '依赖关系图',
        description: '可视化模块依赖关系',
        icon: 'GitGraph',
        category: 'code-analysis',
      },
      {
        id: 'dead-code-detector',
        name: '死代码检测',
        description: '检测未使用的代码和导入',
        icon: 'AlertCircle',
        category: 'code-analysis',
      },
    ],
  },
  {
    id: 'testing',
    name: '测试工具',
    icon: 'CheckSquare',
    tools: [
      {
        id: 'test-coverage',
        name: '测试覆盖率报告',
        description: '生成和查看测试覆盖率',
        icon: 'ClipboardList',
        category: 'testing',
      },
      {
        id: 'test-generator',
        name: '测试用例生成',
        description: '基于代码生成测试用例',
        icon: 'Bot',
        category: 'testing',
      },
      {
        id: 'mutation-testing',
        name: '变异测试',
        description: '通过修改代码验证测试质量',
        icon: 'Activity',
        category: 'testing',
      },
    ],
  },
  {
    id: 'security',
    name: '安全工具',
    icon: 'AlertCircle',
    tools: [
      {
        id: 'vulnerability-scanner',
        name: '漏洞扫描',
        description: '扫描代码中的安全漏洞',
        icon: 'AlertCircle',
        category: 'security',
      },
      {
        id: 'dependency-audit',
        name: '依赖审计',
        description: '检查依赖包的安全问题',
        icon: 'CheckSquare',
        category: 'security',
      },
      {
        id: 'secret-scanner',
        name: '密钥扫描',
        description: '检测代码中的硬编码密钥',
        icon: 'Target',
        category: 'security',
      },
    ],
  },
  {
    id: 'performance',
    name: '性能工具',
    icon: 'Activity',
    tools: [
      {
        id: 'bundle-analyzer',
        name: '包大小分析',
        description: '分析前端包大小和组成',
        icon: 'Activity',
        category: 'performance',
      },
      {
        id: 'performance-profiler',
        name: '性能分析',
        description: '分析代码执行性能',
        icon: 'Activity',
        category: 'performance',
      },
      {
        id: 'memory-leak-detector',
        name: '内存泄漏检测',
        description: '检测潜在的内存泄漏',
        icon: 'Activity',
        category: 'performance',
      },
    ],
  },
  {
    id: 'documentation',
    name: '文档工具',
    icon: 'BookOpen',
    tools: [
      {
        id: 'api-doc-generator',
        name: 'API文档生成',
        description: '从代码生成API文档',
        icon: 'BookOpen',
        category: 'documentation',
      },
      {
        id: 'changelog-generator',
        name: '更新日志生成',
        description: '从Git提交生成更新日志',
        icon: 'GitPullRequest',
        category: 'documentation',
      },
      {
        id: 'readme-generator',
        name: 'README生成',
        description: '为项目生成README文件',
        icon: 'BookOpen',
        category: 'documentation',
      },
    ],
  },
  {
    id: 'development',
    name: '开发工具',
    icon: 'Terminal',
    tools: [
      {
        id: 'code-formatter',
        name: '代码格式化',
        description: '格式化代码风格',
        icon: 'Code2',
        category: 'development',
      },
      {
        id: 'code-transformer',
        name: '代码转换',
        description: '在不同语法间转换代码',
        icon: 'Code2',
        category: 'development',
      },
      {
        id: 'snippet-manager',
        name: '代码片段管理',
        description: '管理和复用代码片段',
        icon: 'ClipboardList',
        category: 'development',
      },
    ],
  },
  {
    id: 'database',
    name: '数据库工具',
    icon: 'Database',
    tools: [
      {
        id: 'schema-viewer',
        name: '数据库Schema查看',
        description: '查看和分析数据库结构',
        icon: 'Database',
        category: 'database',
      },
      {
        id: 'query-builder',
        name: '查询构建器',
        description: '可视化构建SQL查询',
        icon: 'Terminal',
        category: 'database',
      },
      {
        id: 'data-migration',
        name: '数据迁移工具',
        description: '管理数据库迁移',
        icon: 'GitPullRequest',
        category: 'database',
      },
    ],
  },
  {
    id: 'devops',
    name: 'DevOps工具',
    icon: 'Terminal',
    tools: [
      {
        id: 'docker-manager',
        name: 'Docker管理',
        description: '管理Docker容器和镜像',
        icon: 'Terminal',
        category: 'devops',
      },
      {
        id: 'ci-cd-pipeline',
        name: 'CI/CD管道',
        description: '管理持续集成/部署管道',
        icon: 'GitPullRequest',
        category: 'devops',
      },
      {
        id: 'environment-manager',
        name: '环境管理',
        description: '管理开发环境配置',
        icon: 'Terminal',
        category: 'devops',
      },
    ],
  },
]

export function ToolMenuPanel({ pluginId, onSendToChat }: ToolMenuPanelProps) {
  const [expandedCategories, setExpandedCategories] = useState<string[]>(['code-analysis'])
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedTool, setSelectedTool] = useState<ToolItem | null>(null)

  const toggleCategory = (categoryId: string) => {
    setExpandedCategories((prev) =>
      prev.includes(categoryId)
        ? prev.filter((id) => id !== categoryId)
        : [...prev, categoryId]
    )
  }

  const filteredCategories = toolCategories
    .map((category) => ({
      ...category,
      tools: category.tools.filter(
        (tool) =>
          tool.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          tool.description.toLowerCase().includes(searchQuery.toLowerCase())
      ),
    }))
    .filter((category) => category.tools.length > 0)

  const handleToolClick = (tool: ToolItem) => {
    setSelectedTool(tool)
    if (onSendToChat) {
      onSendToChat(`使用工具: ${tool.name}`)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 搜索栏 */}
      <div className="p-3 border-b border-border">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 w-4 h-4 text-text-muted" />
          <input
            type="text"
            placeholder="搜索工具..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-2 text-sm bg-background-elevated border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-muted"
          />
        </div>
      </div>

      {/* 工具分类列表 */}
      <div className="flex-1 overflow-y-auto">
        {filteredCategories.map((category) => (
          <div key={category.id} className="border-b border-border">
            {/* 分类标题 */}
            <button
              onClick={() => toggleCategory(category.id)}
              className="w-full flex items-center justify-between px-3 py-2 hover:bg-background-hover transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text-primary">{category.name}</span>
                <span className="text-xs text-text-muted">({category.tools.length})</span>
              </div>
              {expandedCategories.includes(category.id) ? (
                <ChevronDown className="w-4 h-4 text-text-muted" />
              ) : (
                <ChevronRight className="w-4 h-4 text-text-muted" />
              )}
            </button>

            {/* 工具列表 */}
            {expandedCategories.includes(category.id) && (
              <div className="px-3 pb-2">
                {category.tools.map((tool) => (
                  <button
                    key={tool.id}
                    onClick={() => handleToolClick(tool)}
                    className={`w-full flex items-start gap-3 p-2 rounded-md transition-colors ${
                      selectedTool?.id === tool.id
                        ? 'bg-primary/10 border border-primary/20'
                        : 'hover:bg-background-hover'
                    }`}
                  >
                    <div className="flex-1 text-left">
                      <div className="text-sm font-medium text-text-primary">{tool.name}</div>
                      <div className="text-xs text-text-muted mt-0.5">{tool.description}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 工具详情面板 */}
      {selectedTool && (
        <div className="border-t border-border p-3 bg-background-elevated">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-text-primary">{selectedTool.name}</h3>
            <button
              onClick={() => setSelectedTool(null)}
              className="text-xs text-text-muted hover:text-text-primary"
            >
              关闭
            </button>
          </div>
          <p className="text-xs text-text-muted mb-3">{selectedTool.description}</p>
          <div className="flex gap-2">
            <button
              onClick={() => {
                if (onSendToChat) {
                  onSendToChat(`执行工具: ${selectedTool.name}`)
                }
              }}
              className="flex-1 px-3 py-1.5 text-xs font-medium text-white bg-primary rounded-md hover:bg-primary/90 transition-colors"
            >
              执行
            </button>
            <button
              onClick={() => {
                if (onSendToChat) {
                  onSendToChat(`查看帮助: ${selectedTool.name}`)
                }
              }}
              className="px-3 py-1.5 text-xs font-medium text-text-secondary bg-background-hover rounded-md hover:bg-background-active transition-colors"
            >
              帮助
            </button>
          </div>
        </div>
      )}
    </div>
  )
}