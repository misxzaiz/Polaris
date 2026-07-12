/**
 * Link 卡片：渲染图标/标题/描述/标签/优先级/截止日期/完成态/加密徽章
 */
import { memo } from 'react'
import {
  Pencil, Trash2, Lock, ExternalLink, Calendar, Compass, Star, ListChecks, Link as LinkIcon,
} from 'lucide-react'
import type { Link } from '@/services/personalHub/types'
import {
  TYPE_LABELS, PRIORITY_LABEL, PRIORITY_COLOR, formatRelativeDate, isOverdue,
} from './constants'
import { decryptDescription } from '@/services/personalHub/crypto'
import { getPersonalHubConfig } from '@/services/personalHub/supabase'

interface LinkCardProps {
  link: Link
  onEdit: (link: Link) => void
  onDelete: (id: string) => void
  onToggleComplete: (link: Link) => void
  onOpen: (link: Link) => void
}

function TypeDefaultIcon({ type }: { type: Link['type'] }) {
  const Icon = type === 'navigation' ? Compass : type === 'bookmark' ? Star : type === 'todo' ? ListChecks : LinkIcon
  return <Icon size={16} className="text-text-tertiary shrink-0" />
}

function LinkCardInner({ link, onEdit, onDelete, onToggleComplete, onOpen }: LinkCardProps) {
  const key = getPersonalHubConfig().encryptionKey
  const description = decryptDescription(link.description, !!link.is_encrypted, key)
  const overdue = isOverdue(link.due_date, link.completed)
  const tags = (link.tags ?? []).slice(0, 4)
  const stop = (e: React.MouseEvent) => e.stopPropagation()

  return (
    <div
      onClick={() => onOpen(link)}
      className="rounded-lg border border-border-subtle bg-surface p-3 hover:border-border transition-colors cursor-pointer"
    >
      <div className="flex items-start gap-2">
        {/* 图标 */}
        <div className="shrink-0 mt-0.5">
          {link.icon ? (
            <img
              src={link.icon}
              alt=""
              className="w-5 h-5 rounded object-contain"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          ) : (
            <TypeDefaultIcon type={link.type} />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {link.type === 'todo' && (
              <input
                type="checkbox"
                checked={!!link.completed}
                onChange={() => onToggleComplete(link)}
                onClick={stop}
                className="accent-primary shrink-0"
              />
            )}
            <span
              className={`text-sm font-medium truncate ${
                link.completed ? 'line-through text-text-tertiary' : 'text-text-primary'
              }`}
            >
              {link.title}
            </span>
            {link.is_encrypted && <Lock size={11} className="text-text-tertiary shrink-0" />}
          </div>

          {description && (
            <p className="mt-1 text-xs text-text-secondary line-clamp-2 whitespace-pre-wrap break-all">
              {description}
            </p>
          )}

          {link.url && (
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer"
              onClick={stop}
              className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline truncate max-w-full"
            >
              <ExternalLink size={10} />
              <span className="truncate">{link.url}</span>
            </a>
          )}

          {/* 标签 + 优先级 + 截止日期 + 类型 */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {tags.map((tag) => (
              <span key={tag} className="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px]">
                {tag}
              </span>
            ))}
            {link.tags && link.tags.length > 4 && (
              <span className="text-[10px] text-text-muted">+{link.tags.length - 4}</span>
            )}
            {link.priority && (
              <span
                className="px-1.5 py-0.5 rounded text-[10px] text-white"
                style={{ backgroundColor: PRIORITY_COLOR[link.priority] }}
              >
                {PRIORITY_LABEL[link.priority]}
              </span>
            )}
            {link.due_date && (
              <span className={`inline-flex items-center gap-0.5 text-[10px] ${overdue ? 'text-danger' : 'text-text-tertiary'}`}>
                <Calendar size={10} />
                {formatRelativeDate(link.due_date)}
              </span>
            )}
            <span className="text-[10px] text-text-muted ml-auto">{TYPE_LABELS[link.type]}</span>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0" onClick={stop}>
          <button
            onClick={() => onEdit(link)}
            className="p-1 rounded text-text-tertiary hover:text-primary hover:bg-background-hover"
            title="编辑"
          >
            <Pencil size={12} />
          </button>
          <button
            onClick={() => onDelete(link.id)}
            className="p-1 rounded text-text-tertiary hover:text-danger hover:bg-background-hover"
            title="删除"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}

export const LinkCard = memo(LinkCardInner)
