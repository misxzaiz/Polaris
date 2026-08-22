/**
 * CompanionAchievementBridge — Companion 技能 → polarisPet 成就桥接
 *
 * 通过 inject 模式与 polarisPetStore 解耦。
 * 在 companionStore 的技能更新路径中调用。
 */

import { createLogger } from '@/utils/logger';
import type { CompanionSkill } from '@/services/companion';

const log = createLogger('CompanionAchievement');

/** polarisPetStore 的轻量接口（避免直接依赖） */
export interface PetBridge {
  triggerEvent: (event: 'achievement_unlock' | 'happy' | 'excited') => void;
  incrementCounter: (key: string, amount?: number) => void;
}

/** 已触发成就的技能 ID（防止重复触发） */
const completedSet = new Set<string>();

/**
 * 检查技能列表，将新完成的技能桥接到 polarisPet 成就。
 * 应在技能更新后调用。
 */
export function checkSkillAchievements(
  skills: CompanionSkill[],
  pet: PetBridge
): void {
  for (const skill of skills) {
    if (skill.completedAt && !completedSet.has(skill.id)) {
      completedSet.add(skill.id);
      pet.triggerEvent('achievement_unlock');
      pet.triggerEvent('happy');
      pet.incrementCounter('skill_completed', 1);
      log.info('技能完成 → 成就触发', { skillId: skill.id, name: skill.name });
    }
  }
}

/** 重置跟踪状态（测试用） */
export function resetSkillAchievements(): void {
  completedSet.clear();
}