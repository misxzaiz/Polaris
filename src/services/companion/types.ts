/**
 * AI 主动陪伴助手 — 类型定义
 *
 * Phase 0 基础工具的类型模型。全部模块共享此类型定义，
 * 保证 API 一致、可独立测试、无 UI 依赖。
 */

// ============================================================================
// 内容类型
// ============================================================================

/** 主动内容类型（疲劳抑制与轮换策略依赖此枚举） */
export type CompanionContentType =
  | 'project_insight'      // 项目洞察：基于最近文件/错误/构建
  | 'learning_challenge'   // 学习挑战：邀请用户动手做一个小项目
  | 'skill_explore'        // 技能探索：介绍一个用户未用过的 Polaris 能力
  | 'achievement_celebrate' // 成就祝贺：回顾里程碑
  | 'tip_curiosity'        // 趣味知识：轻量、无动手要求
  | 'daily_review'         // 每日回顾：当天工作内容总结
  | 'learning_followup';   // 学习跟进：追踪用户之前的学习任务

/** 用户对内容的反馈类型 */
export type CompanionUserAction =
  | 'accepted'    // 用户接受并开始（进入挑战/学习）
  | 'dismissed'   // 用户忽略
  | 'deferred'    // 用户推迟（稍后再说）
  | 'completed'   // 用户完成
  | 'declined_forever'; // 用户永久拒绝此类内容

// ============================================================================
// 记忆层
// ============================================================================

/** 一次主动内容交互记录 */
export interface CompanionInteraction {
  id: string;
  type: CompanionContentType;
  timestamp: number;          // epoch ms
  contentId: string;
  userAction: CompanionUserAction;
  context?: string;           // 生成时的上下文摘要（用于调试）
}

/** 学习技能记录 */
export interface CompanionSkill {
  id: string;
  name: string;
  description: string;
  /** 0-100 进度 */
  progress: number;
  /** 学习开始时间 */
  startedAt: number;
  /** 最近一次进展时间 */
  lastActivityAt: number;
  /** 完成时间（若有） */
  completedAt?: number;
  /** 挑战完成次数 */
  completedChallenges: number;
}

/** 主动内容条目（一次推送的完整内容） */
export interface GeneratedContent {
  id: string;
  type: CompanionContentType;
  title: string;
  body: string;
  /** 用户可执行的行动建议（可选） */
  action?: {
    label: string;
    payload: string;
  };
  /** 关联的学习技能（如有） */
  skillId?: string;
  /** 内容生成的时间 */
  createdAt: number;
  /** 上下文证据（项目洞察等） */
  evidence?: string[];
}

/**
 * Companion 记忆状态（快照）
 *
 * 所有统计基于用户活动，用于触发决策和内容生成。
 */
export interface CompanionMemorySnapshot {
  // ---- 用户活动汇总 ----
  /** 总会话数 */
  totalSessions: number;
  /** 总编辑次数 */
  totalEdits: number;
  /** 总构建次数 */
  totalBuilds: number;
  /** 成功构建次数 */
  successfulBuilds: number;
  /** 失败构建次数 */
  failedBuilds: number;
  /** 总错误数 */
  totalErrors: number;
  /** 累计生成代码行数 */
  totalCodeLines: number;
  /** 累计工具调用 */
  totalToolCalls: number;

  // ---- 近期活动（窗口期） ----
  /** 最近编辑文件（最近 10 条） */
  recentFiles: string[];
  /** 最近错误信息（最近 10 条） */
  recentErrors: string[];
  /** 最近构建结果（最近 20 条） */
  recentBuilds: Array<{ success: boolean; timestamp: number }>;
  /** 最近会话（最近 10 条） */
  recentSessions: Array<{ engineId: string; startedAt: number; messageCount: number }>;

  // ---- 学习状态 ----
  /** 全部学习技能 */
  skills: CompanionSkill[];
  /** 活跃挑战（未完成） */
  activeChallenges: string[];

  // ---- 交互历史 ----
  /** 全部主动交互记录（按时间倒序） */
  interactions: CompanionInteraction[];
  /** 最近一次触发时间 */
  lastTriggerAt: number;
  /** 今日已触发次数 */
  todayTriggerCount: number;

  // ---- 项目状态 ----
  /** 当前工作区路径 */
  currentWorkspacePath?: string;
  /** 上次检查时间 */
  lastUpdatedAt: number;
}

// ============================================================================
// 触发引擎
// ============================================================================

/** 触发源类型 */
export type CompanionTriggerSource =
  | 'interval'      // 定时触发（每 N 小时）
  | 'build_event'   // 构建事件（成功/失败）
  | 'idle_timeout'  // 空闲超时
  | 'achievement'   // 成就解锁
  | 'learning_milestone' // 学习里程碑
  | 'error_spike'   // 错误激增
  | 'manual';       // 手动请求（测试/调试）

/** 触发决策结果 */
export interface CompanionTriggerDecision {
  shouldTrigger: boolean;
  /** 触发的来源 */
  source?: CompanionTriggerSource;
  /** 触发的主要原因 */
  reason: string;
  /** 若未触发，原因描述 */
  ignoreReason?: string;
  /** 建议的内容类型（若有） */
  suggestedType?: CompanionContentType;
  /** 决策成本（ms） */
  decisionMs: number;
}

