/**
 * ContextBlockPreview - 上下文块预览组件
 *
 * 展示挂载在 AI 输入框的上下文块（如浏览器圈选区域）：
 * - 折叠态：单行 chip 显示标题/区域数量/尺寸摘要 + 删除按钮
 * - 展开态：显示每个区域的坐标、元素列表、文本与 DOM 片段，供发送前核对
 *
 * 与 AttachmentPreview 平行，但上下文块不进入后端附件管线，
 * 发送时由 ChatInput 转为文本拼入消息。
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, ChevronDown, Target } from 'lucide-react'
import type { MarqueeContextBlock } from '@/services/tauri/browserService'

interface ContextBlockPreviewProps {
  blocks: MarqueeContextBlock[]
  onRemove: (id: string) => void
}

export function ContextBlockPreview({ blocks, onRemove }: ContextBlockPreviewProps) {
  const { t } = useTranslation('chat')
  if (blocks.length === 0) return null

  return (
    <div className="flex flex-col gap-1.5 px-2.5 sm:px-3 pt-2 pb-1 border-b border-border-subtle">
      {blocks.map((block) => (
        <ContextBlockItem key={block.id} block={block} onRemove={() => onRemove(block.id)} />
      ))}
    </div>
  )
}

function ContextBlockItem({ block, onRemove }: { block: MarqueeContextBlock; onRemove: () => void }) {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = useState(false)
  const regionCount = block.regions.length
  const sizeSummary = block.regions
    .map((r) => `${Math.round(r.rect.width)}×${Math.round(r.rect.height)}`)
    .join(' · ')

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 overflow-hidden">
      {/* 折叠态：chip 头部 */}
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <Target size={14} className="shrink-0 text-primary" />
        <span className="shrink-0 text-xs font-medium text-text-primary">
          {t('contextBlock.marqueeTitle', {
            regionCount,
            defaultValue: '圈选区域 · {{regionCount}} 个',
          })}
        </span>
        {sizeSummary && (
          <span className="shrink-0 text-[10px] font-mono text-text-tertiary truncate">{sizeSummary}</span>
        )}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="ml-1 shrink-0 flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-text-secondary hover:bg-background-hover hover:text-text-primary"
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
          className="ml-auto shrink-0 p-0.5 rounded text-text-tertiary hover:text-danger"
          title={t('contextBlock.remove', { defaultValue: '移除' })}
        >
          <X size={13} />
        </button>
      </div>

      {/* 展开态：区域详情 */}
      {expanded && (
        <div className="border-t border-primary/20 px-2.5 py-2">
          <div className="mb-1.5 text-[10px] text-text-tertiary truncate" title={block.url}>
            {block.title || 'Browser'} · {block.url}
          </div>
          {block.userNote && (
            <div className="mb-1.5 text-[11px] text-text-secondary">
              💬 {block.userNote}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            {block.regions.map((region, idx) => (
              <div key={idx} className="rounded-md bg-background-surface border border-border-subtle px-2 py-1.5">
                <div className="flex items-center gap-1.5 text-[10px] text-text-tertiary font-mono">
                  <span className="rounded bg-primary/15 px-1 py-px font-medium text-primary">{idx + 1}</span>
                  <span>({Math.round(region.rect.x)}, {Math.round(region.rect.y)})</span>
                  <span>{Math.round(region.rect.width)}×{Math.round(region.rect.height)}</span>
                  <span>· {region.count} 个元素</span>
                </div>
                {region.elements.length > 0 && (
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
          <div className="mt-1.5 text-[9.5px] text-text-tertiary">
            {t('contextBlock.sendHint', { defaultValue: '发送时将以上内容作为上下文附带给 AI' })}
          </div>
        </div>
      )}
    </div>
  )
}