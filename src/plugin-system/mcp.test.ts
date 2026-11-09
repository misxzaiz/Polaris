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
        id: 'polaris-scheduler',
        pluginId: 'polaris.scheduler',
        transport: 'stdio',
      }),
    ]))
  })

  it('filters a single MCP server when only that server is disabled', () => {
    const pluginStates: PluginStateMap = {
      'polaris.scheduler': {
        enabled: true,
        uiEnabled: true,
        mcpEnabled: true,
        mcpServers: {
          'polaris-scheduler': { enabled: false },
        },
      },
    }

    expect(listEnabledPluginMcpServers(pluginStates)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'polaris-scheduler',
        }),
      ])
    )
    expect(listEnabledPluginMcpServers(pluginStates)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'polaris-ask',
        }),
      ])
    )
  })

  it.each([
    ['polaris.scheduler', 'polaris-scheduler', 'polaris_scheduler_mcp'],
  ])('keeps %s manifest aligned with the backend MCP registry contract', (
    pluginId,
    serverId,
    command
  ) => {
    const plugin = pluginRegistry
      .listPlugins()
      .find((plugin) => plugin.id === pluginId)

    expect(plugin).toBeDefined()
    expect(plugin?.contributes.mcpServers).toEqual([
      expect.objectContaining({
        id: serverId,
        transport: 'stdio',
        command,
        argsTemplate: ['{{appConfigDir}}', '{{workspacePath}}'],
      }),
    ])
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
