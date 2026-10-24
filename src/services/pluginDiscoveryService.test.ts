import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pluginIconMap } from '@/plugin-system/icons'
import { VALID_PLUGIN_ICONS as SCHEMA_ICONS } from '@/plugin-system/schema'
import {
  applyPluginUpdate,
  checkPluginUpdate,
  discoverInstalledPlugins,
  installPluginPackage,
  installRemotePlugin,
  normalizeDiscoveredPlugin,
  uninstallPluginWithCleanup,
  validateDiscoveredPlugin,
  validatePluginManifest,
} from './pluginDiscoveryService'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('./transport', () => ({
  invoke: invokeMock,
}))

/**
 * 服务已迁移到 RouterBus（invoke('router_dispatch', { req: { target, payload } })），
 * mock 返回形态对齐 commands/router.rs RouterDispatchResponse。
 */
function dispatchOk(result: unknown) {
  return {
    msgId: 'm1',
    ok: true,
    result,
    error: null,
    trace: 't',
  }
}

describe('pluginDiscoveryService', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('icon whitelist bidirectional alignment: schema.ts == Rust VALID_PLUGIN_ICONS == pluginIconMap (phase 1.1)', () => {
    // Rust 侧常量的镜像基线（src-tauri/src/services/plugin_service.rs::VALID_PLUGIN_ICONS）；
    // 若 Rust 新增/删减 icon，此基线必须同步，双向 diff 即刻暴露
    const RUST_VALID_PLUGIN_ICONS_MIRROR = [
      'Files',
      'GitPullRequest',
      'CheckSquare',
      'Languages',
      'Clock',
      'Target',
      'ClipboardList',
      'Terminal',
      'SquareTerminal',
      'Code2',
      'Bot',
      'BookOpen',
      'AlertCircle',
      'Film',
      'Globe2',
      'Activity',
      'Users',
      'Beaker',
    ] as const

    const schemaIcons = [...SCHEMA_ICONS]
    const iconMapKeys = Object.keys(pluginIconMap)

    expect(schemaIcons).toEqual([...RUST_VALID_PLUGIN_ICONS_MIRROR])
    expect(new Set(iconMapKeys).size).toBe(schemaIcons.length)
    expect(new Set(iconMapKeys)).toEqual(new Set(schemaIcons))
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

  it('rejects metadata without a valid source', () => {
    expect(normalizeDiscoveredPlugin({
      id: 'example.invalid',
      name: 'Invalid',
      version: '0.1.0',
    })).toBeNull()
  })

  it('accepts adapter-translated sources with adapterId passthrough', () => {
    const result = validateDiscoveredPlugin({
      id: 'zcode.example',
      name: 'ZCode Example',
      version: '0.1.0',
      source: { kind: 'adapter', adapterId: 'adapter.zcode' },
      installPath: 'C:\\Users\\sample\\plugins\\zcode.example',
    })

    expect(result.errors).toEqual([])
    expect(result.plugin?.source).toEqual({ kind: 'adapter', adapterId: 'adapter.zcode' })
  })

  it('passes through adapter staleness markers from backend discovery errors (S2 mirror)', async () => {
    invokeMock.mockResolvedValueOnce({
      msgId: 't',
      ok: true,
      result: {
        plugins: [
          {
            id: 'zcode.stale-panel',
            name: 'Stale Panel',
            version: '0.1.0',
            source: { kind: 'adapter', adapterId: 'adapter.zcode' },
            installPath: 'C:\\plugins\\stale-root',
          },
        ],
        errors: [
          {
            path: 'adapter:adapter.zcode:C:\\roots\\zcode',
            error: '适配器连续 3 次失败已熔断，跳过本轮调用（缓存产物不可用）',
            stale: true,
          },
        ],
      },
      error: null,
      trace: '',
    })

    const result = await discoverInstalledPlugins()

    expect(result.plugins.map((plugin) => plugin.id)).toEqual(['zcode.stale-panel'])
    // 平滑降级语义：stale 标记必须原样透传，前端可据此区分实时失败与缓存回退
    expect(result.errors).toEqual([
      {
        path: 'adapter:adapter.zcode:C:\\roots\\zcode',
        error: '适配器连续 3 次失败已熔断，跳过本轮调用（缓存产物不可用）',
        stale: true,
      },
    ])
  })

  it('rejects unknown source kinds (silent-drop prevention, phase 1 P1-8)', () => {
    const result = validateDiscoveredPlugin({
      id: 'example.ghost',
      name: 'Ghost',
      version: '0.1.0',
      source: { kind: 'websocket' },
      installPath: 'C:\\plugins\\ghost',
    })

    expect(result.plugin).toBeNull()
    expect(result.errors).toContain('source.kind must be user, project or adapter')
  })

  it('keeps SquareTerminal views (phase 1.1 icon alignment: no silent drop)', () => {
    const result = validateDiscoveredPlugin({
      id: 'example.term',
      name: 'Term',
      version: '0.1.0',
      contributes: {
        views: [
          {
            id: 'example.term.panel',
            area: 'activityBar',
            panelType: 'term',
            icon: 'SquareTerminal',
            labelKey: 'term:title',
            order: 10,
          },
        ],
      },
      source: { kind: 'user' },
      installPath: 'C:\\plugins\\example.term',
    })

    expect(result.errors).toEqual([])
    expect(result.plugin?.contributes.views).toHaveLength(1)
    expect(result.plugin?.contributes.views[0]?.icon).toBe('SquareTerminal')
  })

  it('rejects unknown top-level manifest fields (phase 1.1 deny_unknown_fields)', () => {
    const result = validateDiscoveredPlugin({
      id: 'example.mystery',
      name: 'Mystery',
      version: '1.0.0',
      source: { kind: 'user' },
      installPath: 'C:\\plugins\\mystery',
      mysteryField: { sneaky: true },
    })

    expect(result.plugin).toBeNull()
    expect(result.errors.length).toBe(1)
    expect(result.errors[0]).toContain('unrecognized top-level field: mysteryField')
    expect(result.errors[0]).toContain('deny_unknown_fields fail fast')
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
            panelType: 'unknown',
            icon: 'NotARealIcon',
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
      'contributes.mcpServers[0] is invalid and was ignored',
      'contributes.views[0] is invalid and was ignored',
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
            panelType: 'demoPlugin',
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
        panelType: 'demoPlugin',
        icon: 'Bot',
      }),
    ])
  })

  it('accepts the Beaker icon for API-style plugins', () => {
    const plugin = normalizeDiscoveredPlugin({
      id: 'example.polaris-api',
      name: 'Polaris API',
      version: '1.0.0',
      enabledByDefault: true,
      contributes: {
        views: [
          {
            id: 'polaris-api.panel',
            area: 'activityBar',
            panelType: 'polarisApi',
            icon: 'Beaker',
            labelKey: 'plugins.polarisApi',
            labelDefault: 'API',
            order: 85,
          },
        ],
      },
      permissions: {},
      source: {
        kind: 'user',
      },
      installPath: 'C:\\Users\\sample\\plugins\\polaris-api',
    })

    expect(plugin?.contributes.views).toEqual([
      expect.objectContaining({
        panelType: 'polarisApi',
        icon: 'Beaker',
      }),
    ])
  })

  it('calls the backend manifest validation command', async () => {
    invokeMock.mockResolvedValueOnce(dispatchOk({
      valid: true,
      manifestPath: 'D:\\plugins\\demo\\plugin.json',
      pluginId: 'example.demo-mcp',
      errors: [],
    }))

    await expect(validatePluginManifest('D:\\plugins\\demo')).resolves.toEqual({
      valid: true,
      manifestPath: 'D:\\plugins\\demo\\plugin.json',
      pluginId: 'example.demo-mcp',
      errors: [],
    })
    expect(invokeMock).toHaveBeenCalledWith('router_dispatch', {
      req: {
        target: 'cap.pluginDiscovery',
        payload: {
          action: 'validate_manifest',
          sourcePath: 'D:\\plugins\\demo',
        },
      },
    })
  })

  it('calls the backend update check command', async () => {
    invokeMock.mockResolvedValueOnce(dispatchOk({
      pluginId: 'example.demo-mcp',
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: true,
      checked: true,
      sourceUrl: 'https://example.test/plugin.json',
      downloadUrl: 'https://example.test/plugin.zip',
    }))

    await expect(checkPluginUpdate('D:\\plugins\\demo')).resolves.toEqual({
      pluginId: 'example.demo-mcp',
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: true,
      checked: true,
      sourceUrl: 'https://example.test/plugin.json',
      downloadUrl: 'https://example.test/plugin.zip',
    })
    expect(invokeMock).toHaveBeenCalledWith('router_dispatch', {
      req: {
        target: 'cap.pluginDiscovery',
        payload: {
          action: 'check_update',
          installPath: 'D:\\plugins\\demo',
        },
      },
    })
  })

  it('calls the backend package install command', async () => {
    invokeMock.mockResolvedValueOnce(dispatchOk({ success: true }))

    await expect(installPluginPackage('D:\\packages\\demo.zip', 'user')).resolves.toEqual({ success: true })
    expect(invokeMock).toHaveBeenCalledWith('router_dispatch', {
      req: {
        target: 'cap.pluginDiscovery',
        payload: {
          action: 'install_package',
          packagePath: 'D:\\packages\\demo.zip',
          scope: 'user',
          workspacePath: undefined,
        },
      },
    })
  })

  it('calls the backend remote install command', async () => {
    invokeMock.mockResolvedValueOnce(dispatchOk({ success: true }))

    await expect(installRemotePlugin('https://example.test/plugin.json', 'project', 'D:\\space\\project')).resolves.toEqual({ success: true })
    expect(invokeMock).toHaveBeenCalledWith('router_dispatch', {
      req: {
        target: 'cap.pluginDiscovery',
        payload: {
          action: 'install_remote',
          sourceUrl: 'https://example.test/plugin.json',
          scope: 'project',
          workspacePath: 'D:\\space\\project',
        },
      },
    })
  })

  it('calls the backend apply update command', async () => {
    invokeMock.mockResolvedValueOnce(dispatchOk({ success: true }))

    await expect(applyPluginUpdate('D:\\plugins\\demo')).resolves.toEqual({ success: true })
    expect(invokeMock).toHaveBeenCalledWith('router_dispatch', {
      req: {
        target: 'cap.pluginDiscovery',
        payload: {
          action: 'apply_update',
          installPath: 'D:\\plugins\\demo',
          workspacePath: undefined,
        },
      },
    })
  })

  describe('uninstallPluginWithCleanup', () => {
    it('calls the backend enhanced uninstall command with pluginId', async () => {
      invokeMock.mockResolvedValueOnce(dispatchOk({ success: true, message: 'Plugin uninstalled' }))

      const result = await uninstallPluginWithCleanup(
        'D:\\plugins\\demo',
        'example.demo-plugin',
        'D:\\workspace'
      )

      expect(result).toEqual({ success: true, message: 'Plugin uninstalled' })
      expect(invokeMock).toHaveBeenCalledWith('router_dispatch', {
        req: {
          target: 'cap.pluginDiscovery',
          payload: {
            action: 'uninstall_with_cleanup',
            installPath: 'D:\\plugins\\demo',
            pluginId: 'example.demo-plugin',
            workspacePath: 'D:\\workspace',
          },
        },
      })
    })

    it('works without workspacePath', async () => {
      invokeMock.mockResolvedValueOnce(dispatchOk({ success: true }))

      await uninstallPluginWithCleanup('D:\\plugins\\demo', 'example.demo-plugin')
      expect(invokeMock).toHaveBeenCalledWith('router_dispatch', {
        req: {
          target: 'cap.pluginDiscovery',
          payload: {
            action: 'uninstall_with_cleanup',
            installPath: 'D:\\plugins\\demo',
            pluginId: 'example.demo-plugin',
            workspacePath: undefined,
          },
        },
      })
    })

    it('handles failure returns', async () => {
      invokeMock.mockResolvedValueOnce(dispatchOk({
        success: false,
        error: '进程仍在运行，无法删除目录',
      }))

      const result = await uninstallPluginWithCleanup('D:\\plugins\\demo', 'example.demo-plugin')
      expect(result.success).toBe(false)
      expect(result.error).toContain('进程')
    })
  })
})
