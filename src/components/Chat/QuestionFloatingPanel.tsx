/**
 * 问题浮窗组件
 *
 * 当有待回答的 AskUserQuestion 时，在输入框上方弹出紧凑浮窗。
 * 所有问题纵向堆叠，各自独立选择，全部选完后一起格式化发送。
 */

import { memo, useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { X, HelpCircle, Send, Check, Pencil } from 'lucide-react'
import type { QuestionBlock } from '@/types'
import { AutoResizingTextarea } from './AutoResizingTextarea'

export interface QuestionFloatingPanelProps {
  questions: QuestionBlock[]
  onFillAndSend: (text: string) => void
  onDismiss: () => void
}

export const QuestionFloatingPanel = memo(function QuestionFloatingPanel({
  questions,
  onFillAndSend,
  onDismiss,
}: QuestionFloatingPanelProps) {
  const { t } = useTranslation('chat')
  const containerRef = useRef<HTMLDivElement>(null)

  // 每个问题独立追踪选择: questionId → selected values
  const [selections, setSelections] = useState<Map<string, string[]>>(new Map())
  // 自定义输入: questionId → 自定义文本
  const [customInputs, setCustomInputs] = useState<Map<string, string>>(new Map())

  // questions 变化时重置状态
  useEffect(() => {
    setSelections(new Map())
    setCustomInputs(new Map())
  }, [questions])

  // 某个问题的选择处理 — 选选项时清除自定义输入
  const handleOptionClick = useCallback((questionId: string, value: string, multiSelect?: boolean) => {
    setCustomInputs(prev => {
      if (!prev.has(questionId)) return prev
      const next = new Map(prev)
      next.delete(questionId)
      return next
    })
    setSelections(prev => {
      const next = new Map(prev)
      if (multiSelect) {
        const current = next.get(questionId) || []
        next.set(questionId, current.includes(value) ? current.filter(v => v !== value) : [...current, value])
      } else {
        next.set(questionId, [value])
      }
      return next
    })
  }, [])

  // 自定义输入变更 — 输入时清除已选选项
  const handleCustomInputChange = useCallback((questionId: string, text: string) => {
    setCustomInputs(prev => {
      const next = new Map(prev)
      if (text.trim()) {
        next.set(questionId, text)
      } else {
        next.delete(questionId)
      }
      return next
    })
    // 输入内容非空时清除选项选择
    if (text.trim()) {
      setSelections(prev => {
        if (!prev.has(questionId)) return prev
        const next = new Map(prev)
        next.delete(questionId)
        return next
      })
    }
  }, [])

  // 判断某个问题是否已回答（选项已选 或 自定义输入非空）
  const isQuestionAnswered = useCallback((qId: string) => {
    return (selections.get(qId)?.length ?? 0) > 0 || (customInputs.get(qId)?.trim().length ?? 0) > 0
  }, [selections, customInputs])

  // 是否所有问题都已回答
  const allAnswered = questions.every(q => isQuestionAnswered(q.id))

  // 已回答数
  const answeredCount = questions.filter(q => isQuestionAnswered(q.id)).length

  // 构建格式化文本并发送
  const handleSend = useCallback(() => {
    if (!allAnswered) return
    const lines = questions.map(q => {
      const customText = customInputs.get(q.id)?.trim()
      if (customText) {
        return `${q.header}: ${customText}`
      }
      const values = selections.get(q.id) || []
      const labels = values.map(v => {
        const opt = q.options.find(o => o.value === v)
        return opt?.label || v
      })
      return `${q.header}: ${labels.join(', ')}`
    })
    onFillAndSend(lines.join('\n'))
  }, [allAnswered, questions, selections, customInputs, onFillAndSend])

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onDismiss()
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 100)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [onDismiss])

  // 键盘 — textarea 内的 Enter 不触发发送
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onDismiss()
    }
    // 如果焦点在 textarea 内，不拦截 Enter（允许换行）
    const target = e.target as HTMLElement
    const isInTextarea = target.tagName === 'TEXTAREA'
    if ((e.key === 'Enter' && !e.shiftKey && !isInTextarea) && allAnswered) {
      e.preventDefault()
      e.stopPropagation()
      handleSend()
    }
  }, [onDismiss, allAnswered, handleSend])

  const isSingle = questions.length === 1

  return (
    <div
      ref={containerRef}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      className={clsx(
        'rounded-xl border shadow-medium overflow-hidden',
        'bg-background-elevated border-accent/30',
        'max-h-[50vh] flex flex-col',
      )}
    >
      {/* 头部 */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border bg-accent-faint/50 shrink-0">
        <HelpCircle className="w-3.5 h-3.5 text-accent shrink-0" />
        <span className="text-xs font-medium text-text-primary truncate flex-1">
          {isSingle
            ? (questions[0].categoryLabel || t('question.label', '问题'))
            : t('question.pendingQuestion', `待回答问题 (${questions.length})`)
          }
        </span>
        <button
          onClick={onDismiss}
          className="p-0.5 rounded hover:bg-background-hover text-text-tertiary hover:text-text-primary transition-colors shrink-0"
        >
          <X size={14} />
        </button>
      </div>

      {/* 问题列表 - 可滚动 */}
      <div className="flex-1 overflow-y-auto">
        {questions.map((question, qIdx) => {
          const selected = selections.get(question.id) || []
          const hasCustomInput = (customInputs.get(question.id)?.trim().length ?? 0) > 0
          const hasAnswer = selected.length > 0 || hasCustomInput

          return (
            <div key={question.id}>
              {/* 问题标题 + 正文 */}
              <div className={clsx(
                'px-3',
                !isSingle ? 'pt-2 pb-1' : 'pt-2.5 pb-1.5'
              )}>
                {/* 多问题时显示类别标签 + 完成状态 */}
                {!isSingle && (
                  <div className="flex items-center gap-1.5 mb-0.5">
                    {question.categoryLabel && (
                      <span className="text-[10px] font-medium text-accent bg-accent/10 px-1.5 py-0.5 rounded shrink-0">
                        {question.categoryLabel}
                      </span>
                    )}
                    <span className="flex-1" />
                    {hasAnswer && (
                      <Check className="w-3 h-3 text-accent shrink-0" />
                    )}
                  </div>
                )}
                {/* 问题正文：不截断，允许换行 */}
                <p className="text-[13px] leading-relaxed text-text-primary whitespace-pre-wrap break-words">
                  {question.header}
                </p>
              </div>

              {/* 选项 */}
              <div className={clsx(isSingle ? 'px-2.5 pb-2 space-y-1' : 'px-2.5 pb-2 space-y-1')}>
                {question.options.map((option) => {
                  const isSelected = selected.includes(option.value)
                  const hasDescription = !!option.description
                  return (
                    <button
                      key={option.value}
                      onClick={() => handleOptionClick(question.id, option.value, question.multiSelect)}
                      className={clsx(
                        'w-full text-left px-2.5 rounded-md text-sm transition-colors',
                        'flex items-start gap-2 cursor-pointer',
                        'focus:outline-none',
                        hasDescription ? 'py-2' : 'py-1.5',
                        isSelected
                          ? 'bg-accent/15 text-accent border border-accent/25'
                          : 'hover:bg-background-hover border border-transparent',
                      )}
                    >
                      <div
                        role="presentation"
                        className={clsx(
                          question.multiSelect ? 'rounded-sm' : 'rounded-full',
                          'w-3.5 h-3.5 border-2 flex items-center justify-center shrink-0 mt-0.5',
                          isSelected
                            ? 'border-accent bg-accent'
                            : 'border-border'
                        )}
                      >
                        {isSelected && <Check className="w-2 h-2 text-white" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="font-medium text-[13px] leading-tight text-text-primary block">
                          {option.label || option.value}
                        </span>
                        {option.description && (
                          <span className="text-[12px] leading-snug text-text-tertiary mt-0.5 block">
                            {option.description}
                          </span>
                        )}
                        {option.preview && (
                          <code className="text-[11px] leading-snug text-text-tertiary/80 mt-0.5 block font-mono truncate opacity-75">
                            {option.preview}
                          </code>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>

              {/* 自定义输入区域 */}
              {question.allowCustomInput !== false && (
                <div className="px-2.5 pb-2">
                  {/* 当已有选项选中时，显示"或输入自定义内容"入口 */}
                  {selected.length > 0 && !customInputs.get(question.id) ? (
                    <button
                      onClick={() => {
                        // 清除选项选中，聚焦到输入框
                        setSelections(prev => {
                          const next = new Map(prev)
                          next.delete(question.id)
                          return next
                        })
                      }}
                      className="flex items-center gap-1.5 px-2.5 py-1 text-[12px] text-text-tertiary hover:text-accent transition-colors cursor-pointer"
                    >
                      <Pencil size={12} />
                      {t('question.orCustomInput', '或输入自定义内容...')}
                    </button>
                  ) : (
                    <div className={clsx(
                      'rounded-md border transition-colors',
                      customInputs.get(question.id)?.trim()
                        ? 'border-accent/40 bg-accent/5'
                        : 'border-border bg-background-surface/30'
                    )}>
                      <AutoResizingTextarea
                        value={customInputs.get(question.id) || ''}
                        onChange={(e) => handleCustomInputChange(question.id, e.target.value)}
                        placeholder={t('question.customInputPlaceholder', '输入自定义回答...')}
                        maxHeight={80}
                        minHeight={32}
                        className="w-full px-2.5 py-1.5 text-[13px] leading-snug bg-transparent resize-none focus:outline-none text-text-primary placeholder:text-text-tertiary/60"
                        // 阻止 Enter 向上冒泡到容器的 handleKeyDown，避免误触发发送
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            // 普通 Enter = 换行，不冒泡
                            e.stopPropagation()
                          }
                        }}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* 分隔线（非最后一个） */}
              {qIdx < questions.length - 1 && (
                <div className="mx-3 border-t border-border/50" />
              )}
            </div>
          )
        })}
      </div>

      {/* 底部操作 */}
      <div className="shrink-0 px-2.5 py-2 border-t border-border bg-background-elevated/50 flex items-center gap-2">
        <button
          onClick={handleSend}
          disabled={!allAnswered}
          className={clsx(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
            allAnswered
              ? 'bg-primary text-white hover:bg-primary-hover shadow-soft'
              : 'bg-bg-secondary text-text-tertiary cursor-not-allowed',
          )}
        >
          <Send size={12} />
          {isSingle
            ? t('question.selectAndSend')
            : t('question.selectAndSendAll', `确认并发送 (${answeredCount}/${questions.length})`)
          }
        </button>
        {!allAnswered && !isSingle && (
          <span className="text-[11px] text-text-tertiary">
            {t('question.answerAllHint', '请回答所有问题')}
          </span>
        )}
      </div>
    </div>
  )
})

export default QuestionFloatingPanel
