/**
 * PolarisPetStore — 桌面宠物 + 成就状态管理
 *
 * 使用 Zustand + persist 持久化到 localStorage
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Achievement, AchievementCondition, PetConfig, PetEvent, PetMood } from '@/types/polarisPet';

const log = console.log.bind(console, '[PolarisPet]');

// ============================================================
// 成就定义表
// ============================================================
const ACHIEVEMENT_DEFINITIONS: Omit<Achievement, 'unlocked' | 'unlockedAt' | 'progress'>[] = [
  { id: 'first-chat', name: '初次对话', description: '完成第一次 AI 对话', icon: '💬',
    condition: 'chat_count', threshold: 1 },
  { id: 'chat-10', name: '聊得火热', description: '累计 10 次对话', icon: '🔥',
    condition: 'chat_count', threshold: 10 },
  { id: 'chat-100', name: '话痨模式', description: '累计 100 次对话', icon: '🗣️',
    condition: 'chat_count', threshold: 100 },
  { id: 'first-build', name: '初次构建', description: '完成第一次构建', icon: '🏗️',
    condition: 'build_count', threshold: 1 },
  { id: 'build-10', name: '工程大师', description: '累计 10 次构建', icon: '🏗️',
    condition: 'build_count', threshold: 10 },
  { id: 'first-tool', name: '小试牛刀', description: '第一次调用工具', icon: '🔧',
    condition: 'tool_call_count', threshold: 1 },
  { id: 'tool-100', name: '工具人', description: '累计 100 次工具调用', icon: '🛠️',
    condition: 'tool_call_count', threshold: 100 },
  { id: 'first-edit', name: '初出茅庐', description: '第一次编辑文件', icon: '📝',
    condition: 'file_edit_count', threshold: 1 },
  { id: 'edit-500', name: '码农本色', description: '累计编辑 500 个文件', icon: '✍️',
    condition: 'file_edit_count', threshold: 500 },
  { id: 'session-5', name: '多面手', description: '创建 5 个会话', icon: '📑',
    condition: 'session_count', threshold: 5 },
  { id: 'engine-hopper', name: '引擎收集者', description: '切换过 3 种不同引擎', icon: '🎮',
    condition: 'engine_switch', threshold: 3 },
  { id: 'week-warrior', name: '一周战士', description: '连续使用 7 天', icon: '📅',
    condition: 'continuous_days', threshold: 7 },
  { id: 'code-1000', name: '千行代码', description: 'AI 累计生成 1000 行代码', icon: '📟',
    condition: 'code_lines', threshold: 1000 },
  { id: 'code-10000', name: '万行码农', description: 'AI 累计生成 10000 行代码', icon: '💻',
    condition: 'code_lines', threshold: 10000 },
];

// ============================================================
// 状态接口
// ============================================================
interface PolarisPetState {
  // ---- 宠物状态 ----
  petConfig: PetConfig;
  petMood: PetMood;
  /** 宠物是否可见（被收起） */
  petVisible: boolean;

  // ---- 成就统计 ----
  achievements: Achievement[];
  /** 计数器 */
  counters: Record<string, number>;
  /** 已使用过的引擎列表 */
  usedEngines: string[];
  /** 最近解锁的成就 ID（用于展示动画） */
  lastUnlockedId: string | null;

  // ---- 动作 ----
  updatePetConfig: (config: Partial<PetConfig>) => void;
  togglePetVisibility: () => void;
  setPetMood: (mood: PetMood) => void;

  /** 触发事件（宠物反应 + 成就检测） */
  triggerEvent: (event: PetEvent) => void;

  /** 增加计数器并检测成就 */
  incrementCounter: (key: string, amount?: number) => void;
  /** 记录引擎切换 */
  recordEngine: (engineId: string) => void;

  /** 重置所有数据 */
  resetAll: () => void;
}

// ============================================================
// 工具函数
// ============================================================
/** 检测成就解锁 */
function checkAchievements(
  achievements: Achievement[],
  counters: Record<string, number>,
  usedEngines: string[],
): { updated: Achievement[]; newlyUnlocked: Achievement[] } {
  const updated = achievements.map((a) => {
    let progress = 0;

    switch (a.condition) {
      case 'chat_count':
        progress = counters.chat_count ?? 0;
        break;
      case 'build_count':
        progress = counters.build_count ?? 0;
        break;
      case 'tool_call_count':
        progress = counters.tool_call_count ?? 0;
        break;
      case 'file_edit_count':
        progress = counters.file_edit_count ?? 0;
        break;
      case 'session_count':
        progress = counters.session_count ?? 0;
        break;
      case 'engine_switch':
        progress = usedEngines.length;
        break;
      case 'continuous_days':
        progress = counters.continuous_days ?? 0;
        break;
      case 'code_lines':
        progress = counters.code_lines ?? 0;
        break;
    }

    const wasUnlocked = a.unlocked;
    const nowUnlocked = progress >= a.threshold;

    return {
      ...a,
      progress,
      unlocked: nowUnlocked,
      unlockedAt: nowUnlocked && !wasUnlocked ? Date.now() : a.unlockedAt,
    };
  });

  const newlyUnlocked = updated.filter(
    (a, i) => a.unlocked && !achievements[i].unlocked,
  );

  return { updated, newlyUnlocked };
}

