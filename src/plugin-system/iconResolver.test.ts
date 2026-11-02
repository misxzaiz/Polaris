/**
 * 插件图标解析器测试（plans/plugin-custom-icon-spec.md §7）
 *
 * 覆盖：icon 四类值域规则（与 Rust is_supported_plugin_icon 镜像）、同步分类、
 * 相对路径 → data URL 装载（含护栏：逃逸拒绝/大小上限/扩展名白名单）、
 * getPluginIconComponent 内置名直返与包装组件缓存稳定性。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pluginIconMap } from './icons'
import { pluginRegistry } from './registry'
import {
  getPluginIconComponent,
  resolvePluginIcon,
  resolvePluginIconSync,
} from './iconResolver'
import { isValidPluginIconValue } from './schema'
import type { PolarisPluginManifest } from './types'

vi.mock('@/services/transport', () => ({ invoke: vi.fn() }))

import { invoke } from '@/services/transport'
const mockedInvoke = vi.mocked(invoke)

function createManifest(overrides: Partial<PolarisPluginManifest> = {}): PolarisPluginManifest {
  return {
    id: 'icon-test-plugin',
    name: 'Icon Test Plugin',
    version: '1.0.0',
    enabledByDefault: true,
    builtin: false,
    contributes: {},
    ...overrides,
  }
}

const TINY_SVG_BASE64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')

describe('isValidPluginIconValue（与 Rust is_supported_plugin_icon 镜像）', () => {
  it('接受四类合法值', () => {
    // 1. 内置 lucide 名
    expect(isValidPluginIconValue('Bot')).toBe(true)
    // 2. 相对路径
    expect(isValidPluginIconValue('./assets/icon.svg')).toBe(true)
    expect(isValidPluginIconValue('assets/logo.PNG')).toBe(true)
    expect(isValidPluginIconValue('assets\\img\\logo.webp')).toBe(true)
    // 3. http(s) URL
    expect(isValidPluginIconValue('https://example.com/icon.svg')).toBe(true)
    // 4. data:image URL
    expect(isValidPluginIconValue('data:image/svg+xml,%3Csvg%3E%3C/svg%3E')).toBe(true)
  })

  it('拒绝非法值（逃逸/绝对/危险 scheme/控制字符/超长）', () => {
    expect(isValidPluginIconValue('FileText')).toBe(false)
    expect(isValidPluginIconValue('')).toBe(false)
    expect(isValidPluginIconValue('  ')).toBe(false)
    expect(isValidPluginIconValue('../secret.png')).toBe(false)
    expect(isValidPluginIconValue('assets/../../escape.png')).toBe(false)
    expect(isValidPluginIconValue('/abs/path.png')).toBe(false)
    expect(isValidPluginIconValue('C:\\icons\\x.png')).toBe(false)
    expect(isValidPluginIconValue('file:///C:/x.png')).toBe(false)
    expect(isValidPluginIconValue('javascript:alert(1)')).toBe(false)
    expect(isValidPluginIconValue('data:text/html,<h1>')).toBe(false)
    expect(isValidPluginIconValue('icon')).toBe(false)
    expect(isValidPluginIconValue('has space.png')).toBe(false)
    expect(isValidPluginIconValue('a'.repeat(2049))).toBe(false)
  })
})

describe('resolvePluginIconSync', () => {
  it('内置名返回 lucide 组件本体', () => {
    const resolved = resolvePluginIconSync('Bot')
    expect(resolved.kind).toBe('builtin')
    if (resolved.kind === 'builtin') {
      expect(resolved.Icon).toBe(pluginIconMap.Bot)
    }
  })

  it('http(s)/data:image URL 直接归为 image', () => {
    expect(resolvePluginIconSync('https://x.com/i.png')).toEqual({ kind: 'image', src: 'https://x.com/i.png' })
    expect(resolvePluginIconSync('data:image/png;base64,iVBOR')).toEqual({
      kind: 'image',
      src: 'data:image/png;base64,iVBOR',
    })
  })

  it('相对路径同步阶段为 missing（需异步装载）；非法值 missing', () => {
    expect(resolvePluginIconSync('./icon.svg').kind).toBe('missing')
    expect(resolvePluginIconSync('javascript:alert(1)').kind).toBe('missing')
  })
})

describe('resolvePluginIcon（相对路径装载）', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it('读插件安装目录文件并转 data URL', async () => {
    await pluginRegistry.replaceInstalled([
      createManifest({ id: 'icon-test-plugin', installPath: 'D:/plugins/icon-test' }),
    ])
    mockedInvoke.mockResolvedValueOnce(TINY_SVG_BASE64)

    const resolved = await resolvePluginIcon('./icon.svg', 'icon-test-plugin')

    expect(mockedInvoke).toHaveBeenCalledWith('download_file_binary', {
      path: 'D:/plugins/icon-test/icon.svg',
    })
    expect(resolved.kind).toBe('image')
    if (resolved.kind === 'image') {
      expect(resolved.src).toBe(`data:image/svg+xml;base64,${TINY_SVG_BASE64}`)
    }
  })

  it('同一图标只读盘一次（缓存命中）', async () => {
    await pluginRegistry.replaceInstalled([
      createManifest({ id: 'icon-test-plugin', installPath: 'D:/plugins/icon-test' }),
    ])
    mockedInvoke.mockResolvedValue(TINY_SVG_BASE64)

    await resolvePluginIcon('cached-icon.png', 'icon-test-plugin')
    await resolvePluginIcon('cached-icon.png', 'icon-test-plugin')

    expect(mockedInvoke).toHaveBeenCalledTimes(1)
  })

  it('无 pluginId/installPath 时直接 missing，不读盘', async () => {
    expect((await resolvePluginIcon('./icon.svg')).kind).toBe('missing')
    await pluginRegistry.replaceInstalled([createManifest({ id: 'no-install-path' })])
    expect((await resolvePluginIcon('./icon.svg', 'no-install-path')).kind).toBe('missing')
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('护栏：.. 逃逸 / 非图片扩展名拒绝读盘', async () => {
    await pluginRegistry.replaceInstalled([
      createManifest({ id: 'icon-test-plugin', installPath: 'D:/plugins/icon-test' }),
    ])

    expect((await resolvePluginIcon('../escape.png', 'icon-test-plugin')).kind).toBe('missing')
    expect((await resolvePluginIcon('./script.js', 'icon-test-plugin')).kind).toBe('missing')
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('护栏：超 512KB 拒绝', async () => {
    await pluginRegistry.replaceInstalled([
      createManifest({ id: 'icon-test-plugin', installPath: 'D:/plugins/icon-test' }),
    ])
    // 700KB base64（解码后约 525KB > 512KB 上限）
    mockedInvoke.mockResolvedValueOnce('A'.repeat(700_000))

    expect((await resolvePluginIcon('./big.png', 'icon-test-plugin')).kind).toBe('missing')
  })

  it('读盘失败回退 missing，不抛出', async () => {
    await pluginRegistry.replaceInstalled([
      createManifest({ id: 'icon-test-plugin', installPath: 'D:/plugins/icon-test' }),
    ])
    mockedInvoke.mockRejectedValueOnce(new Error('file not found'))

    expect((await resolvePluginIcon('./missing.svg', 'icon-test-plugin')).kind).toBe('missing')
  })
})

describe('getPluginIconComponent', () => {
  it('内置名直返 lucide 组件本体（行为与旧 pluginIconMap 一致）', () => {
    expect(getPluginIconComponent('Bot')).toBe(pluginIconMap.Bot)
  })

  it('自定义图标返回包装组件，且按 (icon, pluginId) 缓存稳定', () => {
    const a = getPluginIconComponent('./icon-a.svg', 'icon-test-plugin')
    const b = getPluginIconComponent('./icon-a.svg', 'icon-test-plugin')
    expect(a).toBe(b)
    expect(a).not.toBe(pluginIconMap.Bot)
    // 不同 pluginId 各自缓存
    expect(getPluginIconComponent('./icon-a.svg', 'other-plugin')).not.toBe(a)
  })
})
