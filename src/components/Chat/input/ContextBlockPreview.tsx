/**
 * ContextBlockPreview - 上下文块预览组件
 *
 * 展示挂载在 AI 输入框的临时上下文块（TCB，如浏览器圈选区域）：
 * - 折叠态：单行 chip 显示标题/来源/尺寸摘要 + 备注按钮 + 删除按钮
 * - 展开态：按 kind 分发渲染详情（坐标/元素列表/文本与 DOM 片段），供发送前核对
 * - 备注编辑：chip 头部备注按钮 → 内联编辑 userNote（updateContextBlockNote）
 *
 * 与 AttachmentPreview 平行，但上下文块不进入后端附件管线，
 * 发送时由 ChatInput 按 kind 转为文本拼入消息。
 *
 * 兼容说明：marquee-context 支持「顶层兼容字段 + data 并存」（见 ContextBlock 类型注释），
 * 读取时顶层优先、data 兜底，保证左侧边栏与输入框视图一致。
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, ChevronDown, Target, MessageSquarePlus, Check } from 'lucide-react'
import type { ContextBlock, ContextBlockKindSpec } from '@/stores/conversationStore/types'

interface ContextBlockPreviewProps {
  blocks: ContextBlock[]
  onRemove: (id: string) => void
  /** 备注编辑回调（ChatInput 注入 updateContextBlockNote） */
  onUpdateNote?: (id: string, note: string) => void
}

export function ContextBlockPreview({ blocks, onRemove, onUpdateNote }: ContextBlockPreviewProps) {
  const { t } = useTranslation('chat')
  if (blocks.length === 0) return null

  return (
    <div className="flex flex-col gap-1.5 px-2.5 sm:px-3 pt-2 pb-1 border-b border-border-subtle">
      {blocks.map((block) => (
        <ContextBlockItem key={block.id} block={block} onRemove={() => onRemove(block.id)} onUpdateNote={onUpdateNote} />
      ))}
    </div>
  )
}

