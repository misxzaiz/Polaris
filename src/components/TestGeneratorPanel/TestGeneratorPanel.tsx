import { useState, useCallback } from 'react'
import { Play, RefreshCw, Copy, Download } from 'lucide-react'

interface TestGeneratorPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface GeneratedTest {
  id: string
  functionName: string
  testCode: string
  framework: string
  coverage: number
}

export function TestGeneratorPanel({ pluginId, onSendToChat }: TestGeneratorPanelProps) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _pluginId = pluginId
  const [code, setCode] = useState('')
  const [generatedTests, setGeneratedTests] = useState<GeneratedTest[]>([])
  const [isGenerating, setIsGenerating] = useState(false)
  const [selectedFramework, setSelectedFramework] = useState('jest')
  const [selectedTest, setSelectedTest] = useState<GeneratedTest | null>(null)

  const generateTests = useCallback(() => {
    if (!code.trim()) return

    setIsGenerating(true)

    // 模拟生成测试用例
    setTimeout(() => {
      const lines = code.split('\n')
      const functions: string[] = []

      // 提取函数名
      lines.forEach(line => {
        const match = line.match(/function\s+(\w+)/)
        if (match) {
          functions.push(match[1])
        }
      })

      // 如果没有找到函数，创建一些示例测试
      if (functions.length === 0) {
        functions.push('exampleFunction')
      }

      const mockTests: GeneratedTest[] = functions.map((funcName, index) => ({
        id: `test-${index}`,
        functionName: funcName,
        testCode: generateTestCode(funcName, selectedFramework),
        framework: selectedFramework,
        coverage: Math.floor(Math.random() * 30) + 70,
      }))

      setGeneratedTests(mockTests)
      setIsGenerating(false)
    }, 1000)
  }, [code, selectedFramework])

  const generateTestCode = (functionName: string, framework: string) => {
    if (framework === 'jest') {
      return `describe('${functionName}', () => {
  it('should handle normal input', () => {
    // Arrange
    const input = 'test input';
    
    // Act
    const result = ${functionName}(input);
    
    // Assert
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('should handle edge cases', () => {
    // Arrange
    const input = '';
    
    // Act
    const result = ${functionName}(input);
    
    // Assert
    expect(result).toBeDefined();
  });

  it('should throw error for invalid input', () => {
    // Arrange
    const input = null;
    
    // Act & Assert
    expect(() => ${functionName}(input)).toThrow();
  });
});`
    } else if (framework === 'mocha') {
      return `import { expect } from 'chai';
import { ${functionName} } from './module';

describe('${functionName}', function() {
  it('should handle normal input', function() {
    // Arrange
    const input = 'test input';
    
    // Act
    const result = ${functionName}(input);
    
    // Assert
    expect(result).to.exist;
    expect(typeof result).to.equal('string');
  });

  it('should handle edge cases', function() {
    // Arrange
    const input = '';
    
    // Act
    const result = ${functionName}(input);
    
    // Assert
    expect(result).to.exist;
  });

  it('should throw error for invalid input', function() {
    // Arrange
    const input = null;
    
    // Act & Assert
    expect(() => ${functionName}(input)).to.throw();
  });
});`
    } else {
      return `import { test, expect } from '@playwright/test';
import { ${functionName} } from './module';

test.describe('${functionName}', () => {
  test('should handle normal input', async () => {
    // Arrange
    const input = 'test input';
    
    // Act
    const result = ${functionName}(input);
    
    // Assert
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  test('should handle edge cases', async () => {
    // Arrange
    const input = '';
    
    // Act
    const result = ${functionName}(input);
    
    // Assert
    expect(result).toBeDefined();
  });

  test('should throw error for invalid input', async () => {
    // Arrange
    const input = null;
    
    // Act & Assert
    expect(() => ${functionName}(input)).toThrow();
  });
});`
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const handleSendToChat = () => {
    if (onSendToChat && generatedTests.length > 0) {
      const message = `已生成 ${generatedTests.length} 个测试用例：
${generatedTests.map(test => `- ${test.functionName}: ${test.framework} (覆盖率: ${test.coverage}%)`).join('\n')}

建议: 可以根据实际业务逻辑调整测试用例，添加更多边界条件测试。`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <select
            value={selectedFramework}
            onChange={(e) => setSelectedFramework(e.target.value)}
            className="px-2 py-1 text-sm bg-background-elevated border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary text-text-primary"
          >
            <option value="jest">Jest</option>
            <option value="mocha">Mocha</option>
            <option value="playwright">Playwright</option>
          </select>
          
          <button
            onClick={generateTests}
            disabled={isGenerating || !code.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isGenerating ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isGenerating ? '生成中...' : '生成测试'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          {generatedTests.length > 0 && (
            <button
              onClick={handleSendToChat}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-text-secondary bg-background-elevated border border-border rounded-md hover:bg-background-hover transition-colors"
            >
              <Download className="w-4 h-4" />
              发送报告
            </button>
          )}
        </div>
      </div>

      {/* 代码输入区 */}
      <div className="h-48 p-3 border-b border-border">
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="在此粘贴代码，自动生成测试用例..."
          className="w-full h-full p-3 text-sm font-mono bg-background-elevated border border-border rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-muted"
        />
      </div>

      {/* 生成的测试 */}
      <div className="flex-1 overflow-y-auto p-3">
        {generatedTests.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-text-muted text-sm">粘贴代码并点击"生成测试"按钮</div>
            <div className="text-text-muted text-xs mt-1">支持 Jest、Mocha、Playwright 等测试框架</div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-text-primary">
                已生成 <span className="font-medium">{generatedTests.length}</span> 个测试用例
              </div>
            </div>
            
            {generatedTests.map((test) => (
              <div
                key={test.id}
                className={`border rounded-md cursor-pointer transition-colors ${
                  selectedTest?.id === test.id
                    ? 'bg-primary/10 border-primary/30'
                    : 'bg-background-elevated border-border hover:border-border-hover'
                }`}
                onClick={() => setSelectedTest(test)}
              >
                <div className="flex items-center justify-between p-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-primary">{test.functionName}</span>
                      <span className="px-1.5 py-0.5 text-xs bg-background rounded text-text-muted">
                        {test.framework}
                      </span>
                    </div>
                    <div className="text-xs text-text-muted mt-1">
                      预期覆盖率: {test.coverage}%
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        copyToClipboard(test.testCode)
                      }}
                      className="p-1 text-text-muted hover:text-text-primary hover:bg-background-hover rounded transition-colors"
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                
                {selectedTest?.id === test.id && (
                  <div className="p-3 border-t border-border">
                    <pre className="text-xs font-mono text-text-secondary bg-background p-3 rounded-md overflow-x-auto">
                      {test.testCode}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}