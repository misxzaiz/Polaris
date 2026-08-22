/**
 * companionStore 单元测试
 *
 * 覆盖：初始化、触发评估、用户响应、配置更新、启停
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useCompanionStore, __setCompanionDeps } from './companionStore';
import {
  CompanionMemory,
  MemoryMemoryStorage,
  CompanionConfigManager,
  MemoryConfigStorage,
  MockContentGenerator,
} from '@/services/companion';

// 测试前重置 store 状态与依赖
beforeEach(() => {
  __setCompanionDeps({
    memory: new CompanionMemory(new MemoryMemoryStorage()),
    configManager: new CompanionConfigManager(new MemoryConfigStorage()),
    generator: new MockContentGenerator(),
  });
});

describe('useCompanionStore', () => {
  it('初始化后应加载默认配置', () => {
    const store = useCompanionStore.getState();
    expect(store.config).toBeDefined();
    expect(store.config.personality.name).toBe('星芒');
    expect(store.enabled).toBe(true);
  });

  it('_reset 应清空 pending/history', () => {
    const store = useCompanionStore.getState();
    // 故意填充
    useCompanionStore.setState({
      pending: [{ content: { id: 'x', type: 'tip_curiosity', title: 't', body: 'b', createdAt: 1 }, queuedAt: 1 }],
      history: [],
    });
    store._reset();
    expect(useCompanionStore.getState().pending).toEqual([]);
  });

  it('evaluateTrigger 在无上下文时应拒绝', async () => {
    const ok = await useCompanionStore.getState().evaluateTrigger();
    expect(ok).toBe(false);
    expect(useCompanionStore.getState().pending).toEqual([]);
  });

  it('evaluateTrigger 在有上下文+窗口内时应生成内容', async () => {
    // 模拟用户活动建立上下文
    const store = useCompanionStore.getState();
    store.recordActivity({ type: 'session', engineId: 'claude-code' });
    store.recordActivity({ type: 'edit', file: 'src/main.ts' });

    // 强制注入当前时刻（在工作时间内）与上下文标记
    const today = new Date();
    today.setHours(14, 0, 0, 0);
    const ok = await useCompanionStore.getState().evaluateTrigger({
      now: today.getTime(),
      hasEnoughContext: true,
      cooldownMinutes: 0,
      activeWindowStart: '00:00',
      activeWindowEnd: '23:59',
    });

    expect(ok).toBe(true);
    const pending = useCompanionStore.getState().pending;
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0].content.id).toBeTruthy();
  });

  it('禁用后 evaluateTrigger 应直接返回 false', async () => {
    useCompanionStore.getState().toggleEnabled();
    const ok = await useCompanionStore.getState().evaluateTrigger();
    expect(ok).toBe(false);
    expect(useCompanionStore.getState().enabled).toBe(false);
  });

  it('respondToCard 应将卡片移到 history', async () => {
    // 先生成一条
    const store = useCompanionStore.getState();
    store.recordActivity({ type: 'session', engineId: 'claude-code' });
    const today = new Date();
    today.setHours(14, 0, 0, 0);
    await useCompanionStore.getState().evaluateTrigger({
      now: today.getTime(),
      hasEnoughContext: true,
      cooldownMinutes: 0,
      activeWindowStart: '00:00',
      activeWindowEnd: '23:59',
    });

    const pending = useCompanionStore.getState().pending;
    expect(pending.length).toBeGreaterThan(0);
    const id = pending[0].content.id;

    useCompanionStore.getState().respondToCard(id, 'accepted');

    const state = useCompanionStore.getState();
    expect(state.pending.find(e => e.content.id === id)).toBeUndefined();
    expect(state.history.find(e => e.content.id === id)?.userAction).toBe('accepted');
  });

  it('dismissCard 应从 pending 移除但不入 history', async () => {
    const store = useCompanionStore.getState();
    store.recordActivity({ type: 'session', engineId: 'claude-code' });
    const today = new Date();
    today.setHours(14, 0, 0, 0);
    await useCompanionStore.getState().evaluateTrigger({
      now: today.getTime(),
      hasEnoughContext: true,
      cooldownMinutes: 0,
      activeWindowStart: '00:00',
      activeWindowEnd: '23:59',
    });

    const id = useCompanionStore.getState().pending[0].content.id;
    const historyLen = useCompanionStore.getState().history.length;

    useCompanionStore.getState().dismissCard(id);

    const state = useCompanionStore.getState();
    expect(state.pending.find(e => e.content.id === id)).toBeUndefined();
    expect(state.history.length).toBe(historyLen); // 不进入历史
  });

  it('clearPending 应清空 pending', async () => {
    const store = useCompanionStore.getState();
    store.recordActivity({ type: 'session', engineId: 'claude-code' });
    const today = new Date();
    today.setHours(14, 0, 0, 0);
    await useCompanionStore.getState().evaluateTrigger({
      now: today.getTime(),
      hasEnoughContext: true,
      cooldownMinutes: 0,
      activeWindowStart: '00:00',
      activeWindowEnd: '23:59',
    });
    expect(useCompanionStore.getState().pending.length).toBeGreaterThan(0);

    useCompanionStore.getState().clearPending();
    expect(useCompanionStore.getState().pending).toEqual([]);
  });

  it('updateConfig 应更新配置', () => {
    const ok = useCompanionStore.getState().updateConfig({ maxDailyInteractions: 5 });
    expect(ok).toBe(true);
    expect(useCompanionStore.getState().config.maxDailyInteractions).toBe(5);
  });

  it('updateConfig 拒绝非法值', () => {
    const ok = useCompanionStore.getState().updateConfig({ maxDailyInteractions: -1 });
    expect(ok).toBe(false);
    expect(useCompanionStore.getState().config.maxDailyInteractions).not.toBe(-1);
  });

  it('toggleEnabled 应切换启停', () => {
    const before = useCompanionStore.getState().enabled;
    useCompanionStore.getState().toggleEnabled();
    expect(useCompanionStore.getState().enabled).toBe(!before);
    useCompanionStore.getState().toggleEnabled();
    expect(useCompanionStore.getState().enabled).toBe(before);
  });

  it('recordActivity 应累加到 memory', () => {
    const store = useCompanionStore.getState();
    store.recordActivity({ type: 'build', success: true });
    store.recordActivity({ type: 'edit', file: 'a.ts' });
    const snap = store.memory.getSnapshot();
    expect(snap.totalBuilds).toBe(1);
    expect(snap.totalEdits).toBe(1);
  });
});