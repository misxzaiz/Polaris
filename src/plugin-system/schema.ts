/**
 * 插件 manifest 契约单源（阶段 1.1 B-lite）
 *
 * plans/plugin-system-upgrade-phase1-spec.md 1.1：本模块是前端插件契约的
 * 唯一权威 —— 枚举常量（areas/transports/sourceKinds/cardModes/icons）与
 * 发现产物的 strict 校验都在这里定义；`pluginDiscoveryService` 等消费方
 * 只允许从这里 import，不再各自手写副本（防白名单漂移，如 SquareTerminal
 * 曾被前端校验集静默丢弃）。
 *
 * 与 Rust 侧对应关系：`VALID_PLUGIN_ICONS` 等常量必须与
 * `src-tauri/src/services/plugin_service.rs` 的同名常量集相等（双向 diff
 * 由 vitest 镜像断言守护）；`deny_unknown_fields` 语义由 `.strict()` 承担。
 */
import { z } from 'zod'

export const VALID_VIEW_AREAS = ['activityBar'] as const
export const VALID_TRANSPORTS = ['stdio', 'http'] as const
export const VALID_SOURCE_KINDS = ['user', 'project', 'adapter'] as const
export const VALID_CARD_MODES = ['result', 'interaction'] as const

/**
 * 内置 lucide 图标名（icon 四类值域之一），与 Rust `VALID_PLUGIN_ICONS` 逐字对齐
 * （含 SquareTerminal）。icon 其余三类自定义值（相对路径 / http(s) URL / data:image
 * URL）由 {@link isValidPluginIconValue} 校验，规格见 plans/plugin-custom-icon-spec.md §3。
 */
export const VALID_PLUGIN_ICONS = [
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

/** 自定义图标资源允许的扩展名（与 Rust PLUGIN_ICON_IMAGE_EXTENSIONS 对齐） */
export const PLUGIN_ICON_IMAGE_EXTENSIONS = [
  'svg', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'ico', 'bmp', 'avif',
] as const

/** icon 字段总长上限（与 Rust PLUGIN_ICON_MAX_LEN 对齐） */
export const PLUGIN_ICON_MAX_LEN = 2048

/** 控制字符判定（C0 与 C1；正则形式会触发 no-control-regex，改用码点判断） */
function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

/**
 * icon 字段值域校验（与 Rust `plugin_service::is_supported_plugin_icon` 镜像同一规则）：
 * 1. 内置 lucide 名（白名单，向后兼容）；
 * 2. 相对插件安装目录的资源路径（扩展名白名单，禁止绝对路径/盘符/`..` 逃逸）；
 * 3. http(s) URL；
 * 4. data:image/* URL。
 */
export function isValidPluginIconValue(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > PLUGIN_ICON_MAX_LEN) return false
  if (/\s/.test(trimmed) || hasControlChar(trimmed)) return false
  const builtinNames: readonly string[] = VALID_PLUGIN_ICONS
  if (builtinNames.includes(trimmed)) return true
  if (trimmed.startsWith('data:image/')) return true
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return true
  return isSafePluginIconRelativePath(trimmed)
}

/** 相对路径分支：`\` 归一为 `/` 后校验无 scheme 前缀、无绝对前缀、无盘符、无 `..` 段、扩展名白名单 */
function isSafePluginIconRelativePath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/')
  // 任何 scheme: 前缀（http/data 已在上方显式放行）一律拒绝：file:、ftp: 等
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)) return false
  if (normalized.startsWith('/')) return false
  if (normalized.length >= 2 && normalized[1] === ':') return false
  if (normalized.split('/').some((seg) => seg === '..')) return false
  const ext = normalized.includes('.') ? (normalized.split('.').pop() ?? '') : ''
  if (!ext) return false
  return (PLUGIN_ICON_IMAGE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase())
}

/** 当前前端支持的 manifest schema 版本（与 Rust MANIFEST_SCHEMA_VERSION 对齐） */
export const MANIFEST_SCHEMA_VERSION = '1.0'

/**
 * 发现产物顶层 strict 校验（deny_unknown_fields 语义）。
 *
 * contributes/permissions/origin/compat 内容由各自深度校验负责（views 等
 * 条目级诊断在 pluginDiscoveryService 的 normalize 流程），本 schema 只
 * 承担「未知顶层字段必须 fail fast，绝不静默继承」这一条红线。
 */
export const discoveredManifestShapeSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().optional(),
    builtin: z.boolean().optional(),
    enabledByDefault: z.boolean().optional(),
    // 核心通道插件（plugin-ui-contribution-spec [S-9]）：承载宿主核心交互渲染
    core: z.boolean().optional(),
    manifestVersion: z.string().optional(),
    contributes: z.record(z.string(), z.unknown()).optional(),
    permissions: z.record(z.string(), z.unknown()).optional(),
    origin: z.record(z.string(), z.unknown()).optional(),
    // 方言适配器宿主留注命名空间（L2 前置；host 独占消费）
    compat: z.record(z.string(), z.unknown()).optional(),
    // 宿主盖戳字段（适配器产出不得自带，由容许其存在以回反序列化发现结果）
    source: z.record(z.string(), z.unknown()).optional(),
    // dev-link 直连标记（needs/001，宿主盖戳）：{ sourcePath: 源码目录 }
    dev: z.object({ sourcePath: z.string().min(1) }).strict().optional(),
    installPath: z.string().optional(),
  })
  .strict()

/** 顶层未知字段名提取（仅取 Unrecognized key 类 zod issue；兼容 zod v3/v4 issue 形状） */
export function unknownManifestTopLevelFields(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return []
  const result = discoveredManifestShapeSchema.safeParse(raw)
  if (result.success) return []
  return result.error.issues
    .filter((issue) => issue.code === 'unrecognized_keys')
    .flatMap((issue) => {
      // zod v4 在 issue 上直接给 keys 数组；v3 只有 message，用引号 token 兜底
      const fromKeys = (issue as { keys?: unknown }).keys
      if (Array.isArray(fromKeys)) {
        return fromKeys.filter((key): key is string => typeof key === 'string')
      }
      return [...String(issue.message ?? '').matchAll(/"([^"]+)"|'([^']+)'/g)].map(
        (match) => (match[1] ?? match[2]) ?? '',
      )
    })
    .filter(Boolean)
}
