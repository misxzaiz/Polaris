/**
 * AI 主动陪伴助手 — 配置模块
 *
 * 负责 CompanionConfig 的加载、校验、默认值回退与持久化。
 * 设计为纯函数+可注入存储，便于独立测试。
 */

import type { CompanionConfig } from './types';
import { DEFAULT_COMPANION_CONFIG } from './types';
import { createLogger } from '@/utils/logger';

const log = createLogger('CompanionConfig');

// ============================================================================
// 存储抽象（测试可注入）
// ============================================================================

export interface CompanionConfigStorage {
  load(): CompanionConfig | null;
  save(config: CompanionConfig): void;
}

/** 基于 localStorage 的默认存储（web 端） */
export class LocalStorageConfigStorage implements CompanionConfigStorage {
  private readonly key: string;

  constructor(key = 'polaris.companion.config') {
    this.key = key;
  }

  load(): CompanionConfig | null {
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return null;
      return JSON.parse(raw) as CompanionConfig;
    } catch (e) {
      log.warn('读取伴侣配置失败，返回 null', { error: (e as Error).message });
      return null;
    }
  }

  save(config: CompanionConfig): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(config));
    } catch (e) {
      log.warn('保存伴侣配置失败', { error: (e as Error).message });
    }
  }
}

/** 纯内存存储（测试用） */
export class MemoryConfigStorage implements CompanionConfigStorage {
  private config: CompanionConfig | null = null;
  load(): CompanionConfig | null { return this.config; }
  save(config: CompanionConfig): void { this.config = config; }
}

// ============================================================================
// 校验
// ============================================================================

/** 校验单个配置项，返回错误列表；空数组 = 合法 */
export function validateCompanionConfig(config: CompanionConfig): string[] {
  const errors: string[] = [];

  if (typeof config.enabled !== 'boolean') {
    errors.push('enabled 必须是 boolean');
  }

  // 人格
  if (!config.personality || typeof config.personality !== 'object') {
    errors.push('personality 必须存在');
  } else {
    if (!config.personality.name) errors.push('personality.name 不能为空');
    if (!config.personality.systemPrompt || config.personality.systemPrompt.trim().length < 10) {
      errors.push('personality.systemPrompt 长度至少 10');
    }
    if (!['warm', 'professional', 'playful', 'minimal'].includes(config.personality.tone)) {
      errors.push(`personality.tone 非法: ${config.personality.tone}`);
    }
    if (!['socratic', 'demonstration', 'guided', 'exploration'].includes(config.personality.teachingStyle)) {
      errors.push(`personality.teachingStyle 非法: ${config.personality.teachingStyle}`);
    }
    if (!['low', 'medium', 'high'].includes(config.personality.initiativeLevel)) {
      errors.push(`personality.initiativeLevel 非法: ${config.personality.initiativeLevel}`);
    }
  }

  // 触发参数
  if (typeof config.maxDailyInteractions !== 'number'
    || !Number.isInteger(config.maxDailyInteractions)
    || config.maxDailyInteractions < 0
    || config.maxDailyInteractions > 50) {
    errors.push('maxDailyInteractions 必须是 0-50 的整数');
  }

  if (typeof config.cooldownMinutes !== 'number'
    || config.cooldownMinutes < 0
    || config.cooldownMinutes > 7 * 24 * 60) {
    errors.push('cooldownMinutes 必须是非负分钟数');
  }

  // 时间窗口格式 HH:mm
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(config.activeWindowStart)) {
    errors.push(`activeWindowStart 非法（应为 HH:mm）: ${config.activeWindowStart}`);
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(config.activeWindowEnd)) {
    errors.push(`activeWindowEnd 非法（应为 HH:mm）: ${config.activeWindowEnd}`);
  }

  // 静默日 0-6
  if (!Array.isArray(config.quietDays)
    || config.quietDays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
    errors.push('quietDays 必须是 0-6 的整数数组');
  }

  // 内容类型
  if (!Array.isArray(config.enabledContentTypes) || config.enabledContentTypes.length === 0) {
    errors.push('enabledContentTypes 必须是非空数组');
  }

  // 难度
  if (!['beginner', 'intermediate', 'advanced'].includes(config.difficultyLevel)) {
    errors.push(`difficultyLevel 非法: ${config.difficultyLevel}`);
  }

  return errors;
}

/** 发出一套完全合法的默认配置（总是合法） */
export function createDefaultConfig(): CompanionConfig {
  return structuredClone(DEFAULT_COMPANION_CONFIG);
}

/**
 * 合并用户配置与默认配置。
 * 缺失字段用默认值；非法字段回退到默认值。
 */
