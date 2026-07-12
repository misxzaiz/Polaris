/**
 * AskQuestionCard — AskUserQuestion 多题轮播卡片
 *
 * 设计原则：
 *   - 一个 MCP tool_call 内的 N 个 question（1~4）统一在一张卡片里渲染
 *   - 顶部 Stepper 显示进度，可点击跳转任一题
 *   - 底部 "上一题 / 下一题 / 全部提交" 控制
 *   - 当前题支持选项 + 自定义输入互斥 + 单题跳过
 *   - 全部提交：把每题答案打包成 answers[] 一次性回填 CLI tool_result
 *   - 全部跳过：declined = true，整 call decline
 *   - 提交/跳过过程中整张卡片所有交互禁用
 */

import { memo, useReducer, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Check, HelpCircle, CheckCircle, X, ChevronLeft, ChevronRight, SkipForward } from 'lucide-react';
import { invoke } from '@/services/tauri';
import { createLogger } from '@/utils/logger';
import { Button } from '../Common/Button';
import type { QuestionBlock, QuestionItem, QuestionOption, SubAnswer } from '@/types';

const log = createLogger('AskQuestionCard');

interface SlotState {
  selected: string[];
  customInput: string;
  declined: boolean;
}

interface State {
  /** 每题独立答题状态 */
  per: SlotState[];
  /** 当前显示的题序号 */
  currentIdx: number;
  /** 提交中（整卡禁用） */
  submitting: boolean;
  /** 当前题内焦点位置：-1 无焦点；0..options-1 选项；options 输入框 */
  focusedSlot: number;
}

