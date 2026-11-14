/**
 * 聊天卡片只读宿主桥（ai-chat-plugin-extraction-spec P1.6）
 *
 * chat 域出仓为 chat-desk 插件后，plugin_card 块的渲染仍需查宿主持有的
 * chatCardRegistry（各插件经 contributes.chatCards 注册的卡片渲染器）。
 * 本桥向插件暴露**只读**查询面：match/list，不含 loader 与注册/注销入口——
 * 卡片组件的动态加载仍由插件自行经 hostInvoke 走面板模块通道，或直接
 * import 自身 bundle。模型目录/引擎元数据不设新桥：走既有 cap.config get
 * 与 engine metadata 通道（spec §5.6 决议）。
 */

import type { ContentBlock } from '@/types'

export interface ChatCardBridgeEntry {
  pluginId: string
  cardId: string
  mode: 'result' | 'interaction'
  mcpServerId: string
  tools: string[]
  matchBy?: 'block' | 'tool'
}

interface ChatCardRegistryLike {
  match(toolName: string): {
    pluginId: string
    cardId: string
    mode: 'result' | 'interaction'
    mcpServerId: string
    tools: string[]
    matchBy?: 'block' | 'tool'
  } | undefined
  resolveWithKey(
    toolName: string,
    blockInput: unknown,
  ): { entry: ChatCardBridgeEntry; key: string } | undefined
  listKeys(): string[]
}

export function createChatCardsApi(registry: ChatCardRegistryLike): {
  match: (toolName: string) => ChatCardBridgeEntry | undefined
  resolve: (toolName: string, blockInput: unknown) => ChatCardBridgeEntry | undefined
  listKeys: () => string[]
} {
  return {
    /** 按工具完整名查卡片元数据（不含 loader） */
    match: (toolName) => {
      try {
        const entry = registry.match(toolName)
        return entry ? { ...entry } : undefined
      } catch {
        return undefined
      }
    },
    /** 含 Code Mode 适配的解析（同 PluginCardHost 语义，剥 loader） */
    resolve: (toolName, blockInput) => {
      try {
        const hit = registry.resolveWithKey(toolName, blockInput)
        return hit ? { ...hit.entry } : undefined
      } catch {
        return undefined
      }
    },
    /** 全部已注册 key（调试/降级判断用） */
    listKeys: () => {
      try {
        return registry.listKeys()
      } catch {
        return []
      }
    },
  }
}

/** 类型保护：桥入参的 block 形状校验交给调用方（ContentBlock） */
export type ChatCardBridge = ReturnType<typeof createChatCardsApi>

// ContentBlock 仅作类型引用（防 tree-shake 误删类型导入）；运行时无依赖
export type { ContentBlock }
