import { describe, it, expect } from 'vitest'
import { builtinCommands, type Command, type ParsedCommand } from './command'

describe('builtinCommands', () => {
  it('应该包含内置命令', () => {
    expect(builtinCommands.length).toBeGreaterThan(0)
  })

  it('所有命令应该有必需字段', () => {
    for (const cmd of builtinCommands) {
      expect(cmd.name).toBeDefined()
      expect(cmd.type).toBe('builtin')
      expect(cmd.description).toBeDefined()
      expect(cmd.name.length).toBeGreaterThan(0)
      expect(cmd.description.length).toBeGreaterThan(0)
    }
  })

  it('应该包含会话管理命令', () => {
    const names = builtinCommands.map(c => c.name)
    expect(names).toContain('stats')
    expect(names).toContain('map')
    expect(names).toContain('token')
  })

  it('应该包含 Git 操作命令', () => {
    const names = builtinCommands.map(c => c.name)
    expect(names).toContain('commit')
    expect(names).toContain('diff')
    expect(names).toContain('push')
    expect(names).toContain('pull')
    expect(names).toContain('status')
    expect(names).toContain('log')
    expect(names).toContain('branch')
  })

  it('应该包含代码质量命令', () => {
    const names = builtinCommands.map(c => c.name)
    expect(names).toContain('format')
    expect(names).toContain('lint')
    expect(names).toContain('test')
    expect(names).toContain('build')
    expect(names).toContain('run')
  })

  it('应该包含文件操作命令', () => {
    const names = builtinCommands.map(c => c.name)
    expect(names).toContain('edit')
    expect(names).toContain('search')
    expect(names).toContain('explain')
    expect(names).toContain('review')
    expect(names).toContain('refactor')
    expect(names).toContain('document')
  })

  it('应该包含配置和依赖命令', () => {
    const names = builtinCommands.map(c => c.name)
    expect(names).toContain('config')
    expect(names).toContain('install')
    expect(names).toContain('env')
  })

  it('应该包含帮助命令', () => {
    const names = builtinCommands.map(c => c.name)
    expect(names).toContain('commands')
    expect(names).toContain('help')
    expect(names).toContain('guide')
  })

  it('命令名称应该是唯一的', () => {
    const names = builtinCommands.map(c => c.name)
    const uniqueNames = new Set(names)
    expect(uniqueNames.size).toBe(names.length)
  })
})
