/**
 * 角色状态管理
 *
 * 维护角色当前表情状态，通过 EventBus 订阅 AI 事件自动切换表情。
 * 零侵入设计：不修改任何现有文件。
 */

import { create } from 'zustand'
import type { AIEvent } from '../ai-runtime'
import { getEventBus } from '../ai-runtime/event-bus'
import type { CharacterExpression } from '../components/Character/expressions'
import { EVENT_TO_EXPRESSION } from '../components/Character/expressions'
import { createLogger } from '../utils/logger'

const log = createLogger('CharacterStore')

/** 短暂表情的自动恢复定时器（毫秒） */
const TEMPORARY_EXPRESSION_DURATION = 1500

/** 需要自动恢复到前一状态的短暂表情 */
const TEMPORARY_EXPRESSIONS: Partial<Record<CharacterExpression, boolean>> = {
  celebrating: true,
}

interface CharacterState {
  /** 当前表情 */
  expression: CharacterExpression
  /** 口型开合度 (0~1)，用于 TTS 驱动 */
  mouthOpen: number
  /** 是否已初始化 EventBus 订阅 */
  _initialized: boolean
}

interface CharacterActions {
  /** 设置表情 */
  setExpression: (expr: CharacterExpression) => void
  /** 设置口型开合度 */
  setMouthOpen: (open: number) => void
  /** 初始化 EventBus 订阅（幂等） */
  init: () => () => void
}

export type CharacterStore = CharacterState & CharacterActions

export const useCharacterStore = create<CharacterStore>((set, get) => {
  /** 恢复定时器 ID */
  let revertTimer: ReturnType<typeof setTimeout> | null = null

  return {
    expression: 'idle',
    mouthOpen: 0,
    _initialized: false,

    setExpression: (expr: CharacterExpression) => {
      // 清除之前的恢复定时器
      if (revertTimer) {
        clearTimeout(revertTimer)
        revertTimer = null
      }

      set({ expression: expr })

      // 短暂表情自动恢复到 idle
      if (TEMPORARY_EXPRESSIONS[expr]) {
        revertTimer = setTimeout(() => {
          const current = get().expression
          // 只在仍然是同一个短暂表情时恢复
          if (current === expr) {
            set({ expression: 'idle' })
          }
          revertTimer = null
        }, TEMPORARY_EXPRESSION_DURATION)
      }
    },

    setMouthOpen: (open: number) => {
      set({ mouthOpen: Math.max(0, Math.min(1, open)) })
    },

    init: () => {
      if (get()._initialized) {
        return () => {}
      }

      set({ _initialized: true })

      const eventBus = getEventBus()

      const unsubscribe = eventBus.onAny((event: AIEvent) => {
        const expr = EVENT_TO_EXPRESSION[event.type as keyof typeof EVENT_TO_EXPRESSION]
        if (expr) {
          get().setExpression(expr)
        }
      })

      log.info('Character store initialized, EventBus subscribed')

      return () => {
        unsubscribe()
        if (revertTimer) {
          clearTimeout(revertTimer)
          revertTimer = null
        }
        set({ _initialized: false })
        log.info('Character store destroyed, EventBus unsubscribed')
      }
    },
  }
})
