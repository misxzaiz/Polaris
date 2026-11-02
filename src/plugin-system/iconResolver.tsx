/**
 * 插件图标解析器（icon 值域唯一解析权威）
 *
 * plans/plugin-custom-icon-spec.md §4：icon 四类值（内置 lucide 名 / 相对插件安装
 * 目录的路径 / http(s) URL / data:image URL）在此统一解析；消费点经
 * `getPluginIconComponent` 拿渲染组件，不自行解析。
 *
 * 失败语义：任一环节失败（文件不存在/超限/非图片扩展名）→ missing，渲染回退
 * Puzzle，不阻塞面板装载。
 *
 * 安全护栏（与 Rust 安装期校验双重执行，防 dev-link 等绕过）：
 * - 相对路径禁止绝对前缀/盘符/`..` 逃逸（schema.ts::isValidPluginIconValue 同源规则）
 * - 扩展名白名单；文件 ≤ 512KB；SVG 经 <img> 渲染（隔离上下文，脚本不执行）
 * - data URL 缓存在内存，页面刷新清空
 */

import { useMemo, useState, useEffect } from 'react'
import type { ComponentType } from 'react'
import { Puzzle, type LucideIcon } from 'lucide-react'
import { invoke } from '@/services/transport'
import { isValidPluginIconValue, PLUGIN_ICON_IMAGE_EXTENSIONS } from './schema'
import { pluginIconMap } from './icons'
import { pluginRegistry } from './registry'

/** 单个图标文件大小上限（512KB；base64 解码前按 3/4 估算） */
const PLUGIN_ICON_MAX_FILE_BYTES = 512 * 1024

export type ResolvedPluginIcon =
  | { kind: 'builtin'; Icon: LucideIcon }
  | { kind: 'image'; src: string }
  | { kind: 'missing' }

/** 渲染回退图标（自定义图标加载失败时避免空白按钮） */
const FALLBACK_ICON = Puzzle

/** data URL 解析缓存：key = `${installPath}::${icon}`（页面刷新清空） */
const fileIconCache = new Map<string, Promise<string | null>>()

const MIME_BY_EXTENSION: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  avif: 'image/avif',
}

/** 内置名判定（icons.ts 的 pluginIconMap 即白名单本体） */
export function isBuiltinPluginIcon(icon: string): boolean {
  return Object.prototype.hasOwnProperty.call(pluginIconMap, icon)
}

/**
 * 同步解析：内置名 / URL / data URL 三类可直接得出结果；相对路径返回 missing
 * （调用方应改用 {@link resolvePluginIcon} 异步补齐）。
 */
export function resolvePluginIconSync(icon: string): ResolvedPluginIcon {
  if (!isValidPluginIconValue(icon)) return { kind: 'missing' }
  if (isBuiltinPluginIcon(icon)) {
    return { kind: 'builtin', Icon: pluginIconMap[icon as keyof typeof pluginIconMap] }
  }
  if (icon.startsWith('data:image/') || icon.startsWith('http://') || icon.startsWith('https://')) {
    return { kind: 'image', src: icon }
  }
  return { kind: 'missing' }
}

/** 由 installPath + 相对路径拼绝对路径（`./` 剥离、`\` 归一，对齐 pluginModuleLoader 语义） */
function joinPluginIconPath(installPath: string, relativeIcon: string): string {
  const base = installPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const rel = relativeIcon.replace(/\\/g, '/')
  return `${base}/${rel.startsWith('./') ? rel.slice(2) : rel}`
}

/**
 * 异步解析：内置名/URL 同步返回；相对路径读插件安装目录下的图片文件 → data URL。
 * 结果缓存；护栏（扩展名白名单 / 512KB 上限 / `..` 逃逸拒绝）在此二次执行。
 */
