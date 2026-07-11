/**
 * MobileSessionRuntime 单元测试
 * - 事件路由不串会话
 * - 切 active 不 dispose
 * - 关 Tab 释放
 * - 超限淘汰规则
 * - applyAIEvent 归约
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/transport', () => ({
  invoke: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));

import { applyAIEvent } from './applyAIEvent';
import {
  useMobileSessionRuntime,
  setMobileHistoryRefresher,
  __resetTabSessionsCacheForTests,
  selectTabSessions,
} from './mobileSessionRuntime';
import {
  MAX_MOBILE_TABS,
  createEmptySessionState,
  fromMobileContextId,
  toMobileContextId,
} from './types';
import type { AIEvent } from '@/ai-runtime/event';

function baseMeta(id: string) {
  return {
    id,
    title: `会话 ${id}`,
    engineId: 'claude-code' as const,
    projectPath: '/tmp/p',
    messages: [],
  };
}

describe('mobile contextId helpers', () => {
  it('round-trips mobile context id', () => {
    expect(toMobileContextId('abc')).toBe('mobile-abc');
    expect(fromMobileContextId('mobile-abc')).toBe('abc');
    expect(fromMobileContextId('session-abc')).toBeNull();
    expect(fromMobileContextId(undefined)).toBeNull();
  });
});

describe('applyAIEvent', () => {
  it('accumulates assistant deltas', () => {
    let state = createEmptySessionState(baseMeta('s1'));
    state = {
      ...state,
      sending: true,
    };

    const first = applyAIEvent(state, {
      type: 'assistant_message',
      sessionId: 's1',
      content: 'Hello',
      isDelta: false,
    } as AIEvent);
    expect(first.state.messages).toHaveLength(1);
    expect(first.state.messages[0]).toMatchObject({ type: 'assistant', content: 'Hello' });
    expect(first.state.partial?.content).toBe('Hello');
    expect(first.state.status).toBe('running');

    const second = applyAIEvent(first.state, {
      type: 'assistant_message',
      sessionId: 's1',
      content: ' world',
      isDelta: true,
    } as AIEvent);
    expect(second.state.messages[0]).toMatchObject({ content: 'Hello world' });
    expect(second.state.partial?.content).toBe('Hello world');
  });

  it('marks waiting on question', () => {
    const state = createEmptySessionState(baseMeta('s1'));
    const next = applyAIEvent(state, {
      type: 'question',
      sessionId: 's1',
      questionId: 'q1',
      header: '继续？',
      options: [{ value: 'yes', label: '是' }],
    } as AIEvent);
    expect(next.state.status).toBe('waiting');
    expect(next.state.pendingCard?.type).toBe('question');
    expect(next.state.pendingCard?.questionId).toBe('q1');
  });

  it('result clears sending and requests history refresh', () => {
    let state = createEmptySessionState(baseMeta('s1'));
    state = { ...state, sending: true, status: 'running' };
    const next = applyAIEvent(state, {
      type: 'result',
      sessionId: 's1',
      output: null,
    } as AIEvent);
    expect(next.state.sending).toBe(false);
    expect(next.shouldRefreshHistory).toBe(true);
  });
});

describe('MobileSessionRuntime store', () => {
  beforeEach(() => {
    setMobileHistoryRefresher(null);
    useMobileSessionRuntime.getState().reset();
    __resetTabSessionsCacheForTests();
  });

  it('selectTabSessions returns stable reference when store unchanged', () => {
    const store = useMobileSessionRuntime.getState();
    store.openSession(baseMeta('a'));
    const state = useMobileSessionRuntime.getState();
    const first = selectTabSessions(state);
    const second = selectTabSessions(state);
    expect(first).toBe(second);
    expect(first).toHaveLength(1);
  });

  it('openSession activates and keeps state when reopened', () => {
    const store = useMobileSessionRuntime.getState();
    store.openSession(baseMeta('a'));
    store.setInput('a', 'draft-a');

    let s = useMobileSessionRuntime.getState();
    expect(s.activeSessionId).toBe('a');
    expect(s.sessions.a.input).toBe('draft-a');

    store.openSession(baseMeta('b'));
    s = useMobileSessionRuntime.getState();
    expect(s.activeSessionId).toBe('b');
    expect(s.tabOrder).toEqual(['a', 'b']);

    // 切回 a：草稿仍在（Runtime 未 dispose）
    store.setActiveSession('a');
    s = useMobileSessionRuntime.getState();
    expect(s.activeSessionId).toBe('a');
    expect(s.sessions.a.input).toBe('draft-a');
    expect(s.sessions.b).toBeTruthy();
  });

  it('routes events only to matching session', () => {
    const store = useMobileSessionRuntime.getState();
    store.openSession(baseMeta('a'));
    store.openSession(baseMeta('b'));

    store.routeEvent('mobile-a', {
      type: 'assistant_message',
      sessionId: 'backend-a',
      content: 'from-a',
      isDelta: false,
    } as AIEvent);

    store.routeEvent('mobile-b', {
      type: 'assistant_message',
      sessionId: 'backend-b',
      content: 'from-b',
      isDelta: false,
    } as AIEvent);

    const s = useMobileSessionRuntime.getState();
    expect(s.sessions.a.messages[0]).toMatchObject({ content: 'from-a' });
    expect(s.sessions.b.messages[0]).toMatchObject({ content: 'from-b' });
    // 后台 a 仍更新
    expect(s.sessions.a.status).toBe('running');
  });

  it('does not drop background session events after active switch', () => {
    const store = useMobileSessionRuntime.getState();
    store.openSession(baseMeta('a'));
    store.openSession(baseMeta('b'));
    store.setActiveSession('b');

    store.routeEvent('mobile-a', {
      type: 'assistant_message',
      sessionId: 'x',
      content: 'bg',
      isDelta: false,
    } as AIEvent);

    const s = useMobileSessionRuntime.getState();
    expect(s.activeSessionId).toBe('b');
    expect(s.sessions.a.messages).toHaveLength(1);
    expect(s.sessions.a.messages[0]).toMatchObject({ content: 'bg' });
  });

  it('closeSession disposes state', () => {
    const store = useMobileSessionRuntime.getState();
    store.openSession(baseMeta('a'));
    store.openSession(baseMeta('b'));
    store.setInput('a', 'will-drop');
    store.closeSession('a');

    const s = useMobileSessionRuntime.getState();
    expect(s.sessions.a).toBeUndefined();
    expect(s.tabOrder).toEqual(['b']);
    expect(s.activeSessionId).toBe('b');
  });

  it('evicts oldest idle when exceeding max tabs', () => {
    const store = useMobileSessionRuntime.getState();
    for (let i = 0; i < MAX_MOBILE_TABS; i++) {
      const r = store.openSession(baseMeta(`s${i}`));
      expect(r.ok).toBe(true);
    }

    // 全部 idle 时再开，应淘汰最早的 s0
    const r = store.openSession(baseMeta('new'));
    expect(r.ok).toBe(true);
    const s = useMobileSessionRuntime.getState();
    expect(s.tabOrder).toHaveLength(MAX_MOBILE_TABS);
    expect(s.sessions.s0).toBeUndefined();
    expect(s.sessions.new).toBeTruthy();
  });

  it('refuses to open when all tabs are running/waiting', () => {
    const store = useMobileSessionRuntime.getState();
    for (let i = 0; i < MAX_MOBILE_TABS; i++) {
      store.openSession(baseMeta(`s${i}`));
      // 标记 running
      store.routeEvent(`mobile-s${i}`, {
        type: 'session_start',
        sessionId: `s${i}`,
      } as AIEvent);
    }

    const r = store.openSession(baseMeta('overflow'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/上限/);
    }
  });

  it('marks waiting status on question for tab indicators', () => {
    const store = useMobileSessionRuntime.getState();
    store.openSession(baseMeta('a'));
    store.routeEvent('mobile-a', {
      type: 'question',
      sessionId: 'a',
      questionId: 'q',
      header: '?',
      options: [],
    } as AIEvent);
    expect(useMobileSessionRuntime.getState().sessions.a.status).toBe('waiting');
  });
});
