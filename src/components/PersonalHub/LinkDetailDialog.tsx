/**
 * Link 详情对话框：展示完整字段
 */
import { X, ExternalLink, Lock, Calendar, Tag, Flag, CheckCircle2, Circle } from 'lucide-react'
import type { Link } from '@/services/personalHub/types'
import {
  TYPE_LABELS, PRIORITY_LABEL, formatDateTime, formatRelativeDate,
} from './constants'
import { decryptDescription } from '@/services/personalHub/crypto'
import { getPersonalHubConfig } from '@/services/personalHub/supabase'

interface LinkDetailDialogProps {
  link: Link
  onClose: () => void
  onEdit: (link: Link) => void
}

export function LinkDetailDialog({ link, onClose, onEdit }: LinkDetailDialogProps) {
  const key = getPersonalHubConfig().encryptionKey
  const description = decryptDescription(link.description, !!link.is_encrypted, key)

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-background-elevated">
      {/* 顶栏 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle shrink-0">
        <span className="text-sm font-medium text-text-primary truncate">{link.title}</span>
        <div className="flex items-center gap-1">
          <button onClick={() => onEdit(link)} className="text-xs text-primary hover:underline px-2 py-1">
            编辑
          </button>
          <button onClick={onClose} className="p-1 rounded text-text-secondary hover:text-text-primary hover:bg-background-hover">
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {/* 基本信息 */}
        <section className="space-y-2">
          <h4 className="text-xs font-medium text-text-tertiary uppercase">基本信息</h4>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-text-secondary w-16 shrink-0">类型</span>
            <span className="text-text-primary">{TYPE_LABELS[link.type]}</span>
          </div>
          {link.url && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-text-secondary w-16 shrink-0">URL</span>
              <a href={link.url} target="_blank" rel="noreferrer" className="text-primary hover:underline truncate inline-flex items-center gap-1">
                <ExternalLink size={11} /> <span className="truncate">{link.url}</span>
              </a>
            </div>
          )}
          {link.tags && link.tags.length > 0 && (
            <div className="flex items-start gap-2 text-sm">
              <span className="text-text-secondary w-16 shrink-0 mt-0.5">标签</span>
              <div className="flex flex-wrap gap-1">
                {link.tags.map((t) => (
                  <span key={t} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-primary/10 text-primary text-xs">
                    <Tag size={9} /> {t}
                  </span>
                ))}
              </div>
            </div>
          )}
          {link.priority && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-text-secondary w-16 shrink-0">优先级</span>
              <span className="inline-flex items-center gap-1 text-text-primary">
                <Flag size={11} /> {PRIORITY_LABEL[link.priority]}
              </span>
            </div>
          )}
          {link.due_date && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-text-secondary w-16 shrink-0">截止</span>
              <span className="inline-flex items-center gap-1 text-text-primary">
                <Calendar size={11} /> {formatRelativeDate(link.due_date)} · {formatDateTime(link.due_date)}
              </span>
            </div>
          )}
          {link.type === 'todo' && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-text-secondary w-16 shrink-0">状态</span>
              <span className="inline-flex items-center gap-1 text-text-primary">
                {link.completed ? <CheckCircle2 size={12} className="text-success" /> : <Circle size={12} className="text-text-tertiary" />}
                {link.completed ? '已完成' : '待完成'}
              </span>
            </div>
          )}
        </section>

        {/* 描述 */}
        {description && (
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium text-text-tertiary uppercase">描述</h4>
              {link.is_encrypted && (
                <span className="inline-flex items-center gap-1 text-[10px] text-text-tertiary">
                  <Lock size={10} /> 已加密
                </span>
              )}
            </div>
            <p className="text-sm text-text-primary whitespace-pre-wrap break-words">{description}</p>
          </section>
        )}

        {/* 时间信息 */}
        <section className="space-y-2">
          <h4 className="text-xs font-medium text-text-tertiary uppercase">时间</h4>
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <span className="w-16 shrink-0">创建</span>
            <span>{formatDateTime(link.created_at)}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <span className="w-16 shrink-0">更新</span>
            <span>{formatDateTime(link.updated_at)}</span>
          </div>
        </section>
      </div>

      <div className="px-3 py-2 border-t border-border-subtle shrink-0 flex gap-2">
        {link.url && (
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer"
            className="flex-1 py-2 text-sm font-medium text-center text-primary border border-primary/30 rounded-lg hover:bg-primary/10"
          >
            访问链接
          </a>
        )}
        <button
          onClick={onClose}
          className="flex-1 py-2 text-sm font-medium text-text-secondary border border-border rounded-lg hover:bg-background-hover"
        >
          关闭
        </button>
      </div>
    </div>
  )
}
