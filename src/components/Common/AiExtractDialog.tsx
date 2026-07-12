/**
 * AiExtractDialog - 通用 AI 结构化提取对话框
 *
 * 输入自然语言 → 调用 `onExtract`（底层走 claude --json-schema 结构化提取）→
 * 预览结果 → 确认写入。供 Todo / 需求等场景复用，业务文案与预览渲染由调用方注入，
 * 组件本身只负责「输入 → 提取 → 预览 → 确认」的交互骨架与状态管理。
 */

import { useState, useEffect, type ReactNode } from 'react'
import { X, Sparkles, Loader2 } from 'lucide-react'

export interface AiExtractDialogLabels {
  /** 对话框标题 */
  title: string
  /** 顶部说明（可选） */
  description?: string
  /** 输入框 placeholder */
  placeholder: string
  /** 提取按钮文案 */
  extract: string
  /** 提取中文案 */
  extracting: string
  /** 确认创建按钮文案 */
  confirm: string
  /** 取消按钮文案 */
  cancel: string
  /** 提取结果为空时的提示 */
  empty: string
  /** 未输入内容时的提示 */
  inputRequired: string
}

interface AiExtractDialogProps<T> {
  open: boolean
  labels: AiExtractDialogLabels
  /** 执行提取，返回结构化结果 */
  onExtract: (text: string) => Promise<T>
  /** 判断结果是否为空（空则禁用确认并提示） */
  isEmpty: (result: T) => boolean
  /** 渲染结果预览 */
  renderPreview: (result: T) => ReactNode
  /** 确认写入 */
  onConfirm: (result: T) => Promise<void>
  onClose: () => void
}

export function AiExtractDialog<T>({
  open,
  labels,
  onExtract,
  isEmpty,
  renderPreview,
  onConfirm,
  onClose,
}: AiExtractDialogProps<T>) {
  const [text, setText] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 打开时重置全部状态
  useEffect(() => {
    if (open) {
      setText('')
      setExtracting(false)
      setConfirming(false)
      setResult(null)
      setError(null)
    }
  }, [open])

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const hasResult = result !== null && !isEmpty(result)

  const handleExtract = async () => {
    const value = text.trim()
    if (!value) {
      setError(labels.inputRequired)
      return
    }
    setExtracting(true)
    setError(null)
    setResult(null)
    try {
      const r = await onExtract(value)
      setResult(r)
      if (isEmpty(r)) setError(labels.empty)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setExtracting(false)
    }
  }

  const handleConfirm = async () => {
    if (result === null || isEmpty(result)) return
    setConfirming(true)
    setError(null)
    try {
      await onConfirm(result)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setConfirming(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={labels.title}
      className="fixed inset-0 bg-overlay flex items-center justify-center z-50"
    >
      <div
        className="bg-background-elevated rounded-lg shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-base font-medium text-text-primary flex items-center gap-2">
            <Sparkles size={16} className="text-primary" />
            {labels.title}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-background-hover text-text-secondary hover:text-text-primary transition-all"
            aria-label={labels.cancel}
          >
            <X size={18} />
          </button>
        </div>

        {/* 内容 */}
        <div className="px-4 py-4 space-y-3 overflow-y-auto">
          {labels.description && (
            <p className="text-xs text-text-tertiary">{labels.description}</p>
          )}
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={labels.placeholder}
            rows={5}
            disabled={extracting || confirming}
            className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 text-text-primary placeholder-text-tertiary resize-none disabled:opacity-60"
          />

          {/* 结果预览 */}
          {hasResult && (
            <div className="rounded-lg border border-border bg-background-surface p-3">
              {renderPreview(result as T)}
            </div>
          )}

          {/* 错误提示 */}
          {error && (
            <div className="text-xs text-error bg-error/10 border border-error/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={confirming}
            className="px-3 py-1.5 text-sm bg-background-surface border border-border rounded-lg hover:bg-background-hover text-text-secondary transition-all disabled:opacity-60"
          >
            {labels.cancel}
          </button>
          {!hasResult ? (
            <button
              onClick={handleExtract}
              disabled={extracting || !text.trim()}
              className="px-3 py-1.5 text-sm bg-primary text-on-primary rounded-lg hover:bg-primary/90 transition-all disabled:opacity-60 flex items-center gap-1.5"
            >
              {extracting && <Loader2 size={14} className="animate-spin" />}
              {extracting ? labels.extracting : labels.extract}
            </button>
          ) : (
            <button
              onClick={handleConfirm}
              disabled={confirming}
              className="px-3 py-1.5 text-sm bg-primary text-on-primary rounded-lg hover:bg-primary/90 transition-all disabled:opacity-60 flex items-center gap-1.5"
            >
              {confirming && <Loader2 size={14} className="animate-spin" />}
              {labels.confirm}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
