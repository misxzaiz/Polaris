/**
 * 消息压缩器
 *
 * 对不可见区域的消息执行数据压缩，清除重数据（工具输出、diff 等），
 * 保留元信息（状态、名称、摘要）。当消息重新进入可见区域时从快照恢复。
 *
 * 核心机制：
 * - 由 Virtuoso rangeChanged 驱动，可见范围外消息触发压缩
 * - BUFFER=5：可见区域前后各保留 5 条完整消息
 * - 两级恢复：优先从 store 内快照 Map 恢复，降级从 localStorage 恢复
 */

import type {
  ChatMessage,
  AssistantChatMessage,
  UserChatMessage,
  ContentBlock,
  ToolCallBlock,
  ThinkingBlock,
  TextBlock,
  ToolGroupBlock,
} from '../types/chat'

// ============================================================================
// 常量
// ============================================================================

/** 可见区域前后缓冲条数 */
const VISIBLE_BUFFER = 5

/** 快照 Map 最大容量（LRU 淘汰） */
const MAX_SNAPSHOTS = 20

// ============================================================================
// 压缩截取阈值
// ============================================================================

const TRUNCATE = {
  /** ToolCallBlock: 截取 output 的长度 */
  toolOutput: 0,
  /** ThinkingBlock: 截取 content 的长度 */
  thinkingContent: 100,
  /** TextBlock: 截取 content 的长度 */
  textContent: 500,
  /** UserChatMessage: 截取 content 的长度 */
  userContent: 200,
} as const

// ============================================================================
// 压缩标记
// ============================================================================

/** 压缩消息的标记符号 */
const COMPACT_MARKER = '__compacted__'

// ============================================================================
// 类型辅助
// ============================================================================

/** 标记已压缩的消息（仅内部使用） */
export interface CompactedAssistantMessage extends AssistantChatMessage {
  [COMPACT_MARKER]: true
}

export interface CompactedUserMessage extends UserChatMessage {
  [COMPACT_MARKER]: true
}

/** 判断消息是否已被压缩 */
export function isCompacted(message: ChatMessage): boolean {
  return COMPACT_MARKER in message
}

// ============================================================================
// MessageCompactor 类
// ============================================================================

export class MessageCompactor {
  /** 消息快照存储：messageId -> 原始完整消息 */
  private snapshots: Map<string, ChatMessage> = new Map()
  /** 快照 LRU 顺序 */
  private snapshotOrder: string[] = []

  /**
   * 根据可见范围计算需要压缩和恢复的消息索引
   * @param totalCount 消息总数
   * @param visibleStart 可见区域起始索引
   * @param visibleEnd 可见区域结束索引（含）
   * @returns { toCompact, toHydrate }
   */
  computeRangeActions(
    totalCount: number,
    visibleStart: number,
    visibleEnd: number
  ): { toCompact: number[]; toHydrate: number[] } {
    const toCompact: number[] = []
    const toHydrate: number[] = []

    // 完整保留区域：可见范围 ± BUFFER
    const safeStart = Math.max(0, visibleStart - VISIBLE_BUFFER)
    const safeEnd = Math.min(totalCount - 1, visibleEnd + VISIBLE_BUFFER)

    for (let i = 0; i < totalCount; i++) {
      if (i >= safeStart && i <= safeEnd) {
        toHydrate.push(i)
      } else {
        toCompact.push(i)
      }
    }

    return { toCompact, toHydrate }
  }

  /**
   * 压缩单条消息
   * - 先保存快照（用于快速恢复）
   * - 返回压缩后的消息
   * - 如果已经是压缩消息或流式消息，直接返回原消息
   */
  compactMessage<T extends ChatMessage>(message: T): T {
    // 已压缩过，跳过
    if (isCompacted(message)) {
      return message
    }

    // 流式消息不压缩
    if ('isStreaming' in message && message.isStreaming) {
      return message
    }

    // 先保存快照
    this.saveSnapshot(message)

    // 根据消息类型执行压缩
    switch (message.type) {
      case 'assistant':
        return this.compactAssistantMessage(message) as unknown as T
      case 'user':
        return this.compactUserMessage(message) as unknown as T
      // system / tool / tool_group 消息较轻，不压缩
      default:
        return message
    }
  }

  /**
   * 恢复单条消息
   * - 优先从快照 Map 恢复
   * - 如果快照不存在，返回原消息（调用方可以降级到 localStorage）
   */
  hydrateMessage<T extends ChatMessage>(message: T): T {
    if (!isCompacted(message)) {
      return message
    }

    const snapshot = this.snapshots.get(message.id)
    if (snapshot) {
      // 更新 LRU 顺序
      this.touchSnapshotOrder(message.id)
      return snapshot as T
    }

    // 快照不存在，返回当前压缩版本（调用方降级处理）
    return message
  }

