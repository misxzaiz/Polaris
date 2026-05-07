import { describe, expect, it } from 'vitest'
import { normalizeDiscoveredPlugin } from './pluginDiscoveryService'

describe('pluginDiscoveryService', () => {
  it('normalizes discovered plugin metadata', () => {
    const plugin = normalizeDiscoveredPlugin({
      id: 'example.todo',
      name: 'Example Todo',
      version: '0.1.0',
      enabledByDefault: true,
      contributes: {
        views: [
          {
            id: 'example.todo.panel',
            area: 'activityBar',
            panelType: 'todo',
            icon: 'CheckSquare',
            labelKey: 'todo:title',
            order: 120,
          },
        ],
        mcpServers: [
          {
            id: 'example-todo',
            transport: 'stdio',
            command: 'example-todo',
            argsTemplate: ['{{workspacePath}}'],
          },
        ],
      },
      permissions: {
        workspaceRead: true,
        unsupported: 'ignored',
      },
      source: {
        kind: 'project',
        workspacePath: 'D:\\space\\project',
      },
      installPath: 'D:\\space\\project\\.polaris\\plugins\\example',
    })

    expect(plugin).toEqual(
      expect.objectContaining({
        id: 'example.todo',
        builtin: false,
        enabledByDefault: true,
        source: {
          kind: 'project',
          workspacePath: 'D:\\space\\project',
        },
      })
    )
    expect(plugin?.contributes.views).toHaveLength(1)
    expect(plugin?.contributes.mcpServers).toEqual([
      expect.objectContaining({
        id: 'example-todo',
        transport: 'stdio',
      }),
    ])
    expect(plugin?.permissions).toEqual({ workspaceRead: true })
  })

  it('rejects metadata without a valid source', () => {
    expect(normalizeDiscoveredPlugin({
      id: 'example.invalid',
      name: 'Invalid',
      version: '0.1.0',
    })).toBeNull()
  })
})
