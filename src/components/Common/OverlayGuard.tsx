/**
 * OverlayGuard - 覆盖层守卫组件（原 components/Browser/OverlayGuard，
 * 内置浏览器退役后上移为通用浮层基建）。
 *
 * 包裹任何模态框/面板/弹窗，自动管理 overlayStore 的计数器。
 * 历史：计数器原用于驱动 BrowserPanel 隐藏原生 WebView（WebView2 置顶问题）；
 * 内置浏览器已由 browser-desk 插件（独立 Chrome 进程）承接，计数器现仅承载
 * 浮层互斥/统计语义，消费方保持不变。
 *
 * 使用方式：<OverlayGuard> 包裹模态框的根元素即可
 *
 * 设计原则：
 * - 使用 useEffect 在挂载时 +1 计数器，卸载时 -1
 * - 支持嵌套（如 CreateSessionModal 内打开 CreateWorkspaceModal）
 * - 不影响子组件的渲染和样式
 */

import { useEffect } from 'react'
import { useOverlayStore } from '@/stores/overlayStore'

interface OverlayGuardProps {
  children: React.ReactNode
  /** 可选：调试标签，日志中标识哪个组件触发了覆盖 */
  label?: string
}

export function OverlayGuard({ children, label: _label }: OverlayGuardProps) {
  const increment = useOverlayStore((s) => s.increment)
  const decrement = useOverlayStore((s) => s.decrement)

  useEffect(() => {
    increment()
    return () => {
      decrement()
    }
  }, [increment, decrement])

  return <>{children}</>
}