  /**
   * 从外部数据恢复消息（用于 localStorage 降级恢复）
   * 恢复后同时保存到快照 Map
   */
  hydrateFromExternal<T extends ChatMessage>(_messageId: string, fullMessage: T): T {
    this.saveSnapshot(fullMessage)
    return fullMessage
  }

  /**
   * 获取快照
   */
  getSnapshot(messageId: string): ChatMessage | undefined {
    return this.snapshots.get(messageId)
  }

  /**
   * 清除所有快照
   */
  clearSnapshots(): void {
    this.snapshots.clear()
    this.snapshotOrder = []
  }

  /**
   * 获取当前快照数量
   */
  get snapshotCount(): number {
    return this.snapshots.size
  }

  // ========================================================================
  // 私有方法
  // ========================================================================

  /**
   * 保存消息快照（LRU 淘汰）
   */
  private saveSnapshot(message: ChatMessage): void {
    const id = message.id

    // 已存在则更新
    if (this.snapshots.has(id)) {
      this.snapshots.set(id, message)
      this.touchSnapshotOrder(id)
      return
    }

    // 淘汰最老的快照
    if (this.snapshots.size >= MAX_SNAPSHOTS) {
      const oldestId = this.snapshotOrder.shift()
      if (oldestId) {
        this.snapshots.delete(oldestId)
      }
    }

    this.snapshots.set(id, message)
    this.snapshotOrder.push(id)
  }

  /**
   * 更新 LRU 顺序
   */
  private touchSnapshotOrder(id: string): void {
    const idx = this.snapshotOrder.indexOf(id)
    if (idx !== -1) {
      this.snapshotOrder.splice(idx, 1)
      this.snapshotOrder.push(id)
    }
  }

  /**
   * 压缩 Assistant 消息
   * - 遍历 blocks，按类型执行压缩策略
   */
  private compactAssistantMessage(message: AssistantChatMessage): CompactedAssistantMessage {
    const compactedBlocks = message.blocks.map(block => this.compactBlock(block))
    return {
      ...message,
      blocks: compactedBlocks,
      [COMPACT_MARKER]: true as const,
    }
  }

  /**
   * 压缩 User 消息
   */
  private compactUserMessage(message: UserChatMessage): CompactedUserMessage {
    return {
      ...message,
      content: truncate(message.content, TRUNCATE.userContent),
      attachments: message.attachments?.map(a => ({
        id: a.id,
        type: a.type,
        fileName: a.fileName,
        fileSize: a.fileSize,
      })),
      [COMPACT_MARKER]: true as const,
    }
  }

  /**
   * 压缩单个 ContentBlock
   */
  private compactBlock(block: ContentBlock): ContentBlock {
    switch (block.type) {
      case 'tool_call':
        return this.compactToolCallBlock(block)
      case 'thinking':
        return this.compactThinkingBlock(block)
      case 'text':
        return this.compactTextBlock(block)
      case 'tool_group':
        return this.compactToolGroupBlock(block)
      // question / plan_mode / agent_run / permission_request 不压缩
      default:
        return block
    }
  }

  /**
   * 压缩 ToolCallBlock — 最大的内存消耗者
   * 清除 output/diffData.fullOldContent，保留 name/status/error/summary
   */
  private compactToolCallBlock(block: ToolCallBlock): ToolCallBlock {
    const compacted: ToolCallBlock = {
      ...block,
      output: undefined,
      input: {},
    }

    // 清除 diffData 中的大字段，保留 filePath
    if (block.diffData) {
      compacted.diffData = {
        oldContent: '',
        newContent: '',
        filePath: block.diffData.filePath,
        fullOldContent: undefined,
      }
    }

    return compacted
  }

  /**
   * 压缩 ThinkingBlock — 截取前 100 字
   */
  private compactThinkingBlock(block: ThinkingBlock): ThinkingBlock {
    return {
      ...block,
      content: truncate(block.content, TRUNCATE.thinkingContent),
      collapsed: true,
    }
  }

  /**
   * 压缩 TextBlock — 截取前 500 字
   */
  private compactTextBlock(block: TextBlock): TextBlock {
    return {
      ...block,
      content: truncate(block.content, TRUNCATE.textContent),
    }
  }

  /**
   * 压缩 ToolGroupBlock — 清除各工具的 output/input
   */
  private compactToolGroupBlock(block: ToolGroupBlock): ToolGroupBlock {
    return {
      ...block,
      tools: block.tools.map(tool => ({
        ...tool,
        output: undefined,
        input: undefined,
      })),
    }
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 截取字符串，超出部分用省略号标记
 * @param str 原始字符串
 * @param maxLen 最大长度，0 表示完全清除
 */
function truncate(str: string, maxLen: number): string {
  if (maxLen === 0) return ''
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen) + `... [compacted, original ${str.length} chars]`
}