/** 触发输入上下文 */
export interface CompanionTriggerContext {
  /** 当前时刻（测试可注入） */
  now: number;
  /** 最大日触发次数（默认 3） */
  maxDailyInteractions?: number;
  /** 冷却时间（分钟，默认 120） */
  cooldownMinutes?: number;
  /** 活跃时间窗口起点（HH:mm，默认 09:00） */
  activeWindowStart?: string;
  /** 活跃时间窗口终点（HH:mm，默认 21:00） */
  activeWindowEnd?: string;
  /** 敏感词/静默日期（每周几，0-6，默认 []） */
  quietDays?: number[];
  /** 最近 3 次内容类型（用于多样性） */
  recentContentTypes?: CompanionContentType[];
  /** 今日已触发次数 */
  todayTriggerCount: number;
  /** 上次触发时间（epoch ms） */
  lastTriggerAt: number;
  /** 触发源（若为事件触发） */
  eventSource?: CompanionTriggerSource;
  /** 是否有足够上下文（默认 true） */
  hasEnoughContext?: boolean;
  /** 启用的内容类型 */
  enabledContentTypes?: CompanionContentType[];
  /** 首选内容类型 */
  preferredContentType?: CompanionContentType;
  /** 触发源（非事件触发时默认 interval） */
  triggerSource?: CompanionTriggerSource;
}

// ============================================================================
// 内容引擎
// ============================================================================

/** 内容生成输入 */
export interface CompanionGenerationContext {
  memory: CompanionMemorySnapshot;
  /** 指定内容类型（可选，用于测试） */
  forcedType?: CompanionContentType;
  /** 额外上下文（从外部注入） */
  extraContext?: string;
}

/** LLM 生成器抽象（测试可注入 mock） */
export interface CompanionContentGenerator {
  /**
   * 生成一份主动内容。
   * 必须返回结构化 JSON 兼容对象；失败时抛出或返回 null。
   */
  generate(prompt: string, schema: ContentSchema): Promise<GeneratedContent | null>;
}

/** 生成内容需要遵循的 schema 约束 */
export interface ContentSchema {
  type: CompanionContentType;
  /** 允许的字段 */
  fields: Array<keyof GeneratedContent>;
}

/** 内容生成验证结果 */
export interface ContentValidationResult {
  valid: boolean;
  issues: string[];
}

// ============================================================================
// 人格系统
// ============================================================================

/** 教学风格 */
export type TeachingStyle = 'socratic' | 'demonstration' | 'guided' | 'exploration';

/** 主动程度 */
export type InitiativeLevel = 'low' | 'medium' | 'high';

/** 陪伴者人格 */
export interface CompanionPersona {
  /** 人格名称 */
  name: string;
  /** 语气 */
  tone: 'warm' | 'professional' | 'playful' | 'minimal';
  /** 教学风格 */
  teachingStyle: TeachingStyle;
  /** 主动程度（影响最大日触发次数） */
  initiativeLevel: InitiativeLevel;
  /** 首次主动时的开场白 */
  greeting: string;
  /** 系统提示语（注入 LLM） */
  systemPrompt: string;
  /** 主动内容的写作风格约束 */
  writingGuidelines: string;
}

// ============================================================================
// 配置
// ============================================================================

/** 完整配置 */
export interface CompanionConfig {
  enabled: boolean;
  personality: CompanionPersona;
  /** 最大日触发次数 */
  maxDailyInteractions: number;
  /** 冷却时间（分钟） */
  cooldownMinutes: number;
  /** 活跃窗口起（HH:mm） */
  activeWindowStart: string;
  /** 活跃窗口止（HH:mm） */
  activeWindowEnd: string;
  /** 静默周几（0-6） */
  quietDays: number[];
  /** 启用的内容类型 */
  enabledContentTypes: CompanionContentType[];
  /** 学习偏好 */
  preferredSkills: string[];
  /** 难度 */
  difficultyLevel: 'beginner' | 'intermediate' | 'advanced';
  /** 持久化路径（测试可注入） */
  persistencePath?: string;
}

// ============================================================================
// 引擎
// ============================================================================

/** 完整 Companion 引擎结果 */
export interface CompanionEngineResult {
  decision: CompanionTriggerDecision;
  content: GeneratedContent | null;
  memory: CompanionMemorySnapshot;
  elapsedMs: number;
}

/** 配置默认值常量 */
export const DEFAULT_COMPANION_CONFIG: CompanionConfig = {
  enabled: true,
  personality: {
    name: '星芒',
    tone: 'warm',
    teachingStyle: 'guided',
    initiativeLevel: 'medium',
    greeting: '嘿，我在。要不要一起做点有意思的？',
    systemPrompt: '你是「星芒」，一位陪伴用户在 Polaris 中学习与成长的 AI 伙伴。'
      + '你既温暖又专业，主动提议基于上下文的动手任务，'
      + '你了解用户的技能进度与近期活动，你给的建议具体、可执行、不泛泛而谈。',
    writingGuidelines: '主动内容要：1) 基于具体上下文，绝不用空话；'
      + '2) 提出一个明确的小行动；3) 语言温暖但克制；'
      + '4) 短（<150字）；5) 不重复已给过的建议。',
  },
  maxDailyInteractions: 3,
  cooldownMinutes: 120,
  activeWindowStart: '09:00',
  activeWindowEnd: '21:00',
  quietDays: [],
  enabledContentTypes: [
    'project_insight',
    'learning_challenge',
    'skill_explore',
    'achievement_celebrate',
    'tip_curiosity',
    'daily_review',
    'learning_followup',
  ],
  preferredSkills: [],
  difficultyLevel: 'intermediate',
};