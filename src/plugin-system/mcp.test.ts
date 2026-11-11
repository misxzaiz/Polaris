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

    expect(listEnabledPluginMcpServers(pluginStates)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'polaris-ask',
        }),
      ])
    )
    expect(listEnabledPluginMcpServers(pluginStates)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'polaris-browser',
        }),
      ])
    )
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