// ============================================================
// Store
// ============================================================
export const usePolarisPetStore = create<PolarisPetState>()(
  persist(
    (set, get) => ({
      // ---- 初始状态 ----
      petConfig: {
        enabled: true,
        size: 'mini',
        opacity: 0.85,
        idleTimeoutSeconds: 120,
      },
      petMood: 'idle',
      petVisible: true,
      achievements: ACHIEVEMENT_DEFINITIONS.map((def) => ({
        ...def,
        unlocked: false,
        progress: 0,
      })),
      counters: {
        chat_count: 0,
        build_count: 0,
        tool_call_count: 0,
        file_edit_count: 0,
        session_count: 0,
        code_lines: 0,
        continuous_days: 0,
      },
      usedEngines: [] as string[],
      lastUnlockedId: null,

      // ---- 动作 ----
      updatePetConfig: (config) =>
        set((s) => ({ petConfig: { ...s.petConfig, ...config } })),

      togglePetVisibility: () =>
        set((s) => ({ petVisible: !s.petVisible })),

      setPetMood: (mood) => set({ petMood: mood }),

      triggerEvent: (event) => {
        switch (event) {
          case 'build_success':
            set({ petMood: 'happy' });
            break;
          case 'build_fail':
            set({ petMood: 'sad' });
            break;
          case 'ai_start':
            set({ petMood: 'thinking' });
            break;
          case 'ai_complete':
            set({ petMood: 'happy' });
            break;
          case 'achievement_unlock':
            set({ petMood: 'excited' });
            break;
          case 'idle_timeout':
            set({ petMood: 'sleeping' });
            break;
        }
        // 情绪在 3 秒后自动恢复 idle
        setTimeout(() => {
          const current = get().petMood;
          if (current !== 'sleeping') {
            set({ petMood: 'idle' });
          }
        }, 3000);
      },

      incrementCounter: (key, amount = 1) => {
        const state = get();
        const newCounters = {
          ...state.counters,
          [key]: (state.counters[key] ?? 0) + amount,
        };
        const { updated, newlyUnlocked } = checkAchievements(
          state.achievements,
          newCounters,
          state.usedEngines,
        );

        set({
          counters: newCounters,
          achievements: updated,
          lastUnlockedId: newlyUnlocked.length > 0 ? newlyUnlocked[0].id : state.lastUnlockedId,
        });

        // 显示新成就通知
        if (newlyUnlocked.length > 0) {
          // 触发自定义事件，让成就通知组件渲染
          window.dispatchEvent(
            new CustomEvent('polaris:achievement', {
              detail: newlyUnlocked[0],
            }),
          );
          // 3 秒后清除高亮
          setTimeout(() => {
            set({ lastUnlockedId: null });
          }, 3000);
        }
      },

      recordEngine: (engineId) => {
        const state = get();
        if (state.usedEngines.includes(engineId)) return;
        const newEngines = [...state.usedEngines, engineId];
        const { updated, newlyUnlocked } = checkAchievements(
          state.achievements,
          state.counters,
          newEngines,
        );
        set({
          usedEngines: newEngines,
          achievements: updated,
          lastUnlockedId: newlyUnlocked.length > 0 ? newlyUnlocked[0].id : null,
        });
        if (newlyUnlocked.length > 0) {
          window.dispatchEvent(
            new CustomEvent('polaris:achievement', { detail: newlyUnlocked[0] }),
          );
          setTimeout(() => set({ lastUnlockedId: null }), 3000);
        }
      },

      resetAll: () => {
        set({
          counters: {
            chat_count: 0,
            build_count: 0,
            tool_call_count: 0,
            file_edit_count: 0,
            session_count: 0,
            code_lines: 0,
            continuous_days: 0,
          },
          usedEngines: [],
          achievements: ACHIEVEMENT_DEFINITIONS.map((def) => ({
            ...def,
            unlocked: false,
            progress: 0,
          })),
          lastUnlockedId: null,
        });
      },
    }),
    {
      name: 'polaris-pet-storage',
      partialize: (state) => ({
        petConfig: state.petConfig,
        petVisible: state.petVisible,
        achievements: state.achievements,
        counters: state.counters,
        usedEngines: state.usedEngines,
      }),
    },
  ),
);