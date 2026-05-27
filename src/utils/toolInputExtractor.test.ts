import { describe, it, expect } from 'vitest'
import {
  extractFilePath,
  extractFullFilePath,
  extractCommand,
  extractFullCommand,
  extractSearchQuery,
  extractUrl,
  extractTodoInfo,
  extractValue,
  normalizeCommandForDisplay,
} from './toolInputExtractor'

describe('extractFilePath', () => {
  it('应该从 path 提取文件名', () => {
    expect(extractFilePath({ path: '/src/components/App.tsx' })).toBe('App.tsx')
  })

  it('应该从 file_path 提取文件名', () => {
    expect(extractFilePath({ file_path: 'C:\\project\\index.js' })).toBe('index.js')
  })

  it('应该从 filePath 提取文件名', () => {
    expect(extractFilePath({ filePath: '/home/user/test.ts' })).toBe('test.ts')
  })

  it('应该返回空字符串当输入为空', () => {
    expect(extractFilePath(undefined)).toBe('')
    expect(extractFilePath({})).toBe('')
  })

  it('应该处理没有路径分隔符的文件名', () => {
    expect(extractFilePath({ path: 'README.md' })).toBe('README.md')
  })
})

describe('extractFullFilePath', () => {
  it('应该返回完整路径', () => {
    expect(extractFullFilePath({ path: '/src/components/App.tsx' })).toBe('/src/components/App.tsx')
  })

  it('应该返回 null 当输入为空', () => {
    expect(extractFullFilePath(undefined)).toBeNull()
    expect(extractFullFilePath({})).toBeNull()
  })

  it('应该跳过空字符串', () => {
    expect(extractFullFilePath({ path: '' })).toBeNull()
  })
})

describe('extractCommand', () => {
  it('应该从 command 提取命令', () => {
    expect(extractCommand({ command: 'npm run build' })).toBe('npm run build')
  })

  it('应该从 commands 数组提取第一个命令', () => {
    expect(extractCommand({ commands: ['git commit', 'git push'] })).toBe('git commit')
  })

  it('应该截断过长的命令', () => {
    const longCommand = 'a'.repeat(50)
    const result = extractCommand({ command: longCommand }, 20)
    expect(result.length).toBeLessThanOrEqual(20)
    expect(result).toContain('...')
  })

  it('应该返回空字符串当输入为空', () => {
    expect(extractCommand(undefined)).toBe('')
    expect(extractCommand({})).toBe('')
  })
})

describe('extractFullCommand', () => {
  it('应该返回完整命令', () => {
    expect(extractFullCommand({ command: 'npm run build -- --production' })).toBe('npm run build -- --production')
  })

  it('应该从数组提取第一个命令', () => {
    expect(extractFullCommand({ commands: ['cmd1', 'cmd2'] })).toBe('cmd1')
  })

  it('应该返回空字符串当输入为空', () => {
    expect(extractFullCommand(undefined)).toBe('')
  })
})

describe('extractSearchQuery', () => {
  it('应该从 query 提取', () => {
    expect(extractSearchQuery({ query: 'useState' })).toBe('useState')
  })

  it('应该从 pattern 提取', () => {
    expect(extractSearchQuery({ pattern: '^export.*function' })).toBe('^export.*function')
  })

  it('应该截断过长的查询', () => {
    const longQuery = 'a'.repeat(40)
    const result = extractSearchQuery({ query: longQuery }, 20)
    expect(result.length).toBeLessThanOrEqual(20)
  })

  it('应该返回空字符串当输入为空', () => {
    expect(extractSearchQuery(undefined)).toBe('')
  })
})

describe('extractUrl', () => {
  it('应该简化 URL 显示', () => {
    const result = extractUrl({ url: 'https://example.com/docs/api/reference' })
    expect(result).toContain('example.com')
  })

  it('应该截断过长的 URL', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(50)
    const result = extractUrl({ url: longUrl }, 20)
    expect(result.length).toBeLessThanOrEqual(20)
  })

  it('应该返回空字符串当输入为空', () => {
    expect(extractUrl(undefined)).toBe('')
  })

  it('应该处理无效 URL', () => {
    expect(extractUrl({ url: 'not-a-url' })).toBe('not-a-url')
  })
})

describe('extractTodoInfo', () => {
  it('应该显示全部完成', () => {
    const input = {
      todos: [
        { status: 'completed', content: 'task1' },
        { status: 'completed', content: 'task2' },
      ],
    }
    expect(extractTodoInfo(input)).toBe('2个已完成')
  })

  it('应该显示进度百分比', () => {
    const input = {
      todos: [
        { status: 'completed', content: 'task1' },
        { status: 'pending', content: 'task2' },
      ],
    }
    expect(extractTodoInfo(input)).toBe('1/2 (50%)')
  })

  it('应该显示进行中状态', () => {
    const input = {
      todos: [
        { status: 'in_progress', content: 'task1' },
        { status: 'pending', content: 'task2' },
      ],
    }
    expect(extractTodoInfo(input)).toBe('2个任务 · 进行中')
  })

  it('应该显示任务总数', () => {
    const input = {
      todos: [
        { status: 'pending', content: 'task1' },
        { status: 'pending', content: 'task2' },
      ],
    }
    expect(extractTodoInfo(input)).toBe('2个任务')
  })

  it('应该返回空字符串当输入为空', () => {
    expect(extractTodoInfo(undefined)).toBe('')
    expect(extractTodoInfo({})).toBe('')
  })
})

describe('extractValue', () => {
  it('应该提取第一个匹配的值', () => {
    expect(extractValue({ name: 'test', title: 'Test' }, ['name', 'title'])).toBe('test')
  })

  it('应该跳过不存在的键', () => {
    expect(extractValue({ title: 'Test' }, ['name', 'title'])).toBe('Test')
  })

  it('应该返回 null 当没有匹配', () => {
    expect(extractValue({ other: 'value' }, ['name', 'title'])).toBeNull()
  })

  it('应该返回 null 当输入为空', () => {
    expect(extractValue(undefined, ['name'])).toBeNull()
  })
})

describe('normalizeCommandForDisplay', () => {
  it('应该移除 PowerShell 包装', () => {
    const cmd = 'powershell.exe -Command "npm run build"'
    const result = normalizeCommandForDisplay(cmd)
    expect(result).toBe('npm run build')
  })

  it('应该移除 cmd.exe 包装', () => {
    const cmd = 'cmd.exe /c "npm run build"'
    const result = normalizeCommandForDisplay(cmd)
    expect(result).toBe('npm run build')
  })

  it('应该移除 rejected 后缀', () => {
    const cmd = 'npm run build rejected: timeout'
    const result = normalizeCommandForDisplay(cmd)
    expect(result).toBe('npm run build')
  })

  it('应该剥离配对引号', () => {
    expect(normalizeCommandForDisplay('"npm run build"')).toBe('npm run build')
    expect(normalizeCommandForDisplay("'npm run build'")).toBe('npm run build')
  })

  it('应该处理普通命令', () => {
    expect(normalizeCommandForDisplay('npm run build')).toBe('npm run build')
  })
})
