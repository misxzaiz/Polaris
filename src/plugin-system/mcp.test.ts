import { afterEach, describe, expect, it } from 'vitest'
import {
  listEnabledPluginMcpServers,
  listPluginMcpServerStatuses,
} from './index'
import type { PluginStateMap } from '@/stores/pluginStore'
import { pluginRegistry } from './registry'

describe('plugin MCP contributions', () => {
  afterEach(async () => {
    await pluginRegistry.replaceInstalled([])
  })

  it('lists built-in MCP servers as enabled by default', () => {
    const servers = listEnabledPluginMcpServers({})

    expect(servers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'polaris-ask',
        pluginId: 'polaris.ask',
        transport: 'stdio',
      }),
    ]))
  })

  it('filters a single MCP server when only that server is disabled', () => {
    // 现存内置 MCP 壳仅剩 polaris.ask（bus/scheduler/browser 已分别出仓或退役）。
    // 本用例验证「按 server 粒度禁用」：ask 的 polaris-ask 被禁后应从启用清单消失。
    const pluginStates: PluginStateMap = {
      'polaris.ask': {
        enabled: true,
        uiEnabled: true,
        mcpEnabled: true,
        mcpServers: {
          'polaris-ask': { enabled: false },
        },
      },
    }

    const enabled = listEnabledPluginMcpServers(pluginStates)
    expect(enabled).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'polaris-ask',
        }),
      ])
    )
    // ask 整体 enabled:true，仅单个 server 被禁 → 不应连带清空其它来源（如有）
    expect(enabled.every((s) => s.id !== 'polaris-ask')).toBe(true)
  })


  it('lists installed MCP contributions even when the plugin is disabled by default', () => {
    pluginRegistry.registerInstalled([
      {
        id: 'example.disabled-mcp',
        name: 'Disabled MCP',
        version: '0.1.0',
        builtin: false,
        enabledByDefault: false,
        contributes: {
          mcpServers: [
            {
              id: 'example-disabled-mcp',
              transport: 'stdio',
              command: 'node',
            },
          ],
        },
        permissions: {},
      },
    ])

    expect(listPluginMcpServerStatuses({})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'example-disabled-mcp',
          pluginId: 'example.disabled-mcp',
          enabled: false,
        }),
      ])
    )
  })
})
