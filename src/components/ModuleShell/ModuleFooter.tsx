/**
 * ModuleFooter - 模块底栏
 *
 * 用于状态栏/操作按钮固定区. 与 Header 对称.
 *
 * 视觉规范:
 *   - 默认高度: var(--module-footer-h) = 28px
 *   - padding: 0 var(--module-padding-x)
 *   - 顶部 1px divider
 *   - 字号 11px (较 header 小一档)
 *
 * 用法:
 *   <ModuleFooter>
 *     <span className="text-text-tertiary">3 items</span>
 *     <button className="ml-auto">Action</button>
 *   </ModuleFooter>
 */

import type { ReactNode } from 'react'

export interface ModuleFooterProps {
  children: ReactNode
  className?: string
}

export function ModuleFooter({ children, className = '' }: ModuleFooterProps) {
  return (
    <footer
      role="contentinfo"
      className={`flex items-center shrink-0 border-t border-border-subtle text-[11px] text-text-secondary gap-2 ${className}`}
      style={{
        height: 'var(--module-footer-h)',
        paddingLeft: 'var(--module-padding-x)',
        paddingRight: 'var(--module-padding-x)',
      }}
    >
      {children}
    </footer>
  )
}
