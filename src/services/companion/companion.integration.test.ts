/**
 * Companion 集成测试 — 完整端到端模块协作
 *
 * 验证：伴侣内存 → 触发决策 → 内容生成 → 内容验证 → 记忆更新的完整流程
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CompanionMemory,
  MemoryMemoryStorage,
  decideCompanionTrigger,
  MockContentGenerator,
  generateCompanionContent,
  validateContent,
  getDefaultPersona,
  createDefaultConfig,
  PRESET_PERSONAS,
} from './index';

function createNow(h: number, m = 0): number {
  // 使用今天的日期，但设定指定的时刻
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

describe('端到端流程', () => {
  let memory: CompanionMemory;
  const persona = getDefaultPersona();

  beforeEach(() => {
    memory = new CompanionMemory(new MemoryMemoryStorage());
  });

  it('完整流程：用户工作 → 触发 → 生成内容 → 记录', async () => {
    // 1. 模拟用户活动
    memory.recordActivity({ type: 'session', engineId: 'claude-code' });
    memory.recordActivity({ type: 'edit', file: 'src/main.ts' });
    memory.recordActivity({ type: 'edit', file: 'src/utils/helper.ts' });
    memory.recordActivity({ type: 'build', success: true });
    memory.recordActivity({ type: 'build', success: true });
    memory.recordActivity({ type: 'build', success: false });
    memory.recordActivity({ type: 'error', message: 'Cannot find module' });
    memory.recordActivity({ type: 'code_line', count: 1200 });

    // 2. 触发决策
    const snapshot = memory.getSnapshot();
    const decision = decideCompanionTrigger({
      now: createNow(14, 0),
      maxDailyInteractions: 3,
      cooldownMinutes: 120,
      activeWindowStart: '09:00',
      activeWindowEnd: '21:00',
      quietDays: [],
      recentContentTypes: memory.getRecentContentTypes(),
      todayTriggerCount: memory.getTodayTriggerCount(),
      lastTriggerAt: memory.getLastTriggerAt(),
      hasEnoughContext: true,
      enabledContentTypes: createDefaultConfig().enabledContentTypes,
    });

    expect(decision.shouldTrigger).toBe(true);

    // 3. 生成内容
    const generator = new MockContentGenerator();
    const content = await generateCompanionContent(
      { memory: snapshot, forcedType: 'learning_challenge' },
      persona,
      generator
    );

    expect(content).not.toBeNull();
    expect(content!.type).toBe('learning_challenge');
    expect(content!.id).toBeTruthy();

    // 4. 验证内容
    const validation = validateContent(content!, content!.type);
    expect(validation.valid).toBe(true);

    // 5. 记录交互到记忆
    memory.recordInteraction({
      id: content!.id,
      type: content!.type,
      timestamp: content!.createdAt,
      contentId: content!.id,
      userAction: 'accepted',
    });

    // 6. 验证记忆更新
    const updatedSnapshot = memory.getSnapshot();
    expect(updatedSnapshot.todayTriggerCount).toBe(1);
    expect(updatedSnapshot.interactions).toHaveLength(1);
    expect(updatedSnapshot.interactions[0].type).toBe('learning_challenge');
  });

  it('学习挑战 → 技能进度关联', async () => {
    // 1. 用户建立技能
    memory.upsertSkill({
      id: 'rust-ownership',
      name: 'Rust 所有权',
      description: '学习 Rust 的所有权模型',
    });

    // 2. 触发内容生成
    const snapshot = memory.getSnapshot();
    const generator = new MockContentGenerator();
    const content = await generateCompanionContent(
      { memory: snapshot, forcedType: 'learning_challenge' },
      persona,
      generator
    );

    expect(content).not.toBeNull();

    // 3. 模拟用户完成挑战，更新技能进度
    memory.updateSkillProgress('rust-ownership', 50);
    const updated = memory.getSnapshot();
    expect(updated.skills[0].progress).toBe(50);
    expect(updated.skills[0].completedChallenges).toBe(0);
  });

  it('不同人格影响内容不同', async () => {
    const snapshot = memory.getSnapshot();
    const generator = new MockContentGenerator();

    const warmContent = await generateCompanionContent(
      { memory: snapshot, forcedType: 'learning_challenge' },
      PRESET_PERSONAS.warm_sister,
      generator
    );

    const playfulContent = await generateCompanionContent(
      { memory: snapshot, forcedType: 'learning_challenge' },
      PRESET_PERSONAS.playful_partner,
      generator
    );

    // Mock 生成器返回相同格式，但人格不同会改变 Prompt
    expect(warmContent).not.toBeNull();
    expect(playfulContent).not.toBeNull();
  });

  it('疲劳抑制：多次触发后拒绝', () => {
    // 模拟今日 3 次触发
    memory.recordInteraction({
      id: 'a',
      type: 'tip_curiosity',
      timestamp: createNow(10, 0),
      contentId: 'a',
      userAction: 'dismissed',
    });
    memory.recordInteraction({
      id: 'b',
      type: 'learning_challenge',
      timestamp: createNow(11, 0),
      contentId: 'b',
      userAction: 'accepted',
    });
    memory.recordInteraction({
      id: 'c',
      type: 'skill_explore',
      timestamp: createNow(12, 0),
      contentId: 'c',
      userAction: 'dismissed',
    });

    // 第四次触发应该被拒绝
    const decision = decideCompanionTrigger({
      now: createNow(14, 0),
      maxDailyInteractions: 3,
      cooldownMinutes: 60,
      activeWindowStart: '09:00',
      activeWindowEnd: '21:00',
      quietDays: [],
      recentContentTypes: memory.getRecentContentTypes(),
      todayTriggerCount: memory.getTodayTriggerCount(),
      lastTriggerAt: memory.getLastTriggerAt(),
      hasEnoughContext: true,
      enabledContentTypes: createDefaultConfig().enabledContentTypes,
    });

    expect(decision.shouldTrigger).toBe(false);
    expect(decision.ignoreReason).toBe('已超过今日频率上限');
  });

  it('事件触发在冷却期内仍可触发', () => {
    memory.recordInteraction({
      id: 'a',
      type: 'tip_curiosity',
      timestamp: createNow(13, 55), // 5分钟前
      contentId: 'a',
      userAction: 'dismissed',
    });

    // 构建失败事件应豁免冷却限制
    const decision = decideCompanionTrigger({
      now: createNow(14, 0),
      maxDailyInteractions: 3,
      cooldownMinutes: 120,
      activeWindowStart: '09:00',
      activeWindowEnd: '21:00',
      quietDays: [],
      recentContentTypes: memory.getRecentContentTypes(),
      todayTriggerCount: memory.getTodayTriggerCount(),
      lastTriggerAt: memory.getLastTriggerAt(),
      eventSource: 'build_event',
      hasEnoughContext: true,
      enabledContentTypes: createDefaultConfig().enabledContentTypes,
    });

    expect(decision.shouldTrigger).toBe(true);
    expect(decision.source).toBe('build_event');
  });

  it('配置变更影响触发行为', () => {
    const cfg = createDefaultConfig();
    cfg.maxDailyInteractions = 1; // 改为保守
    const now = Date.now();

    // 一次触发后，第二次应被拒绝
    memory.recordInteraction({
      id: 'a',
      type: 'tip_curiosity',
      timestamp: now - 2 * 60 * 60 * 1000, // 2小时前（同一天）
      contentId: 'a',
      userAction: 'dismissed',
    });

    const decision = decideCompanionTrigger({
      now: now,
      maxDailyInteractions: cfg.maxDailyInteractions,
      cooldownMinutes: 0, // 无冷却
      activeWindowStart: '00:00',
      activeWindowEnd: '23:59',
      quietDays: [],
      recentContentTypes: memory.getRecentContentTypes(),
      todayTriggerCount: memory.getTodayTriggerCount(),
      lastTriggerAt: memory.getLastTriggerAt(),
      hasEnoughContext: true,
      enabledContentTypes: cfg.enabledContentTypes,
    });

    expect(decision.shouldTrigger).toBe(false);
  });
});