/**
 * AI 主动陪伴助手 — 记忆模块
 *
 * 记录用户活动上下文，支持持久化与查询。
 * 设计为纯 TypeScript、无 UI 依赖，可在测试中独立运行。
 */

import type {
  CompanionMemorySnapshot,
  CompanionInteraction,
  CompanionSkill,
  CompanionContentType,
} from './types';
import { createLogger } from '@/utils/logger';

const log = createLogger('CompanionMemory');

// ============================================================================
// 存储抽象
// ============================================================================

export interface CompanionMemoryStorage {
  load(): CompanionMemorySnapshot | null;
  save(memory: CompanionMemorySnapshot): void;
}

/** 基于 localStorage 的默认存储 */
export class LocalStorageMemoryStorage implements CompanionMemoryStorage {
  private readonly key: string;

  constructor(key = 'polaris.companion.memory') {
    this.key = key;
  }

  load(): CompanionMemorySnapshot | null {
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return null;
      return JSON.parse(raw) as CompanionMemorySnapshot;
    } catch {
      return null;
    }
  }

  save(memory: CompanionMemorySnapshot): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(memory));
    } catch (e) {
      log.warn('保存伴侣记忆失败', { error: (e as Error).message });
    }
  }
}

/** 纯内存存储（测试用） */
export class MemoryMemoryStorage implements CompanionMemoryStorage {
  private memory: CompanionMemorySnapshot | null = null;
  load(): CompanionMemorySnapshot | null { return this.memory; }
  save(memory: CompanionMemorySnapshot): void { this.memory = memory; }
}

// ============================================================================
// 空记忆快照工厂
// ============================================================================

export function createEmptyMemory(): CompanionMemorySnapshot {
  return {
    totalSessions: 0,
    totalEdits: 0,
    totalBuilds: 0,
    successfulBuilds: 0,
    failedBuilds: 0,
    totalErrors: 0,
    totalCodeLines: 0,
    totalToolCalls: 0,
    recentFiles: [],
    recentErrors: [],
    recentBuilds: [],
    recentSessions: [],
    skills: [],
    activeChallenges: [],
    interactions: [],
    lastTriggerAt: 0,
    todayTriggerCount: 0,
    lastUpdatedAt: Date.now(),
  };
}

// ============================================================================
// 时间段辅助
// ============================================================================

