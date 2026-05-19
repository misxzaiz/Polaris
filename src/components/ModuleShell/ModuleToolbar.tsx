/**
 * ModuleToolbar - 模块二级工具栏
 *
 * 用于放置 SegmentedControl / 搜索框 / 过滤 chips 等"模块内导航"控件.
 * 位置在 ModuleHeader 之下, ModuleBody 之上.
 *
 * 视觉规范:
 *   - 默认高度: var(--module-toolbar-h) = 32px
 *   - padding: 0 var(--module-padding-x)
 *   - 底部 1px divider (与 header 同色)
 *   - 内容 flex-wrap=false (溢出由组件自管)
 *
 * 设计要点:
 *   - 工具栏不强制高度, 若内容含多行 (如 chip wrap) 可外部覆盖 style
 *   - 工具栏可以省略 (单模块槽位 + useShell + 无二级控件 → 仅 Header)
 */

import type { ReactNode } from 'react'

export interface ModuleToolbarProps {
  children: ReactNode
  /** 自适应高度 (内容多行时); 默认 false 锁定 32px */
  flexible?: boolean
  className?: string
}

export function ModuleToolbar({
  children,
  flexible = false,
  className = '',
}: ModuleToolbarProps) {
  return (
    <div
      role="toolbar"
      className={`flex items-center shrink-0 border-b border-border-subtle gap-2 ${className}`}
      style={{
        height: flexible ? undefined : 'var(--module-toolbar-h)',
        minHeight: 'var(--module-toolbar-h)',
        paddingLeft: 'var(--module-padding-x)',
        paddingRight: 'var(--module-padding-x)',
        paddingTop: flexible ? 'var(--module-padding-y)' : undefined,
        paddingBottom: flexible ? 'var(--module-padding-y)' : undefined,
      }}
    >
      {children}
    </div>
  )
}
