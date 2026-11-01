/**
 * ChatInput 停止键状态机测试（U2：流式+草稿态紧急出口常驻）
 *
 * 根因：原三元状态机在「流式+有草稿」时把中断键整体替换为发送键，
 * 唯一停止手段只剩无 UI 提示的 ESC，用户边看流式边预输入下一条时紧急出口消失。
 *
 * 断言约定：setup.ts 全局 mock react-i18next（t 返回 key 本身），
 * 故 title 断言使用 i18n key（input.interrupt / input.send / input.sendQueued）。
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatInput } from './ChatInput';

function renderInput(props: Partial<React.ComponentProps<typeof ChatInput>> = {}) {
  const onSend = vi.fn(async () => true);
  const onInterrupt = vi.fn();
  const utils = render(<ChatInput onSend={onSend} onInterrupt={onInterrupt} {...props} />);
  return { onSend, onInterrupt, ...utils };
}

const stopButton = () => screen.queryByTitle('input.interrupt');

describe('ChatInput 停止键状态机（U2）', () => {
  it('流式+有草稿：停止键与发送键并存，点击停止触发 onInterrupt', () => {
    const { container, onInterrupt } = renderInput({ isStreaming: true });
    // 输入草稿 → hasDraftToSubmit=true（handleInputChange 同步 setLocalText）
    const textarea = container.querySelector('textarea');
    expect(textarea).toBeTruthy();
    fireEvent.change(textarea!, { target: { value: '下一条预输入' } });

    // 停止键（title=input.interrupt）与发送键（流式下 title=input.sendQueued）并存
    expect(stopButton()).toBeTruthy();
    expect(screen.queryByTitle('input.sendQueued')).toBeTruthy();

    // 点击停止直连既有中断链路，且只触发一次
    fireEvent.click(stopButton()!);
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('流式+空输入：仅停止键（原语义回归，不被本次改动破坏）', () => {
    renderInput({ isStreaming: true });
    expect(stopButton()).toBeTruthy();
    expect(screen.queryByTitle('input.sendQueued')).toBeNull();
    expect(screen.queryByTitle('input.send')).toBeNull();
  });

  it('空闲+有草稿：仅发送键，无停止键', () => {
    const { container } = renderInput();
    const textarea = container.querySelector('textarea');
    expect(textarea).toBeTruthy();
    fireEvent.change(textarea!, { target: { value: '普通发送' } });

    expect(stopButton()).toBeNull();
    expect(screen.queryByTitle('input.send')).toBeTruthy();
  });
});