function ContextBlockItem({
  block,
  onRemove,
  onUpdateNote,
}: {
  block: ContextBlock
  onRemove: () => void
  onUpdateNote?: (id: string, note: string) => void
}) {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = useState(false)
  const [editingNote, setEditingNote] = useState(false)
  const [noteDraft, setNoteDraft] = useState(block.userNote ?? '')

  const spec = block.kind !== 'marquee-context' ? undefined : marqueeSpec
  const isMarquee = block.kind === 'marquee-context'
  // 双字段兼容读取：顶层优先，data 兜底
  const url = isMarquee ? (block.url ?? (block.data?.url as string | undefined)) : undefined
  const regions = isMarquee ? (block.regions ?? (block.data?.regions ?? [])) : []
  const source = block.source ?? block.kind
  const sizeSummary = regions
    .map((r) => `${Math.round(r.rect.width)}×${Math.round(r.rect.height)}`)
    .join(' · ')

  const saveNote = () => {
    if (onUpdateNote) onUpdateNote(block.id, noteDraft.trim())
    setEditingNote(false)
  }

  return (
    <div className={`rounded-lg border border-primary/30 bg-primary/5 overflow-hidden ${
      spec ? 'kind-known' : 'kind-unknown'
    }`}>
      {/* 折叠态：chip 头部 */}
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <span className="shrink-0 text-primary">
          {isMarquee ? <Target size={14} /> : <span className="text-[13px]">{spec?.icon ?? '🧩'}</span>}
        </span>
        <span className="shrink-0 text-xs font-medium text-text-primary truncate">
          {block.title}
        </span>
        {source && (
          <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-[9.5px] font-medium text-primary">
            {source}
          </span>
        )}
        {sizeSummary && (
          <span className="hidden sm:inline shrink-0 text-[10px] font-mono text-text-tertiary truncate max-w-[140px]">
            {sizeSummary}
          </span>
        )}
        {/* 备注徽标（已有备注时展示） */}
        {block.userNote && (
          <span className="shrink-0 max-w-[120px] truncate rounded bg-background-surface px-1.5 py-px text-[9.5px] text-text-secondary" title={block.userNote}>
            💬 {block.userNote}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5 shrink-0">
          {/* 备注编辑 */}
          {onUpdateNote && (
            <button
              type="button"
              onClick={() => { setNoteDraft(block.userNote ?? ''); setEditingNote((v) => !v) }}
              className="shrink-0 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-text-secondary hover:bg-background-hover hover:text-primary"
              title={t('contextBlock.note', { defaultValue: '备注' })}
            >
              <MessageSquarePlus size={11} />
            </button>
          )}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-text-secondary hover:bg-background-hover hover:text-text-primary"
            title={expanded
              ? t('contextBlock.collapse', { defaultValue: '收起' })
              : t('contextBlock.expand', { defaultValue: '展开查看' })}
          >
            {t('contextBlock.expandView', { defaultValue: expanded ? '收起' : '查看' })}
            <ChevronDown size={11} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="shrink-0 p-0.5 rounded text-text-tertiary hover:text-danger"
            title={t('contextBlock.remove', { defaultValue: '移除' })}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* 备注编辑区 */}
      {editingNote && (
        <div className="border-t border-primary/20 px-2.5 py-1.5">
          <textarea
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            rows={2}
            placeholder={t('contextBlock.notePlaceholder', { defaultValue: '补充你的意图 / 期望 AI 做什么…' })}
            className="w-full rounded-md bg-background-surface border border-border px-2 py-1.5 text-[11px] outline-none focus:border-primary resize-none"
          />
          <div className="mt-1 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setEditingNote(false)}
              className="rounded px-2 py-0.5 text-[10px] text-text-tertiary hover:bg-background-hover"
            >
              {t('contextBlock.noteCancel', { defaultValue: '取消' })}
            </button>
            <button
              type="button"
              onClick={saveNote}
              className="flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-[10px] text-primary hover:bg-primary/20"
            >
              <Check size={10} />
              {t('contextBlock.noteSave', { defaultValue: '保存备注' })}
            </button>
          </div>
        </div>
      )}

      {/* 展开态：按 kind 分发详情 */}
      {expanded && (
        <div className="border-t border-primary/20 px-2.5 py-2">
          <BlockDetails block={block} isMarquee={isMarquee} url={url} regions={regions} />
          <div className="mt-1.5 text-[9.5px] text-text-tertiary">
            {t('contextBlock.sendHint', { defaultValue: '发送时将以上内容作为上下文附带给 AI' })}
          </div>
        </div>
      )}
    </div>
  )
}

/** 展开态详情：marquee 专属渲染 / 未知 kind 降级 JSON */
function BlockDetails({
  block,
  isMarquee,
  url,
  regions,
}: {
  block: ContextBlock
  isMarquee: boolean
  url?: string
  regions: Array<{ rect: { x: number; y: number; width: number; height: number }; count?: number; elements?: Array<{ kind: string; text: string }>; textSnippet?: string | null; htmlSnippet?: string }>
}) {
  const { t } = useTranslation('chat')
  if (!isMarquee) {
    return (
      <div className="flex flex-col gap-1">
        <div className="text-[10px] text-text-tertiary truncate" title={block.title}>
          {block.title} · kind: {block.kind}
        </div>
        {block.data && Object.keys(block.data).length > 0 && (
          <pre className="mt-1 max-h-32 overflow-auto rounded bg-background-elevated px-1.5 py-1 text-[9.5px] font-mono text-text-tertiary whitespace-pre-wrap break-all">
            {JSON.stringify(block.data, null, 2)}
          </pre>
        )}
      </div>
    )
  }

  return (
    <div>
      <div className="mb-1.5 text-[10px] text-text-tertiary truncate" title={url}>
        {block.title} · {url}
      </div>
      {block.userNote && (
        <div className="mb-1.5 text-[11px] text-text-secondary">
          💬 {block.userNote}
        </div>
      )}
      {regions.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {regions.map((region, idx) => (
            <div key={region.htmlSnippet ? `region-${idx}` : idx} className="rounded-md bg-background-surface border border-border-subtle px-2 py-1.5">
              <div className="flex items-center gap-1.5 text-[10px] text-text-tertiary font-mono">
                <span className="rounded bg-primary/15 px-1 py-px font-medium text-primary">{idx + 1}</span>
                <span>({Math.round(region.rect.x)}, {Math.round(region.rect.y)})</span>
                <span>{Math.round(region.rect.width)}×{Math.round(region.rect.height)}</span>
                {region.count !== undefined && <span>· {region.count} 个元素</span>}
              </div>
              {region.elements && region.elements.length > 0 && (
                <div className="mt-1 text-[10px] text-text-secondary line-clamp-1">
                  {region.elements.slice(0, 3).map((e) => `${e.kind} "${e.text}"`).join(' · ')}
                </div>
              )}
              {region.textSnippet && (
                <div className="mt-0.5 text-[10px] text-text-secondary line-clamp-2">{region.textSnippet}</div>
              )}
              {region.htmlSnippet && (
                <pre className="mt-1 max-h-16 overflow-auto rounded bg-background-elevated px-1.5 py-1 text-[9.5px] font-mono text-text-tertiary whitespace-pre-wrap break-all">
                  {region.htmlSnippet}
                </pre>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[10px] text-text-tertiary">{t('contextBlock.noRegions', { defaultValue: '（无区域详情）' })}</div>
      )}
    </div>
  )
}

/** marquee-context 注册表引用（供 chip 判断已知 kind；渲染/格式化为内置实现） */
const marqueeSpec: ContextBlockKindSpec = {
  icon: '🎯',
}