/**
 * AssistantBubble memo comparator 回归测试
 *
 * 背景：memo comparator 对非流式消息直接 `return true`（认为内容永不变），
 * 导致 form / plugin_card 等异步回填块更新 status/ok/receipt 后 UI 不重渲染
 * （step9 验收 #4 双引擎表单闭环卡在前端 pending 态的根因）。
 *
 * 修复：非流式消息改按 blocks 引用比较——引用变化即放行重渲染。
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { AssistantBubble } from './AssistantBubble';
import type { AssistantChatMessage, FormBlock, QuestionBlock } from '@/types';

/** 构造一条含 form 块的 assistant 消息 */
function makeAssistantMessage(
  blocks: AssistantChatMessage['blocks'],
): AssistantChatMessage {
  return {
    id: 'msg-1',
    type: 'assistant',
    engineId: 'claude',
    timestamp: '2026-09-13T00:00:00.000Z',
    blocks,
  } as AssistantChatMessage;
}

/** 构造一个 pending / submitted 的 form 块 */
function makeFormBlock(status: 'pending' | 'submitted'): FormBlock {
  return {
    type: 'form',
    id: 'form-1',
    sessionId: 'session-1',
    title: '创建待办事项',
    target: 'cap.todo',
    action: 'create',
    fields: [{ name: 'content', type: 'string', label: '待办标题', required: true }],
    status,
    ok: status === 'submitted',
    receipt: status === 'submitted' ? '待办已创建' : undefined,
    createdAt: '2026-09-13T00:00:00.000Z',
  };
}

/** 构造一个 pending / answered 的 question 块 */
function makeQuestionBlock(status: 'pending' | 'answered'): QuestionBlock {
  return {
    type: 'question',
    id: 'q-1',
    sessionId: 'session-1',
    status,
    questions: [{
      question: '是否继续？',
      header: '测试',
      multiSelect: false,
      options: [{ value: 'yes', label: '是' }, { value: 'no', label: '否' }],
      allowCustomInput: false,
    }],
    answers: status === 'answered' ? [{ selected: ['yes'], customInput: undefined }] : [],
  };
}

/** 从 DOM 中提取 form 块的渲染状态 */
function readFormStatus(container: HTMLElement): {
  /** 未提交态：role=form 的可交互面板 */
  pendingForm: boolean;
  /** 已提交态：success 样式条 */
  submitted: boolean;
} {
  const formPanel = container.querySelector('[role="form"]');
  const successBar = container.querySelector('[class*="bg-success-faint"]');
  return {
    pendingForm: !!formPanel,
    submitted: !!successBar,
  };
}

describe('AssistantBubble memo comparator', () => {
  it('非流式消息 blocks 引用变化时重渲染（form 块从 pending → submitted 上屏）', () => {
    const { container, rerender } = render(
      <AssistantBubble message={makeAssistantMessage([makeFormBlock('pending')])} />
    );

    // pending 态：可交互表单面板存在，无 success 条
    expect(readFormStatus(container).pendingForm).toBe(true);
    expect(readFormStatus(container).submitted).toBe(false);

    // 模拟 form-answered：blocks 引用变化，form 块转为 submitted
    rerender(
      <AssistantBubble message={makeAssistantMessage([makeFormBlock('submitted')])} />
    );

    // 修复后应重渲染：表单面板消失，success 条出现
    expect(readFormStatus(container).pendingForm).toBe(false);
    expect(readFormStatus(container).submitted).toBe(true);
  });

  it('非流式消息 blocks 引用相同时不重渲染（DOM 不变）', () => {
    const message = makeAssistantMessage([makeFormBlock('pending')]);
    const { container, rerender } = render(<AssistantBubble message={message} />);

    expect(readFormStatus(container).pendingForm).toBe(true);

    // 同引用重新渲染
    rerender(<AssistantBubble message={message} />);

    // 仍为 pending：表单面板存在，无 success 条
    expect(readFormStatus(container).pendingForm).toBe(true);
    expect(readFormStatus(container).submitted).toBe(false);
  });

  it('流式消息 question 块 status 变化时重渲染（提交答案后立即切已答态）', () => {
    // 构造 pending 态 question 块，isStreaming=true（AI 等待答案期间）
    const pendingMsg = makeAssistantMessage([makeQuestionBlock('pending')]) as AssistantChatMessage & { isStreaming: boolean };
    pendingMsg.isStreaming = true;

    const { container, rerender } = render(<AssistantBubble message={pendingMsg} />);

    // pending 态：存在 AskQuestionCard（未答态，有"提交"按钮）
    const pendingCard = container.querySelector('[role="group"][aria-labelledby^="askq-title-"]');
    expect(pendingCard).toBeTruthy();

    // 模拟提交答案：updateQuestionBlock → 新 blocks 引用 + question status='answered'
    const answeredMsg = makeAssistantMessage([makeQuestionBlock('answered')]) as AssistantChatMessage & { isStreaming: boolean };
    answeredMsg.isStreaming = true;

    rerender(<AssistantBubble message={answeredMsg} />);

    // 修复后应重渲染：已答态卡片（success 样式条出现，原交互按钮消失）
    const successBar = container.querySelector('[class*="bg-success-faint"]');
    expect(successBar).toBeTruthy();
    // 已答态标题（i18n key 在测试环境未解析，但 key 文本本身应出现）
    expect(container.textContent).toContain('question.answeredCount');
    // 已答态展示答案内容（不再有提交按钮）
    expect(container.textContent).toContain('yes');
  });

  it('流式消息 question 块 status 相同时不重渲染（DOM 不变）', () => {
    const pendingMsg = makeAssistantMessage([makeQuestionBlock('pending')]) as AssistantChatMessage & { isStreaming: boolean };
    pendingMsg.isStreaming = true;

    const { container, rerender } = render(<AssistantBubble message={pendingMsg} />);
    const before = container.querySelector('[role="group"][aria-labelledby^="askq-title-"]');
    expect(before).toBeTruthy();

    // 同引用重新渲染（status 不变）
    rerender(<AssistantBubble message={pendingMsg} />);

    // 仍为 pending：交互卡片仍在
    const after = container.querySelector('[role="group"][aria-labelledby^="askq-title-"]');
    expect(after).toBeTruthy();
    // 无 success 条（未切已答态）
    expect(container.querySelector('[class*="bg-success-faint"]')).toBeFalsy();
  });
});
