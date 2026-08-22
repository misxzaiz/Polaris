/**
 * CompanionPanel 组件测试
 *
 * 覆盖：渲染、空状态、卡片展示、按钮交互、启停开关、历史展开
 *
 * 注意：测试环境的 i18n mock 返回 key 而非中文翻译，
 * 所以断言用 key 或 defaultValue 中可被匹配的子串。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CompanionPanel } from './CompanionPanel';
import { useCompanionStore, __setCompanionDeps } from '@/stores/companionStore';
import {
  CompanionMemory,
  MemoryMemoryStorage,
  CompanionConfigManager,
  MemoryConfigStorage,
  MockContentGenerator,
} from '@/services/companion';

beforeEach(() => {
  __setCompanionDeps({
    memory: new CompanionMemory(new MemoryMemoryStorage()),
    configManager: new CompanionConfigManager(new MemoryConfigStorage()),
    generator: new MockContentGenerator(),
  });
});

async function injectPendingCard() {
  const today = new Date();
  today.setHours(14, 0, 0, 0);
  const store = useCompanionStore.getState();
  store.recordActivity({ type: 'session', engineId: 'claude-code' });
  await store.evaluateTrigger({
    now: today.getTime(),
    hasEnoughContext: true,
    cooldownMinutes: 0,
    activeWindowStart: '00:00',
    activeWindowEnd: '23:59',
  });
}

describe('CompanionPanel', () => {
  it('应渲染面板（含 Bot 图标与标签 key）', () => {
    render(<CompanionPanel />);
    // 启停开关存在
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });

  it('启停开关默认开启，点击切换', () => {
    render(<CompanionPanel />);
    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  it('无 pending 时应显示空状态文案 key', () => {
    render(<CompanionPanel />);
    // i18n mock 返回 defaultValue 字符串本身（带 options 时替换占位符后仍是该串）
    // 实际 t('messages.companionIdle', { defaultValue: '...' }) → 'messages.companionIdle'
    expect(screen.getByText('messages.companionIdle')).toBeInTheDocument();
  });

  it('禁用时应显示禁用文案', () => {
    useCompanionStore.getState().toggleEnabled();
    render(<CompanionPanel />);
    expect(screen.getByText('messages.companionDisabled')).toBeInTheDocument();
  });

  it('有 pending 时应渲染卡片标题', async () => {
    await injectPendingCard();
    render(<CompanionPanel />);
    expect(screen.getByText(/\[模拟\]/)).toBeInTheDocument();
  });

  it('卡片应包含接受/推迟/忽略按钮', async () => {
    await injectPendingCard();
    render(<CompanionPanel />);
    // MockContentGenerator 的 action.label = '开始'
    expect(screen.getByText('开始')).toBeInTheDocument();
    // 推迟按钮的 label 通过 t 返回 'actions.defer'
    expect(screen.getByText('actions.defer')).toBeInTheDocument();
    // 忽略按钮用 aria-label
    expect(screen.getByRole('button', { name: 'actions.dismiss' })).toBeInTheDocument();
  });

  it('点击接受后卡片应消失', async () => {
    await injectPendingCard();
    render(<CompanionPanel />);
    const acceptBtn = screen.getByText('开始');
    fireEvent.click(acceptBtn);
    expect(screen.queryByText(/\[模拟\]/)).not.toBeInTheDocument();
  });

  it('点击忽略应移除卡片', async () => {
    await injectPendingCard();
    render(<CompanionPanel />);
    const dismissBtn = screen.getByRole('button', { name: 'actions.dismiss' });
    fireEvent.click(dismissBtn);
    expect(screen.queryByText(/\[模拟\]/)).not.toBeInTheDocument();
  });

  it('清空按钮应清空 pending', async () => {
    await injectPendingCard();
    render(<CompanionPanel />);
    const clearBtn = screen.getByRole('button', { name: 'actions.clear' });
    fireEvent.click(clearBtn);
    expect(screen.queryByText(/\[模拟\]/)).not.toBeInTheDocument();
    expect(screen.getByText('messages.companionIdle')).toBeInTheDocument();
  });

  it('试一次按钮应触发 evaluateTrigger', async () => {
    render(<CompanionPanel />);
    const tryBtn = screen.getByText('actions.tryTrigger');
    useCompanionStore.getState().recordActivity({ type: 'session', engineId: 'claude-code' });
    fireEvent.click(tryBtn);
    await vi.waitFor(() => {
      expect(screen.getByText(/\[模拟\]/)).toBeInTheDocument();
    });
  });

  it('生成中应显示加载文案', async () => {
    const slowGen = {
      async generate() {
        return new Promise(resolve => setTimeout(() => resolve({
          id: 'slow-1',
          type: 'tip_curiosity' as const,
          title: '慢生成',
          body: '这是一段足够长的测试内容用于通过验证。',
          createdAt: Date.now(),
        }), 50));
      },
    };
    useCompanionStore.getState().setGenerator(slowGen);
    useCompanionStore.getState().recordActivity({ type: 'session', engineId: 'claude-code' });

    render(<CompanionPanel />);
    fireEvent.click(screen.getByText('actions.tryTrigger'));
    await vi.waitFor(() => {
      expect(screen.getByText('messages.companionThinking')).toBeInTheDocument();
    });
  });

  it('历史区可展开看到已接受标记', async () => {
    await injectPendingCard();
    render(<CompanionPanel />);
    fireEvent.click(screen.getByText('开始'));

    // 历史按钮（含数量）
    const historyBtn = screen.getByText(/labels.history/);
    fireEvent.click(historyBtn);
    // 展开后应看到已接受标记（i18n mock 返回 key）
    expect(screen.getByText(/✓ actions.accepted/)).toBeInTheDocument();
  });
});