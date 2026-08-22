/**
 * AI 主动陪伴助手 — 内容策划引擎
 *
 * 基于记忆上下文和人格配置，生成结构化主动内容。
 * 内容生成流程：上下文收集 → 类型选择 → Prompt 构建 → LLM 调用 → 验证。
 * 设计为抽象生成器注入，组件可独立测试。
 */

import type {
  CompanionContentType,
  CompanionMemorySnapshot,
  CompanionPersona,
  GeneratedContent,
  CompanionContentGenerator,
  CompanionGenerationContext,
  ContentValidationResult,
} from './types';
import { createLogger } from '@/utils/logger';

const log = createLogger('CompanionContent');

// ============================================================================
// 内容模板
// ============================================================================

/** 每种内容类型的 Prompt 模板前缀 */
const CONTENT_PROMPT_TEMPLATES: Record<CompanionContentType, string> = {
  project_insight:
    '基于以下项目上下文，生成一个项目洞察型主动内容。\n'
    + '参考最近编辑的文件、构建结果、错误信息，给出一个具体的、可执行的改进建议。\n'
    + '建议必须针对具体文件/代码，不能泛泛而谈。\n',

  learning_challenge:
    '生成一个学习挑战型主动内容。\n'
    + '挑战应该是：完成时间<10分钟、有明确产出、难度适中。\n'
    + '挑战内容与用户的技能水平和项目上下文相关。\n'
    + '包括：挑战标题、一句话描述、用户需要做什么。\n',

  skill_explore:
    '生成一个技能探索型主动内容。\n'
    + '介绍一个用户尚未使用过的 Polaris 能力或编程工具/API。\n'
    + '要具体（包括文件路径、命令示例），且与用户当前项目相关。\n',

  achievement_celebrate:
    '生成一个成就祝贺型主动内容。\n'
    + '回顾用户最近（今日/本周）的成就：代码量、构建次数、解决的问题等。\n'
    + '语气温暖，鼓励用户继续，并附带一个小的下一步建议。\n',

  tip_curiosity:
    '生成一个趣味知识型主动内容。\n'
    + '与编程/技术栈/项目相关的一个冷知识或有趣的事实。\n'
    + '不需要用户动手，纯知识分享，篇幅极短（<50字）。\n',

  daily_review:
    '生成一个每日回顾型主动内容。\n'
    + '总结用户今天在 Polaris 中的活动：编辑了多少文件、跑了多少次构建、\n'
    + '解决了什么错误、学习了什么新东西。\n'
    + '语气温暖，结尾给出一个明天的建议。\n',

  learning_followup:
    '生成一个学习跟进型主动内容。\n'
    + '用户之前开始了一个学习挑战但未完成。\n'
    + '温和地提醒并询问用户是否想继续，或者换一个任务。\n',
};

// ============================================================================
// 上下文提取
// ============================================================================

/**
 * 从记忆快照中提取 LLM 友好的上下文摘要字符串。
 * 用于注入 content generation prompt。
 */
export function extractContextSummary(memory: CompanionMemorySnapshot): string {
  const parts: string[] = [];

  // 基础统计
  parts.push(`总编辑: ${memory.totalEdits}次 | 总构建: ${memory.totalBuilds}次`
    + ` (成功${memory.successfulBuilds}/失败${memory.failedBuilds})`
    + ` | 代码行: ${memory.totalCodeLines}行`
    + ` | 工具调用: ${memory.totalToolCalls}次`);

  // 最近编辑
  if (memory.recentFiles.length > 0) {
    parts.push(`最近编辑文件: ${memory.recentFiles.slice(0, 5).join(', ')}`);
  }

  // 最近错误
  if (memory.recentErrors.length > 0) {
    parts.push(`最近错误: ${memory.recentErrors.slice(0, 3).join('; ')}`);
  }

  // 最近构建
  const recentBuilds = memory.recentBuilds.slice(0, 5);
  if (recentBuilds.length > 0) {
    const successCount = recentBuilds.filter(b => b.success).length;
    parts.push(`最近${recentBuilds.length}次构建: ${successCount}次成功`);
  }

  // 学习技能
  if (memory.skills.length > 0) {
    const active = memory.skills.filter(s => !s.completedAt);
    const completed = memory.skills.filter(s => s.completedAt);
    if (active.length > 0) {
      parts.push(`学习中: ${active.map(s => `${s.name}(${s.progress}%)`).join(', ')}`);
    }
    if (completed.length > 0) {
      parts.push(`已掌握: ${completed.map(s => s.name).join(', ')}`);
    }
  }

  // 今日交互
  parts.push(`今日主动交互: ${memory.todayTriggerCount}次`);

  return parts.join('\n');
}

// ============================================================================
// 内容类型选择
// ============================================================================

/** 根据记忆上下文，推荐最合适的内容类型 */
export function suggestContentType(
  memory: CompanionMemorySnapshot,
  forcedType?: CompanionContentType
): CompanionContentType {
  if (forcedType) return forcedType;

  // 学习跟进优先（如果有未完成的挑战）
  const activeChallenges = memory.skills.filter(s => !s.completedAt);
  if (activeChallenges.length > 0 && memory.activeChallenges.length > 0) {
    return 'learning_followup';
  }

  // 错误激增 → 项目洞察
  if (memory.recentErrors.length >= 3 && memory.failedBuilds > memory.successfulBuilds) {
    return 'project_insight';
  }

  // 有成就可庆祝
  if (memory.totalCodeLines > 0 && memory.totalCodeLines % 1000 < 500) {
    return 'achievement_celebrate';
  }

  // 构建成功 → 可以推荐学习新技能
  if (memory.recentBuilds.length > 0 && memory.recentBuilds[0]?.success) {
    return 'skill_explore';
  }

  // 一天结束时 → 回顾
  const hour = new Date().getHours();
  if (hour >= 20 || hour <= 1) {
    return 'daily_review';
  }

  // 默认轮换
  const types: CompanionContentType[] = [
    'learning_challenge',
    'skill_explore',
    'tip_curiosity',
    'project_insight',
  ];
  return types[Math.floor(Math.random() * types.length)];
}

