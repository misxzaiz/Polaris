/**
 * AskQuestionCard — AskUserQuestion 统一交互卡片
 *
 * 替代旧的 QuestionBlockRenderer + QuestionFloatingPanel 双组件。
 * 与新的 polaris-ask MCP 伴生进程协同：
 *   - 后端 ask_listener 接到问题后 emit `question` → conversationStore
 *   - 本组件渲染卡片，用户提交 → invoke('answer_question', ...)
 *   - 后端 answer_question 触发 oneshot → companion → CLI tool_result
 *   - CLI 在【同回合】续流，不再产生 [交互回答] user 消息
 *
 * 状态机：idle → option_selected | custom_input → submitting → answered
 *           ↘ skipping → declined（已答态）
 */

import { memo, useReducer, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Check, HelpCircle, CheckCircle, X } from 'lucide-react';
import { invoke } from '@/services/tauri';
import { createLogger } from '@/utils/logger';
import { useActiveSessionConversationId } from '@/stores/conversationStore/useActiveSession';
import { Button } from '../Common/Button';
import type { QuestionBlock, QuestionOption } from '@/types';

const log = createLogger('AskQuestionCard');

interface State {
  selected: string[];
  customInput: string;
  submitting: boolean;
  focusedIndex: number;
}

type Action =
  | { type: 'TOGGLE_OPTION'; value: string; multiSelect: boolean }
  | { type: 'SELECT_SINGLE'; value: string }
  | { type: 'SET_CUSTOM_INPUT'; text: string }
  | { type: 'BEGIN_SUBMIT' }
  | { type: 'END_SUBMIT' }
  | { type: 'FOCUS_AT'; index: number }
  | { type: 'FOCUS_DELTA'; delta: number; max: number };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'TOGGLE_OPTION': {
      // 选项与自定义输入互斥：选项被点 → 清空 customInput
      const isOn = state.selected.includes(action.value);
      const next = action.multiSelect
        ? isOn
          ? state.selected.filter((v) => v !== action.value)
          : [...state.selected, action.value]
        : [action.value];
      return { ...state, selected: next, customInput: '' };
    }
    case 'SELECT_SINGLE':
      return { ...state, selected: [action.value], customInput: '' };
    case 'SET_CUSTOM_INPUT':
      // 自定义输入非空 → 清空选项；为空则保留之前的选项不变
      return action.text.trim()
        ? { ...state, customInput: action.text, selected: [] }
        : { ...state, customInput: action.text };
    case 'BEGIN_SUBMIT':
      return { ...state, submitting: true };
    case 'END_SUBMIT':
      return { ...state, submitting: false };
    case 'FOCUS_AT':
      return { ...state, focusedIndex: action.index };
    case 'FOCUS_DELTA': {
      const max = Math.max(1, action.max);
      const next = (state.focusedIndex + action.delta + max) % max;
      return { ...state, focusedIndex: next };
    }
    default:
      return state;
  }
}

export interface AskQuestionCardProps {
  block: QuestionBlock;
}

