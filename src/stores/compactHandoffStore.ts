/**
 * 压缩交接任务 Store
 *
 * 把「压缩交接」从阻塞式面板改为后台异步任务：面板收集配置后触发 start()，
 * 立即返回；压缩在后台静默会话中执行，用户可自由切换查看其他对话。
 * 进度经此 store 广播（右下角进度胶囊消费），完成后 toast 通知（不强制跳转）。
 *
 * 设计约束：同一时刻仅允许一个交接任务（压缩本身占用一个静默会话与模型额度，
 * 串行足够；并发只会放大资源占用且难以在 UI 表达）。
 */

import { create } from 'zustand'
import i18n from 'i18next'
import { createLogger } from '@/utils/logger'
import { useToastStore } from './toastStore'
import { sessionStoreManager } from './conversationStore/sessionStoreManager'
import {
  compactAndHandoff,
  type CompactHandoffStage,
  type CompactHandoffParams,
} from '@/services/contextCompactHandoff'

const log = createLogger('CompactHandoffStore')

export interface CompactHandoffTask {
  /** 任务 ID（用于进度胶囊 key） */
  id: string
  /** 源会话标题（进度展示用） */
  sourceTitle: string
  stage: CompactHandoffStage
}

interface CompactHandoffState {
  task: CompactHandoffTask | null
  /** 启动一次后台压缩交接。已有任务在跑时返回 false（拒绝并发）。 */
  start: (
    params: Omit<CompactHandoffParams, 'onStage' | 'signal'> & { sourceTitle: string },
  ) => boolean
  /** 取消当前任务 */
  cancel: () => void
}

/** 当前任务的中断控制器（不入 state，避免不可序列化对象触发无谓重渲染） */
let activeAbort: AbortController | null = null

export const useCompactHandoffStore = create<CompactHandoffState>((set, get) => ({
  task: null,

  start: (params) => {
    if (get().task) {
      useToastStore.getState().info(
        i18n.t('chat:compactHandoff.busyToast'),
        i18n.t('chat:compactHandoff.busyToastHint'),
      )
      return false
    }

    const id = `compact-${params.sessionId}-${Date.now()}`
    const abort = new AbortController()
    activeAbort = abort
    set({ task: { id, sourceTitle: params.sourceTitle, stage: 'loading' } })

    void (async () => {
      try {
        const result = await compactAndHandoff({
          sessionId: params.sessionId,
          compact: params.compact,
          newSession: params.newSession,
          signal: abort.signal,
          onStage: (stage) => {
            // 任务可能已被新任务替换（快速取消+重启），仅更新仍匹配的任务
            const cur = get().task
            if (cur?.id === id) set({ task: { ...cur, stage } })
          },
        })

        if (result.ok && result.newSessionId) {
          const newSessionId = result.newSessionId
          useToastStore.getState().addToast({
            type: 'success',
            title: i18n.t('chat:compactHandoff.successToast'),
            message: i18n.t('chat:compactHandoff.successToastHint'),
            duration: 8000,
            sessionId: newSessionId,
            // 点击才跳转：不打断用户当前正在查看的对话
            action: {
              label: i18n.t('chat:compactHandoff.gotoNewSession'),
              onClick: () => sessionStoreManager.getState().switchSession(newSessionId),
            },
          })
          log.info('后台压缩交接完成', { newSessionId })
        } else {
          useToastStore.getState().error(
            i18n.t('chat:compactHandoff.failToast'),
            result.error,
          )
        }
      } catch (e) {
        useToastStore.getState().error(i18n.t('chat:compactHandoff.failToast'), String(e))
        log.error('后台压缩交接异常', e instanceof Error ? e : new Error(String(e)))
      } finally {
        if (activeAbort === abort) activeAbort = null
        // 仅当仍是本任务时清空（避免覆盖后继任务）
        if (get().task?.id === id) set({ task: null })
      }
    })()

    return true
  },

  cancel: () => {
    activeAbort?.abort()
    // 实际清空由 compactAndHandoff 的 finally + 上面的 finally 完成；
    // 这里立即置空以让 UI 即时反馈（服务侧会中断静默会话并清理）。
    set({ task: null })
  },
}))