// ============================================================================
// Prompt 构建
// ============================================================================

/**
 * 构建用于 LLM 生成主动内容的完整 Prompt。
 * 结构：人格约束 + 内容类型模板 + 上下文摘要 + 输出格式要求。
 */
export function buildContentPrompt(
  type: CompanionContentType,
  memory: CompanionMemorySnapshot,
  persona: CompanionPersona
): string {
  const template = CONTENT_PROMPT_TEMPLATES[type];
  const contextSummary = extractContextSummary(memory);
  const toneStyle = persona.tone;

  return [
    `你是一位 AI 陪伴助手「${persona.name}」。`,
    `语气：${toneStyle}。`,
    persona.writingGuidelines,
    '',
    '--- 内容类型 ---',
    template,
    '',
    '--- 当前用户上下文 ---',
    contextSummary,
    '',
    '--- 输出格式 ---',
    '请严格按照以下 JSON 格式返回（不要包含 markdown 代码块包装）：',
    '{',
    '  "title": "内容标题（10字以内，温暖有吸引力）",',
    '  "body": "内容主体（<150字，基于上下文具体地写）",',
    '  "action": { "label": "按钮文字（可选，如"开始"）", "payload": "动作标识" },',
    '  "evidence": ["上下文证据项1", "证据项2"]',
    '}',
    '',
    '关键要求：',
    '- 内容必须基于"当前用户上下文"中的具体信息，绝不能用空话。',
    '- 如果上下文不足以保证内容质量，请在 body 中明确说"我注意到你最近活动不多"，',
    '  然后推荐一个轻量、有趣的小任务。',
    '- 不要使用 markdown 格式，body 为纯文本。',
  ].join('\n');
}

// ============================================================================
// 内容验证
// ============================================================================

/** 验证生成的内容是否合格 */
export function validateContent(
  content: GeneratedContent | null,
  type: CompanionContentType
): ContentValidationResult {
  const issues: string[] = [];

  if (!content) {
    return { valid: false, issues: ['内容为空'] };
  }

  if (!content.title || content.title.trim().length < 2) {
    issues.push('标题为空或太短');
  }
  if (content.title.length > 50) {
    issues.push('标题过长（>50字）');
  }
  if (!content.body || content.body.trim().length < 10) {
    issues.push('内容主体为空或太短（<10字）');
  }
  if (content.body.length > 500) {
    issues.push('内容主体过长（>500字）');
  }

  // 类型不同
  if (content.type !== type) {
    issues.push(`内容类型不匹配：期望 ${type}，实际 ${content.type}`);
  }

  // 检查是否包含空话
  const emptyPhrases = ['看起来', '你最近', '可以试试', '要不要试试', '建议你'];
  const includedPhrases = emptyPhrases.filter(p => content.body?.includes(p));
  if (includedPhrases.length > 1) {
    issues.push('内容包含过多空话/模糊表达: ' + includedPhrases.join(', '));
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

// ============================================================================
// 内容生成（使用注入的生成器）
// ============================================================================

/**
 * 完整内容生成流程。
 * 步骤：提取上下文 → 选择类型 → 构建 Prompt → 调用生成器 → 验证 → 返回。
 */
export async function generateCompanionContent(
  context: CompanionGenerationContext,
  persona: CompanionPersona,
  generator: CompanionContentGenerator
): Promise<GeneratedContent | null> {
  const { memory, forcedType } = context;

  const type = suggestContentType(memory, forcedType);
  const prompt = buildContentPrompt(type, memory, persona);

  try {
    const content = await generator.generate(prompt, {
      type,
      fields: ['title', 'body', 'action', 'evidence'],
    });

    if (!content) {
      log.warn('内容生成器返回 null');
      return null;
    }

    // 填充 ID 和时间戳
    content.id = `comp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    content.type = type;
    content.createdAt = Date.now();

    // 验证
    const validation = validateContent(content, type);
    if (!validation.valid) {
      log.warn('内容验证失败', { issues: validation.issues, title: content.title });
      // 验证失败仍返回，但标记问题
      return null;
    }

    return content;
  } catch (err) {
    log.error('内容生成失败', err as Error);
    return null;
  }
}

// ============================================================================
// Mock 生成器（用于测试/开发）
// ============================================================================

/**
 * 模拟生成器，返回固定格式内容。
 * 用于不需要真实 LLM 的测试场景。
 */
export class MockContentGenerator implements CompanionContentGenerator {
  private counter = 0;

  async generate(prompt: string, schema: { type: CompanionContentType; fields: Array<keyof GeneratedContent> }): Promise<GeneratedContent | null> {
    this.counter++;
    return {
      id: `mock-${this.counter}`,
      type: schema.type,
      title: `[模拟] 第${this.counter}条主动内容`,
      body: `这是根据以下上下文生成的模拟内容：\n${prompt.slice(0, 100)}...`,
      createdAt: Date.now(),
      action: { label: '开始', payload: 'mock_action' },
      evidence: ['模拟上下文证据1'],
    };
  }
}