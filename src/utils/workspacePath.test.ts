import { describe, it, expect } from 'vitest'
import { getPathBasename, normalizeWorkspacePath } from './workspacePath'

describe('getPathBasename', () => {
  it('应该返回路径的最后一部分', () => {
    expect(getPathBasename('/home/user/project')).toBe('project')
  })

  it('应该处理 Windows 路径', () => {
    expect(getPathBasename('C:\\Users\\user\\project')).toBe('project')
  })

  it('应该处理混合路径分隔符', () => {
    expect(getPathBasename('C:\\Users/user/project')).toBe('project')
  })

  it('应该忽略尾部斜杠', () => {
    expect(getPathBasename('/home/user/project/')).toBe('project')
  })

  it('应该返回原始字符串当没有分隔符', () => {
    expect(getPathBasename('filename')).toBe('filename')
  })

  it('应该处理空路径', () => {
    expect(getPathBasename('')).toBe('')
  })
})

describe('normalizeWorkspacePath', () => {
  it('应该规范化 Unix 路径', () => {
    expect(normalizeWorkspacePath('/home/user/project')).toBe('/home/user/project')
  })

  it('应该将反斜杠转换为正斜杠', () => {
    expect(normalizeWorkspacePath('C:\\Users\\user\\project')).toBe('c:/users/user/project')
  })

  it('应该移除尾部斜杠', () => {
    expect(normalizeWorkspacePath('/home/user/project/')).toBe('/home/user/project')
  })

  it('应该将 Windows 路径转换为小写', () => {
    expect(normalizeWorkspacePath('C:\\Users\\USER\\Project')).toBe('c:/users/user/project')
  })

  it('应该检测 Windows 路径格式', () => {
    expect(normalizeWorkspacePath('D:\\space\\base\\Polaris')).toBe('d:/space/base/polaris')
  })

  it('应该保留 Unix 路径的大小写', () => {
    expect(normalizeWorkspacePath('/Home/User/Project')).toBe('/Home/User/Project')
  })

  it('应该处理带空格的路径', () => {
    expect(normalizeWorkspacePath('  /home/user/project  ')).toBe('/home/user/project')
  })

  it('应该处理多个尾部斜杠', () => {
    expect(normalizeWorkspacePath('/home/user/project///')).toBe('/home/user/project')
  })
})
