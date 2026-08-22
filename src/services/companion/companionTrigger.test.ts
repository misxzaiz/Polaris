/**
 * CompanionTrigger 单元测试
 *
 * 覆盖：时间窗口、静默日、频率限制、冷却期、内容多样性、事件触发、边缘情况
 */

import { describe, it, expect } from 'vitest';
import {
  decideCompanionTrigger,
  isWithinActiveWindow,
  isQuietDay,
  isRecentlyRepeated,
  pickNonRepeatingType,
  parseTimeToMinutes,
} from './companionTrigger';
import type { CompanionTriggerContext } from './types';

// ============================================================================
// 时间辅助
// ============================================================================

describe('parseTimeToMinutes', () => {
  it('合法格式', () => {
    expect(parseTimeToMinutes('09:00')).toBe(540);
    expect(parseTimeToMinutes('00:00')).toBe(0);
    expect(parseTimeToMinutes('23:59')).toBe(1439);
  });

  it('非法格式返回 null', () => {
    expect(parseTimeToMinutes('25:00')).toBeNull();
    expect(parseTimeToMinutes('9:00')).toBeNull();
    expect(parseTimeToMinutes('abc')).toBeNull();
    expect(parseTimeToMinutes('')).toBeNull();
  });
});

describe('isWithinActiveWindow', () => {
  // 测试辅助：创建特定时间的时间戳
  function atTime(h: number, m: number): number {
    const d = new Date(2026, 0, 1, h, m, 0, 0);
    return d.getTime();
  }

  it('普通窗口内（09:00-21:00）', () => {
    expect(isWithinActiveWindow(atTime(12, 0), '09:00', '21:00')).toBe(true);
    expect(isWithinActiveWindow(atTime(9, 0), '09:00', '21:00')).toBe(true);
    expect(isWithinActiveWindow(atTime(21, 0), '09:00', '21:00')).toBe(true);
  });

  it('普通窗口外', () => {
    expect(isWithinActiveWindow(atTime(8, 59), '09:00', '21:00')).toBe(false);
    expect(isWithinActiveWindow(atTime(21, 1), '09:00', '21:00')).toBe(false);
    expect(isWithinActiveWindow(atTime(3, 0), '09:00', '21:00')).toBe(false);
  });

  it('跨天窗口（22:00-06:00）', () => {
    expect(isWithinActiveWindow(atTime(23, 0), '22:00', '06:00')).toBe(true);
    expect(isWithinActiveWindow(atTime(5, 59), '22:00', '06:00')).toBe(true);
    expect(isWithinActiveWindow(atTime(12, 0), '22:00', '06:00')).toBe(false);
  });
});

describe('isQuietDay', () => {
  function atDay(weekday: number): number {
    // 2026-01-05 是周一（1），所以调整
    const base = new Date(2026, 0, 5); // 周一
    base.setDate(base.getDate() + weekday - 1);
    return base.getTime();
  }

  it('静默日应返回 true', () => {
    expect(isQuietDay(atDay(0), [0])).toBe(true); // 周日
    expect(isQuietDay(atDay(6), [6])).toBe(true); // 周六
  });

  it('非静默日应返回 false', () => {
    expect(isQuietDay(atDay(3), [0, 6])).toBe(false);
  });

  it('空数组应返回 false', () => {
    expect(isQuietDay(atDay(0), [])).toBe(false);
  });
});

// ============================================================================
// 多样性
// ============================================================================

describe('isRecentlyRepeated', () => {
  it('重复应返回 true', () => {
    expect(isRecentlyRepeated('project_insight', ['project_insight', 'tip_curiosity'])).toBe(true);
  });

  it('不重复应返回 false', () => {
    expect(isRecentlyRepeated('learning_challenge', ['project_insight', 'tip_curiosity'])).toBe(false);
  });

  it('空列表应返回 false', () => {
    expect(isRecentlyRepeated('project_insight', [])).toBe(false);
  });
});

describe('pickNonRepeatingType', () => {
  it('应优选不重复类型', () => {
    const result = pickNonRepeatingType(
      ['project_insight', 'learning_challenge', 'skill_explore'],
      ['project_insight']
    );
    expect(result).toBe('learning_challenge');
  });

  it('preferred 不重复时优先', () => {
    const result = pickNonRepeatingType(
      ['project_insight', 'learning_challenge'],
      ['skill_explore'],
      'learning_challenge'
    );
    expect(result).toBe('learning_challenge');
  });

  it('全部重复时退化到第一个', () => {
    const result = pickNonRepeatingType(
      ['project_insight', 'learning_challenge'],
      ['project_insight', 'learning_challenge']
    );
    expect(result).toBe('project_insight');
  });
});

