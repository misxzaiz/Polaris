/**
 * QuickSwitchPanel 组件类型定义
 */

import type { SessionStatus } from '@/types/session'

/** 面板可见状态 */
export type PanelVisibility = 'hidden' | 'visible'

/** 会话项信息 */
export interface QuickSessionInfo {
  id: string
  title: string
  status: SessionStatus
  isActive: boolean
  /** 是否可删除（非当前会话且至少有一个其他会话） */
  canDelete: boolean
  /** 是否可续接到新会话 */
  canHandoff?: boolean
  /** 不可续接原因（chat 命名空间 i18n key） */
  handoffReasonKey?: string
}

/** 工作区项信息 */
export interface QuickWorkspaceInfo {
  id: string
  name: string
  path: string
  /** 是否为当前会话的主工作区 */
  isMain: boolean
  /** 是否为关联工作区 */
  isContext: boolean
  /** 关联工作区数量（仅主工作区使用） */
  contextCount?: number
}

/** QuickSwitchPanel Props */
export interface QuickSwitchPanelProps {
  /** 自定义类名 */
  className?: string
}

/** QuickSwitchContent Props（扩展用于钉住功能） */
export interface QuickSwitchContentBaseProps {
  /** 是否钉住面板 */
  isPinned?: boolean
  /** 切换钉住状态回调 */
  onTogglePin?: () => void
}