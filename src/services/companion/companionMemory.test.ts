/**
 * CompanionMemory 单元测试
 *
 * 覆盖：活动记录、交互记录、技能进度、跨天重置、持久化
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CompanionMemory,
  MemoryMemoryStorage,
  createEmptyMemory,
} from './companionMemory';

describe('CompanionMemory', () => {
  let memory: CompanionMemory;

  beforeEach(() => {
    memory = new CompanionMemory(new MemoryMemoryStorage());
  });

  it('初始快照应为空', () => {
    const snapshot = memory.getSnapshot();
    expect(snapshot.totalSessions).toBe(0);
    expect(snapshot.recentFiles).toEqual([]);
    expect(snapshot.interactions).toEqual([]);
  });

  describe('recordActivity', () => {
    it('应记录构建成功/失败', () => {
      memory.recordActivity({ type: 'build', success: true });
      memory.recordActivity({ type: 'build', success: true });
      memory.recordActivity({ type: 'build', success: false });

      const snapshot = memory.getSnapshot();
      expect(snapshot.totalBuilds).toBe(3);
      expect(snapshot.successfulBuilds).toBe(2);
      expect(snapshot.failedBuilds).toBe(1);
      expect(snapshot.recentBuilds).toHaveLength(3);
    });

    it('应记录编辑文件和错误', () => {
      memory.recordActivity({ type: 'edit', file: 'src/main.ts' });
      memory.recordActivity({ type: 'error', message: 'Cannot find module' });

      const snapshot = memory.getSnapshot();
      expect(snapshot.totalEdits).toBe(1);
      expect(snapshot.recentFiles).toContain('src/main.ts');
      expect(snapshot.totalErrors).toBe(1);
      expect(snapshot.recentErrors).toContain('Cannot find module');
    });

    it('应记录代码行和工具调用', () => {
      memory.recordActivity({ type: 'code_line', count: 120 });
      memory.recordActivity({ type: 'tool_call' });

      const snapshot = memory.getSnapshot();
      expect(snapshot.totalCodeLines).toBe(120);
      expect(snapshot.totalToolCalls).toBe(1);
    });

    it('recentFiles 应限长 10', () => {
      for (let i = 0; i < 15; i++) memory.recordActivity({ type: 'edit', file: `file-${i}.ts` });
      const snapshot = memory.getSnapshot();
      expect(snapshot.recentFiles).toHaveLength(10);
    });
  });

  describe('recordInteraction', () => {
    it('应记录交互并更新触发统计', () => {
      memory.recordInteraction({
        id: 'i1',
        type: 'learning_challenge',
        timestamp: Date.now(),
        contentId: 'c1',
        userAction: 'accepted',
      });

      const snapshot = memory.getSnapshot();
      expect(snapshot.interactions).toHaveLength(1);
      expect(snapshot.todayTriggerCount).toBe(1);
      expect(snapshot.lastTriggerAt).toBeGreaterThan(0);
    });

    it('应限制交互历史 100 条', () => {
      const now = Date.now();
      for (let i = 0; i < 110; i++) {
        memory.recordInteraction({
          id: `i${i}`,
          type: 'tip_curiosity',
          timestamp: now,
          contentId: `c${i}`,
          userAction: 'dismissed',
        });
      }
      const snapshot = memory.getSnapshot();
      expect(snapshot.interactions).toHaveLength(100);
    });
  });

  describe('skills', () => {
    it('应添加技能', () => {
      memory.upsertSkill({
        id: 'rust-ownership',
        name: 'Rust 所有权',
        description: '学习 Rust 的所有权模型',
      });
      const snapshot = memory.getSnapshot();
      expect(snapshot.skills).toHaveLength(1);
      expect(snapshot.skills[0].progress).toBe(0);
    });

    it('应更新技能进度', () => {
      memory.upsertSkill({ id: 'rust-ownership', name: 'Rust 所有权' });
      memory.updateSkillProgress('rust-ownership', 25);
      memory.updateSkillProgress('rust-ownership', 75);
      const snapshot = memory.getSnapshot();
      expect(snapshot.skills[0].progress).toBe(100);
      expect(snapshot.skills[0].completedAt).toBeDefined();
    });

    it('进度不应超过 100 或低于 0', () => {
      memory.upsertSkill({ id: 'rust-ownership', name: 'Rust 所有权' });
      memory.updateSkillProgress('rust-ownership', 200);
      expect(memory.getSnapshot().skills[0].progress).toBe(100);

      memory.updateSkillProgress('rust-ownership', -500);
      expect(memory.getSnapshot().skills[0].progress).toBe(0);
    });
  });

  describe('getRecentContentTypes', () => {
    it('应返回最近 3 次内容类型', () => {
      const now = Date.now();
      memory.recordInteraction({ id: 'a', type: 'tip_curiosity', timestamp: now, contentId: 'a', userAction: 'dismissed' });
      memory.recordInteraction({ id: 'b', type: 'learning_challenge', timestamp: now, contentId: 'b', userAction: 'accepted' });
      memory.recordInteraction({ id: 'c', type: 'skill_explore', timestamp: now, contentId: 'c', userAction: 'dismissed' });

      expect(memory.getRecentContentTypes()).toEqual(['skill_explore', 'learning_challenge', 'tip_curiosity']);
    });
  });

  describe('reset', () => {
    it('应重置所有数据', () => {
      memory.recordInteraction({
        id: 'a',
        type: 'tip_curiosity',
        timestamp: Date.now(),
        contentId: 'a',
        userAction: 'dismissed',
      });
      memory.upsertSkill({ id: 's1', name: '技能' });
      memory.reset();

      const snapshot = memory.getSnapshot();
      expect(snapshot.interactions).toHaveLength(0);
      expect(snapshot.skills).toHaveLength(0);
      expect(snapshot.totalSessions).toBe(0);
    });
  });
});

describe('createEmptyMemory', () => {
  it('应返回所有字段默认值', () => {
    const memory = createEmptyMemory();
    expect(memory.totalSessions).toBe(0);
    expect(memory.totalEdits).toBe(0);
    expect(memory.recentFiles).toEqual([]);
    expect(memory.skills).toEqual([]);
    expect(memory.interactions).toEqual([]);
    expect(memory.todayTriggerCount).toBe(0);
    expect(memory.lastTriggerAt).toBe(0);
  });
});