export const AskQuestionCard = memo(function AskQuestionCard({ block }: AskQuestionCardProps) {
  const { t } = useTranslation('chat');
  const conversationId = useActiveSessionConversationId();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isAnswered = block.status === 'answered';
  const answer = block.answer;

  const [state, dispatch] = useReducer(reducer, {
    selected: answer?.selected ?? [],
    customInput: answer?.customInput ?? '',
    submitting: false,
    focusedIndex: -1,
  });

  const options = block.options;
  const optionCount = options.length;
  const allowCustomInput = block.allowCustomInput !== false;
  // 焦点遍历空间：每个选项一个槽位 + 自定义输入一个槽位（若允许）
  const focusSlots = optionCount + (allowCustomInput ? 1 : 0);

  // 提交答案：调用后端 answer_question，触发同回合 tool_result 回填
  const submit = useCallback(
    async (kind: 'answer' | 'decline') => {
      if (isAnswered || state.submitting) return;
      if (!conversationId) return;
      const hasSelection = state.selected.length > 0 || !!state.customInput.trim();
      if (kind === 'answer' && !hasSelection) return;

      dispatch({ type: 'BEGIN_SUBMIT' });
      try {
        const payload =
          kind === 'answer'
            ? {
                selected: state.selected,
                customInput: state.customInput.trim() || undefined,
              }
            : { selected: [] as string[], customInput: undefined };
        await invoke('answer_question', {
          sessionId: conversationId,
          callId: block.id,
          answer: payload,
        });
        // 不再 continueChat — CLI 通过 polaris-ask MCP 在同回合接收 tool_result
      } catch (error) {
        log.error(
          '提交答案失败:',
          error instanceof Error ? error : new Error(String(error))
        );
      } finally {
        dispatch({ type: 'END_SUBMIT' });
      }
    },
    [isAnswered, state.submitting, state.selected, state.customInput, conversationId, block.id]
  );

  const handleOptionClick = useCallback(
    (option: QuestionOption) => {
      if (isAnswered || state.submitting) return;
      dispatch({
        type: 'TOGGLE_OPTION',
        value: option.value,
        multiSelect: !!block.multiSelect,
      });
    },
    [isAnswered, state.submitting, block.multiSelect]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isAnswered || state.submitting) return;
      switch (e.key) {
        case 'ArrowDown':
        case 'Tab':
          if (e.shiftKey) return;
          e.preventDefault();
          dispatch({ type: 'FOCUS_DELTA', delta: 1, max: focusSlots });
          break;
        case 'ArrowUp':
          e.preventDefault();
          dispatch({ type: 'FOCUS_DELTA', delta: -1, max: focusSlots });
          break;
        case 'Enter': {
          // 在输入框内 Enter 不拦截（允许换行 / 提交两可）
          const target = e.target as HTMLElement;
          if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
            // Enter 在输入框：直接提交
            e.preventDefault();
            void submit('answer');
            return;
          }
          e.preventDefault();
          if (state.focusedIndex >= 0 && state.focusedIndex < optionCount) {
            handleOptionClick(options[state.focusedIndex]);
          } else if (state.selected.length > 0 || state.customInput.trim()) {
            void submit('answer');
          }
          break;
        }
        case ' ':
          if (state.focusedIndex >= 0 && state.focusedIndex < optionCount) {
            e.preventDefault();
            handleOptionClick(options[state.focusedIndex]);
          }
          break;
        case 'Escape':
          e.preventDefault();
          dispatch({ type: 'FOCUS_AT', index: -1 });
          break;
      }
    },
    [
      isAnswered,
      state.submitting,
      state.focusedIndex,
      state.selected,
      state.customInput,
      focusSlots,
      optionCount,
      options,
      handleOptionClick,
      submit,
    ]
  );

  // roving tabindex 焦点管理
  useEffect(() => {
    if (state.focusedIndex < 0) return;
    if (state.focusedIndex < optionCount) {
      const el = containerRef.current?.querySelector<HTMLElement>(
        `[data-option-index="${state.focusedIndex}"]`
      );
      el?.focus();
    } else if (state.focusedIndex === optionCount && allowCustomInput) {
      inputRef.current?.focus();
    }
  }, [state.focusedIndex, optionCount, allowCustomInput]);

  const canSubmit = state.selected.length > 0 || !!state.customInput.trim();

  return (
    <div
      ref={containerRef}
      role="group"
      aria-labelledby={`askq-header-${block.id}`}
      onKeyDown={handleKeyDown}
      className={clsx(
        'my-2 rounded-lg border overflow-hidden flex flex-col transition-colors',
        isAnswered
          ? 'bg-success-faint/40 border-success/30'
          : 'bg-accent-faint/30 border-accent/30'
      )}
    >
      {/* 头部 */}
      <div
        id={`askq-header-${block.id}`}
        className={clsx(
          'flex items-center gap-2 px-3 py-2 border-b shrink-0',
          isAnswered
            ? 'bg-success-faint/50 border-success/20'
            : 'bg-accent-faint/50 border-accent/20'
        )}
      >
        {isAnswered ? (
          <CheckCircle className="w-4 h-4 text-success shrink-0" aria-hidden="true" />
        ) : (
          <HelpCircle className="w-4 h-4 text-accent shrink-0" aria-hidden="true" />
        )}
        <div className="flex-1 min-w-0">
          {block.categoryLabel && (
            <span className="text-[11px] text-text-tertiary block leading-tight">
              {block.categoryLabel}
            </span>
          )}
          <span className="text-sm font-medium text-text-primary block break-words">
            {block.header}
          </span>
        </div>
        {isAnswered && (
          <span className="text-xs text-success shrink-0">{t('question.answered')}</span>
        )}
        {!isAnswered && block.multiSelect && (
          <span className="text-xs text-text-tertiary shrink-0">
            {t('question.multiSelectHint')}
          </span>
        )}
      </div>

      {/* 选项 + 自定义输入 */}
      <div className="flex flex-col p-2.5 gap-1.5">
        <div
          role={block.multiSelect ? 'group' : 'radiogroup'}
          aria-multiselectable={block.multiSelect}
          className="flex flex-col gap-1"
        >
          {options.map((option, index) => {
            const isSelected = (answer?.selected ?? state.selected).includes(option.value);
            const isFocused = state.focusedIndex === index;
            return (
              <button
                key={option.value || index}
                type="button"
                role={block.multiSelect ? 'checkbox' : 'radio'}
                data-option-index={index}
                tabIndex={isFocused ? 0 : -1}
                aria-checked={isSelected}
                disabled={isAnswered || state.submitting}
                onClick={() => handleOptionClick(option)}
                onFocus={() => dispatch({ type: 'FOCUS_AT', index })}
                className={clsx(
                  'w-full text-left px-3 py-2 rounded-md text-sm',
                  'flex items-start gap-2.5 transition-colors',
                  'focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1',
                  isAnswered
                    ? isSelected
                      ? 'bg-success/15 text-success border border-success/30'
                      : 'bg-bg-secondary/40 text-text-tertiary border border-transparent'
                    : isSelected
                      ? 'bg-accent/15 text-accent border border-accent/30'
                      : 'bg-bg-secondary hover:bg-bg-tertiary border border-transparent',
                  !isAnswered && !state.submitting && 'cursor-pointer'
                )}
              >
                <span
                  aria-hidden="true"
                  className={clsx(
                    'mt-0.5 w-4 h-4 border-2 flex items-center justify-center shrink-0',
                    block.multiSelect ? 'rounded-[3px]' : 'rounded-full',
                    isSelected
                      ? isAnswered
                        ? 'border-success bg-success'
                        : 'border-accent bg-accent'
                      : 'border-border'
                  )}
                >
                  {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="font-medium block leading-tight">
                    {option.label || option.value}
                  </span>
                  {option.description && (
                    <span className="block text-xs text-text-tertiary mt-0.5 leading-snug">
                      {option.description}
                    </span>
                  )}
                  {option.preview && !isAnswered && (
                    <span className="block text-[11px] font-mono text-text-tertiary/80 mt-0.5 italic">
                      {option.preview}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        {/* 自定义输入 */}
        {allowCustomInput && !isAnswered && (
          <div className="mt-1">
            <label htmlFor={`askq-custom-${block.id}`} className="sr-only">
              {t('question.customInputLabel')}
            </label>
            <input
              ref={inputRef}
              id={`askq-custom-${block.id}`}
              type="text"
              value={state.customInput}
              onChange={(e) => dispatch({ type: 'SET_CUSTOM_INPUT', text: e.target.value })}
              onFocus={() => dispatch({ type: 'FOCUS_AT', index: optionCount })}
              placeholder={t('question.customInputPlaceholder')}
              disabled={state.submitting}
              className={clsx(
                'w-full px-3 py-1.5 rounded-md text-sm bg-bg-secondary border border-border',
                'focus:border-accent focus:ring-1 focus:ring-accent outline-none',
                'placeholder:text-text-tertiary disabled:opacity-50'
              )}
            />
          </div>
        )}

        {/* 已答态显示用户答案摘要 */}
        {isAnswered && answer && (answer.selected.length > 0 || answer.customInput) && (
          <div className="mt-1 pt-2 border-t border-success/20 text-xs text-text-secondary">
            {answer.selected.length > 0 && (
              <div>
                {t('question.selected')}: {answer.selected.join(', ')}
              </div>
            )}
            {answer.customInput && (
              <div>
                {t('question.input')}: {answer.customInput}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 操作按钮 */}
      {!isAnswered && (
        <div
          className={clsx(
            'shrink-0 px-3 py-2 border-t flex items-center gap-2',
            'bg-background-elevated/50 border-accent/20'
          )}
        >
          <Button
            variant="primary"
            size="sm"
            onClick={() => void submit('answer')}
            disabled={!canSubmit || state.submitting}
          >
            {state.submitting ? t('question.submitting') : t('question.submit')}
          </Button>
          <button
            type="button"
            onClick={() => void submit('decline')}
            disabled={state.submitting}
            className={clsx(
              'flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs',
              'text-text-secondary hover:text-text-primary',
              'hover:bg-background-hover disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            <X className="w-3 h-3" />
            {t('question.skip', '跳过')}
          </button>
          <span className="ml-auto text-[11px] text-text-tertiary">
            {t('question.keyboardHint', '↑↓ 切换  Enter 提交')}
          </span>
        </div>
      )}
    </div>
  );
});

/** 归档层简化渲染 — 沿用旧 SimplifiedQuestionRenderer 形态 */
export const SimplifiedAskQuestionCard = memo(function SimplifiedAskQuestionCard({
  block,
}: { block: QuestionBlock }) {
  const { t } = useTranslation('chat');
  return (
    <div
      className="my-1 flex items-center gap-2 text-xs text-text-tertiary"
      aria-label={
        block.status === 'answered' ? t('question.answered') : t('question.pendingAnswer')
      }
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

export default AskQuestionCard;
