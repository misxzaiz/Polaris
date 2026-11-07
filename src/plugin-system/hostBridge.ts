/**
 * 宿主桥（polaris-host/*）—— 插件消费宿主通用核心的唯一通道
 *
 * 规范：plugins/docs/plugin-ui-contribution-spec.md §3 [S-1..S-4]
 * - 桥清单封闭：artifact / form / cap（react 走既有独立 shim）
 * - 准入：桥内只放已服务多调用方的宿主通用核心；API 只增不改
 * - 禁绕桥：插件禁止 import 宿主内部路径 / 直调宿主 store
 *
 * 机制：各桥对象挂 window.__POLARIS_HOST_<NAME>__（宿主侧注册），本模块生成
 * 「重导出 blob shim」供插件 bundle import。artifact 对象按需注册（动态
 * import 注册模块，避免把 591 行渲染核心拖进启动包——mermaid 教训），
 * loadModuleFromFile 在检测到插件用到对应桥时先确保注册再重写。
 */

import { rewritePluginImports } from './reactImportRewrite'

export type HostBridgeName = 'artifact' | 'form' | 'cap'

/** 已注册桥清单（封闭，扩展须过 spec [S-2] 准入） */
export const HOST_BRIDGE_NAMES: readonly HostBridgeName[] = ['artifact', 'form', 'cap']

const windowKey = (name: string): string => `__POLARIS_HOST_${name.toUpperCase()}__`

/** 各桥的命名导出成员（与宿主注册对象接口对齐；spec [S-3] 只增不改） */
const HOST_BRIDGE_MEMBERS: Record<HostBridgeName, readonly string[]> = {
  artifact: [
    'ArtifactPreviewRenderer',
    'buildArtifactBlockFromData',
    'normalizeArtifactLikeBlock',
    'useArtifactVersions',
    'useIsSupersededArtifactVersion',
    'readArtifactHtml',
    'openArtifactSource',
  ],
  form: ['registerComponent', 'submitForm', 'skipForm', 'answerQuestion', 'saveFormTemplate'],
  cap: ['forwardCap'],
}

/**
 * 生成一座桥的重导出 shim 源码：命名导出（插件 `import { X } from 'polaris-host/<name>'`）
 * + default 整对象。命名成员在模块求值期即解引用——宿主对象必须先注册
 * （loadModuleFromFile 的 ensureBridgesReady 保证），缺成员在 import 阶段报明确错误。
 */
function shimSource(name: HostBridgeName): string {
  const key = windowKey(name)
  const members = HOST_BRIDGE_MEMBERS[name]
    .map((m) => `export const ${m} = H.${m};`)
    .join('\n')
  return `const H = window[${JSON.stringify(key)}];
if (!H) throw new Error('polaris-host/${name} 宿主桥未就绪（window.${key} 缺失）');
${members}
export default H;
`
}

/** 未注册桥的报错 stub：插件 import 阶段拿到明确错误而非裸 SyntaxError */
function stubSource(name: string): string {
  return `throw new Error('polaris-host/${name} 不是已注册的宿主桥（可用: ${HOST_BRIDGE_NAMES.join('/')}），请检查插件 import');`
}

function makeBlobUrl(source: string): string {
  const blob = new Blob([source], { type: 'application/javascript' })
  return URL.createObjectURL(blob)
}

const shimUrlCache = new Map<string, string>()

/** 生成（或取缓存）一座已注册桥的 shim blob URL */
export function getHostShimUrl(name: HostBridgeName): string {
  const cached = shimUrlCache.get(name)
  if (cached) return cached
  const url = makeBlobUrl(shimSource(name))
  shimUrlCache.set(name, url)
  return url
}

/** 未注册桥名 → 报错 stub URL（按名缓存） */
export function getHostStubUrl(name: string): string {
  const key = `__stub__${name}`
  const cached = shimUrlCache.get(key)
  if (cached) return cached
  const url = makeBlobUrl(stubSource(name))
  shimUrlCache.set(key, url)
  return url
}

