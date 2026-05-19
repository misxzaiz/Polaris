/**
 * ModuleBody - 模块正文区
 *
 * 撑满 ModuleShell 剩余空间, 自带 overflow auto.
 *
 * 视觉规范:
 *   - 默认 padding: var(--module-padding-y) var(--module-padding-x)
 *   - flex-1 撑满
 *   - overflow-auto (滚动容器)
 *
 * 设计要点:
 *   - 内部应使用 ContainerQuery 或 useSlotContext 感知尺寸 (V2 Phase 3)
 *   - 列表类模块 (FileTree, TodoList) 可通过 noPadding 让自己控制 padding
 */

import type { ReactNode } from 'react'

export interface ModuleBodyProps {
  children: ReactNode
  /** 取消默认 padding, 让内部控件直接贴边 (虚拟列表等) */
  noPadding?: boolean
  /** 关闭 overflow 滚动 (内部自管时) */
  noScroll?: boolean
  /** ARIA 区域名 (建议传入, 与 ModuleHeader.title 同源) */
  ariaLabel?: string
  className?: string
}

export function ModuleBody({
  children,
  noPadding = false,
  noScroll = false,
  ariaLabel,
  className = '',
}: ModuleBodyProps) {
  return (
    <div
      role="region"
      aria-label={ariaLabel}
      className={`flex-1 min-h-0 min-w-0 flex flex-col ${noScroll ? '' : 'overflow-auto'} ${className}`}
      style={
        noPadding
          ? undefined
          : {
              paddingLeft: 'var(--module-padding-x)',
              paddingRight: 'var(--module-padding-x)',
              paddingTop: 'var(--module-padding-y)',
              paddingBottom: 'var(--module-padding-y)',
            }
      }
    >
      {children}
    </div>
  )
}
