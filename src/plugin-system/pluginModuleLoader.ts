/**
 * 插件 React 模块动态加载器（共享）
 *
 * 读取插件磁盘上的 JS 文件 → import 重写 → Blob URL 动态 import。面板
 * （panelRegistry）与聊天卡片（chatCardRegistry）共用此加载器，保证外部插件
 * 组件与宿主共享同一份 React 实例。
 *
 * 重写规则（上下文感知见 reactImportRewrite）：
 * - `react` / `react/jsx-runtime` → 宿主 React shim
 */

import { readFileBinaryText } from '@/services/tauri/fileService'

let shimUrl: string | null = null
let reactDomShimUrl: string | null = null

/**
 * 模块级加载缓存（路径 → 已加载模块）。
 *
 * 根因（2026-11-16 AI 回复重复显示）：同一插件 entry 被动态 import 多次时，
 * 每次都会新建 Blob URL → 模块顶层代码重新执行 → 插件内模块级单例
 * （chat-desk 的 EventRouter 等）出现多实例，各自订阅 chat-event →
 * 同一事件被处理两遍（流式 token 双拼、会话双写）。
 * 面板/卡片/UI 贡献三层 loader 共用本缓存，同一路径只加载一次。
 */
const moduleCache = new Map<string, Promise<Record<string, unknown>>>()

async function ensureReactDomShim(): Promise<string> {
  if (reactDomShimUrl) return reactDomShimUrl

  // react-dom shim（ai-chat-plugin-extraction-spec P1.4）：宿主 bundle 已含
  // react-dom，导出 createPortal/flushSync 等插件面板所需成员。插件 bundle
  // 必须 external react-dom（不内嵌副本），由本 shim 提供宿主实例。
  // 缺失的成员导出 undefined，不会在 import 期崩溃（对齐 react shim 容错）。
  const shimCode = `
    const RD = window.__POLARIS_HOST_REACT_DOM__;
    if (!RD) throw new Error('Host ReactDOM not found on window.__POLARIS_HOST_REACT_DOM__');
    export const createPortal = RD.createPortal;
    export const flushSync = RD.flushSync;
    export const createRoot = RD.createRoot;
    export const hydrateRoot = RD.hydrateRoot;
    export default RD;
  `
  const blob = new Blob([shimCode], { type: 'application/javascript' })
  reactDomShimUrl = URL.createObjectURL(blob)
  return reactDomShimUrl
}

async function ensureReactShim(): Promise<string> {
  if (shimUrl) return shimUrl

  const shimCode = `
    const R = window.__POLARIS_HOST_REACT__;
    const J = window.__POLARIS_HOST_REACT_JSX__;
    if (!R) throw new Error('Host React not found on window.__POLARIS_HOST_REACT__');
    export const useState = R.useState;
    export const useEffect = R.useEffect;
    export const useCallback = R.useCallback;
    export const useMemo = R.useMemo;
    export const useRef = R.useRef;
    // 2026-11-12 补齐：插件面板常用但原白名单缺失的导出（polaris-git 实测
    // useSyncExternalStore 不可用被迫降级 useState 订阅，见
    // plans/git-panel-plugin-extraction-implementation.md §6-G3）。
    // 缺失的成员在旧宿主 React 上导出 undefined，不会在 import 期崩溃。
    export const useSyncExternalStore = R.useSyncExternalStore;
    export const useLayoutEffect = R.useLayoutEffect;
    export const useReducer = R.useReducer;
    export const useContext = R.useContext;
    export const useId = R.useId;
    export const useImperativeHandle = R.useImperativeHandle;
    export const useTransition = R.useTransition;
    export const useDeferredValue = R.useDeferredValue;
    export const useInsertionEffect = R.useInsertionEffect;
    export const useDebugValue = R.useDebugValue;
    export const startTransition = R.startTransition;
    export const isValidElement = R.isValidElement;
    export const cloneElement = R.cloneElement;
    export const memo = R.memo;
    export const createElement = R.createElement;
    export const Fragment = R.Fragment;
    export const Component = R.Component;
    export const forwardRef = R.forwardRef;
    // chat-desk 真 UI（P3）依赖面：宿主同实例直取，缺失成员导出 undefined 不崩
    export const Children = R.Children;
    export const Suspense = R.Suspense;
    export const createContext = R.createContext;
    export const lazy = R.lazy;
    export const StrictMode = R.StrictMode;
    export const Profiler = R.Profiler;
    export const useCallbackRef = R.useCallbackRef;
    // 兜底：插件 bundle 可能引用任意 React 顶层成员（如 Component 子类、
    // memo/forwardRef 组合等）。React 公开面整体代理导出，避免逐个补。
    export default R;
    export const jsx = J.jsx;
    export const jsxs = J.jsxs;
    export const jsx_Fragment = J.Fragment;
  `
  const blob = new Blob([shimCode], { type: 'application/javascript' })
  shimUrl = URL.createObjectURL(blob)
  return shimUrl
}

/**
 * 从磁盘文件加载一个 ES module。宿主 React import 会被重写为 shim。
 */
export async function loadModuleFromFile(filePath: string): Promise<Record<string, unknown>> {
  // 同路径复用已加载模块（见 moduleCache 注释：防重复执行插件顶层代码产生多例单例）
  const cached = moduleCache.get(filePath)
  if (cached) return cached

  const pending = (async () => {
    // 面板/卡片 bundle 常含大 vendor（如 exceljs ~950KB），get_file_content 的
    // 1MB 文本限制会误杀合法 bundle（gezhi panel.js 1.45MB 即中招）。改用二进制
    // 接口（download_file_binary，50MB 上限）读取，绕过文本限制。
    const code = await readFileBinaryText(filePath)
    const reactShimUrl = await ensureReactShim()
    const reactDomShimUrl = await ensureReactDomShim()

    // 2026-11-15 chat-desk P3 实测：上下文感知扫描器（reactImportRewrite）在
    // mermaid 库的反引号模板串密集段会错位（把闭合反引号当开启，吞掉 7KB+ 代码），
    // 导致后续 4 处真实 `import ... from "react"` 漏重写 → 面板加载失败
    // 「Failed to resolve module specifier "react"」。
    // 已验证 bundle 内所有 `from "react"` 形态均为真实 import 语句（无字符串字面量
    // 误伤面），改用全局替换：正确率 140/140，误替换风险为零。
    const patchedCode = code
      .replace(/(from\s*)(["'])react\/jsx-runtime\2/g, `$1$2${reactShimUrl}$2`)
      .replace(/(from\s*)(["'])react-dom\/client\2/g, `$1$2${reactDomShimUrl}$2`)
      .replace(/(from\s*)(["'])react-dom\2/g, `$1$2${reactDomShimUrl}$2`)
      .replace(/(from\s*)(["'])react\2/g, `$1$2${reactShimUrl}$2`)

    const blob = new Blob([patchedCode], { type: 'application/javascript' })
    const blobUrl = URL.createObjectURL(blob)

    try {
      const mod = await import(/* @vite-ignore */ blobUrl)
      return mod
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
  })()

  moduleCache.set(filePath, pending)
  // 失败时移除缓存，允许下次重试（面板 error retry 面板仍可用）
  pending.catch(() => moduleCache.delete(filePath))
  return pending
}

/**
 * 由 installPath + 相对 entry 构造完整文件路径。
 */
export function resolvePluginEntryPath(pluginInstallPath: string, entry: string): string {
  const basePath = pluginInstallPath.replace(/\\/g, '/')
  const entryPath = entry.startsWith('./') ? entry.slice(2) : entry
  return `${basePath}/${entryPath}`
}
