/**
 * ModuleShell - V2 模块通用 chrome 容器
 *
 * 设计目标:
 *   消灭"模块自带 header + SlotPanel ModuleTabBar"的双层装饰条 (V1 痛点).
 *   ModuleShell 提供统一的头部/工具栏/正文/底栏四件套, 模块作者只需关心内容,
 *   不再自己画 border-b + padding.
 *
 * 用法:
 *   <ModuleShell>
 *     <ModuleHeader title="Git" icon={<GitBranch />} actions={...} />
 *     <ModuleToolbar>{...}</ModuleToolbar>
 *     <ModuleBody>{...}</ModuleBody>
 *     <ModuleFooter>{...}</ModuleFooter>
 *   </ModuleShell>
 *
 * 与 SlotPanel/ModuleTabBar 关系:
 *   - SlotPanel 是"槽位级 chrome": 圆角 + 边描 + Tab 切换
 *   - ModuleShell 是"模块级 chrome": Header + Toolbar + Body + Footer
 *   - 一个 SlotPanel 可包含多个 module, 每个 module 内部用 ModuleShell
 *   - PluginViewContribution.useShell=true 启用 ModuleShell, 期间 SlotPanel
 *     不再画 ModuleTabBar 标题 (由 ModuleHeader 接管, 见 ModuleTabBar 升级)
 *
 * Token:
 *   所有几何尺寸来自 layout-tokens.css 的 --module-* 变量, 不要 hardcode 数值.
 *
 * 可访问性:
 *   - Header 用 <header role="banner">
 *   - Footer 用 <footer role="contentinfo">
 *   - Body 用 <div role="region"> + aria-label (由模块提供)
 */

import type { ReactNode } from 'react'

export interface ModuleShellProps {
  children: ReactNode
  className?: string
}

/** 顶层容器, flex column 撑满父槽位 */
export function ModuleShell({ children, className = '' }: ModuleShellProps) {
  return (
    <div
      className={`flex flex-col flex-1 min-h-0 min-w-0 ${className}`}
      data-module-shell="1"
    >
      {children}
    </div>
  )
}
