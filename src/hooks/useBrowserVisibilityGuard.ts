/**
 * useBrowserVisibilityGuard - 内置浏览器 WebView 可见性全局守护
 *
 * 背景：Native WebView 是 OS 级子窗口（host_window.add_child），与 React 组件树解耦。
 * BrowserPanel unmount 触发的 browserClose 是一次 fire-and-forget IPC，失败即静默，
 * 导致 WebView 残留且 visible 置顶（"关不掉"）。
 *
 * 此 hook 作为常驻全局守护，持续监听 tabStore：对"非激活的 browser tab"主动
 * setBounds(0,0,0,0) 隐藏并重试 close。不依赖单次 IPC 成功——store 每次变化都会重算，
 * 失败下次再补。状态源是 tabStore（单一可信源），而非组件挂载/卸载信号。
 *
 * 复用 BrowserPanel 内已有模式：overlayStore → setBounds(HIDDEN) 隐藏 webview。
 */
import { useEffect } from 'react'
import { useTabStore } from '@/stores/tabStore'
import {
  browserClose,
  browserSetBounds,
  makeBrowserWebviewLabel,
  type BrowserBounds,
} from '@/services/tauri/browserService'

const HIDDEN_BOUNDS: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 }

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function useBrowserVisibilityGuard(): void {
  // 通过 selector 订阅，tabs/activeTabId 变化时组件重渲染，effect 才会重跑
  const tabs = useTabStore((state) => state.tabs)
  const activeTabId = useTabStore((state) => state.activeTabId)

  useEffect(() => {
    if (!isTauriRuntime()) return

    const browserTabs = tabs.filter((tab) => tab.type === 'browser')

    // 目标：所有"非激活"的 browser tab 的 webview label。
    // 激活的那个由 BrowserPanel 自身的 syncBounds 负责 bounds 同步，不在此处干扰。
    const hiddenLabels = browserTabs
      .filter((tab) => tab.id !== activeTabId)
      .map((tab) => makeBrowserWebviewLabel(tab.id))

    if (hiddenLabels.length === 0) return

    // 对每个非激活 browser webview：先隐藏 bounds（立即消除可见残影），
    // 再尝试 close 销毁（释放进程）。二者均为 fire-and-forget，失败由下一轮 effect 补刀。
    for (const label of hiddenLabels) {
      browserSetBounds(label, HIDDEN_BOUNDS).catch(() => {
        // webview 可能已被销毁，静默
      })
      browserClose(label).catch((e) => {
        // eslint-disable-next-line no-console
        console.warn(`[BrowserVisibilityGuard] close failed for ${label}:`, String(e))
      })
    }
  }, [tabs, activeTabId])
}
