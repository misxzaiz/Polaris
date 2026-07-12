/**
 * Link 新增/编辑表单抽屉
 * 移植自 personal-hub useLinkForm.ts + LinksView 表单部分。
 * 字段：title/type/url/tags/priority/due_date/icon/description/is_encrypted
 */
import { useState } from 'react'
import { RefreshCw, Image as ImageIcon } from 'lucide-react'
import type { Link, LinkType, Priority } from '@/services/personalHub/types'
import { PRIORITY_OPTIONS, TYPE_OPTIONS_FOR_FORM } from './constants'
import { encryptDescription, decrypt } from '@/services/personalHub/crypto'
import { fetchFavicon } from '@/services/personalHub/favicon'
import { getPersonalHubConfig } from '@/services/personalHub/supabase'

export interface LinkDraft {
  id: string | null
  title: string
  url: string
  description: string
  type: LinkType
  tagsText: string
  priority: Priority
  due_date: string // ISO date string (yyyy-mm-dd) 或空
  is_encrypted: boolean
  icon: string
  completed: boolean
}

interface LinkFormDialogProps {
  draft: LinkDraft
  onChange: (d: LinkDraft) => void
  onClose: () => void
  onSave: () => void
  saving?: boolean
}

export function emptyDraft(type: LinkType = 'navigation'): LinkDraft {
  return {
    id: null,
    title: '',
    url: '',
    description: '',
    type,
    tagsText: '',
    priority: 'medium',
    due_date: '',
    is_encrypted: false,
    icon: '',
    completed: false,
  }
}

export function draftFromLink(link: Link, hasKey: boolean): LinkDraft {
  let description = link.description ?? ''
  if (link.is_encrypted) {
    if (hasKey) {
      try {
        description = decrypt(link.description ?? '', getPersonalHubConfig().encryptionKey) || ''
      } catch {
        description = ''
      }
    } else {
      description = ''
    }
  }
  const due = link.due_date ? link.due_date.slice(0, 10) : ''
  return {
    id: link.id,
    title: link.title,
    url: link.url ?? '',
    description,
    type: link.type,
    tagsText: link.tags?.join(', ') ?? '',
    priority: link.priority ?? 'medium',
    due_date: due,
    is_encrypted: !!link.is_encrypted,
    icon: link.icon ?? '',
    completed: !!link.completed,
  }
}

/** 构造写入 DB 的数据（含加密描述、tags 转数组、todo 字段） */
export function buildLinkData(d: LinkDraft): Record<string, unknown> {
  const key = getPersonalHubConfig().encryptionKey
  const data: Record<string, unknown> = {
    title: d.title.trim(),
    type: d.type,
    icon: d.icon || null,
    is_encrypted: d.is_encrypted,
  }

  if (d.description) {
    data.description = d.is_encrypted ? encryptDescription(d.description, key) : d.description
  } else {
    data.description = null
  }

  if (d.type !== 'todo') {
    data.url = d.url.trim() || null
  }

  const tags = d.tagsText
    ? d.tagsText.split(',').map((t) => t.trim()).filter(Boolean)
    : []
  if (tags.length > 0) data.tags = tags

  if (d.type === 'todo') {
    data.priority = d.priority
    data.due_date = d.due_date ? new Date(d.due_date).toISOString() : null
  }

  return data
}

