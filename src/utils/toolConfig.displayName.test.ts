import { describe, it, expect } from 'vitest'
import {
  parseMcpToolName,
  getToolDisplayName,
  getToolShortName,
  getToolCategory,
} from './toolConfig'

describe('parseMcpToolName', () => {
  it('解析标准 MCP 工具名', () => {
    expect(parseMcpToolName('mcp__polaris-api__send_message')).toEqual({
      server: 'polaris-api',
      tool: 'send_message',
    })
  })

  it('解析含多个下划线的 server/tool', () => {
    expect(parseMcpToolName('mcp__polaris_dispatch__dispatch_task')).toEqual({
      server: 'polaris_dispatch',
      tool: 'dispatch_task',
    })
  })

  it('非 MCP 前缀返回 null', () => {
    expect(parseMcpToolName('sendMessage')).toBeNull()
    expect(parseMcpToolName('bash')).toBeNull()
    expect(parseMcpToolName('mcp__')).toBeNull()
    expect(parseMcpToolName('mcp__server')).toBeNull()
    expect(parseMcpToolName('mcp__server__')).toBeNull()
  })
})

describe('getToolDisplayName - 已注册工具保持精确映射', () => {
  it('已注册工具不受解析层影响', () => {
    // Bash 有精确映射（labels.execute），解析层不得覆盖
    const label = getToolDisplayName('Bash')
    expect(label).not.toBe('Bash')
    expect(label.length).toBeGreaterThan(0)
  })
})

describe('getToolDisplayName - MCP 工具', () => {
  it('mcp__server__send_message 显示 server 与友好工具名', () => {
    const label = getToolDisplayName('mcp__polaris-api__send_message')
    expect(label).toContain('·')
    expect(label).toContain('发送')
    expect(label).not.toContain('mcp__')
    expect(label).not.toContain('send_message')
  })

  it('词典未命中的 tool 部分回退原始 tool 名', () => {
    const label = getToolDisplayName('mcp__myserver__xyzzy_custom_op')
    expect(label).toBe('myserver · xyzzy_custom_op')
  })
})

describe('getToolDisplayName - 未注册普通工具启发式命名', () => {
  it('snake_case 词典命中拼接', () => {
    expect(getToolDisplayName('send_message')).toBe('发送消息')
  })

  it('camelCase 分词命中', () => {
    expect(getToolDisplayName('sendNotification')).toBe('发送')
  })

  it('仅取前两个命中词避免过长', () => {
    const label = getToolDisplayName('send_message_to_user')
    expect(label).toBe('发送消息')
  })

  it('完全未命中回退原始名', () => {
    expect(getToolDisplayName('qqqzzz')).toBe('qqqzzz')
  })
})

describe('getToolShortName - MCP 工具取 server 首字母', () => {
  it('MCP 工具缩写取 server 名首字母', () => {
    expect(getToolShortName('mcp__polaris-api__send_message')).toBe('P')
  })

  it('已注册工具缩写不变', () => {
    expect(getToolShortName('Bash')).toBe('B')
    expect(getToolShortName('TaskCreate')).toBe('TC')
  })
})

describe('getToolCategory - 未注册工具按关键词推断', () => {
  it('send_message 推断为 network', () => {
    expect(getToolCategory('send_message')).toBe('network')
  })

  it('mcp 工具按 tool 部分关键词推断', () => {
    expect(getToolCategory('mcp__git-plugin__commit_changes')).toBe('git')
  })

  it('已注册工具分类不变', () => {
    expect(getToolCategory('Bash')).toBe('execute')
    expect(getToolCategory('Grep')).toBe('search')
  })
})