/** 检查某个时间戳是否在今天（基于本地时区） */
function isToday(ts: number): boolean {
  const now = new Date();
  const date = new Date(ts);
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

// ============================================================================
// CompanionMemory 管理器
// ============================================================================

export class CompanionMemory {
  private snapshot: CompanionMemorySnapshot;
  private storage: CompanionMemoryStorage;
  private log = createLogger('CompanionMemory');

  constructor(storage?: CompanionMemoryStorage) {
    this.storage = storage ?? new LocalStorageMemoryStorage();
    this.snapshot = this.storage.load() ?? createEmptyMemory();
    // 跨天重置 todayTriggerCount
    if (this.snapshot.lastTriggerAt > 0 && !isToday(this.snapshot.lastTriggerAt)) {
      this.snapshot.todayTriggerCount = 0;
    }
  }

  // ===== 读取 =====

  /** 获取当前记忆快照（只读副本） */
  getSnapshot(): CompanionMemorySnapshot {
    return structuredClone(this.snapshot);
  }

  /** 快速获取今日触发次数 */
  getTodayTriggerCount(): number {
    if (!isToday(this.snapshot.lastTriggerAt)) return 0;
    return this.snapshot.todayTriggerCount;
  }

  /** 获取最近 3 次内容类型（多样性检查用） */
  getRecentContentTypes(): CompanionContentType[] {
    return this.snapshot.interactions
      .slice(0, 3)
      .map(i => i.type);
  }

  /** 获取上次触发时间 */
  getLastTriggerAt(): number {
    return this.snapshot.lastTriggerAt;
  }

  /** 获取已完成/未完成的技能列表 */
  getSkills(completed?: boolean): CompanionSkill[] {
    return this.snapshot.skills.filter(s =>
      completed === undefined
        ? true
        : completed ? s.completedAt != null : s.completedAt == null
    );
  }

  // ===== 写入 =====

  /** 记录一次主动交互 */
  recordInteraction(interaction: CompanionInteraction): void {
    this.snapshot.interactions.unshift(interaction);
    // 限制交互历史长度（最近 100 条）
    if (this.snapshot.interactions.length > 100) {
      this.snapshot.interactions = this.snapshot.interactions.slice(0, 100);
    }
    this.snapshot.lastTriggerAt = interaction.timestamp;
    if (isToday(interaction.timestamp)) {
      this.snapshot.todayTriggerCount += 1;
    } else {
      this.snapshot.todayTriggerCount = 1;
    }
    this.snapshot.lastUpdatedAt = interaction.timestamp;
    this.persist();
  }

  /** 添加技能（或更新已有技能进度） */
  upsertSkill(skill: Partial<CompanionSkill> & { id: string; name: string }): void {
    const idx = this.snapshot.skills.findIndex(s => s.id === skill.id);
    if (idx >= 0) {
      this.snapshot.skills[idx] = {
        ...this.snapshot.skills[idx],
        ...skill,
        lastActivityAt: Date.now(),
      };
    } else {
      this.snapshot.skills.push({
        id: skill.id,
        name: skill.name,
        description: skill.description ?? '',
        progress: skill.progress ?? 0,
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        completedChallenges: 0,
        completedAt: skill.completedAt,
      });
    }
    this.persist();
  }

  /** 标记技能进度 */
  updateSkillProgress(skillId: string, delta: number): void {
    const skill = this.snapshot.skills.find(s => s.id === skillId);
    if (!skill) return;
    skill.progress = Math.min(100, Math.max(0, skill.progress + delta));
    skill.lastActivityAt = Date.now();
    if (skill.progress >= 100 && !skill.completedAt) {
      skill.completedAt = Date.now();
    }
    this.persist();
  }

  /** 记录用户活动（构建、编辑、错误等） */
  recordActivity(activity: {
    type: 'build' | 'edit' | 'error' | 'session' | 'code_line' | 'tool_call';
    success?: boolean;
    file?: string;
    message?: string;
    engineId?: string;
    count?: number;
  }): void {
    const now = Date.now();

    switch (activity.type) {
      case 'build':
        this.snapshot.totalBuilds += 1;
        if (activity.success) {
          this.snapshot.successfulBuilds += 1;
        } else {
          this.snapshot.failedBuilds += 1;
        }
        this.snapshot.recentBuilds.unshift({ success: activity.success ?? true, timestamp: now });
        if (this.snapshot.recentBuilds.length > 20) {
          this.snapshot.recentBuilds = this.snapshot.recentBuilds.slice(0, 20);
        }
        break;

      case 'edit':
        this.snapshot.totalEdits += 1;
        if (activity.file) {
          this.snapshot.recentFiles.unshift(activity.file);
          if (this.snapshot.recentFiles.length > 10) {
            this.snapshot.recentFiles = this.snapshot.recentFiles.slice(0, 10);
          }
        }
        break;

      case 'error':
        this.snapshot.totalErrors += 1;
        if (activity.message) {
          this.snapshot.recentErrors.unshift(activity.message);
          if (this.snapshot.recentErrors.length > 10) {
            this.snapshot.recentErrors = this.snapshot.recentErrors.slice(0, 10);
          }
        }
        break;

      case 'session':
        this.snapshot.totalSessions += 1;
        this.snapshot.recentSessions.unshift({
          engineId: activity.engineId ?? 'unknown',
          startedAt: now,
          messageCount: 0,
        });
        if (this.snapshot.recentSessions.length > 10) {
          this.snapshot.recentSessions = this.snapshot.recentSessions.slice(0, 10);
        }
        break;

      case 'code_line':
        this.snapshot.totalCodeLines += activity.count ?? 1;
        break;

      case 'tool_call':
        this.snapshot.totalToolCalls += 1;
        break;
    }

    this.snapshot.lastUpdatedAt = now;
    this.persist();
  }

  /** 重置所有记忆 */
  reset(): void {
    this.snapshot = createEmptyMemory();
    this.snapshot.lastUpdatedAt = Date.now();
    this.persist();
  }

  // ===== 持久化 =====

  private persist(): void {
    try {
      this.storage.save(this.snapshot);
    } catch (e) {
      this.log.warn('持久化记忆失败', { error: (e as Error).message });
    }
  }
}

// ============================================================================
// 默认单例
// ============================================================================

/** 默认 CompanionMemory 实例（使用 localStorage） */
let defaultMemory: CompanionMemory | null = null;

export function getDefaultCompanionMemory(): CompanionMemory {
  if (!defaultMemory) {
    defaultMemory = new CompanionMemory();
  }
  return defaultMemory;
}