/**
 * FloatingIsland 组件类型定义
 */

import type { SessionStatus } from '@/types/session'

export interface SessionMenuItemInfo {
  id: string
  title: string
  status: SessionStatus
  workspaceId: string | null
  workspaceName?: string
  contextWorkspaceCount: number
  isActive: boolean
}