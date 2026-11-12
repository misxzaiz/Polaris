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
import { rewriteReactImports } from './reactImportRewrite'

let shimUrl: string | null = null

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
  // 面板/卡片 bundle 常含大 vendor（如 exceljs ~950KB），get_file_content 的
  // 1MB 文本限制会误杀合法 bundle（gezhi panel.js 1.45MB 即中招）。改用二进制
  // 接口（download_file_binary，50MB 上限）读取，绕过文本限制。
  const code = await readFileBinaryText(filePath)
  const reactShimUrl = await ensureReactShim()

  // 上下文感知重写：字符串/模板字面量里的代码模板（如 plugin-forge 脚手架）
  // 不能被改写——裸正则会把模板文本也改掉，注入的 blob URL 破坏 bundle 语法
  const patchedCode = rewriteReactImports(code, reactShimUrl)

  const blob = new Blob([patchedCode], { type: 'application/javascript' })
  const blobUrl = URL.createObjectURL(blob)

  try {
    const mod = await import(/* @vite-ignore */ blobUrl)
    return mod
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

/**
 * 由 installPath + 相对 entry 构造完整文件路径。
 */
export function resolvePluginEntryPath(pluginInstallPath: string, entry: string): string {
  const basePath = pluginInstallPath.replace(/\\/g, '/')
  const entryPath = entry.startsWith('./') ? entry.slice(2) : entry
  return `${basePath}/${entryPath}`
}
