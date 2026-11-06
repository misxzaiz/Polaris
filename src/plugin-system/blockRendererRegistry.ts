/**
 * 块委托渲染注册表（plugin-ui-contribution-spec [R-8..R-11]）
 *
 * 插件经 `contributes.blockRenderers: [{ blockType, entry }]` 接管宿主块类型
 * 的渲染（form/question）。语义层（form_core/ask oneshot/审计）仍在宿主——
 * 委托的只是「谁来画」（spec [R-1]）。
 *
 * 语义：
 * - blockType 白名单由宿主维护（BLOCK_RENDERER_TYPES），未开放类型拒绝注册
 * - 同 blockType 多插件声明：先注册者生效 + warn（[R-11]）
 * - 未命中/插件禁用/加载失败 → 调用方回落宿主兜底卡（[R-10]）
 */

import type { PluginBlockRendererContribution } from './types'
import { createLogger } from '@/utils/logger'

const log = createLogger('BlockRendererRegistry')

/** 宿主开放委托的块类型白名单（扩展须修订 spec [R-8]） */
export const BLOCK_RENDERER_TYPES = ['form', 'question'] as const
export type BlockRendererType = (typeof BLOCK_RENDERER_TYPES)[number]

export interface BlockRendererRegistration {
  pluginId: string
  blockType: BlockRendererType
  loader: () => Promise<{ default: React.ComponentType<{ block: unknown }> }>
}

interface BlockRendererState {
  /** blockType → 生效注册（先到先得） */
  byType: Map<BlockRendererType, BlockRendererRegistration>
}

class BlockRendererRegistry {
  private state: BlockRendererState = { byType: new Map() }

  /**
   * 注册插件的块委托。校验：blockType 在白名单内；同类型先到先得。
   * 失败降级为 warn 不抛错（[R-18] 兜底降级，不留死注册）。
   */
  register(manifestId: string, contribution: PluginBlockRendererContribution, loader: BlockRendererRegistration['loader']): void {
    const blockType = contribution.blockType as BlockRendererType
    if (!BLOCK_RENDERER_TYPES.includes(blockType)) {
      log.warn('块委托注册被拒（blockType 未开放）', { pluginId: manifestId, blockType: contribution.blockType })
      return
    }
    if (this.state.byType.has(blockType)) {
      log.warn('块委托注册被拒（同类型已由其他插件生效，先到先得）', {
        pluginId: manifestId,
        blockType,
        owner: this.state.byType.get(blockType)?.pluginId,
      })
      return
    }
    this.state.byType.set(blockType, { pluginId: manifestId, blockType, loader })
    log.info('块委托已注册', { pluginId: manifestId, blockType })
  }

  /** 注销插件名下的全部委托（卸载/禁用时调用） */
  unregisterPlugin(manifestId: string): void {
    for (const [type, reg] of this.state.byType) {
      if (reg.pluginId === manifestId) this.state.byType.delete(type)
    }
  }

  /** 查询某块类型的生效委托（未命中返回 null → 调用方走兜底） */
  lookup(blockType: string): BlockRendererRegistration | null {
    return this.state.byType.get(blockType as BlockRendererType) ?? null
  }

  /** 全部生效委托（inspector 观测用，[R-19]） */
  list(): BlockRendererRegistration[] {
    return [...this.state.byType.values()]
  }

  /** 测试注入：清空 */
  resetForTest(): void {
    this.state.byType.clear()
  }
}

export const blockRendererRegistry = new BlockRendererRegistry()
