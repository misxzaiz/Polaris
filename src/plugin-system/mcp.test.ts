import { afterEach, describe, expect, it } from 'vitest'
import {
  listEnabledPluginMcpServers,
  listPluginMcpServerStatuses,
} from './index'
import type { PluginStateMap } from '@/stores/pluginStore'
import { pluginRegistry } from './registry'

describe('plugin MCP contributions', () => {
  afterEach(() => {
    pluginRegistry.replaceInstalled([])
  })

  it('lists built-in MCP servers as enabled by default', () => {
    const servers = listEnabledPluginMcpServers({})

    expect(servers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'polaris-todo',
        pluginId: 'polaris.todo',
        transport: 'stdio',
      }),
      expect.objectContaining({
        id: 'polaris-requirements',
        pluginId: 'polaris.requirements',
        transport: 'stdio',
      }),
      expect.objectContaining({
        id: 'polaris-scheduler',
        pluginId: 'polaris.scheduler',
        transport: 'stdio',
      }),
      expect.objectContaining({
        id: 'polaris-computer',
        pluginId: 'polaris.computer',
        transport: 'stdio',
      }),
    ]))
  })

  it('filters Todo MCP when its plugin MCP surface is disabled', () => {
    const pluginStates: PluginStateMap = {
      'polaris.todo': {
        enabled: true,
        uiEnabled: true,
        mcpEnabled: false,
      },
    }

    expect(listEnabledPluginMcpServers(pluginStates)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'polaris-todo',
        }),
      ])
    )
    expect(listPluginMcpServerStatuses(pluginStates)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'polaris-todo',
        enabled: false,
      }),
    ]))
  })

  it('filters Todo MCP when the whole plugin is disabled', () => {
    const pluginStates: PluginStateMap = {
      'polaris.todo': {
        enabled: false,
        uiEnabled: true,
        mcpEnabled: true,
      },
    }

    expect(listEnabledPluginMcpServers(pluginStates)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'polaris-todo',
        }),
      ])
    )
  })

  it('filters Computer MCP when its plugin is disabled (关闭即不注入)', () => {
    const pluginStates: PluginStateMap = {
      'polaris.computer': {
        enabled: false,
        uiEnabled: true,
        mcpEnabled: true,
      },
    }

    expect(listEnabledPluginMcpServers(pluginStates)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'polaris-computer',
        }),
      ])
    )
    expect(listPluginMcpServerStatuses(pluginStates)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'polaris-computer',
        enabled: false,
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
          id: 'polaris-todo',
        }),
      ])
    )
  })

  it.each([
    ['polaris.todo', 'polaris-todo', 'polaris_todo_mcp'],
    ['polaris.requirements', 'polaris-requirements', 'polaris_requirements_mcp'],
    ['polaris.scheduler', 'polaris-scheduler', 'polaris_scheduler_mcp'],
    ['polaris.computer', 'polaris-computer', 'polaris_computer_mcp'],
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
