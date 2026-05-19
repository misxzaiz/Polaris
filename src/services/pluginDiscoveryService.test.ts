import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyPluginUpdate,
  checkPluginUpdate,
  installPluginPackage,
  installRemotePlugin,
  normalizeDiscoveredPlugin,
  validateDiscoveredPlugin,
  validatePluginManifest,
} from './pluginDiscoveryService'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('./transport', () => ({
  invoke: invokeMock,
}))

describe('pluginDiscoveryService', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

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
            moduleId: 'todo',
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
      origin: {
        repository: 'https://example.test/example.todo',
        updateUrl: 'https://example.test/example.todo/plugin.json',
        downloadUrl: 'https://example.test/example.todo/plugin.zip',
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
        origin: {
          repository: 'https://example.test/example.todo',
          updateUrl: 'https://example.test/example.todo/plugin.json',
          downloadUrl: 'https://example.test/example.todo/plugin.zip',
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

  it('reports invalid contribution diagnostics while keeping valid metadata', () => {
    const result = validateDiscoveredPlugin({
      id: 'example.partial',
      name: 'Partial',
      version: '0.1.0',
      contributes: {
        views: [
          {
            id: 'bad-view',
            area: 'activityBar',
            moduleId: 'unknown',
            icon: 'CheckSquare',
            labelKey: 'example:view',
          },
        ],
        mcpServers: [
          {
            id: 'bad-server',
            transport: 'websocket',
            command: 'bad-server',
          },
        ],
      },
      permissions: {},
      source: {
        kind: 'user',
      },
      installPath: 'C:\\Users\\sample\\plugins\\partial',
    })

    expect(result.plugin).toEqual(expect.objectContaining({ id: 'example.partial' }))
    expect(result.plugin?.contributes.views).toEqual([])
    expect(result.plugin?.contributes.mcpServers).toEqual([])
    expect(result.errors).toEqual([
      'contributes.views[0] is invalid and was ignored',
      'contributes.mcpServers[0] is invalid and was ignored',
    ])
  })

  it('accepts the controlled demo plugin panel type', () => {
    const plugin = normalizeDiscoveredPlugin({
      id: 'example.demo-mcp',
      name: 'Demo MCP Plugin',
      version: '0.1.0',
      enabledByDefault: true,
      contributes: {
        views: [
          {
            id: 'example.demo-mcp.panel',
            area: 'activityBar',
            moduleId: 'demoPlugin',
            icon: 'Bot',
            labelKey: 'plugins.demoMcpPanel',
            labelDefault: 'Demo MCP',
            order: 85,
          },
        ],
      },
      permissions: {},
      source: {
        kind: 'user',
      },
      installPath: 'C:\\Users\\sample\\plugins\\example.demo-mcp',
    })

    expect(plugin?.contributes.views).toEqual([
      expect.objectContaining({
        moduleId: 'demoPlugin',
        icon: 'Bot',
      }),
    ])
  })

  it('preserves allowedSlots / defaultSlot / preferredSize / bareRender when discovering', () => {
    const plugin = normalizeDiscoveredPlugin({
      id: 'example.layout-aware',
      name: 'Layout Aware',
      version: '0.1.0',
      enabledByDefault: true,
      contributes: {
        views: [
          {
            id: 'example.layout-aware.panel',
            area: 'activityBar',
            moduleId: 'todo',
            icon: 'CheckSquare',
            labelKey: 'example:view',
            order: 200,
            allowedSlots: ['left', 'bottom'],
            defaultSlot: 'bottom',
            preferredSize: 240,
            bareRender: true,
          },
        ],
      },
      permissions: {},
      source: { kind: 'user' },
      installPath: 'C:\\Users\\sample\\plugins\\layout-aware',
    })

    expect(plugin?.contributes.views).toEqual([
      expect.objectContaining({
        moduleId: 'todo',
        allowedSlots: ['left', 'bottom'],
        defaultSlot: 'bottom',
        preferredSize: 240,
        bareRender: true,
      }),
    ])
  })

  it('drops unknown slot ids in allowedSlots and falls back when defaultSlot is invalid', () => {
    const plugin = normalizeDiscoveredPlugin({
      id: 'example.dirty-slots',
      name: 'Dirty Slots',
      version: '0.1.0',
      enabledByDefault: true,
      contributes: {
        views: [
          {
            id: 'example.dirty-slots.panel',
            area: 'activityBar',
            moduleId: 'todo',
            icon: 'CheckSquare',
            labelKey: 'example:view',
            order: 200,
            allowedSlots: ['left', 'evil', 99, 'right'],
            defaultSlot: 'galaxy',
          },
        ],
      },
      permissions: {},
      source: { kind: 'user' },
      installPath: 'C:\\Users\\sample\\plugins\\dirty-slots',
    })

    const view = plugin?.contributes.views?.[0]
    expect(view?.allowedSlots).toEqual(['left', 'right'])
    expect(view?.defaultSlot).toBeUndefined()
  })

  it('normalizes the long goal MCP plugin without a view contribution', () => {
    const plugin = normalizeDiscoveredPlugin({
      id: 'polaris.long-goal-mcp',
      name: 'Long Goal MCP',
      version: '0.1.0',
      enabledByDefault: false,
      contributes: {
        mcpServers: [
          {
            id: 'polaris-long-goal',
            transport: 'stdio',
            command: 'node',
            argsTemplate: [
              '{{pluginDir}}/mcp/long-goal-mcp-server.js',
              '{{workspacePath}}',
            ],
          },
        ],
      },
      permissions: {
        workspaceRead: true,
        workspaceWrite: true,
        aiToolAccess: true,
      },
      source: {
        kind: 'project',
        workspacePath: 'D:\\space\\base\\Polaris',
      },
      installPath: 'D:\\space\\base\\Polaris\\.polaris\\plugins\\polaris.long-goal-mcp',
    })

    expect(plugin?.contributes.views).toEqual([])
    expect(plugin?.contributes.mcpServers).toEqual([
      expect.objectContaining({
        id: 'polaris-long-goal',
        transport: 'stdio',
        command: 'node',
      }),
    ])
    expect(plugin?.permissions).toEqual({
      workspaceRead: true,
      workspaceWrite: true,
      aiToolAccess: true,
    })
  })

  it('calls the backend manifest validation command', async () => {
    invokeMock.mockResolvedValueOnce({
      valid: true,
      manifestPath: 'D:\\plugins\\demo\\plugin.json',
      pluginId: 'example.demo-mcp',
      errors: [],
    })

    await expect(validatePluginManifest('D:\\plugins\\demo')).resolves.toEqual({
      valid: true,
      manifestPath: 'D:\\plugins\\demo\\plugin.json',
      pluginId: 'example.demo-mcp',
      errors: [],
    })
    expect(invokeMock).toHaveBeenCalledWith('plugin_validate_manifest', {
      sourcePath: 'D:\\plugins\\demo',
    })
  })

  it('calls the backend update check command', async () => {
    invokeMock.mockResolvedValueOnce({
      pluginId: 'example.demo-mcp',
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: true,
      checked: true,
      sourceUrl: 'https://example.test/plugin.json',
      downloadUrl: 'https://example.test/plugin.zip',
    })

    await expect(checkPluginUpdate('D:\\plugins\\demo')).resolves.toEqual({
      pluginId: 'example.demo-mcp',
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: true,
      checked: true,
      sourceUrl: 'https://example.test/plugin.json',
      downloadUrl: 'https://example.test/plugin.zip',
    })
    expect(invokeMock).toHaveBeenCalledWith('plugin_check_update', {
      installPath: 'D:\\plugins\\demo',
    })
  })

  it('calls the backend package install command', async () => {
    invokeMock.mockResolvedValueOnce({ success: true })

    await expect(installPluginPackage('D:\\packages\\demo.zip', 'user')).resolves.toEqual({ success: true })
    expect(invokeMock).toHaveBeenCalledWith('plugin_install_package', {
      packagePath: 'D:\\packages\\demo.zip',
      scope: 'user',
      workspacePath: undefined,
    })
  })

  it('calls the backend remote install command', async () => {
    invokeMock.mockResolvedValueOnce({ success: true })

    await expect(installRemotePlugin('https://example.test/plugin.json', 'project', 'D:\\space\\project')).resolves.toEqual({ success: true })
    expect(invokeMock).toHaveBeenCalledWith('plugin_install_remote', {
      sourceUrl: 'https://example.test/plugin.json',
      scope: 'project',
      workspacePath: 'D:\\space\\project',
    })
  })

  it('calls the backend apply update command', async () => {
    invokeMock.mockResolvedValueOnce({ success: true })

    await expect(applyPluginUpdate('D:\\plugins\\demo')).resolves.toEqual({ success: true })
    expect(invokeMock).toHaveBeenCalledWith('plugin_apply_update', {
      installPath: 'D:\\plugins\\demo',
      workspacePath: undefined,
    })
  })
})
