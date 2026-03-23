/**
 * 问题块渲染器组件
 *
 * 用于 AskUserQuestion 工具的交互界面
 * - 显示问题标题、选项列表
 * - 支持单选/多选模式
 * - 支持自定义输入
 * - 支持键盘导航
 */

import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { invoke } from '@tauri-apps/api/core';
import { Check, HelpCircle, CheckCircle } from 'lucide-react';
import { useEventChatStore } from '../../stores';
import { Button } from '../Common/Button';
import type { QuestionBlock } from '../../types';

export interface QuestionBlockRendererProps {
  block: QuestionBlock;
}

export const QuestionBlockRenderer = memo(function QuestionBlockRenderer({ block }: QuestionBlockRendererProps) {
  const { t } = useTranslation('chat');
  const [selectedOptions, setSelectedOptions] = useState<string[]>(block.answer?.selected || []);
  const [customInput, setCustomInput] = useState(block.answer?.customInput || '');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 键盘导航状态
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const conversationId = useEventChatStore(state => state.conversationId);
  const continueChat = useEventChatStore(state => state.continueChat);

  // 是否已回答
  const isAnswered = block.status === 'answered';
  const answer = block.answer;

  // 当前显示的选项
  const allOptions = block.options;
  const displayOptions = block.options.slice(0, 5);
  const hasMoreOptions = block.options.length > 5;
  const [showAllOptions, setShowAllOptions] = useState(false);
  const visibleOptions = showAllOptions ? allOptions : displayOptions;

  // 处理选项选择
  const handleOptionSelect = useCallback((value: string) => {
    if (isAnswered || isSubmitting) return;

    if (block.multiSelect) {
      setSelectedOptions(prev =>
        prev.includes(value)
          ? prev.filter(v => v !== value)
          : [...prev, value]
      );
    } else {
      setSelectedOptions([value]);
    }
  }, [block.multiSelect, isAnswered, isSubmitting]);

  // 构建答案 prompt 格式
  const buildAnswerPrompt = useCallback((answerData: { selected: string[]; customInput?: string }): string => {
    const parts: string[] = [`[交互回答] 问题: "${block.header}"`];

    if (answerData.selected.length > 0) {
      const selectedLabels = answerData.selected.map(value => {
        const option = block.options.find(o => o.value === value);
        return option?.label || value;
      });
      parts.push(`选择的选项: ${selectedLabels.join(', ')}`);
    }

    if (answerData.customInput) {
      parts.push(`自定义输入: ${answerData.customInput}`);
    }

    return parts.join('\n');
  }, [block.header, block.options]);

  // 提交答案
  const handleSubmit = useCallback(async () => {
    if (isAnswered || isSubmitting) return;
    if (selectedOptions.length === 0 && !customInput.trim()) return;

    setIsSubmitting(true);
    try {
      const answer = {
        selected: selectedOptions,
        customInput: customInput.trim() || undefined,
      };

      // 1. 调用后端命令提交答案，更新状态
      await invoke('answer_question', {
        sessionId: conversationId,
        callId: block.id,
        answer,
      });

      // 2. 构建答案 prompt 并发送给 CLI
      const answerPrompt = buildAnswerPrompt(answer);

      // 3. 调用 continueChat 将答案发送给 CLI
      if (conversationId) {
        await continueChat(answerPrompt);
      }
    } catch (error) {
      console.error('[QuestionBlock] 提交答案失败:', error);
    } finally {
      setIsSubmitting(false);
    }
  }, [isAnswered, isSubmitting, selectedOptions, customInput, conversationId, block.id, buildAnswerPrompt, continueChat]);

  // 键盘导航处理
  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (isAnswered || isSubmitting) return;

    const totalInteractiveItems = visibleOptions.length + (block.allowCustomInput ? 1 : 0);

    switch (event.key) {
      case 'ArrowDown':
      case 'Tab':
        if (!event.shiftKey) {
          event.preventDefault();
          setFocusedIndex(prev => (prev + 1) % totalInteractiveItems);
        }
        break;
      case 'ArrowUp':
        event.preventDefault();
        setFocusedIndex(prev => (prev - 1 + totalInteractiveItems) % totalInteractiveItems);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (focusedIndex >= 0 && focusedIndex < visibleOptions.length) {
          handleOptionSelect(visibleOptions[focusedIndex].value);
        } else if (focusedIndex === visibleOptions.length && block.allowCustomInput) {
          // 焦点在输入框，不做特殊处理
        }
        break;
      case 'Escape':
        event.preventDefault();
        setFocusedIndex(-1);
        setCustomInput('');
        break;
    }
  }, [isAnswered, isSubmitting, visibleOptions, block.allowCustomInput, focusedIndex, handleOptionSelect]);

  // 焦点管理
  useEffect(() => {
    if (focusedIndex >= 0 && focusedIndex < visibleOptions.length) {
      const optionElement = containerRef.current?.querySelector(`[data-option-index="${focusedIndex}"]`) as HTMLElement;
      optionElement?.focus();
    } else if (focusedIndex === visibleOptions.length && block.allowCustomInput && inputRef.current) {
      inputRef.current.focus();
    }
  }, [focusedIndex, visibleOptions.length, block.allowCustomInput]);

  return (
    <div
      ref={containerRef}
      role="group"
      aria-labelledby={`question-header-${block.id}`}
      aria-describedby={block.multiSelect ? 'multi-select-hint' : undefined}
      onKeyDown={handleKeyDown}
      className={clsx(
        'my-2 rounded-lg border max-h-[300px] overflow-hidden flex flex-col',
        isAnswered
          ? 'bg-success-faint border-success/30'
          : 'bg-accent-faint border-accent/30'
      )}
    >
      {/* 头部 */}
      <div
        id={`question-header-${block.id}`}
        className="flex items-center gap-2 px-3 py-2 border-b border-inherit bg-inherit/50 shrink-0"
      >
        {isAnswered ? (
          <CheckCircle className="w-4 h-4 text-success" aria-hidden="true" />
        ) : (
          <HelpCircle className="w-4 h-4 text-accent" aria-hidden="true" />
        )}
        <div className="flex-1 min-w-0">
          {block.categoryLabel && (
            <span className="text-xs text-text-tertiary block mb-0.5">
              {block.categoryLabel}
            </span>
          )}
          <span className="text-sm font-medium text-text-primary">
            {block.header}
          </span>
        </div>
        {isAnswered && (
          <span className="ml-auto text-xs text-success">
            {t('question.answered')}
          </span>
        )}
        {block.multiSelect && !isAnswered && (
          <span id="multi-select-hint" className="ml-auto text-xs text-text-tertiary">
            {t('question.multiSelectHint')}
          </span>
        )}
      </div>

      {/* 内容区 - 可滚动 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {/* 选项列表 */}
        {displayOptions.length > 0 && (
          <div role="listbox" aria-multiselectable={block.multiSelect} className="space-y-1.5">
            {visibleOptions.map((option, index) => {
              const isSelected = (answer?.selected || selectedOptions).includes(option.value);
              const isFocused = focusedIndex === index;
              return (
                <button
                  key={index}
                  role="option"
                  data-option-index={index}
                  tabIndex={isFocused ? 0 : -1}
                  aria-selected={isSelected}
                  aria-checked={isSelected}
                  onClick={() => handleOptionSelect(option.value)}
                  disabled={isAnswered || isSubmitting}
                  className={clsx(
                    'w-full text-left px-3 py-2 rounded-md text-sm transition-colors',
                    'flex items-center gap-2',
                    'focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1',
                    isAnswered
                      ? isSelected
                        ? 'bg-success/20 text-success border border-success/30'
                        : 'bg-bg-secondary/50 text-text-tertiary'
                      : isSelected
                        ? 'bg-accent/20 text-accent border border-accent/30'
                        : 'bg-bg-secondary hover:bg-bg-tertiary border border-transparent',
                    isFocused && !isAnswered && 'ring-2 ring-accent ring-offset-1',
                    !isAnswered && !isSubmitting && 'cursor-pointer'
                  )}
                >
                  <div
                    role="presentation"
                    aria-hidden="true"
                    className={clsx(
                    'w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0',
                    isSelected
                      ? isAnswered
                        ? 'border-success bg-success'
                        : 'border-accent bg-accent'
                      : 'border-border'
                  )}>
                    {isSelected && (
                      <Check className="w-2.5 h-2.5 text-white" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium">{option.label || option.value}</span>
                    {option.description && (
                      <span className="block text-xs text-text-tertiary mt-0.5">
                        {option.description}
                      </span>
                    )}
                    {option.preview && !isAnswered && (
                      <span className="block text-xs text-text-quaternary mt-0.5 italic">
                        {option.preview}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}

            {/* 展开更多选项 */}
            {hasMoreOptions && !showAllOptions && !isAnswered && (
              <button
                onClick={() => setShowAllOptions(true)}
                className="w-full text-center text-xs text-accent hover:text-accent-dark py-1"
              >
                {t('question.showMore', { count: block.options.length - 5 })}
              </button>
            )}
          </div>
        )}

        {/* 自定义输入 */}
        {block.allowCustomInput && !isAnswered && (
          <div className="mt-2">
            <label htmlFor={`custom-input-${block.id}`} className="sr-only">
              {t('question.customInputLabel')}
            </label>
            <input
              ref={inputRef}
              id={`custom-input-${block.id}`}
              type="text"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              placeholder={t('question.customInputPlaceholder')}
              disabled={isSubmitting}
              aria-label={t('question.customInputLabel')}
              onFocus={() => setFocusedIndex(visibleOptions.length)}
              className={clsx(
                'w-full px-3 py-2 rounded-md text-sm bg-bg-secondary border border-border',
                'focus:border-accent focus:ring-1 focus:ring-accent outline-none',
                'placeholder:text-text-tertiary disabled:opacity-50',
                focusedIndex === visibleOptions.length && 'ring-2 ring-accent'
              )}
            />
          </div>
        )}

        {/* 已回答时显示答案 */}
        {isAnswered && answer && (
          <div className="mt-2 pt-2 border-t border-inherit">
            <div className="text-xs text-text-secondary">
              {answer.selected.length > 0 && (
                <span>{t('question.selected')}: {answer.selected.join(', ')}</span>
              )}
              {answer.customInput && (
                <span className="ml-2">{t('question.input')}: {answer.customInput}</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 操作按钮 - 固定底部 */}
      {!isAnswered && (
        <div className="shrink-0 px-3 py-2 border-t border-inherit bg-inherit/30">
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={(selectedOptions.length === 0 && !customInput.trim()) || isSubmitting}
            className="w-full"
          >
            {isSubmitting ? t('question.submitting') : t('question.submit')}
          </Button>
        </div>
      )}
    </div>
  );
});

/** 简化版问题渲染器 - 用于归档层 */
export const SimplifiedQuestionRenderer = memo(function SimplifiedQuestionRenderer({ block }: { block: QuestionBlock }) {
  const { t } = useTranslation('chat');

  return (
    <div
      className="my-1 flex items-center gap-2 text-xs text-text-tertiary"
      aria-label={block.status === 'answered' ? t('question.answered') : t('question.pendingAnswer')}
    >
      {block.status === 'answered' ? (
        <CheckCircle className="w-3 h-3 text-success" aria-hidden="true" />
      ) : (
        <HelpCircle className="w-3 h-3 text-accent" aria-hidden="true" />
      )}
      <span className="truncate">{block.header}</span>
      {block.answer && (
        <span className="text-text-secondary truncate max-w-[200px]">
          {block.answer.selected.join(', ') || block.answer.customInput}
        </span>
      )}
    </div>
  );
});

export default QuestionBlockRenderer;