export function resolveCompanionConfig(
  userConfig: Partial<CompanionConfig> | null | undefined
): { config: CompanionConfig; errors: string[] } {
  const base = createDefaultConfig();
  if (!userConfig) {
    return { config: base, errors: [] };
  }

  // 深合并顶层
  const merged: CompanionConfig = {
    ...base,
    ...userConfig,
    personality: {
      ...base.personality,
      ...(userConfig.personality ?? {}),
    },
  };

  // 校验 + 逐项回退
  const errors = validateCompanionConfig(merged);
  const config = { ...merged };

  if (errors.length > 0) {
    log.warn('伴侣配置存在非法项，回退到默认值', { errors });
    // 逐项回退：找到非法字段并使用 base 的对应值
    const revalidated = {
      ...config,
      enabled: typeof config.enabled === 'boolean' ? config.enabled : base.enabled,
      personality: {
        ...base.personality,
        ...(validatePersonalitySafe(config.personality) ? config.personality : {}),
      },
      maxDailyInteractions: safeNumber(
        config.maxDailyInteractions, base.maxDailyInteractions, (n) => Number.isInteger(n) && n >= 0 && n <= 50
      ),
      cooldownMinutes: safeNumber(
        config.cooldownMinutes, base.cooldownMinutes, (n) => n >= 0
      ),
      activeWindowStart: safeTime(config.activeWindowStart, base.activeWindowStart),
      activeWindowEnd: safeTime(config.activeWindowEnd, base.activeWindowEnd),
      quietDays: safeQuietDays(config.quietDays, base.quietDays),
      enabledContentTypes: Array.isArray(config.enabledContentTypes) && config.enabledContentTypes.length > 0
        ? config.enabledContentTypes
        : base.enabledContentTypes,
      difficultyLevel: (['beginner', 'intermediate', 'advanced'] as const).includes(config.difficultyLevel as never)
        ? config.difficultyLevel
        : base.difficultyLevel,
    };
    return { config: revalidated, errors };
  }

  return { config, errors: [] };
}

// ===== 内部安全工具 =====

function validatePersonalitySafe(p: unknown): p is CompanionConfig['personality'] {
  if (!p || typeof p !== 'object') return false;
  const pp = p as Record<string, unknown>;
  if (typeof pp.name !== 'string' || !pp.name) return false;
  if (!['warm', 'professional', 'playful', 'minimal'].includes(pp.tone as string)) return false;
  if (!['socratic', 'demonstration', 'guided', 'exploration'].includes(pp.teachingStyle as string)) return false;
  if (!['low', 'medium', 'high'].includes(pp.initiativeLevel as string)) return false;
  if (typeof pp.systemPrompt !== 'string' || pp.systemPrompt.trim().length < 10) return false;
  return true;
}

function safeNumber(value: unknown, fallback: number, pred: (n: number) => boolean): number {
  return typeof value === 'number' && pred(value) ? value : fallback;
}

function safeTime(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
}

function safeQuietDays(value: unknown, fallback: number[]): number[] {
  return Array.isArray(value) && value.every(d => Number.isInteger(d) && d >= 0 && d <= 6)
    ? value
    : fallback;
}

// ============================================================================
// 高层管理 API
// ============================================================================

/** CompanionConfigManager：加载+合并+保存 */
export class CompanionConfigManager {
  constructor(
    private storage: CompanionConfigStorage = new LocalStorageConfigStorage(),
    private log = createLogger('CompanionConfig')
  ) {}

  /** 加载配置（合并 + 回退） */
  load(): CompanionConfig {
    const stored = this.storage.load();
    const { config, errors } = resolveCompanionConfig(stored ?? undefined);
    if (errors.length > 0) {
      this.log.warn('加载配置时有非法项，已回退', { count: errors.length });
      // 回退后重新保存归一化配置
      try { this.storage.save(config); } catch { /* 忽略 */ }
    }
    return config;
  }

  /** 保存配置（先校验） */
  save(config: CompanionConfig): boolean {
    const { config: resolved, errors } = resolveCompanionConfig(config);
    if (errors.length > 0) {
      this.log.warn('保存配置被拒绝：存在非法项', { errors });
      return false;
    }
    this.storage.save(resolved);
    return true;
  }

  /** 部分更新（浅合并 + 校验） */
  update(patch: Partial<CompanionConfig>): boolean {
    const current = this.load();
    return this.save({ ...current, ...patch });
  }

  /** 重置为默认 */
  reset(): CompanionConfig {
    const base = createDefaultConfig();
    this.storage.save(base);
    return base;
  }
}