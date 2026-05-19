/**
 * WorkspaceSelector — V2 Dock 顶部的工作区色块
 *
 * 当前阶段最小实现: 仅显示当前工作区缩写 + 渐变色块.
 * 点击行为预留 (后续可拉起工作区切换器 modal).
 *
 * 视觉:
 *   - 36x36 圆角矩形, 8px radius
 *   - 渐变背景 (primary → accent)
 *   - 缩写: workspace.name 取前 1-2 字符大写
 *   - hover scale 1.05
 */

import { useWorkspaceStore } from '@/stores'
import { useTranslation } from 'react-i18next'

export interface WorkspaceSelectorProps {
  onClick?: () => void
}

function deriveInitials(name: string | undefined): string {
  if (!name) return 'P'
  const trimmed = name.trim()
  if (trimmed.length === 0) return 'P'
  // 取前 2 个英文字母, 或第一个中文字符
  const match = trimmed.match(/^[A-Za-z]{1,2}/)
  if (match) return match[0].toUpperCase()
  return trimmed[0].toUpperCase()
}

export function WorkspaceSelector({ onClick }: WorkspaceSelectorProps) {
  const { t } = useTranslation('common')
  const workspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.currentWorkspaceId)
  )
  const initials = deriveInitials(workspace?.name)
  const title = workspace?.name
    ? `${t('labels.workspace', { defaultValue: '工作区' })}: ${workspace.name}`
    : t('labels.workspace', { defaultValue: '工作区' })

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="w-9 h-9 rounded-lg flex items-center justify-center text-white font-bold text-[14px] shadow-lg transition-transform hover:scale-105 mx-auto mb-1"
      style={{
        background: 'linear-gradient(135deg, rgb(var(--c-primary)), rgb(var(--c-accent-ai, 167 139 250)))',
        boxShadow: '0 4px 12px rgb(var(--c-primary) / 0.3)',
      }}
    >
      {initials}
    </button>
  )
}
