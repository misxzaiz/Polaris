/**
 * ModuleHeader - 模块统一头部
 *
 * 替代各模块自带的 `<div className="border-b px-3 py-2">[icon] Module Name</div>` 老写法.
 * 由 ModuleShell 容器渲染, 与 SlotPanel 的 ModuleTabBar 互斥:
 *   - 单模块槽位 + useShell=true → ModuleTabBar 不渲染, ModuleHeader 接管标题
 *   - 多模块槽位 → ModuleTabBar 显示 Tab, ModuleHeader 通常隐藏 (或退化为 title-less)
 *
 * 视觉规范:
 *   - 高度: var(--module-header-h) = 36px
 *   - padding: 0 var(--module-padding-x)
 *   - 底部 1px divider (var(--module-divider))
 *   - 字号 13px, 字重 600
 *
 * 用法:
 *   <ModuleHeader
 *     title="Git"
 *     icon={<GitBranch size={14} />}
 *     subtitle="main · 3 changes"
 *     actions={<><RefreshButton/><MoreButton/></>}
 *   />
 */

import type { ReactNode } from 'react'

export interface ModuleHeaderProps {
  /** 标题文本 (i18n 后传入) */
  title: ReactNode
  /** 标题左侧图标 (建议 size=14) */
  icon?: ReactNode
  /** 标题旁的副标 (灰色小字) */
  subtitle?: ReactNode
  /** 右侧 actions 区 (按钮组) */
  actions?: ReactNode
  className?: string
}

export function ModuleHeader({
  title,
  icon,
  subtitle,
  actions,
  className = '',
}: ModuleHeaderProps) {
  return (
    <header
      role="banner"
      className={`flex items-center shrink-0 border-b border-border-subtle ${className}`}
      style={{
        height: 'var(--module-header-h)',
        paddingLeft: 'var(--module-padding-x)',
        paddingRight: 'var(--module-padding-x)',
      }}
    >
      {icon && (
        <span className="shrink-0 text-text-secondary mr-2" aria-hidden="true">
          {icon}
        </span>
      )}
      <h2 className="text-[13px] font-semibold text-text-primary truncate">{title}</h2>
      {subtitle && (
        <span className="ml-2 text-[11px] text-text-tertiary truncate">{subtitle}</span>
      )}
      {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
    </header>
  )
}
