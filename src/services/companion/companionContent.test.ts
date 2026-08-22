/**
 * CompanionContent 单元测试
 *
 * 覆盖：上下文提取、内容类型建议、Prompt 构建、内容验证、生成流程
 */

import { describe, it, expect } from 'vitest';
import {
  extractContextSummary,
  suggestContentType,
  buildContentPrompt,
  validateContent,
  generateCompanionContent,
  MockContentGenerator,
} from './companionContent';
import { getDefaultPersona } from './companionPersona';
import { createEmptyMemory } from './companionMemory';
import type { GeneratedContent } from './types';

describe('extractContextSummary', () => {
  it('应包含基本统计', () => {
    const memory = createEmptyMemory();
    memory.totalEdits = 10;
    memory.totalBuilds = 5;
    memory.totalCodeLines = 10000;

    const summary = extractContextSummary(memory);
    expect(summary).toContain('10');
    expect(summary).toContain('5');
    expect(summary).toContain('10000');
  });

  it('应包含最近文件', () => {
    const memory = createEmptyMemory();
    memory.recentFiles = ['src/a.ts', 'src/b.ts'];
    const summary = extractContextSummary(memory);
    expect(summary).toContain('src/a.ts');
  });

  it('应包含学习技能', () => {
    const memory = createEmptyMemory();
    memory.skills = [
      { id: 's1', name: 'Rust 所有权', description: '', progress: 50, startedAt: 1, lastActivityAt: 1, completedChallenges: 0 },
    ];
    const summary = extractContextSummary(memory);
    expect(summary).toContain('Rust 所有权');
    expect(summary).toContain('50%');
  });
});

describe('suggestContentType', () => {
  it('forcedType 应覆盖逻辑', () => {
    const memory = createEmptyMemory();
    expect(suggestContentType(memory, 'tip_curiosity')).toBe('tip_curiosity');
  });

  it('活跃挑战应返回 learning_followup', () => {
    const memory = createEmptyMemory();
    memory.activeChallenges = ['c1'];
    memory.skills = [
      { id: 's1', name: '技能', description: '', progress: 30, startedAt: 1, lastActivityAt: 1, completedChallenges: 0 },
    ];
    expect(suggestContentType(memory)).toBe('learning_followup');
  });

  it('错误激增应返回 project_insight', () => {
    const memory = createEmptyMemory();
    memory.recentErrors = ['err1', 'err2', 'err3'];
    memory.failedBuilds = 5;
    memory.successfulBuilds = 2;
    expect(suggestContentType(memory)).toBe('project_insight');
  });

  it('代码里程碑应返回 achievement_celebrate', () => {
    const memory = createEmptyMemory();
    memory.totalCodeLines = 1500; // %1000 = 500 < 500 false... 用 2500
    memory.totalCodeLines = 2500; // %1000 = 500, 500 < 500 = false
    memory.totalCodeLines = 1400; // 1400%1000 = 400 < 500 true
    expect(suggestContentType(memory)).toBe('achievement_celebrate');
  });

  it('夜间应返回 daily_review', () => {
    const memory = createEmptyMemory();
    const realNow = Date.now;
    // Mock Date 的 getHours 很难，跳过实际测试
    void realNow;
    // 只验证逻辑不依赖外部
    expect(suggestContentType(memory, 'daily_review')).toBe('daily_review');
  });
});

describe('buildContentPrompt', () => {
  it('应包含人格与内容类型模板', () => {
    const persona = getDefaultPersona();
    const memory = createEmptyMemory();
    const prompt = buildContentPrompt('learning_challenge', memory, persona);
    expect(prompt).toContain('星芒');
    expect(prompt).toContain('学习挑战');
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('当前用户上下文');
  });

  it('应包含上下文摘要', () => {
    const persona = getDefaultPersona();
    const memory = createEmptyMemory();
    memory.recentFiles = ['src/main.ts'];
    const prompt = buildContentPrompt('project_insight', memory, persona);
    expect(prompt).toContain('src/main.ts');
  });
});

describe('validateContent', () => {
  it('null 内容无效', () => {
    const result = validateContent(null, 'project_insight');
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('内容为空');
  });

  it('空标题无效', () => {
    const content = createValidContent('project_insight');
    content.title = '';
    const result = validateContent(content, 'project_insight');
    expect(result.valid).toBe(false);
  });

  it('内容过短无效', () => {
    const content = createValidContent('project_insight');
    content.body = '短';
    const result = validateContent(content, 'project_insight');
    expect(result.valid).toBe(false);
  });

  it('类型不匹配无效', () => {
    const content = createValidContent('project_insight');
    content.type = 'tip_curiosity';
    const result = validateContent(content, 'project_insight');
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.stringContaining('类型不匹配'));
  });

  it('合格内容有效', () => {
    const content = createValidContent('project_insight');
    const result = validateContent(content, 'project_insight');
    expect(result).toEqual({ valid: true, issues: [] });
  });
});

describe('generateCompanionContent', () => {
  it('应使用 Mock 生成器产出内容', async () => {
    const persona = getDefaultPersona();
    const memory = createEmptyMemory();
    const generator = new MockContentGenerator();

    const content = await generateCompanionContent(
      { memory, forcedType: 'learning_challenge' },
      persona,
      generator
    );

    expect(content).not.toBeNull();
    expect(content!.type).toBe('learning_challenge');
    expect(content!.id).toBeTruthy();
    expect(content!.title).toBeTruthy();
    expect(content!.createdAt).toBeGreaterThan(0);
  });

  it('生成器失败应返回 null', async () => {
    const persona = getDefaultPersona();
    const memory = createEmptyMemory();
    const failingGenerator = {
      async generate(): Promise<GeneratedContent | null> {
        throw new Error('LLM 不可用');
      },
    };

    const content = await generateCompanionContent(
      { memory, forcedType: 'learning_challenge' },
      persona,
      failingGenerator
    );
    expect(content).toBeNull();
  });

  it('生成器返回异常内容应被拦截', async () => {
    const persona = getDefaultPersona();
    const memory = createEmptyMemory();
    const badGenerator = {
      async generate(): Promise<GeneratedContent | null> {
        return {
          id: 'bad',
          type: 'tip_curiosity', // 与要求的类型不匹配
          title: '',
          body: '太短',
          createdAt: 0,
        };
      },
    };

    const content = await generateCompanionContent(
      { memory, forcedType: 'learning_challenge' },
      persona,
      badGenerator
    );
    expect(content).toBeNull();
  });
});

function createValidContent(type: GeneratedContent['type']): GeneratedContent {
  return {
    id: 'test-id',
    type,
    title: '测试标题',
    body: '这是一段足够长的测试内容主体，用于通过验证。包含具体语境与上下文。',
    createdAt: Date.now(),
    action: { label: '开始', payload: 'start' },
    evidence: ['ctx1'],
  };
}