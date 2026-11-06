/**
 * 块委托渲染宿主侧（plugin-ui-contribution-spec [R-9..R-10]）
 *
 * chatBlocks 的 form/question 块经 blockRendererRegistry 委托给插件模板：
 * - 命中：懒加载插件组件，props = { block, updateBlock }
 *   （updateBlock 由宿主实现——语义层 store 写入留在宿主，插件只拿回调；
 *    ask 卡的乐观更新走这里，form 卡仅用事件流）
 * - 未命中/加载失败：宿主兜底卡（[R-10]）——核心通道插件（core:true）+
 *   不可卸载（[S-9]）下仅极端场景可见
 */

import { useEffect, useState } from 'react'
import { blockRendererRegistry, type BlockRendererRegistration } from '@/plugin-system/blockRendererRegistry'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { createLogger } from '@/utils/logger'

const log = createLogger('BlockDelegation')

export interface BlockDelegationProps {
  /** 块原样（协议冻结，spec [R-2]）；QuestionBlock/FormBlock 均含 sessionId */
  block: { id: string; sessionId?: string; [k: string]: unknown }
  blockType: 'form' | 'question'
}

/** 宿主实现的块补丁写入（语义层留宿主）：仅允许写本块归属会话的对应块 */
function useUpdateBlock(blockType: 'form' | 'question', block: BlockDelegationProps['block']) {
  return (patch: Record<string, unknown>) => {
    const sessionId = block.sessionId
    if (!sessionId) return
    const store = sessionStoreManager.getState().stores.get(sessionId)?.getState()
    if (!store) return
    if (blockType === 'question') {
      ;(store as { updateQuestionBlock?: (id: string, patch: Record<string, unknown>) => void }).updateQuestionBlock?.(block.id, patch)
    } else {
      ;(store as { updateFormBlock?: (id: string, patch: Record<string, unknown>) => void }).updateFormBlock?.(block.id, patch)
    }
  }
}

/** 兜底卡：委托未命中/加载失败时的宿主最小渲染（[R-10]） */
export function BlockFallbackCard({ blockType, reason }: { blockType: string; reason: string }) {
  return (
    <div className="my-2 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning-faint/30 px-3 py-2 text-xs text-text-tertiary">
      <span>
        {blockType === 'form' ? '表单' : '问答'}由「交互组件」插件渲染，当前不可用（{reason}）。请在插件面板确认交互组件插件已启用。
      </span>
    </div>
  )
}

/** 委托渲染器：懒加载 + 兜底（含加载错误重试） */
export function BlockDelegationRenderer({ blockType, block }: BlockDelegationProps) {
  const registration: BlockRendererRegistration | null = blockRendererRegistry.lookup(blockType)
  const [Comp, setComp] = useState<React.ComponentType<{ block: unknown; updateBlock?: (patch: Record<string, unknown>) => void }> | null>(null)
  const [error, setError] = useState<string | null>(registration ? null : '未启用')
  const updateBlock = useUpdateBlock(blockType, block)

  const reload = () => {
    const reg = blockRendererRegistry.lookup(blockType)
    if (!reg) {
      setError('未启用')
      return
    }
    setError(null)
    reg
      .loader()
      .then((m) => setComp(() => m.default as React.ComponentType<{ block: unknown; updateBlock?: (patch: Record<string, unknown>) => void }>))
      .catch((e: unknown) => {
        log.error('块委托模板加载失败', e instanceof Error ? e : new Error(String(e)), { blockType })
        setError(e instanceof Error ? e.message : String(e))
      })
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockType, registration?.pluginId])

  if (error || !Comp) {
    return (
      <div className="relative">
        <BlockFallbackCard blockType={blockType} reason={error || '加载中…'} />
        {error && error !== '未启用' && (
          <button type="button" onClick={reload} className="absolute right-2 top-1.5 rounded border border-border px-1.5 py-0.5 text-[10px] text-text-secondary hover:text-primary">
            重试
          </button>
        )}
      </div>
    )
  }
  return <Comp block={block} updateBlock={updateBlock} />
}
