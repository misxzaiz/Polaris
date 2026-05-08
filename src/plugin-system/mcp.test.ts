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

  it('lists Todo MCP as enabled by default', () => {
    const servers = listEnabledPluginMcpServers({})

    expect(servers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'polaris-todo',
        pluginId: 'polaris.todo',
        transport: 'stdio',
      }),
    ]))
    expect(servers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'polaris-long-goal',
        pluginId: 'polaris.long-goal',
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

  it('keeps the Todo manifest aligned with the backend MCP registry contract', () => {
    const todoPlugin = pluginRegistry
      .listPlugins()
      .find((plugin) => plugin.id === 'polaris.todo')

    expect(todoPlugin).toBeDefined()
    expect(todoPlugin?.contributes.mcpServers).toEqual([
      expect.objectContaining({
        id: 'polaris-todo',
        transport: 'stdio',
        command: 'polaris_todo_mcp',
        argsTemplate: ['{{appConfigDir}}', '{{workspacePath}}'],
      }),
    ])
  })

  it('keeps the Long Goal manifest aligned with the backend MCP registry contract', () => {
    const longGoalPlugin = pluginRegistry
      .listPlugins()
      .find((plugin) => plugin.id === 'polaris.long-goal')

    expect(longGoalPlugin).toBeDefined()
    expect(longGoalPlugin?.contributes.mcpServers).toEqual([
      expect.objectContaining({
        id: 'polaris-long-goal',
        transport: 'stdio',
        command: 'polaris_long_goal_mcp',
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
        }),
      ])
    )
  })
})
