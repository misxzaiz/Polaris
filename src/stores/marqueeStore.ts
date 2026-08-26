/**
 * MarqueeStore - 浏览器圈选区域瞬时状态
 *
 * 与 browserSidebarStore 不同，圈选区域是瞬时数据，不做持久化。
 * BrowserPanel 在圈选完成后写入；BrowserSidebarPanel 的「AI 信息源」tab
 * 读取并展示，供发送前/发送后复核区域详情（坐标/元素/DOM）。
 */

import { create } from 'zustand'
import type { MarqueeContextBlock } from '@/services/tauri/browserService'

interface MarqueeState {
  /**
   * 最近一次圈选上下文块（含区域详情）。发送后清空。
   * 用块 id 区分不同浏览器标签的圈选；同名/同来源覆盖最后一次。
   */
  blocks: MarqueeContextBlock[]
}

interface MarqueeActions {
  /** 写入/覆盖一次圈选结果（按 browserLabel 去重，同一浏览器标签保留最新） */
  upsertBlock: (block: MarqueeContextBlock) => void
  /** 移除某块（用户点 × 或发送后） */
  removeBlock: (id: string) => void
  /** 清空全部（可选） */
  clear: () => void
}

export type MarqueeStore = MarqueeState & MarqueeActions

export const useMarqueeStore = create<MarqueeStore>()((set, get) => ({
  blocks: [],

  upsertBlock: (block) => {
    const { blocks } = get()
    // 同一浏览器标签的圈选只保留最新一次
    const others = blocks.filter(
      (b) => !(b.browserLabel && b.browserLabel === block.browserLabel)
    )
    set({ blocks: [...others, block] })
  },

  removeBlock: (id) => {
    set((s) => ({ blocks: s.blocks.filter((b) => b.id !== id) }))
  },

  clear: () => set({ blocks: [] }),
}))