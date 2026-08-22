/**
 * AI 主动陪伴助手 — 统一导出
 *
 * 提供所有模块的公共 API 单点导出。
 * 外部使用者只需 import { ... } from '@/services/companion'
 */

// 类型
export type {
  CompanionContentType,
  CompanionUserAction,
  CompanionInteraction,
  CompanionSkill,
  GeneratedContent,
  CompanionContentGenerator,
  ContentSchema,
  ContentValidationResult,
  CompanionMemorySnapshot,
  CompanionTriggerSource,
  CompanionTriggerDecision,
  CompanionTriggerContext,
  CompanionGenerationContext,
  TeachingStyle,
  InitiativeLevel,
  CompanionPersona,
  CompanionConfig,
  CompanionEngineResult,
} from './types';

export {
  DEFAULT_COMPANION_CONFIG,
} from './types';

// 配置
export {
  CompanionConfigManager,
  LocalStorageConfigStorage,
  MemoryConfigStorage,
  validateCompanionConfig,
  resolveCompanionConfig,
  createDefaultConfig,
} from './companionConfig';
export type { CompanionConfigStorage } from './companionConfig';

// 记忆
export {
  CompanionMemory,
  LocalStorageMemoryStorage,
  MemoryMemoryStorage,
  createEmptyMemory,
  getDefaultCompanionMemory,
} from './companionMemory';
export type { CompanionMemoryStorage } from './companionMemory';

// 触发
export {
  decideCompanionTrigger,
  isWithinActiveWindow,
  isQuietDay,
  isRecentlyRepeated,
  pickNonRepeatingType,
  parseTimeToMinutes,
  defaultDailyLimitForInitiative,
} from './companionTrigger';

// 人格
export {
  PRESET_PERSONAS,
  buildCompanionSystemPrompt,
  getPersona,
  getDefaultPersona,
  initiativeToDailyLimit,
  toneToStyle,
} from './companionPersona';

// 内容
export {
  extractContextSummary,
  suggestContentType,
  buildContentPrompt,
  validateContent,
  generateCompanionContent,
  MockContentGenerator,
} from './companionContent';

// 真实引擎
export {
  RealEngineContentGenerator,
  extractJSON,
} from './realEngineGenerator';