export function LinkFormDialog({ draft, onChange, onClose, onSave, saving }: LinkFormDialogProps) {
  const hasKey = getPersonalHubConfig().encryptionKey.trim().length > 0
  const [iconLoading, setIconLoading] = useState(false)
  const isEdit = !!draft.id
  const isTodo = draft.type === 'todo'

  // 新增模式 + 填了 url 时，url 失焦自动抓 favicon
  const handleUrlBlur = async () => {
    if (isEdit || !draft.url.trim()) return
    try {
      setIconLoading(true)
      const icon = await fetchFavicon(draft.url)
      if (icon) onChange({ ...draft, icon })
    } finally {
      setIconLoading(false)
    }
  }

  const handleFetchIcon = async () => {
    if (!draft.url.trim()) return
    try {
      setIconLoading(true)
      const icon = await fetchFavicon(draft.url)
      if (icon) onChange({ ...draft, icon })
    } finally {
      setIconLoading(false)
    }
  }

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background-elevated">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle shrink-0">
        <span className="text-sm font-medium text-text-primary">{isEdit ? '编辑' : '新增'}</span>
        <button onClick={onClose} className="text-xs text-text-secondary hover:text-text-primary px-2 py-1">
          取消
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {/* 标题 */}
        <div>
          <label className="block text-xs text-text-secondary mb-1.5">标题 *</label>
          <input
            value={draft.title}
            onChange={(e) => onChange({ ...draft, title: e.target.value })}
            className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        {/* 类型 */}
        <div>
          <label className="block text-xs text-text-secondary mb-1.5">类型</label>
          <select
            value={draft.type}
            onChange={(e) => onChange({ ...draft, type: e.target.value as LinkType })}
            className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {TYPE_OPTIONS_FOR_FORM.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        {/* URL（非 todo） */}
        {!isTodo && (
          <div>
            <label className="block text-xs text-text-secondary mb-1.5">URL</label>
            <input
              value={draft.url}
              onChange={(e) => onChange({ ...draft, url: e.target.value })}
              onBlur={handleUrlBlur}
              placeholder="https://"
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
        )}

        {/* 图标 */}
        {!isTodo && (
          <div>
            <label className="block text-xs text-text-secondary mb-1.5">图标</label>
            <div className="flex items-center gap-2">
              {draft.icon ? (
                <img src={draft.icon} alt="" className="w-7 h-7 rounded object-contain bg-surface border border-border" />
              ) : (
                <div className="w-7 h-7 rounded bg-surface border border-border flex items-center justify-center">
                  <ImageIcon size={12} className="text-text-muted" />
                </div>
              )}
              <input
                value={draft.icon}
                onChange={(e) => onChange({ ...draft, icon: e.target.value })}
                placeholder="图标 URL（自动抓取或手动填写）"
                className="flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <button
                type="button"
                onClick={handleFetchIcon}
                disabled={iconLoading || !draft.url.trim()}
                title="重新抓取图标"
                className="inline-flex items-center gap-1 px-3 py-2 text-xs border border-border rounded-lg text-text-secondary hover:bg-background-hover disabled:opacity-50 shrink-0"
              >
                <RefreshCw size={12} className={iconLoading ? 'animate-spin' : ''} />
                抓取
              </button>
            </div>
          </div>
        )}

        {/* 标签 */}
        <div>
          <label className="block text-xs text-text-secondary mb-1.5">标签（逗号分隔）</label>
          <input
            value={draft.tagsText}
            onChange={(e) => onChange({ ...draft, tagsText: e.target.value })}
            placeholder="vue, react, 工具"
            className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        {/* todo 专属：优先级 + 截止日期 */}
        {isTodo && (
          <>
            <div>
              <label className="block text-xs text-text-secondary mb-1.5">优先级</label>
              <select
                value={draft.priority}
                onChange={(e) => onChange({ ...draft, priority: e.target.value as Priority })}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {PRIORITY_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1.5">截止日期</label>
              <input
                type="date"
                value={draft.due_date}
                onChange={(e) => onChange({ ...draft, due_date: e.target.value })}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          </>
        )}

        {/* 描述 */}
        <div>
          <label className="block text-xs text-text-secondary mb-1.5">描述</label>
          <textarea
            value={draft.description}
            onChange={(e) => onChange({ ...draft, description: e.target.value })}
            rows={4}
            className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary resize-none"
          />
          <label className="mt-2 flex items-center gap-2 text-xs text-text-secondary">
            <input
              type="checkbox"
              checked={draft.is_encrypted}
              disabled={!hasKey}
              onChange={(e) => onChange({ ...draft, is_encrypted: e.target.checked })}
              className="accent-primary"
            />
            <span className={hasKey ? '' : 'text-text-muted'}>
              加密描述 {!hasKey && '（需先在设置中配置加密密钥）'}
            </span>
          </label>
        </div>
      </div>

      <div className="px-3 py-2 border-t border-border-subtle shrink-0">
        <button
          onClick={onSave}
          disabled={saving}
          className="w-full py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? '保存中...' : '保存'}
        </button>
      </div>
    </div>
  )
}