export function resolvePluginIcon(icon: string, pluginId?: string): Promise<ResolvedPluginIcon> {
  const sync = resolvePluginIconSync(icon)
  if (sync.kind !== 'missing') return Promise.resolve(sync)

  const installPath = pluginId
    ? pluginRegistry.listPlugins().find((p) => p.id === pluginId)?.installPath
    : undefined
  if (!installPath) return Promise.resolve({ kind: 'missing' })

  const key = `${installPath}::${icon}`
  let cached = fileIconCache.get(key)
  if (!cached) {
    cached = loadIconAsDataUrl(installPath, icon).catch(() => null)
    fileIconCache.set(key, cached)
  }
  return cached.then((src) => (src ? { kind: 'image', src } : { kind: 'missing' }))
}

async function loadIconAsDataUrl(installPath: string, icon: string): Promise<string | null> {
  // 护栏二次校验：安装期校验后的 manifest 可能经 dev-link 直连绕过
  if (!isValidPluginIconValue(icon)) return null
  if (icon.startsWith('/') || icon.includes('..')) return null

  const ext = (icon.includes('.') ? (icon.split('.').pop() ?? '') : '').toLowerCase()
  if (!(PLUGIN_ICON_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return null
  const mime = MIME_BY_EXTENSION[ext]
  if (!mime) return null

  const absolutePath = joinPluginIconPath(installPath, icon)
  const base64: string = await invoke('download_file_binary', { path: absolutePath })
  if (!base64) return null
  // 大小护栏：base64 长度 × 3/4 ≈ 原始字节数
  if (Math.floor((base64.length * 3) / 4) > PLUGIN_ICON_MAX_FILE_BYTES) return null
  return `data:${mime};base64,${base64}`
}

/**
 * React hook：同步给出当前解析结果，相对路径类在异步解析完成后补齐。
 * 供 getPluginIconComponent 生成的包装组件内部使用。
 */
export function usePluginIcon(icon: string | undefined, pluginId?: string): ResolvedPluginIcon {
  const initial = useMemo(() => (icon ? resolvePluginIconSync(icon) : ({ kind: 'missing' } as const)), [icon])
  const [resolved, setResolved] = useState<ResolvedPluginIcon>(initial)

  useEffect(() => {
    let cancelled = false
    if (!icon) {
      setResolved({ kind: 'missing' })
      return
    }
    setResolved(resolvePluginIconSync(icon))
    resolvePluginIcon(icon, pluginId).then((result) => {
      if (!cancelled) setResolved(result)
    })
    return () => {
      cancelled = true
    }
  }, [icon, pluginId])

  return resolved
}

export type PluginIconComponentType = ComponentType<{ size?: number; className?: string }>

/**
 * 由 icon 值 + 归属插件取得渲染组件。返回组件与所有消费点现用的
 * `ComponentType<{size?, className?}>` 形状一致（lucide 组件可直返），消费点
 * 仅需把 `pluginIconMap[view.icon]` 换成本函数，渲染 JSX 零改动。
 *
 * 组件按 (icon, pluginId) 模块级缓存，避免每次 render 新建组件类型导致 remount 闪烁。
 */
export function getPluginIconComponent(icon: string, pluginId?: string): PluginIconComponentType {
  const cacheKey = `${pluginId ?? ''}::${icon}`
  const cached = iconComponentCache.get(cacheKey)
  if (cached) return cached

  const sync = resolvePluginIconSync(icon)
  // 内置名直返 lucide 组件本体（零包装、行为与旧 pluginIconMap 完全一致）
  if (sync.kind === 'builtin') {
    iconComponentCache.set(cacheKey, sync.Icon as unknown as PluginIconComponentType)
    return sync.Icon as unknown as PluginIconComponentType
  }

  const Wrapper = ({ size, className }: { size?: number; className?: string }) => {
    const resolved = usePluginIcon(icon, pluginId)
    if (resolved.kind === 'image') {
      return (
        <img
          src={resolved.src}
          width={size}
          height={size}
          alt=""
          draggable={false}
          className={className}
          style={{ objectFit: 'contain' }}
        />
      )
    }
    const Icon = resolved.kind === 'builtin' ? resolved.Icon : FALLBACK_ICON
    return <Icon size={size} className={className} />
  }
  Wrapper.displayName = `PluginIcon(${icon})`

  iconComponentCache.set(cacheKey, Wrapper)
  return Wrapper
}

const iconComponentCache = new Map<string, PluginIconComponentType>()