// ============================================================================
// 主决策函数
// ============================================================================

describe('decideCompanionTrigger', () => {
  const now = new Date(2026, 0, 1, 14, 0, 0).getTime(); // 2026-01-01 14:00 周四

  function makeContext(overrides?: Partial<CompanionTriggerContext>): CompanionTriggerContext {
    return {
      now,
      maxDailyInteractions: 3,
      cooldownMinutes: 120,
      activeWindowStart: '09:00',
      activeWindowEnd: '21:00',
      quietDays: [],
      recentContentTypes: [],
      todayTriggerCount: 0,
      lastTriggerAt: 0,
      hasEnoughContext: true,
      enabledContentTypes: [
        'project_insight', 'learning_challenge', 'skill_explore',
        'achievement_celebrate', 'tip_curiosity', 'daily_review', 'learning_followup',
      ],
      ...overrides,
    };
  }

  it('应触发：常规条件满足', () => {
    const decision = decideCompanionTrigger(makeContext());
    expect(decision.shouldTrigger).toBe(true);
    expect(decision.source).toBe('interval');
    expect(decision.reason).toBeTruthy();
  });

  it('不应触发：无足够上下文', () => {
    const decision = decideCompanionTrigger(makeContext({ hasEnoughContext: false }));
    expect(decision.shouldTrigger).toBe(false);
    expect(decision.ignoreReason).toBe('无足够上下文');
  });

  it('不应触发：超过今日频率上限', () => {
    const decision = decideCompanionTrigger(makeContext({ todayTriggerCount: 3 }));
    expect(decision.shouldTrigger).toBe(false);
    expect(decision.ignoreReason).toBe('已超过今日频率上限');
  });

  it('不应触发：在冷却期内', () => {
    const decision = decideCompanionTrigger(makeContext({
      lastTriggerAt: now - 30 * 60 * 1000, // 30分钟前
    }));
    expect(decision.shouldTrigger).toBe(false);
    expect(decision.ignoreReason).toBe('在冷却期内');
  });

  it('不应触发：不在活跃窗口', () => {
    const night = new Date(2026, 0, 1, 22, 30, 0).getTime();
    const decision = decideCompanionTrigger(makeContext({ now: night }));
    expect(decision.shouldTrigger).toBe(false);
    expect(decision.ignoreReason).toBe('不在活跃窗口');
  });

  it('不应触发：静默日', () => {
    const sunday = new Date(2026, 0, 4, 14, 0, 0).getTime(); // 2026-01-04 周日
    const decision = decideCompanionTrigger(makeContext({ now: sunday, quietDays: [0] }));
    expect(decision.shouldTrigger).toBe(false);
    expect(decision.ignoreReason).toBe('今天是静默日');
  });

  it('事件触发（build_event）应豁免频率/冷却限制', () => {
    const decision = decideCompanionTrigger(makeContext({
      eventSource: 'build_event',
      todayTriggerCount: 3, // 已超上限
      lastTriggerAt: now - 10 * 60 * 1000, // 10分钟前（冷却期内）
    }));
    expect(decision.shouldTrigger).toBe(true);
    expect(decision.source).toBe('build_event');
  });

  it('事件触发（error_spike）应豁免频率/冷却限制', () => {
    const decision = decideCompanionTrigger(makeContext({
      eventSource: 'error_spike',
      todayTriggerCount: 3,
      lastTriggerAt: now - 10 * 60 * 1000,
    }));
    expect(decision.shouldTrigger).toBe(true);
    expect(decision.source).toBe('error_spike');
  });

  it('事件触发仍应受静默时段限制', () => {
    const night = new Date(2026, 0, 1, 23, 0, 0).getTime();
    const decision = decideCompanionTrigger(makeContext({
      now: night,
      eventSource: 'build_event',
    }));
    expect(decision.shouldTrigger).toBe(false);
    expect(decision.ignoreReason).toBe('静默时段');
  });

  it('shouldTrigger=false 时 suggestedType 应为 undefined', () => {
    const decision = decideCompanionTrigger(makeContext({ hasEnoughContext: false }));
    expect(decision.suggestedType).toBeUndefined();
  });

  it('shouldTrigger=true 时 suggestedType 应有值', () => {
    const decision = decideCompanionTrigger(makeContext());
    expect(decision.suggestedType).toBeDefined();
  });

  it('应返回合理的 decisionMs', () => {
    const decision = decideCompanionTrigger(makeContext());
    expect(decision.decisionMs).toBeGreaterThanOrEqual(0);
    expect(decision.decisionMs).toBeLessThan(1000);
  });
});