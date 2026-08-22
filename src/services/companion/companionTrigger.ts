/**
 * AI 主动陪伴助手 — 触发决策引擎
 *
 * 根据用户上下文、配置、疲劳抑制策略，决定当前是否应主动发起内容。
 * 纯函数设计，决策逻辑无副作用。遵循调研结论中的"低打扰、不疲劳"原则。
 */

import type {
  CompanionTriggerDecision,
  CompanionTriggerSource,
  CompanionTriggerContext,
  CompanionContentType,
} from './types';

// ============================================================================
// 时间辅助
// ============================================================================

/** 解析 "HH:mm" 为当日分钟数 (0-1439) */
export function parseTimeToMinutes(time: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

/** 判断某时刻是否在活跃窗口内（支持跨天，如 22:00-06:00） */
export function isWithinActiveWindow(
  now: number,
  activeWindowStart: string,
  activeWindowEnd: string
): boolean {
  const date = new Date(now);
  const nowMinutes = date.getHours() * 60 + date.getMinutes();

  const start = parseTimeToMinutes(activeWindowStart);
  const end = parseTimeToMinutes(activeWindowEnd);
  if (start === null || end === null) return true;

  if (start === end) return true;

  if (start < end) {
    return nowMinutes >= start && nowMinutes <= end;
  }
  // 跨天窗口：22:00-06:00
  return nowMinutes >= start || nowMinutes <= end;
}

/** 判断某天是否是静默日（weekday 0-6） */
export function isQuietDay(now: number, quietDays: number[]): boolean {
  if (!quietDays || quietDays.length === 0) return false;
  const weekday = new Date(now).getDay(); // 0=周日
  return quietDays.includes(weekday);
}

// ============================================================================
// 多样性辅助
// ============================================================================

/** 检查最近内容类型是否会导致连续重复 */
export function isRecentlyRepeated(
  type: CompanionContentType,
  recentTypes: CompanionContentType[]
): boolean {
  return recentTypes.includes(type);
}

/** 从启用的内容类型中挑选不重复的类型 */
export function pickNonRepeatingType(
  candidates: CompanionContentType[],
  recentTypes: CompanionContentType[],
  preferred?: CompanionContentType
): CompanionContentType | null {
  if (preferred && candidates.includes(preferred) && !recentTypes.includes(preferred)) {
    return preferred;
  }
  const fresh = candidates.filter(c => !recentTypes.includes(c));
  if (fresh.length > 0) return fresh[0];
  return candidates[0] ?? null;
}

// ============================================================================
// 阈值判定
// ============================================================================

/** 根据人格主动级别返回默认最大日触发次数 */
export function defaultDailyLimitForInitiative(level: string): number {
  switch (level) {
    case 'high': return 5;
    case 'medium': return 3;
    case 'low': return 1;
    default: return 3;
  }
}

// ============================================================================
// 主决策函数
// ============================================================================

/**
 * 判断是否触发主动内容。
 *
 * 决策规则：
 * 1. 有足够上下文
 * 2. 今日触发次数 < 上限
 * 3. 距离上次触发 >= 冷却期
 * 4. 当前在活跃窗口内
 * 5. 今天不是静默日
 * 6. 事件触发（build_fail/error_spike）可豁免频率/冷却限制
 */
export function decideCompanionTrigger(
  context: CompanionTriggerContext
): CompanionTriggerDecision {
  const startMs = performance.now();

  const now = context.now;
  const eventSource = context.eventSource;
  const maxDaily = context.maxDailyInteractions ?? 3;
  const cooldownMinutes = context.cooldownMinutes ?? 120;
  const activeStart = context.activeWindowStart ?? '09:00';
  const activeEnd = context.activeWindowEnd ?? '21:00';
  const quietDays = context.quietDays ?? [];
  const hasEnoughContext = context.hasEnoughContext ?? true;
  const recentTypes = context.recentContentTypes ?? [];
  const enabledTypes = context.enabledContentTypes ?? ALL_CONTENT_TYPES;

  // ===== 高价值事件触发（构建失败、错误激增） =====
  if (eventSource === 'error_spike' || eventSource === 'build_event') {
    if (!isQuietDay(now, quietDays) && isWithinActiveWindow(now, activeStart, activeEnd)) {
      if (!hasEnoughContext) {
        return buildResult(false, {
          reason: '事件触发但缺少上下文',
          ignoreReason: '无足够上下文',
          source: eventSource,
          suggestedType: 'project_insight',
        }, startMs);
      }
      return buildResult(true, {
        reason: `事件触发（${eventSource}）：项目出现值得关注的变化`,
        source: eventSource,
        suggestedType: eventSource === 'error_spike' ? 'project_insight' : undefined,
      }, startMs);
    }
    return buildResult(false, {
      reason: `事件触发（${eventSource}）但当前在静默时段`,
      ignoreReason: '静默时段',
      source: eventSource,
    }, startMs);
  }

  // ===== 常规触发检查 =====

  // 1. 上下文
  if (!hasEnoughContext) {
    return buildResult(false, {
      reason: '冷启动或无项目上下文',
      ignoreReason: '无足够上下文',
    }, startMs);
  }

  // 2. 今日频率
  if (context.todayTriggerCount >= maxDaily) {
    return buildResult(false, {
      reason: `今日已触发 ${context.todayTriggerCount}/${maxDaily}`,
      ignoreReason: '已超过今日频率上限',
    }, startMs);
  }

  // 3. 冷却期
  if (context.lastTriggerAt > 0 && now - context.lastTriggerAt < cooldownMinutes * 60 * 1000) {
    const remaining = Math.ceil(
      (cooldownMinutes * 60 * 1000 - (now - context.lastTriggerAt)) / 60000
    );
    return buildResult(false, {
      reason: `距上次触发不足 ${remaining} 分钟冷却期`,
      ignoreReason: '在冷却期内',
    }, startMs);
  }

  // 4. 活跃窗口
  if (!isWithinActiveWindow(now, activeStart, activeEnd)) {
    return buildResult(false, {
      reason: `当前时间不在活跃窗口 ${activeStart}-${activeEnd}`,
      ignoreReason: '不在活跃窗口',
    }, startMs);
  }

  // 5. 静默日
  if (isQuietDay(now, quietDays)) {
    return buildResult(false, {
      reason: `今天(${new Date(now).toLocaleDateString()})是静默日`,
      ignoreReason: '今天是静默日',
    }, startMs);
  }

  // 6. 内容轮换
  const suggestedType = pickNonRepeatingType(
    enabledTypes,
    recentTypes,
    context.preferredContentType
  );

  return buildResult(true, {
    reason: '通过频率、冷却、窗口、静默日检查，可主动发起',
    source: context.triggerSource ?? 'interval',
    suggestedType: suggestedType ?? undefined,
  }, startMs);
}

// ============================================================================
// 辅助
// ============================================================================

function buildResult(
  shouldTrigger: boolean,
  extra: {
    reason: string;
    ignoreReason?: string;
    source?: CompanionTriggerSource;
    suggestedType?: CompanionContentType;
  },
  startMs: number
): CompanionTriggerDecision {
  return {
    shouldTrigger,
    source: extra.source ?? 'interval',
    reason: extra.reason,
    ignoreReason: extra.ignoreReason,
    suggestedType: extra.suggestedType,
    decisionMs: Math.round(performance.now() - startMs),
  };
}

const ALL_CONTENT_TYPES: CompanionContentType[] = [
  'project_insight',
  'learning_challenge',
  'skill_explore',
  'achievement_celebrate',
  'tip_curiosity',
  'daily_review',
  'learning_followup',
];