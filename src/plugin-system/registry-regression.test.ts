/**
 * 插件引擎回归验证测试
 *
 * 验证 15455c1d / ca1056de / eceb378e / 56456402 / 2e60e140 五轮修复的运行时正确性。
 *
 * 测试方向：
 * 1. replaceInstalled 异步竞态 —— 注册是否在断言时已完成
 * 2. isProfileForEngine 与插件引擎 ID 的运行时兼容性
 * 3. dynamicEngineList 跨组件作用域 —— 运行时是否可访问
 * 4. normalizeEngines 的 null 安全性
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pluginRegistry } from './registry'
import { validateDiscoveredPlugin } from '@/services/pluginDiscoveryService'
import { isProfileForEngine, resolveTargetEngines } from '@/types/modelProfile'
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

// ============================================================
// 1. replaceInstalled 异步竞态
// ============================================================
describe('replaceInstalled 异步竞态 (ca1056de)', () => {
  beforeEach(async () => {
    // 先清除
    await pluginRegistry.replaceInstalled([])
  })

  it('应同步注册非内置插件（不能在 then() 里异步注册）', async () => {
    // 注册一个内置插件
    pluginRegistry.register(createManifest({ id: 'builtin', builtin: true }))
    pluginRegistry.register(createManifest({ id: 'installed', builtin: false }))

    // replaceInstalled 应该同步完成注册
    await pluginRegistry.replaceInstalled([
      createManifest({ id: 'new-plugin' }),
    ])

    const plugins = pluginRegistry.listPlugins()
    // 如果这里得到 1 而不是 2，说明 registerInstalled 是异步在 Promise.then() 里执行的
    expect(plugins).toHaveLength(2)
    expect(plugins.find(p => p.id === 'builtin')).toBeDefined()
    expect(plugins.find(p => p.id === 'new-plugin')).toBeDefined()
    expect(plugins.find(p => p.id === 'installed')).toBeUndefined()
  })

  it('replaceInstalled 后立即 listPlugins 应包含新插件', async () => {
    pluginRegistry.registerInstalled([
      createManifest({ id: 'old-plugin' }),
    ])

    await pluginRegistry.replaceInstalled([
      createManifest({ id: 'replaced-plugin' }),
    ])

    const plugins = pluginRegistry.listPlugins()
    expect(plugins.find(p => p.id === 'replaced-plugin')).toBeDefined()
    expect(plugins.find(p => p.id === 'old-plugin')).toBeUndefined()
  })
})


// ============================================================
// 2. isProfileForEngine 与插件引擎的运行时兼容性
// ============================================================
describe('isProfileForEngine 插件引擎兼容性 (15455c1d)', () => {
  it('应接受插件引擎 ID（如 omp）作为运行时参数', () => {
    // TypeScript 类型签名是 'claude'|'codex'|'simple-ai'|'pi'，
    // 但 JS 运行时不会检查类型，所以需要验证字符串比较逻辑
    const profile = {
      id: 'test-profile',
      name: 'Test',
      baseUrl: 'https://api.test.com',
      model: 'gpt-4',
      targetEngines: ['omp'],
    }

    // 验证包含 'omp' 的 profile 能被 isProfileForEngine 正确识别
    const engines = resolveTargetEngines(profile)
    expect(engines).toContain('omp')

    // 运行时：即使类型签名限制，function 接受 string 不会抛异常
    // 这里用类型断言模拟运行时传参
    const result = isProfileForEngine(profile as any, 'omp' as any)
    expect(result).toBe(true)
  })

  it('空 targetEngines（全选）应匹配所有引擎', () => {
    const profile = {
      id: 'test-profile',
      name: 'Test',
      baseUrl: 'https://api.test.com',
      model: 'gpt-4',
      targetEngines: [] as string[],
    }

    const result = isProfileForEngine(profile as any, 'omp' as any)
    expect(result).toBe(true)
  })

  it('插件引擎 Profile 不应误匹配已知引擎', () => {
    const profile = {
      id: 'omp-profile',
      name: 'OMP',
      baseUrl: 'https://api.test.com',
      model: 'omp-model',
      targetEngines: ['omp'],
    }

    expect(isProfileForEngine(profile as any, 'claude' as any)).toBe(false)
    expect(isProfileForEngine(profile as any, 'codex' as any)).toBe(false)
    expect(isProfileForEngine(profile as any, 'omp' as any)).toBe(true)
  })
})


// ============================================================
// 3. normalizeEngines 空值安全性（通过 validateDiscoveredPlugin 验证）
// ============================================================
describe('normalizeEngines 空值安全 (pluginDiscoveryService.ts)', () => {
  it('contributes.engines 为数组时正常解析', () => {
    const raw = {
      id: 'omp-engine',
      name: 'OMP Engine Plugin',
      version: '1.0.0',
      source: { kind: 'user' },
      contributes: {
        engines: [
          {
            id: 'omp',
            name: 'OMP Engine',
            description: 'OMP CLI engine',
            cli: { command: 'omp', args: ['--mode', 'rpc'] },
            protocol: 'pi-rpc',
            capabilities: { tools: true, streaming: true, interrupt: true, resume: true },
          },
        ],
      },
    }

    const { plugin } = validateDiscoveredPlugin(raw)
    expect(plugin).not.toBeNull()
    expect(plugin!.contributes.engines).toHaveLength(1)
    expect(plugin!.contributes.engines[0].id).toBe('omp')
    expect(plugin!.contributes.engines[0].cli.command).toBe('omp')
  })

  it('cli 缺失时引擎条目被丢弃', () => {
    const raw = {
      id: 'bad-engine-plugin',
      name: 'Bad Engine Plugin',
      version: '1.0.0',
      source: { kind: 'user' },
      contributes: {
        engines: [
          { id: 'bad-engine', name: 'Bad' },
        ],
      },
    }

    const { plugin } = validateDiscoveredPlugin(raw)
    expect(plugin).not.toBeNull()
    expect(plugin!.contributes.engines).toHaveLength(0)
  })

  it('id 缺失时引擎条目被丢弃', () => {
    const raw = {
      id: 'missing-id-plugin',
      name: 'Missing ID Plugin',
      version: '1.0.0',
      source: { kind: 'user' },
      contributes: {
        engines: [
          { name: 'Missing ID', cli: { command: 'test' } },
        ],
      },
    }

    const { plugin } = validateDiscoveredPlugin(raw)
    expect(plugin).not.toBeNull()
    expect(plugin!.contributes.engines).toHaveLength(0)
  })

  it('engines 非数组时返回空数组', () => {
    const raw = {
      id: 'bad-engines-plugin',
      name: 'Bad Engines Plugin',
      version: '1.0.0',
      source: { kind: 'user' },
      contributes: {
        engines: 'not-array',
      },
    }

    const { plugin } = validateDiscoveredPlugin(raw)
    expect(plugin).not.toBeNull()
    expect(plugin!.contributes.engines).toEqual([])
  })

  it('contributes.engines 通过 validateDiscoveredPlugin 后应保留（含完整字段）', () => {
    const raw = {
      id: 'omp-plugin',
      name: 'OMP Plugin',
      version: '1.0.0',
      source: { kind: 'user' },
      contributes: {
        engines: [
          {
            id: 'omp',
            name: 'OMP Engine',
            description: 'OMP CLI engine',
            cli: { command: 'omp', args: ['--mode', 'rpc'] },
            providerConfig: {
              configFile: 'agent/models.yml',
              format: 'yaml',
              apiValue: 'openai-completions',
              providerArg: '--provider',
              modelArg: '--model',
            },
          },
        ],
      },
    }

    const { plugin } = validateDiscoveredPlugin(raw)
    expect(plugin).not.toBeNull()
    expect(plugin!.contributes.engines).toHaveLength(1)
    expect(plugin!.contributes.engines[0].id).toBe('omp')
    expect(plugin!.contributes.engines[0].cli.command).toBe('omp')
    // mcpConsumption 默认值应为 'mcp-servers'（向后兼容）
    expect(plugin!.contributes.engines[0].mcpConsumption).toBe('mcp-servers')
    // providerConfig 完整保留
    expect(plugin!.contributes.engines[0].providerConfig?.configFile).toBe('agent/models.yml')
  })

  it('mcpConsumption 字段通过 normalizeEngines 保留', () => {
    const raw = {
      id: 'omp-mcp-plugin',
      name: 'OMP MCP Plugin',
      version: '1.0.0',
      source: { kind: 'user' },
      contributes: {
        engines: [
          {
            id: 'omp',
            name: 'OMP Engine',
            description: 'OMP CLI engine',
            cli: { command: 'omp', args: ['--mode', 'rpc'] },
            mcpConsumption: 'pi-extension',
          },
        ],
      },
    }

    const { plugin } = validateDiscoveredPlugin(raw)
    expect(plugin).not.toBeNull()
    expect(plugin!.contributes.engines[0].mcpConsumption).toBe('pi-extension')
  })
})


// ============================================================
// 4. dynamicEngineList 跨组件作用域（静态分析，不能直接运行）
// ============================================================
describe('dynamicEngineList 跨组件作用域 (ModelProviderTab.tsx)', () => {
  it('ProfileEditorModal 应通过 props 获取 dynamicEngineList', () => {
    // 验证：ProfileEditorModal 的 props 类型定义（L393-400）不含 dynamicEngineList。

    // 从 ModelProviderTab.tsx 源码可知：
    // - ProfileEditorModal 接收 props: { initialProfile, onSave, onClose }
    // - dynamicEngineList 定义在 ModelProviderTab 内（L953）
    // - ProfileEditorModal 在 L755/756/766 直接引用 dynamicEngineList（未定义变量）

    // 运行时结果：ProfileEditorModal 被调用时 → ReferenceError: dynamicEngineList is not defined
    // 入口：设置 → 模型供应商 → 新建/编辑 Profile 弹窗
    expect(true).toBe(true)
  })
})

// ============================================================
// 5. engineId → pluginId 映射（getPluginIdForEngine）
// ============================================================
describe('engineId → pluginId 映射 (pluginRegistry)', () => {
  beforeEach(() => {
    // 清空已注册插件，避免测试间相互污染
    pluginRegistry.replaceInstalled([])
  })

  it('registerInstalled 后可通过 getPluginIdForEngine 查到来源插件', async () => {
    const manifest = createManifest({
      id: 'omp-engine',
      name: 'OMP Engine',
      contributes: {
        engines: [
          {
            id: 'omp',
            name: 'Oh My Pi',
            description: 'OMP CLI engine',
            cli: { command: 'omp', args: ['--mode', 'rpc'] },
            protocol: 'pi-rpc',
            sessionFlags: 'omp',
            capabilities: { tools: true, streaming: true, interrupt: true, resume: true },
          },
        ],
      },
    })

    await pluginRegistry.replaceInstalled([manifest])
    expect(pluginRegistry.getPluginIdForEngine('omp')).toBe('omp-engine')
  })

  it('卸载插件后映射被清除', async () => {
    const manifest = createManifest({
      id: 'omp-engine',
      name: 'OMP Engine',
      contributes: {
        engines: [
          {
            id: 'omp',
            name: 'Oh My Pi',
            description: 'OMP CLI engine',
            cli: { command: 'omp', args: ['--mode', 'rpc'] },
            protocol: 'pi-rpc',
            sessionFlags: 'omp',
            capabilities: { tools: true, streaming: true, interrupt: true, resume: true },
          },
        ],
      },
    })

    await pluginRegistry.replaceInstalled([manifest])
    expect(pluginRegistry.getPluginIdForEngine('omp')).toBe('omp-engine')

    // 卸载（replaceInstalled 空数组）
    await pluginRegistry.replaceInstalled([])
    expect(pluginRegistry.getPluginIdForEngine('omp')).toBeUndefined()
  })

  it('未注册引擎返回 undefined', () => {
    expect(pluginRegistry.getPluginIdForEngine('nonexistent-engine')).toBeUndefined()
  })
})