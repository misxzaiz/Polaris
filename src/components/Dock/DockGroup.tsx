/**
 * DockGroup — Dock 中的分组容器
 *
 * 渲染:
 *   - 可选的分组标签 (9px 大写, --text-tertiary 色)
 *   - 子项垂直排列
 *   - 上方分组分隔线 (1px dashed border)
 *
 * 用法:
 *   <DockGroup label="PIN">
 *     <DockItem ... />
 *     <DockItem ... />
 *   </DockGroup>
 */

import type { ReactNode } from 'react'

export interface DockGroupProps {
  /** 分组标签 (大写英文短词); 不传 = 不显示标签 */
  label?: string
  /** 是否在顶部画分隔线 (false 用于第一组) */
  divider?: boolean
  children: ReactNode
}

export function DockGroup({ label, divider = true, children }: DockGroupProps) {
  return (
    <div
      className={`flex flex-col items-center w-full pb-1 ${
        divider
          ? 'border-t border-dashed border-border/30 pt-2 mt-1'
          : ''
      }`}
    >
      {label && (
        <span className="text-[8px] font-semibold tracking-[1.5px] text-text-tertiary mb-1">
          {label}
        </span>
      )}
      <div className="flex flex-col items-center gap-0.5 w-full">{children}</div>
    </div>
  )
}
