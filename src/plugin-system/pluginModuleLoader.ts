/**
 * 插件 React 模块动态加载器（共享）
 *
 * 读取插件磁盘上的 JS 文件 → 将 `react` / `react/jsx-runtime` 的 import 重写为
 * 指向宿主 React 的 shim → Blob URL 动态 import。面板（panelRegistry）与聊天卡片
 * （chatCardRegistry）共用此加载器，保证外部插件组件与宿主共享同一份 React 实例。
 */

import { readFile } from '@/services/tauri/fileService'

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
    export const createElement = R.createElement;
    export const Fragment = R.Fragment;
    export const Component = R.Component;
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
  const code = await readFile(filePath)
  const reactShimUrl = await ensureReactShim()

  const patchedCode = code
    .replace(/from\s*["']react["']/g, `from "${reactShimUrl}"`)
    .replace(/from\s*["']react\/jsx-runtime["']/g, `from "${reactShimUrl}"`)
    .replace(/require\(\s*["']react["']\s*\)/g, `require("${reactShimUrl}")`)
    .replace(/require\(\s*["']react\/jsx-runtime["']\s*\)/g, `require("${reactShimUrl}")`)

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
