/**
 * Companion 状态管理（前端 Zustand store）
 *
 * 桥接 Phase 0 基础工具与 UI 层。
 * 职责：
 * 1. 加载/持久化配置（companionConfig）
 * 2. 维护主动内容卡片队列（待展示 + 已展示）
 * 3. 触发评估（基于活动事件 + 定时器）
 * 4. 与 toastStore 联动（可选）
 *
 * 不直接调用 LLM：使用注入的 ContentGenerator（默认 Mock，Phase 2 替换为真实引擎）
 */

import { create } from 'zustand';
import { createLogger } from '@/utils/logger';
import { useToastStore } from './toastStore';
import {
  CompanionMemory,
  MemoryMemoryStorage,
  CompanionConfigManager,
  MemoryConfigStorage,
  decideCompanionTrigger,
  MockContentGenerator,
  generateCompanionContent,
  validateContent,
  getDefaultPersona,
  type GeneratedContent,
  type CompanionTriggerContext,
  type CompanionConfig,
  type CompanionUserAction,
  type CompanionContentGenerator,
} from '@/services/companion';

const log = createLogger('CompanionStore');

/** 队列最大长度 */
const MAX_PENDING = 10;
const MAX_HISTORY = 50;

/** 一条展示中的内容（携带原始内容 + 状态） */
export interface CompanionCardEntry {
  content: GeneratedContent;
  /** 进入队列的时间 */
  queuedAt: number;
  /** 用户动作（未交互为 undefined） */
  userAction?: CompanionUserAction;
}

interface CompanionStoreState {
  // ===== 状态 =====
  enabled: boolean;
  config: CompanionConfig;
  pending: CompanionCardEntry[];
  history: CompanionCardEntry[];
  /** 是否正在生成内容 */
  isGenerating: boolean;
  /** 上次错误 */
  lastError: string | null;

  // ===== 引擎实例（不参与序列化） =====
  memory: CompanionMemory;
  configManager: CompanionConfigManager;
  generator: CompanionContentGenerator;
  persona: ReturnType<typeof getDefaultPersona>;

  // ===== 动作 =====
  initialize: () => void;
  evaluateTrigger: (contextOverrides?: Partial<CompanionTriggerContext>) => Promise<boolean>;
  respondToCard: (contentId: string, action: CompanionUserAction) => void;
  dismissCard: (contentId: string) => void;
  clearPending: () => void;
  updateConfig: (patch: Partial<CompanionConfig>) => boolean;
  toggleEnabled: () => void;
  setGenerator: (gen: CompanionContentGenerator) => void;
  recordActivity: (activity: {
    type: 'build' | 'edit' | 'error' | 'session' | 'code_line' | 'tool_call';
    success?: boolean;
    file?: string;
    message?: string;
    engineId?: string;
    count?: number;
  }) => void;
  /** 重置（测试用） */
  _reset: () => void;
}

// ============================================================================
// 单例 store
// ============================================================================

// 模块级单例依赖（注入点，测试可改写）
let _memory = new CompanionMemory(new MemoryMemoryStorage());
let _configManager = new CompanionConfigManager(new MemoryConfigStorage());
let _generator: CompanionContentGenerator = new MockContentGenerator();

/** 替换依赖（仅测试用） */
export function __setCompanionDeps(deps: {
  memory?: CompanionMemory;
  configManager?: CompanionConfigManager;
  generator?: CompanionContentGenerator;
}) {
  if (deps.memory) _memory = deps.memory;
  if (deps.configManager) _configManager = deps.configManager;
  if (deps.generator) _generator = deps.generator;
  useCompanionStore.getState()._reset();
}

