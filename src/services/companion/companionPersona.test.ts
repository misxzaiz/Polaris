/**
 * CompanionPersona 单元测试
 *
 * 覆盖：预设人格、系统提示构建、工具函数
 */

import { describe, it, expect } from 'vitest';
import {
  PRESET_PERSONAS,
  buildCompanionSystemPrompt,
  getPersona,
  getDefaultPersona,
  initiativeToDailyLimit,
  toneToStyle,
} from './companionPersona';

describe('PRESET_PERSONAS', () => {
  it('应包含三种预设人格', () => {
    expect(Object.keys(PRESET_PERSONAS)).toHaveLength(3);
    expect(PRESET_PERSONAS.warm_sister).toBeDefined();
    expect(PRESET_PERSONAS.professional_mentor).toBeDefined();
    expect(PRESET_PERSONAS.playful_partner).toBeDefined();
  });

  it('每个人格应包含必要字段', () => {
    for (const p of Object.values(PRESET_PERSONAS)) {
      expect(p.name).toBeTruthy();
      expect(p.tone).toBeTruthy();
      expect(p.teachingStyle).toBeTruthy();
      expect(p.initiativeLevel).toBeTruthy();
      expect(p.greeting).toBeTruthy();
      expect(p.systemPrompt.length).toBeGreaterThan(10);
      expect(p.writingGuidelines.length).toBeGreaterThan(10);
    }
  });
});

describe('getPersona', () => {
  it('应返回默认人格', () => {
    const persona = getPersona('warm_sister');
    expect(persona.name).toBe('星芒');
  });

  it('未知名称回退到默认', () => {
    const persona = getPersona('nonexistent');
    expect(persona).toBe(PRESET_PERSONAS.warm_sister);
  });
});

describe('buildCompanionSystemPrompt', () => {
  it('应包含人格基础提示', () => {
    const prompt = buildCompanionSystemPrompt(PRESET_PERSONAS.warm_sister);
    expect(prompt).toContain('星芒');
    expect(prompt).toContain('主动内容要求');
  });

  it('应包含教学风格指令', () => {
    const prompt = buildCompanionSystemPrompt(PRESET_PERSONAS.warm_sister);
    expect(prompt).toContain('教学风格');
  });

  it('应包含主动程度指令', () => {
    const prompt = buildCompanionSystemPrompt(PRESET_PERSONAS.warm_sister);
    expect(prompt).toContain('主动程度');
  });

  it('应包含学习上下文', () => {
    const prompt = buildCompanionSystemPrompt(PRESET_PERSONAS.warm_sister, {
      skills: ['Rust 所有权'],
      preferredTopics: ['网络编程'],
    });
    expect(prompt).toContain('Rust 所有权');
    expect(prompt).toContain('网络编程');
  });

  it('苏格拉底风格应包含"先问后答"', () => {
    const prompt = buildCompanionSystemPrompt(PRESET_PERSONAS.professional_mentor);
    expect(prompt).toContain('提问引导');
  });
});

describe('initiativeToDailyLimit', () => {
  it('应映射主动级别到每日上限', () => {
    expect(initiativeToDailyLimit('high')).toBe(5);
    expect(initiativeToDailyLimit('medium')).toBe(3);
    expect(initiativeToDailyLimit('low')).toBe(1);
    expect(initiativeToDailyLimit('unknown' as never)).toBe(3);
  });
});

describe('toneToStyle', () => {
  it('应返回对应风格描述', () => {
    expect(toneToStyle('warm')).toContain('温度');
    expect(toneToStyle('professional')).toContain('严谨');
    expect(toneToStyle('playful')).toContain('幽默');
    expect(toneToStyle('minimal')).toContain('极简');
  });
});

describe('getDefaultPersona', () => {
  it('应返回默认人格的克隆', () => {
    const persona = getDefaultPersona();
    expect(persona.name).toBe('星芒');
    // 修改不应影响预设
    persona.name = '改过';
    expect(PRESET_PERSONAS.warm_sister.name).toBe('星芒');
  });
});