type Action =
  | { type: 'TOGGLE_OPTION'; idx: number; value: string; multiSelect: boolean }
  | { type: 'SET_CUSTOM_INPUT'; idx: number; text: string }
  | { type: 'TOGGLE_DECLINE_ONE'; idx: number }
  | { type: 'GO_TO'; idx: number }
  | { type: 'GO_DELTA'; delta: number; max: number }
  | { type: 'BEGIN_SUBMIT' }
  | { type: 'END_SUBMIT' }
  | { type: 'FOCUS_AT'; slot: number }
  | { type: 'FOCUS_DELTA'; delta: number; max: number };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'TOGGLE_OPTION': {
      const slot = state.per[action.idx];
      if (!slot) return state;
      const isOn = slot.selected.includes(action.value);
      const nextSelected = action.multiSelect
        ? isOn
          ? slot.selected.filter(v => v !== action.value)
          : [...slot.selected, action.value]
        : [action.value];
      // 选项被点 → 清空 customInput、退出 declined
      const per = state.per.map((s, i) =>
        i === action.idx
          ? { ...s, selected: nextSelected, customInput: '', declined: false }
          : s
      );
      return { ...state, per };
    }
    case 'SET_CUSTOM_INPUT': {
      const slot = state.per[action.idx];
      if (!slot) return state;
      const per = state.per.map((s, i) =>
        i === action.idx
          ? {
              ...s,
              customInput: action.text,
              // 非空输入清空选项；空输入保留之前的选项
              selected: action.text.trim() ? [] : s.selected,
              declined: false,
            }
          : s
      );
      return { ...state, per };
    }
    case 'TOGGLE_DECLINE_ONE': {
      const slot = state.per[action.idx];
      if (!slot) return state;
      const per = state.per.map((s, i) =>
        i === action.idx
          ? { selected: [], customInput: '', declined: !s.declined }
          : s
      );
      return { ...state, per };
    }
    case 'GO_TO':
      return { ...state, currentIdx: action.idx, focusedSlot: -1 };
    case 'GO_DELTA': {
      const next = Math.min(Math.max(state.currentIdx + action.delta, 0), action.max - 1);
      return { ...state, currentIdx: next, focusedSlot: -1 };
    }
    case 'BEGIN_SUBMIT':
      return { ...state, submitting: true };
    case 'END_SUBMIT':
      return { ...state, submitting: false };
    case 'FOCUS_AT':
      return { ...state, focusedSlot: action.slot };
    case 'FOCUS_DELTA': {
      const max = Math.max(1, action.max);
      const next = (state.focusedSlot + action.delta + max) % max;
      return { ...state, focusedSlot: next };
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
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 兼容旧 block：questions 缺失时用顶层字段合成单题
  const questions: QuestionItem[] = useMemo(() => {
    if (block.questions && block.questions.length > 0) return block.questions;
    if (block.options && block.header) {
      return [
        {
          question: block.header,
          header: block.categoryLabel || '',
          multiSelect: block.multiSelect,
          options: block.options,
          allowCustomInput: block.allowCustomInput,
        },
      ];
    }
    return [];
  }, [block]);

  const isAnswered = block.status === 'answered';
  const isDeclinedAll = !!block.declined;
  const N = questions.length;
  const isSingle = N === 1;

  // 已答态下的答案（来自 store）
  const persistedAnswers: SubAnswer[] = useMemo(() => {
    if (block.answers && block.answers.length > 0) return block.answers;
    if (block.answer) {
      return [
        {
          selected: block.answer.selected || [],
          customInput: block.answer.customInput,
        },
      ];
    }
    return questions.map(() => ({ selected: [], customInput: undefined }));
  }, [block, questions]);

  const [state, dispatch] = useReducer(reducer, undefined as unknown as State, () => ({
    per: questions.map((_, i) => ({
      selected: persistedAnswers[i]?.selected ?? [],
      customInput: persistedAnswers[i]?.customInput ?? '',
      declined: !!persistedAnswers[i]?.declined,
    })),
    currentIdx: 0,
    submitting: false,
    focusedSlot: -1,
  }));

  const currentQ = questions[state.currentIdx];
  const currentSlot = state.per[state.currentIdx];

  // 判断某题是否"已填答"（选中非空 / 自定义输入非空 / 单题跳过）
  const isSlotAnswered = useCallback(
    (idx: number) => {
      const s = state.per[idx];
      if (!s) return false;
      return s.declined || s.selected.length > 0 || s.customInput.trim().length > 0;
    },
    [state.per]
  );

  // 至少有一道题被答（提交按钮可用条件——允许部分跳过的设计）
  const anyAnswered = useMemo(
    () => state.per.some((_, i) => isSlotAnswered(i)),
    [state.per, isSlotAnswered]
  );
  const allAnswered = useMemo(
    () => state.per.every((_, i) => isSlotAnswered(i)),
    [state.per, isSlotAnswered]
  );
  const answeredCount = state.per.filter((_, i) => isSlotAnswered(i)).length;

  // 提交所有答案
  const submitAll = useCallback(
    async (kind: 'answer' | 'decline-all') => {
      if (isAnswered || state.submitting) return;
      if (!block.sessionId) return;
      if (kind === 'answer' && !anyAnswered) return;

      dispatch({ type: 'BEGIN_SUBMIT' });
      try {
        if (kind === 'decline-all') {
          await invoke('answer_question', {
            sessionId: block.sessionId,
            callId: block.id,
            answer: { answers: [], declined: true },
          });
        } else {
          const answers: SubAnswer[] = state.per.map(s => ({
            selected: s.declined ? [] : s.selected,
            customInput: s.declined ? undefined : s.customInput.trim() || undefined,
            declined: s.declined,
          }));
          await invoke('answer_question', {
            sessionId: block.sessionId,
            callId: block.id,
            answer: { answers, declined: false },
          });
        }
      } catch (error) {
        log.error(
          '提交答案失败:',
          error instanceof Error ? error : new Error(String(error))
        );
      } finally {
        dispatch({ type: 'END_SUBMIT' });
      }
    },
    [isAnswered, state.submitting, state.per, anyAnswered, block.id, block.sessionId]
  );

  // 选项点击
  const handleOptionClick = useCallback(
    (option: QuestionOption) => {
      if (isAnswered || state.submitting) return;
      dispatch({
        type: 'TOGGLE_OPTION',
        idx: state.currentIdx,
        value: option.value,
        multiSelect: !!currentQ?.multiSelect,
      });
    },
    [isAnswered, state.submitting, state.currentIdx, currentQ?.multiSelect]
  );

  // 键盘
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isAnswered || state.submitting) return;
      const optionCount = currentQ?.options.length ?? 0;
      const allowCustom = currentQ?.allowCustomInput !== false;
      const slotCount = optionCount + (allowCustom ? 1 : 0);
      const target = e.target as HTMLElement;
      const inTextField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';

      switch (e.key) {
        case 'ArrowLeft':
          if (inTextField) return;
          e.preventDefault();
          dispatch({ type: 'GO_DELTA', delta: -1, max: N });
          break;
        case 'ArrowRight':
          if (inTextField) return;
          e.preventDefault();
          dispatch({ type: 'GO_DELTA', delta: 1, max: N });
          break;
        case 'ArrowDown':
        case 'Tab':
          if (e.shiftKey) return;
          e.preventDefault();
          dispatch({ type: 'FOCUS_DELTA', delta: 1, max: slotCount });
          break;
        case 'ArrowUp':
          e.preventDefault();
          dispatch({ type: 'FOCUS_DELTA', delta: -1, max: slotCount });
          break;
        case 'Enter': {
          if (inTextField) {
            e.preventDefault();
            // 输入框 Enter：若不是最后一题则跳下一题，否则提交
            if (state.currentIdx < N - 1) {
              dispatch({ type: 'GO_DELTA', delta: 1, max: N });
            } else {
              void submitAll('answer');
            }
            return;
          }
          e.preventDefault();
          if (state.focusedSlot >= 0 && state.focusedSlot < optionCount) {
            handleOptionClick(currentQ!.options[state.focusedSlot]);
          } else if (anyAnswered) {
            void submitAll('answer');
          }
          break;
        }
        case ' ':
          if (state.focusedSlot >= 0 && state.focusedSlot < optionCount) {
            e.preventDefault();
            handleOptionClick(currentQ!.options[state.focusedSlot]);
          }
          break;
        case 'Escape':
          if (inTextField) return;
          e.preventDefault();
          dispatch({ type: 'FOCUS_AT', slot: -1 });
          break;
      }
    },
    [
      isAnswered,
      state.submitting,
      state.currentIdx,
      state.focusedSlot,
      currentQ,
      anyAnswered,
      handleOptionClick,
      submitAll,
      N,
    ]
  );

  // roving tabindex 焦点管理
  useEffect(() => {
    if (state.focusedSlot < 0) return;
    const optionCount = currentQ?.options.length ?? 0;
    if (state.focusedSlot < optionCount) {
      const el = containerRef.current?.querySelector<HTMLElement>(
        `[data-option-index="${state.focusedSlot}"]`
      );
      el?.focus();
    } else if (state.focusedSlot === optionCount && currentQ?.allowCustomInput !== false) {
      inputRef.current?.focus();
    }
  }, [state.focusedSlot, currentQ]);

  // 已答态：列出所有题的答案摘要
  if (isAnswered) {
    return (
      <div
        role="group"
        className="my-2 rounded-lg border bg-success-faint/40 border-success/30 overflow-hidden"
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-success/20 bg-success-faint/50">
          <CheckCircle className="w-4 h-4 text-success shrink-0" aria-hidden="true" />
          <span className="text-sm font-medium text-text-primary">
            {isDeclinedAll
              ? t('question.declinedAll', '已全部跳过')
              : t('question.answeredCount', `已回答 ${answeredCount}/${N}`)}
          </span>
        </div>
        <div className="p-3 space-y-2">
          {questions.map((q, idx) => {
            const ans = persistedAnswers[idx];
            const declined = !!ans?.declined;
            return (
              <div key={idx} className="text-xs">
                <div className="flex items-center gap-1.5 mb-0.5">
                  {q.header && (
                    <span className="text-[11px] font-medium text-success bg-success/10 px-1.5 py-0.5 rounded shrink-0">
                      {q.header}
                    </span>
                  )}
                  <span className="text-text-primary truncate flex-1">{q.question}</span>
                </div>
                <div className="text-text-secondary pl-1">
                  {declined ? (
                    <span className="text-text-tertiary italic">{t('question.skipped', '已跳过')}</span>
                  ) : ans?.selected && ans.selected.length > 0 ? (
                    ans.selected.join(', ')
                  ) : ans?.customInput ? (
                    <>
                      <span className="text-text-tertiary mr-1">✎</span>
                      {ans.customInput}
                    </>
                  ) : (
                    <span className="text-text-tertiary italic">{t('question.noAnswer', '未答')}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // 空 questions 保护
  if (!currentQ) {
    return (
      <div className="my-2 rounded-lg border border-warning/30 bg-warning-faint/30 p-3 text-xs text-text-tertiary">
        {t('question.empty', '空问题块')}
      </div>
    );
  }

  // ====== 渲染：未答态 ======
  const optionCount = currentQ.options.length;
  const allowCustom = currentQ.allowCustomInput !== false;

  return (
    <div
      ref={containerRef}
      role="group"
      aria-labelledby={`askq-title-${block.id}`}
      onKeyDown={handleKeyDown}
      className="my-2 rounded-lg border overflow-hidden flex flex-col bg-accent-faint/30 border-accent/30"
    >
      {/* 顶部：标题 + Stepper + 全部跳过 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-accent/20 bg-accent-faint/50">
        <HelpCircle className="w-4 h-4 text-accent shrink-0" aria-hidden="true" />
        <span id={`askq-title-${block.id}`} className="text-sm font-medium text-text-primary">
          {isSingle
            ? t('question.label', '问题')
            : t('question.multiTitle', `问题 (${N}) · ${answeredCount}/${N}`)}
        </span>

        {/* Stepper：单题时隐藏 */}
        {!isSingle && (
          <div role="tablist" className="flex items-center gap-1 ml-2">
            {questions.map((_, i) => {
              const answered = isSlotAnswered(i);
              const isCur = i === state.currentIdx;
              return (
                <button
                  key={i}
                  type="button"
                  role="tab"
                  aria-selected={isCur}
                  aria-label={t('question.gotoQuestion', `跳到第 ${i + 1} 题`)}
                  onClick={() => dispatch({ type: 'GO_TO', idx: i })}
                  disabled={state.submitting}
                  className={clsx(
                    'w-2.5 h-2.5 rounded-full transition-colors',
                    'focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1',
                    state.submitting && 'cursor-not-allowed',
                    isCur
                      ? answered
                        ? 'bg-accent ring-2 ring-accent/30'
                        : 'bg-accent ring-2 ring-accent/30'
                      : answered
                        ? 'bg-accent/60'
                        : 'bg-border hover:bg-text-tertiary'
                  )}
                />
              );
            })}
          </div>
        )}

        <span className="ml-auto" />
        <button
          type="button"
          onClick={() => void submitAll('decline-all')}
          disabled={state.submitting}
          className={clsx(
            'flex items-center gap-1 px-2 py-1 rounded-md text-xs',
            'text-text-tertiary hover:text-text-primary hover:bg-background-hover',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
          title={t('question.skipAll', '全部跳过')}
        >
          <X className="w-3 h-3" />
          {t('question.skipAll', '全部跳过')}
        </button>
      </div>

      {/* 当前题内容 */}
      <div className="p-3 space-y-2">
        {/* 类别标签 + 正文 */}
        <div>
          {currentQ.header && (
            <div className="mb-1">
              <span className="inline-block text-[11px] font-medium text-accent bg-accent/10 px-2 py-0.5 rounded">
                {currentQ.header}
              </span>
              {currentQ.multiSelect && (
                <span className="ml-2 text-[11px] text-text-tertiary">
                  {t('question.multiSelectHint')}
                </span>
              )}
              {currentSlot?.declined && (
                <span className="ml-2 text-[11px] text-warning">
                  {t('question.thisQuestionSkipped', '本题已跳过')}
                </span>
              )}
            </div>
          )}
          <p className="text-sm leading-relaxed text-text-primary whitespace-pre-wrap break-words">
            {currentQ.question}
          </p>
        </div>

        {/* 选项列表 */}
        <div
          role={currentQ.multiSelect ? 'group' : 'radiogroup'}
          aria-multiselectable={currentQ.multiSelect}
          className={clsx('flex flex-col gap-1', currentSlot?.declined && 'opacity-50')}
        >
          {currentQ.options.map((option, index) => {
            const isSelected = !currentSlot?.declined && currentSlot?.selected.includes(option.value);
            const isFocused = state.focusedSlot === index;
            const disabled = state.submitting || currentSlot?.declined;
            return (
              <button
                key={option.value || index}
                type="button"
                role={currentQ.multiSelect ? 'checkbox' : 'radio'}
                data-option-index={index}
                tabIndex={isFocused ? 0 : -1}
                aria-checked={!!isSelected}
                disabled={disabled}
                onClick={() => handleOptionClick(option)}
                onFocus={() => dispatch({ type: 'FOCUS_AT', slot: index })}
                className={clsx(
                  'w-full text-left px-3 py-2 rounded-md text-sm',
                  'flex items-start gap-2.5 transition-colors',
                  'focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1',
                  disabled && 'cursor-not-allowed',
                  isSelected
                    ? 'bg-accent/15 text-accent border border-accent/30'
                    : 'bg-bg-secondary hover:bg-bg-tertiary border border-transparent',
                  !disabled && 'cursor-pointer'
                )}
              >
                <span
                  aria-hidden="true"
                  className={clsx(
                    'mt-0.5 w-4 h-4 border-2 flex items-center justify-center shrink-0',
                    currentQ.multiSelect ? 'rounded-[3px]' : 'rounded-full',
                    isSelected ? 'border-accent bg-accent' : 'border-border'
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
                </span>
              </button>
            );
          })}
        </div>

        {/* 自定义输入 */}
        {allowCustom && (
          <div className={clsx('mt-1', currentSlot?.declined && 'opacity-50')}>
            <label htmlFor={`askq-custom-${block.id}-${state.currentIdx}`} className="sr-only">
              {t('question.customInputLabel')}
            </label>
            <input
              ref={inputRef}
              id={`askq-custom-${block.id}-${state.currentIdx}`}
              type="text"
              value={currentSlot?.customInput ?? ''}
              onChange={e =>
                dispatch({ type: 'SET_CUSTOM_INPUT', idx: state.currentIdx, text: e.target.value })
              }
              onFocus={() => dispatch({ type: 'FOCUS_AT', slot: optionCount })}
              placeholder={t('question.customInputPlaceholder', '或输入自定义答案……')}
              disabled={state.submitting || currentSlot?.declined}
              className={clsx(
                'w-full px-3 py-1.5 rounded-md text-sm bg-bg-secondary border border-border',
                'focus:border-accent focus:ring-1 focus:ring-accent outline-none',
                'placeholder:text-text-tertiary disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            />
          </div>
        )}

        {/* 单题跳过 */}
        {!isSingle && (
          <div>
            <button
              type="button"
              onClick={() => dispatch({ type: 'TOGGLE_DECLINE_ONE', idx: state.currentIdx })}
              disabled={state.submitting}
              className={clsx(
                'flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors',
                'text-text-tertiary hover:text-warning hover:bg-warning/10',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                currentSlot?.declined && 'text-warning bg-warning/10'
              )}
            >
              <SkipForward className="w-3 h-3" />
              {currentSlot?.declined
                ? t('question.unskipThis', '取消跳过本题')
                : t('question.skipThis', '跳过本题')}
            </button>
          </div>
        )}
      </div>

      {/* 底部导航 */}
      <div
        className={clsx(
          'shrink-0 px-3 py-2 border-t border-accent/20',
          'bg-background-elevated/50 flex items-center gap-2'
        )}
      >
        {!isSingle && (
          <>
            <button
              type="button"
              onClick={() => dispatch({ type: 'GO_DELTA', delta: -1, max: N })}
              disabled={state.currentIdx === 0 || state.submitting}
              className={clsx(
                'flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs',
                'text-text-secondary hover:text-text-primary hover:bg-background-hover',
                'disabled:opacity-30 disabled:cursor-not-allowed'
              )}
            >
              <ChevronLeft className="w-3 h-3" />
              {t('question.prev', '上一题')}
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: 'GO_DELTA', delta: 1, max: N })}
              disabled={state.currentIdx === N - 1 || state.submitting}
              className={clsx(
                'flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs',
                'text-text-secondary hover:text-text-primary hover:bg-background-hover',
                'disabled:opacity-30 disabled:cursor-not-allowed'
              )}
            >
              {t('question.next', '下一题')}
              <ChevronRight className="w-3 h-3" />
            </button>
          </>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={() => void submitAll('answer')}
          disabled={!anyAnswered || state.submitting}
          className="ml-auto"
        >
          {state.submitting
            ? t('question.submitting')
            : isSingle
              ? t('question.submit')
              : allAnswered
                ? t('question.submit')
                : t('question.submitPartial', `提交（${answeredCount}/${N}）`)}
        </Button>
      </div>
    </div>
  );
});

/** 归档层简化渲染 */
export const SimplifiedAskQuestionCard = memo(function SimplifiedAskQuestionCard({
  block,
}: { block: QuestionBlock }) {
  const { t } = useTranslation('chat');
  const isAnswered = block.status === 'answered';
  const N = block.questions?.length ?? (block.options ? 1 : 0);
  const firstText = block.questions?.[0]?.question || block.header || '';
  return (
    <div
      className="my-1 flex items-center gap-2 text-xs text-text-tertiary"
      aria-label={isAnswered ? t('question.answered') : t('question.pendingAnswer')}
    >
      {isAnswered ? (
        <CheckCircle className="w-3 h-3 text-success" aria-hidden="true" />
      ) : (
        <HelpCircle className="w-3 h-3 text-accent" aria-hidden="true" />
      )}
      <span className="truncate">
        {firstText}
        {N > 1 && ` (+${N - 1})`}
      </span>
    </div>
  );
});

export default AskQuestionCard;
