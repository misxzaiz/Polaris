import { describe, it, expect } from 'vitest'
import {
  CLI_SUGGESTED_COMMANDS,
  CLI_KNOWN_HIDDEN_COMMANDS,
  CLI_BLOCKED_COMMANDS,
  getCliCommandSuggestions,
  matchBlockedCliCommand,
} from './cliSlashCommands'

describe('cliSlashCommands', () => {
  describe('目录一致性', () => {
    it('建议/隐藏/拦截三个清单互不重叠', () => {
      const suggested = CLI_SUGGESTED_COMMANDS.flatMap(m => [m.name, ...(m.aliases ?? [])])
      const all = [...suggested, ...CLI_KNOWN_HIDDEN_COMMANDS, ...CLI_BLOCKED_COMMANDS]
      expect(new Set(all).size).toBe(all.length)
    })

    it('每个建议命令都有描述 key', () => {
      for (const meta of CLI_SUGGESTED_COMMANDS) {
        expect(meta.descKey.length).toBeGreaterThan(0)
      }
    })
  })

  describe('matchBlockedCliCommand', () => {
    it('拦截 /clear 及其别名', () => {
      expect(matchBlockedCliCommand('/clear')).toBe('clear')
      expect(matchBlockedCliCommand('/reset')).toBe('reset')
      expect(matchBlockedCliCommand('/new')).toBe('new')
      expect(matchBlockedCliCommand('/CLEAR')).toBe('clear')
    })

    it('拦截带参数/多行形式（CLI 会把整条消息按命令解析）', () => {
      expect(matchBlockedCliCommand('/clear now')).toBe('clear')
      expect(matchBlockedCliCommand('/clear\nsecond line')).toBe('clear')
    })

    it('放行普通文本与其它命令', () => {
      expect(matchBlockedCliCommand('hello')).toBeNull()
      expect(matchBlockedCliCommand('/compact')).toBeNull()
      expect(matchBlockedCliCommand('/clearly wrong')).toBeNull()
      // 前导空格：Polaris 发送前会 trim，调用方须传入 trim 后文本；
      // 此处验证函数本身与 CLI 首字符语义一致
      expect(matchBlockedCliCommand(' /clear')).toBeNull()
    })
  })

  describe('getCliCommandSuggestions', () => {
    it('空 query 返回全部建议命令', () => {
      const result = getCliCommandSuggestions('', [], new Set())
      expect(result.map(r => r.name)).toEqual(CLI_SUGGESTED_COMMANDS.map(m => m.name))
    })

    it('按名称与别名过滤', () => {
      expect(getCliCommandSuggestions('comp', [], new Set()).map(r => r.name)).toEqual(['compact'])
      // cost 是 usage 的别名
      expect(getCliCommandSuggestions('cost', [], new Set()).map(r => r.name)).toEqual(['usage'])
    })

    it('前缀命中排在包含命中之前', () => {
      // "c" 前缀命中 compact/context，包含命中 mcp/recap
      const names = getCliCommandSuggestions('c', [], new Set()).map(r => r.name)
      const prefixIdx = names.indexOf('compact')
      const containsIdx = names.indexOf('mcp')
      expect(prefixIdx).toBeGreaterThanOrEqual(0)
      expect(containsIdx).toBeGreaterThan(prefixIdx)
    })

    it('动态清单排除内置命令/skill/内部命令后以 custom 展示', () => {
      const dynamic = ['compact', 'config', 'clear', '__remote-workflow', 'my-skill', 'deploy-check']
      const result = getCliCommandSuggestions('', dynamic, new Set(['my-skill']))
      const dynamicOnly = result.filter(r => r.dynamic)
      expect(dynamicOnly.map(r => r.name)).toEqual(['deploy-check'])
      expect(dynamicOnly[0].descKey).toBe('custom')
    })

    it('动态建议数量有上限', () => {
      const dynamic = Array.from({ length: 20 }, (_, i) => `cmd-${i}`)
      const result = getCliCommandSuggestions('', dynamic, new Set())
      expect(result.filter(r => r.dynamic).length).toBeLessThanOrEqual(6)
    })
  })
})