export const useCompanionStore = create<CompanionStoreState>()((set, get) => ({
  enabled: _configManager.load().enabled,
  config: _configManager.load(),
  pending: [],
  history: [],
  isGenerating: false,
  lastError: null,

  memory: _memory,
  configManager: _configManager,
  generator: _generator,
  persona: getDefaultPersona(),

  initialize: () => {
    const cfg = _configManager.load();
    set({ enabled: cfg.enabled, config: cfg, persona: cfg.personality });
    log.info('Companion 初始化完成', { enabled: cfg.enabled, persona: cfg.personality.name });
  },

  evaluateTrigger: async (contextOverrides) => {
    const state = get();
    if (!state.enabled) {
      log.debug('未启用，跳过触发评估');
      return false;
    }

    const cfg = state.config;
    const snapshot = state.memory.getSnapshot();

    const ctx: CompanionTriggerContext = {
      now: Date.now(),
      maxDailyInteractions: cfg.maxDailyInteractions,
      cooldownMinutes: cfg.cooldownMinutes,
      activeWindowStart: cfg.activeWindowStart,
      activeWindowEnd: cfg.activeWindowEnd,
      quietDays: cfg.quietDays,
      recentContentTypes: state.memory.getRecentContentTypes(),
      todayTriggerCount: state.memory.getTodayTriggerCount(),
      lastTriggerAt: state.memory.getLastTriggerAt(),
      hasEnoughContext: snapshot.totalSessions > 0 || snapshot.totalEdits > 0,
      enabledContentTypes: cfg.enabledContentTypes,
      ...contextOverrides,
    };

    const decision = decideCompanionTrigger(ctx);
    if (!decision.shouldTrigger) {
      log.debug('触发被拒绝', { reason: decision.ignoreReason });
      return false;
    }

    set({ isGenerating: true, lastError: null });
    try {
      const content = await generateCompanionContent(
        { memory: snapshot, forcedType: decision.suggestedType },
        cfg.personality,
        state.generator
      );

      if (!content) {
        log.warn('内容生成失败（返回 null）');
        set({ isGenerating: false, lastError: '内容生成失败' });
        return false;
      }

      const validation = validateContent(content, content.type);
      if (!validation.valid) {
        log.warn('内容验证失败', { issues: validation.issues });
        set({ isGenerating: false, lastError: '内容验证失败' });
        return false;
      }

      const entry: CompanionCardEntry = { content, queuedAt: Date.now() };
      const pending = [entry, ...get().pending].slice(0, MAX_PENDING);
      set({ pending, isGenerating: false });

      // 所有内容类型都通过 toast 主动推送通知，让用户知道有新内容
      try {
        const toast = useToastStore.getState();
        toast.info(content.title, content.body.slice(0, 80));
      } catch {
        // toast 可能不可用
      }

      state.memory.recordInteraction({
        id: content.id,
        type: content.type,
        timestamp: content.createdAt,
        contentId: content.id,
        userAction: 'dismissed',
      });

      log.info('主动内容已入队', { id: content.id, type: content.type });
      return true;
    } catch (err) {
      log.error('触发评估失败', err as Error);
      set({ isGenerating: false, lastError: (err as Error).message });
      return false;
    }
  },

  respondToCard: (contentId, action) => {
    const state = get();
    const entry = state.pending.find(e => e.content.id === contentId);
    if (!entry) return;

    const historyItem = { ...entry, userAction: action };
    const history = [historyItem, ...state.history].slice(0, MAX_HISTORY);
    const newPending = state.pending.filter(e => e.content.id !== contentId);

    set({ pending: newPending, history });
    log.info('用户响应', { contentId, action });
  },

  dismissCard: (contentId) => {
    const pending = get().pending.filter(e => e.content.id !== contentId);
    set({ pending });
  },

  clearPending: () => set({ pending: [] }),

  updateConfig: (patch) => {
    const state = get();
    const ok = state.configManager.update(patch);
    if (ok) {
      const cfg = state.configManager.load();
      set({ config: cfg, enabled: cfg.enabled, persona: cfg.personality });
    }
    return ok;
  },

  toggleEnabled: () => {
    const state = get();
    const next = !state.enabled;
    state.configManager.update({ enabled: next });
    const cfg = state.configManager.load();
    set({ enabled: next, config: cfg });
  },

  setGenerator: (gen) => set({ generator: gen }),

  recordActivity: (activity) => {
    get().memory.recordActivity(activity);
  },

  _reset: () => {
    set({
      enabled: _configManager.load().enabled,
      config: _configManager.load(),
      pending: [],
      history: [],
      isGenerating: false,
      lastError: null,
      memory: _memory,
      configManager: _configManager,
      generator: _generator,
      persona: getDefaultPersona(),
    });
  },
}));