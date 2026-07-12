import { describe, it, expect, beforeEach } from 'vitest'
import { pluginRegistry } from './registry'
import type { PolarisPluginManifest } from './types'

function createManifest(overrides: Partial<PolarisPluginManifest> = {}): PolarisPluginManifest {
  return {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    enabledByDefault: true,
    builtin: false,
    contributes: {},
    ...overrides,
  }
}

describe('PluginRegistry', () => {
  beforeEach(() => {
    // 清空注册表
    // 注意：replaceInstalled 只清除非内置插件，内置插件会保留
    pluginRegistry.replaceInstalled([])
  })

  describe('register', () => {
    it('应该注册插件', () => {
      const manifest = createManifest()
      pluginRegistry.register(manifest)

      const plugins = pluginRegistry.listPlugins()
      expect(plugins).toHaveLength(1)
      expect(plugins[0].id).toBe('test-plugin')
    })

    it('应该覆盖同 ID 的插件', () => {
      pluginRegistry.register(createManifest({ version: '1.0.0' }))
      pluginRegistry.register(createManifest({ version: '2.0.0' }))

      const plugins = pluginRegistry.listPlugins()
      expect(plugins).toHaveLength(1)
      expect(plugins[0].version).toBe('2.0.0')
    })
  })

  describe('registerInstalled', () => {
    it('应该注册多个插件', () => {
      pluginRegistry.registerInstalled([
        createManifest({ id: 'plugin-1' }),
        createManifest({ id: 'plugin-2' }),
      ])

      const plugins = pluginRegistry.listPlugins()
      expect(plugins).toHaveLength(2)
    })

    it('应该跳过内置插件', () => {
      // 使用 register 注册内置插件
      pluginRegistry.register(createManifest({ id: 'builtin', builtin: true }))

      pluginRegistry.registerInstalled([
        createManifest({ id: 'builtin', version: '2.0.0' }),
      ])

      const plugins = pluginRegistry.listPlugins()
      expect(plugins).toHaveLength(1)
      expect(plugins[0].version).toBe('1.0.0') // 保持原版本
      expect(plugins[0].builtin).toBe(true) // 保持 builtin 标志
    })

    it('应该设置非内置插件的 builtin 为 false', () => {
      pluginRegistry.registerInstalled([
        createManifest({ id: 'external', builtin: true }),
      ])

      const plugins = pluginRegistry.listPlugins()
      const external = plugins.find(p => p.id === 'external')
      expect(external).toBeDefined()
      expect(external!.builtin).toBe(false)
    })
  })

  describe('replaceInstalled', () => {
    it('应该替换非内置插件', () => {
      pluginRegistry.register(createManifest({ id: 'builtin', builtin: true }))
      pluginRegistry.register(createManifest({ id: 'installed', builtin: false }))

      pluginRegistry.replaceInstalled([
        createManifest({ id: 'new-plugin' }),
      ])

      const plugins = pluginRegistry.listPlugins()
      expect(plugins).toHaveLength(2)
      expect(plugins.find(p => p.id === 'builtin')).toBeDefined()
      expect(plugins.find(p => p.id === 'new-plugin')).toBeDefined()
      expect(plugins.find(p => p.id === 'installed')).toBeUndefined()
    })
  })

  describe('listViewContributions', () => {
    it('应该返回指定区域的视图贡献', () => {
      pluginRegistry.register(createManifest({
        id: 'plugin-1',
        contributes: {
          views: [
            { id: 'view-1', name: 'View 1', area: 'sidebar', order: 1 },
            { id: 'view-2', name: 'View 2', area: 'panel', order: 1 },
          ],
        },
      }))

      const sidebarViews = pluginRegistry.listViewContributions('sidebar')
      expect(sidebarViews).toHaveLength(1)
      expect(sidebarViews[0].id).toBe('view-1')
    })

    it('应该按 order 排序', () => {
      pluginRegistry.register(createManifest({
        id: 'plugin-1',
        contributes: {
          views: [
            { id: 'view-2', name: 'View 2', area: 'sidebar', order: 2 },
            { id: 'view-1', name: 'View 1', area: 'sidebar', order: 1 },
          ],
        },
      }))

      const views = pluginRegistry.listViewContributions('sidebar')
      expect(views[0].id).toBe('view-1')
      expect(views[1].id).toBe('view-2')
    })

    it('应该只返回启用的插件的视图', () => {
      pluginRegistry.register(createManifest({
        id: 'disabled',
        enabledByDefault: false,
        contributes: {
          views: [{ id: 'view-1', name: 'View 1', area: 'sidebar', order: 1 }],
        },
      }))

      const views = pluginRegistry.listViewContributions('sidebar')
      expect(views).toHaveLength(0)
    })

    it('应该包含 pluginId', () => {
      pluginRegistry.register(createManifest({
        id: 'my-plugin',
        contributes: {
          views: [{ id: 'view-1', name: 'View 1', area: 'sidebar', order: 1 }],
        },
      }))

      const views = pluginRegistry.listViewContributions('sidebar')
      expect(views[0].pluginId).toBe('my-plugin')
    })
  })

  describe('listMcpServerContributions', () => {
    it('应该返回所有 MCP 服务器贡献', () => {
      pluginRegistry.register(createManifest({
        id: 'plugin-1',
        contributes: {
          mcpServers: [
            { id: 'server-1', name: 'Server 1', command: 'node' },
          ],
        },
      }))

      const servers = pluginRegistry.listMcpServerContributions()
      expect(servers).toHaveLength(1)
      expect(servers[0].id).toBe('server-1')
    })

    it('应该包含 pluginId', () => {
      pluginRegistry.register(createManifest({
        id: 'my-plugin',
        contributes: {
          mcpServers: [
            { id: 'server-1', name: 'Server 1', command: 'node' },
          ],
        },
      }))

      const servers = pluginRegistry.listMcpServerContributions()
      expect(servers[0].pluginId).toBe('my-plugin')
    })
  })
})
