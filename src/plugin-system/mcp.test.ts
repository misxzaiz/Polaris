import { describe, expect, it } from 'vitest'
import {
  listEnabledPluginMcpServers,
  listPluginMcpServerStatuses,
} from './index'
import type { PluginStateMap } from '@/stores/pluginStore'
import { pluginRegistry } from './registry'

describe('plugin MCP contributions', () => {
  it('lists Todo MCP as enabled by default', () => {
    const servers = listEnabledPluginMcpServers({})

    expect(servers).toEqual([
      expect.objectContaining({
        id: 'polaris-todo',
        pluginId: 'polaris.todo',
        transport: 'stdio',
      }),
    ])
  })

  it('filters Todo MCP when its plugin MCP surface is disabled', () => {
    const pluginStates: PluginStateMap = {
      'polaris.todo': {
        enabled: true,
        uiEnabled: true,
        mcpEnabled: false,
      },
    }

    expect(listEnabledPluginMcpServers(pluginStates)).toEqual([])
    expect(listPluginMcpServerStatuses(pluginStates)).toEqual([
      expect.objectContaining({
        id: 'polaris-todo',
        enabled: false,
      }),
    ])
  })

  it('filters Todo MCP when the whole plugin is disabled', () => {
    const pluginStates: PluginStateMap = {
      'polaris.todo': {
        enabled: false,
        uiEnabled: true,
        mcpEnabled: true,
      },
    }

    expect(listEnabledPluginMcpServers(pluginStates)).toEqual([])
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
})
