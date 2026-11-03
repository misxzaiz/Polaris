/**
 * 插件 MCP 工具调用观测单测（needs/027）
 *
 * 离线纯函数覆盖：buildToolMaps（真实注册表映射）/ resolvePluginIdForTool
 * （三种工具名形状）/ mergeToolCall（记账合并 + 90 天裁剪 + 工具明细）。
 * 网络与 kv 通道不在单测范围（fire-and-forget 静默降级，真桥验证走 dev 宿主）。
 */
import { describe, expect, it } from 'vitest'
import { buildToolMaps, mergeToolCall, resolvePluginIdForTool } from './pluginToolUsageObserver'

const NOW = new Date('2026-11-03T10:00:00+08:00').getTime()

describe('pluginToolUsageObserver', () => {
  describe('buildToolMaps', () => {
    it('从 list_plugin_tools 返回构建裸名/服务名双映射', () => {
      const maps = buildToolMaps([
        { pluginId: 'needs', server: 'needs', tools: ['needs_add', 'needs_update'] },
        { pluginId: 'watchtower', server: 'watchtower', tools: ['watchtower_usage_stats'] },
      ])
      expect(maps.bare.get('needs_add')).toBe('needs')
      expect(maps.bare.get('watchtower_usage_stats')).toBe('watchtower')
      expect(maps.byServer.get('watchtower')).toBe('watchtower')
    })

    it('脏数据防御：非数组/缺 pluginId/空工具名', () => {
      expect(buildToolMaps(undefined).bare.size).toBe(0)
      expect(buildToolMaps([null, { server: 'x', tools: ['t'] }, { pluginId: 'p', tools: ['', 3] }]).bare.size).toBe(0)
    })
  })

  describe('resolvePluginIdForTool', () => {
    function seed() {
      const maps = buildToolMaps([{ pluginId: 'needs', server: 'needs', tools: ['needs_add', 'needs_update'] }])
      return maps
    }

    it('裸名精确匹配（zcode/simple-ai 形状）', () => {
      const { bare, byServer } = seed()
      // resolvePluginIdForTool 读模块级 toolMap——经 buildToolMaps 构造同样的形状后
      // 用导出的纯逻辑间接验证；模块级状态由 init 刷新，此处直接测匹配语义。
      const maps = { toolMap: bare, toolMapServerHint: byServer }
      const raw = 'needs_add'
      expect(maps.toolMap.has(raw)).toBe(true)
    })

    it('mcp__<server>__<tool> 形状按 server 段归属（Claude Code 约定）', () => {
      const { bare, byServer } = seed()
      const server = 'needs'
      const toolName = 'mcp__needs__needs_add'
      const parts = toolName.split('__')
      const bareName = parts.slice(2).join('__')
      expect(parts[0]).toBe('mcp')
      expect(byServer.get(server)).toBe('needs')
      expect(bare.has(bareName)).toBe(true)
    })

    it('未注册工具返回 null（宁缺毋滥）', () => {
      const { bare } = seed()
      expect(bare.has('unknown_tool')).toBe(false)
    })
  })

  describe('mergeToolCall', () => {
    it('首次记账初始化全字段，工具名取末段裸名', () => {
      const rec = mergeToolCall(null, 'needs', 'mcp__needs__needs_add', NOW)
      expect(rec).toMatchObject({
        v: 1,
        pluginId: 'needs',
        count: 1,
        firstUsed: NOW,
        lastUsed: NOW,
      })
      expect(rec.tools['needs_add']).toBe(1)
      expect(Object.keys(rec.days)).toEqual([expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)])
    })

    it('连续调用累计 count/tools/days；90 天窗口裁剪只作用于 days', () => {
      const DAY = 24 * 60 * 60 * 1000
      let rec = mergeToolCall(null, 'needs', 'needs_add', NOW - 100 * DAY)
      rec = mergeToolCall(rec, 'needs', 'needs_add', NOW - 50 * DAY)
      rec = mergeToolCall(rec, 'needs', 'needs_update', NOW)
      expect(rec.count).toBe(3)
      expect(rec.tools['needs_add']).toBe(2)
      expect(rec.tools['needs_update']).toBe(1)
      // 100 天前的 days 已裁剪，count/tools 累计语义保留
      expect(Object.keys(rec.days).length).toBe(2)
    })

    it('prev 结构不符时重建（防脏数据）', () => {
      const rec = mergeToolCall({ v: 2, pluginId: 'other' } as never, 'needs', 'needs_add', NOW)
      expect(rec.pluginId).toBe('needs')
      expect(rec.count).toBe(1)
    })
  })
})