// ---------------------------------------------------------------------------
// artifact 桥宿主对象注册（动态，按需）
// ---------------------------------------------------------------------------

let artifactRegistration: Promise<void> | null = null

/**
 * 确保 window.__POLARIS_HOST_ARTIFACT__ 已注册。
 * 动态 import 注册模块：artifact 渲染核心（591 行）只在插件真正用到该桥时
 * 才进加载面（不占启动包）。
 */
export function ensureArtifactHostRegistered(): Promise<void> {
  artifactRegistration ??= (async () => {
    const mod = await bridgeImporters.artifact()
    mod.registerArtifactHost()
  })().catch((err) => {
    // 失败可重试：下次插件加载再试一次
    artifactRegistration = null
    throw err
  })
  return artifactRegistration
}

// ---------------------------------------------------------------------------
// form 桥宿主对象注册（动态，按需）
// ---------------------------------------------------------------------------

/**
 * 动态 importer 注入缝（测试替换用）：生产路径即静态写死的动态 import，
 * 懒 chunk 语义不变；测试经此替换避免 mock 动态 import 的 hoist 陷阱。
 */
export const bridgeImporters = {
  artifact: () => import('../components/Chat/chatBlocks/artifactHostRegistration'),
  form: () => import('../services/formHostRegistration'),
  cap: () => import('../services/capHostRegistration'),
}

let capRegistration: Promise<void> | null = null

/** 确保 window.__POLARIS_HOST_CAP__ 已注册（组件 cap 调用门控执行点，按需加载） */
export function ensureCapHostRegistered(): Promise<void> {
  capRegistration ??= (async () => {
    const mod = await bridgeImporters.cap()
    mod.registerCapHost()
  })().catch((err) => {
    capRegistration = null
    throw err
  })
  return capRegistration
}

let formRegistration: Promise<void> | null = null

/** 确保 window.__POLARIS_HOST_FORM__ 已注册（表单回传薄封装，按需加载） */
export function ensureFormHostRegistered(): Promise<void> {
  formRegistration ??= (async () => {
    const mod = await bridgeImporters.form()
    mod.registerFormHost()
  })().catch((err) => {
    formRegistration = null
    throw err
  })
  return formRegistration
}

/** 测试注入：清空注册与 URL 缓存 */
export function resetHostBridgesForTest(): void {
  artifactRegistration = null
  formRegistration = null
  capRegistration = null
  for (const url of shimUrlCache.values()) URL.revokeObjectURL(url)
  shimUrlCache.clear()
}

/**
 * 检测插件代码用到的宿主桥并确保宿主对象就绪（artifact/form 需动态注册）。
 * 字符串字面量里的误匹配无害——重复 ensure 是幂等的。
 */
export async function ensureBridgesReady(code: string): Promise<void> {
  const names = new Set<string>()
  for (const m of code.matchAll(/polaris-host\/([A-Za-z0-9_-]+)/g)) names.add(m[1])
  if (names.has('artifact')) await ensureArtifactHostRegistered()
  if (names.has('form')) await ensureFormHostRegistered()
  if (names.has('cap')) await ensureCapHostRegistered()
}

/**
 * 完整重写：react → React shim，polaris-host/<name> → 桥 shim（未注册桥 → 报错 stub）。
 * 上下文感知（字符串/注释/正则字面量内不重写）由 rewriteImports 保证。
 */
export function rewriteForPluginModule(code: string, reactShimUrl: string): string {
  const hostShims: Record<string, string> = {}
  for (const name of HOST_BRIDGE_NAMES) hostShims[name] = getHostShimUrl(name)
  return rewritePluginImports(code, {
    reactShimUrl,
    hostShims,
    onUnknownHost: (name) => getHostStubUrl(name),
  })
}
