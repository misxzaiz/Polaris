/**
 * AI 对话存储服务（JSONL 文件版）
 *
 * 职责：会话的保存 / 增量追加 / 列举 / 读取(整份+分页) / 删除，基于 JSONL 文件存储。
 * 整存整取 → 幂等、保序、不重复，根治此前 IndexedDB 方案的"对话错乱"。
 *
 * 数据正确性设计（Phase 0）：
 * - **per-file 串行队列**：同一会话的 append 与整体覆写不并发交错。
 * - **合并保护**：覆写前若内存消息为压缩态（离屏被 messageCompactor 截断），
 *   以磁盘上的完整版本为准——截断态永远写不进磁盘。
 * - **增量 append（WAL）**：消息完成即追加落盘，崩溃最多丢正在流式的半条消息。
 */

import { createLogger } from '@/utils/logger'
import type { ChatMessage } from '@/types'
import { isCompacted } from '@/utils/messageCompactor'
import { getDialogBackend, dialogFileName, type DialogBackend } from './dialogBackend'
import {
  serializeDialog,
  parseDialog,
  parseDialogLines,
  parseMeta,
  parseMessageLine,
  serializeMessageLine,
  buildMeta,
} from './jsonlCodec'
import type {
  DialogMeta,
  DialogRecord,
  DialogSummary,
  DialogPageResult,
  SaveDialogInput,
  ListOptions,
  PaginatedResult,
} from './types'

const log = createLogger('DialogStorageService')

const DEFAULT_PAGE_SIZE = 20

/**
 * meta 列表内存缓存：会话列表面板在切 Tab/范围/筛选时会连续多次请求列表，
 * 缓存 meta 首行解析结果，避免短时间内重复扫描后端。写入/删除会立即失效；
 * 后端实例变更（DataRoot 迁移 / 测试注入）也会自动失效（比对 backend 引用）。
 */
const META_CACHE_TTL = 5000 // ms
let metaCache: { metas: DialogMeta[]; ts: number; backend: DialogBackend } | null = null

function invalidateMetaCache(): void {
  metaCache = null
}

// ============================================================================
// per-file 持久化串行队列
// ============================================================================

/**
 * 同一会话文件的写操作（append / 整体覆写 / 删除）串行执行，
 * 防止 WAL 追加与轮末规整覆写竞速导致行交错。
 */
const persistChains = new Map<string, Promise<void>>()

function enqueuePersist(key: string, job: () => Promise<void>): Promise<void> {
  const prev = persistChains.get(key) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(job)
  persistChains.set(key, next)
  void next.finally(() => {
    if (persistChains.get(key) === next) persistChains.delete(key)
  })
  return next
}

// ============================================================================
// 磁盘消息映射缓存（压缩态降级恢复的数据源）
// ============================================================================

/**
 * conversationId → (messageId → 完整消息) 的小容量 LRU。
 *
 * messageCompactor 的内存快照被 LRU(20) 淘汰后，滚动回看/持久化前恢复
 * 需要一个完整态数据源。旧方案读 localStorage 历史（写入方已废弃，恒 miss），
 * 现改为读自有 JSONL：磁盘上就有上一轮保存的完整版本。
 */
const MSG_MAP_CACHE_LIMIT = 3
const msgMapCache = new Map<string, Map<string, ChatMessage>>()
const msgMapLoading = new Map<string, Promise<Map<string, ChatMessage> | null>>()

function touchMsgMapCache(externalId: string, map: Map<string, ChatMessage>): void {
  msgMapCache.delete(externalId)
  msgMapCache.set(externalId, map)
  while (msgMapCache.size > MSG_MAP_CACHE_LIMIT) {
    const oldest = msgMapCache.keys().next().value
    if (oldest === undefined) break
    msgMapCache.delete(oldest)
  }
}

class DialogStorageServiceImpl {
  /**
   * 保存会话（整体覆写 + 合并保护 + 前缀保留）
   *
   * 以 externalId 为文件名重写。多次保存同一会话 → 幂等，不会重复累积。
   * 创建时间在已存在的文件中保留（读旧 meta 取 createdAt）。
   *
   * - 合并保护：内存中被压缩截断的消息（快照恢复失败时）不覆盖磁盘上的完整版本，
   *   防止"截断态覆写污染"导致历史内容永久丢失。
   * - 前缀保留：尾部优先分页恢复的会话（baseSeq > 0）只持有窗口内消息，
   *   覆写时磁盘上 seq < baseSeq 的更早消息原样保留在前缀。
   *
   * @returns prefixCount：保留的磁盘前缀条数（调用方据此校正分页游标）
   */
  async saveConversation(input: SaveDialogInput): Promise<{ prefixCount: number }> {
    if (!input.externalId || input.messages.length === 0) return { prefixCount: 0 }

    let prefixCount = 0
    await enqueuePersist(input.externalId, async () => {
      const backend = getDialogBackend()
      const fileName = dialogFileName(input.externalId)
      const baseSeq = input.baseSeq ?? 0

      let createdAt: string | undefined
      let finalMessages = input.messages
      let prefix: ChatMessage[] = []
      const hasCompacted = input.messages.some((m) => isCompacted(m))
      const needDiskParse = hasCompacted || baseSeq > 0

      try {
        const existing = await backend.readFile(fileName)
        if (existing) {
          const existingMeta = parseMeta(existing)
          if (existingMeta) createdAt = existingMeta.createdAt

          if (needDiskParse) {
            const record = parseDialogLines(existing)
            if (record) {
              const windowIds = new Set(input.messages.map((m) => m.id))
              if (baseSeq > 0) {
                // 前缀保留：窗口之前的磁盘消息（排除已在窗口中的 id，防重复）
                prefix = record.lines
                  .filter((l) => l.seq < baseSeq && !windowIds.has(l.message.id))
                  .map((l) => l.message)
              }
              if (hasCompacted) {
                // 合并保护：压缩态消息若磁盘上有完整版本，以磁盘为准
                const diskById = new Map(record.lines.map((l) => [l.message.id, l.message]))
                let recovered = 0
                finalMessages = input.messages.map((m) => {
                  if (!isCompacted(m)) return m
                  const disk = diskById.get(m.id)
                  if (disk && !isCompacted(disk)) {
                    recovered++
                    return disk
                  }
                  return m
                })
                if (recovered > 0) {
                  log.info('覆写前从磁盘恢复压缩态消息', {
                    externalId: input.externalId,
                    recovered,
                  })
                }
              }
            }
          }
        }
      } catch {
        /* 忽略，按新建处理 */
      }

      prefixCount = prefix.length

      // 前缀兜底：引擎轮换会话 ID 后新文件缺前缀，从原会话文件复制（一次性，之后自包含）
      if (
        baseSeq > 0 &&
        prefix.length === 0 &&
        input.prefixSourceExternalId &&
        input.prefixSourceExternalId !== input.externalId
      ) {
        try {
          const sourceContent = await backend.readFile(
            dialogFileName(input.prefixSourceExternalId),
          )
          if (sourceContent) {
            const sourceRecord = parseDialogLines(sourceContent)
            if (sourceRecord) {
              const windowIds = new Set(finalMessages.map((m) => m.id))
              prefix = sourceRecord.lines
                .filter((l) => l.seq < baseSeq && !windowIds.has(l.message.id))
                .map((l) => l.message)
              prefixCount = prefix.length
              if (prefixCount > 0) {
                log.info('从原会话文件复制历史前缀', {
                  from: input.prefixSourceExternalId,
                  to: input.externalId,
                  prefixCount,
                })
              }
            }
          }
        } catch {
          /* 前缀复制失败不阻塞保存 */
        }
      }

      const allMessages = prefix.length > 0 ? [...prefix, ...finalMessages] : finalMessages

      const meta = buildMeta({
        externalId: input.externalId,
        engineId: input.engineId,
        title: input.title,
        workspaceId: input.workspaceId,
        workspacePath: input.workspacePath,
        messages: allMessages,
        createdAt,
        updatedAt: new Date().toISOString(),
      })

      const jsonl = serializeDialog(meta, allMessages)
      await backend.writeFile(fileName, jsonl)
      invalidateMetaCache()
      // 磁盘内容已变，恢复缓存作废（下次兜底恢复时重建）
      msgMapCache.delete(input.externalId)
      log.info('会话已保存到 JSONL', {
        externalId: input.externalId,
        messageCount: allMessages.length,
        prefixCount,
        backend: backend.kind,
      })
    })
    return { prefixCount }
  }

  /**
   * 增量追加消息（WAL 式崩溃保护）
   *
   * 消息完成即落盘：崩溃/刷新最多丢"正在流式的半条消息"，不再丢整轮。
   * 文件不存在时用 meta 建档（此时 input.messages 应为从 seq 0 起的全量）。
   * meta 的 messageCount/updatedAt 允许暂时陈旧，轮末 saveConversation 规整。
   */
  async appendConversationMessages(input: SaveDialogInput, startSeq: number): Promise<void> {
    if (!input.externalId || input.messages.length === 0) return

    return enqueuePersist(input.externalId, async () => {
      const backend = getDialogBackend()
      const fileName = dialogFileName(input.externalId)
      const lines = input.messages.map((m, i) => serializeMessageLine(m, startSeq + i))
      const metaLine = JSON.stringify(
        buildMeta({
          externalId: input.externalId,
          engineId: input.engineId,
          title: input.title,
          workspaceId: input.workspaceId,
          workspacePath: input.workspacePath,
          messages: input.messages,
          updatedAt: new Date().toISOString(),
        }),
      )

      if (typeof backend.appendFile === 'function') {
        await backend.appendFile(fileName, metaLine, lines)
      } else {
        // 降级：读-拼-写（老 mock 后端）
        const existing = await backend.readFile(fileName)
        if (existing != null && existing.length > 0) {
          const sep = existing.endsWith('\n') ? '' : '\n'
          await backend.writeFile(fileName, existing + sep + lines.join('\n') + '\n')
        } else {
          await backend.writeFile(fileName, metaLine + '\n' + lines.join('\n') + '\n')
        }
      }

      invalidateMetaCache()
      // 追加的消息是完整态，直接补进恢复缓存（若已加载）
      const cached = msgMapCache.get(input.externalId)
      if (cached) {
        for (const m of input.messages) cached.set(m.id, m)
      }
      log.debug('会话增量追加', {
        externalId: input.externalId,
        appended: lines.length,
        startSeq,
      })
    })
  }

  /**
   * 加载全部会话 meta（带短 TTL 缓存）。
   * 优先用后端 `listMeta`（仅读首行，高效）；旧 mock 后端无此方法时降级到逐文件 readFile。
   */
  private async loadAllMetas(): Promise<DialogMeta[]> {
    const backend = getDialogBackend()
    if (metaCache && metaCache.backend === backend && Date.now() - metaCache.ts < META_CACHE_TTL) {
      return metaCache.metas
    }

    const metas: DialogMeta[] = []

    if (typeof backend.listMeta === 'function') {
      const entries = await backend.listMeta()
      for (const entry of entries) {
        const meta = parseMeta(entry.metaLine)
        if (meta) metas.push(meta)
      }
    } else {
      // 降级：逐文件读取（仅老测试 mock 后端会走到）
      const fileNames = await backend.listFiles()
      for (const name of fileNames) {
        try {
          const content = await backend.readFile(name)
          if (!content) continue
          const meta = parseMeta(content)
          if (meta) metas.push(meta)
        } catch {
          /* 跳过坏文件 */
        }
      }
    }

    metaCache = { metas, ts: Date.now(), backend }
    return metas
  }

  /**
   * 分页列出会话（只读 meta 行，不解析完整消息 → 高效）
   */
  async listConversations(options?: ListOptions): Promise<PaginatedResult<DialogSummary>> {
    const page = options?.page || 1
    const pageSize = options?.pageSize || DEFAULT_PAGE_SIZE
    const sortOrder = options?.sortOrder || 'desc'

    let metas: DialogMeta[]
    try {
      metas = [...(await this.loadAllMetas())]
    } catch (e) {
      log.warn('列出对话失败', { error: String(e) })
      return { items: [], total: 0, page, pageSize, totalPages: 0, hasMore: false }
    }

    // 按 updatedAt 排序
    metas.sort((a, b) => {
      const cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()
      return sortOrder === 'desc' ? -cmp : cmp
    })

    const total = metas.length
    const totalPages = Math.ceil(total / pageSize)
    const start = (page - 1) * pageSize
    const items = metas.slice(start, start + pageSize)

    return {
      items,
      total,
      page,
      pageSize,
      totalPages,
      hasMore: page < totalPages,
    }
  }

  /** 读取单个会话的完整记录（meta + 有序消息） */
  async getConversation(externalId: string): Promise<DialogRecord | null> {
    const backend = getDialogBackend()
    try {
      const content = await backend.readFile(dialogFileName(externalId))
      if (!content) return null
      return parseDialog(content)
    } catch (e) {
      log.warn('读取会话失败', { externalId, error: String(e) })
      return null
    }
  }

  /**
   * 尾部优先分页读取（大会话恢复/预览只 parse 一页）
   *
   * @param beforeSeq 只取 seq 小于该值的消息（向上翻页游标）；null 表示取最新一页
   * @param limit 每页条数
   */
  async getConversationPage(
    externalId: string,
    beforeSeq: number | null,
    limit: number,
  ): Promise<DialogPageResult | null> {
    const backend = getDialogBackend()
    const fileName = dialogFileName(externalId)

    try {
      if (typeof backend.readPage === 'function') {
        const raw = await backend.readPage(fileName, beforeSeq, limit)
        if (!raw) return null
        const meta = parseMeta(raw.metaLine)
        if (!meta) return null
        const lines = raw.lines
          .map((l) => parseMessageLine(l))
          .filter((l): l is NonNullable<typeof l> => l !== null)
        // 后端已按 seq 升序 + 去重；这里仅做防御性排序
        lines.sort((a, b) => a.seq - b.seq)
        return {
          meta,
          messages: lines.map((l) => l.message),
          earliestSeq: lines.length > 0 ? lines[0].seq : null,
          total: raw.total,
          hasMore: raw.hasMore,
        }
      }

      // 降级：整读 + 内存分页（OPFS/localStorage 离线模式）
      const record = await this.getConversation(externalId)
      if (!record) return null
      const all = record.messages
      // 整读路径没有可靠的 seq 游标，用索引近似：beforeSeq 即消息下标
      const end = beforeSeq == null ? all.length : Math.max(0, Math.min(beforeSeq, all.length))
      const start = Math.max(0, end - limit)
      const pageMessages = all.slice(start, end)
      return {
        meta: record.meta,
        messages: pageMessages,
        earliestSeq: pageMessages.length > 0 ? start : null,
        total: all.length,
        hasMore: start > 0,
      }
    } catch (e) {
      log.warn('分页读取会话失败', { externalId, error: String(e) })
      return null
    }
  }

  /** 读取单个会话的有序消息列表（恢复/Fork 用） */
  async getConversationMessages(externalId: string): Promise<ChatMessage[]> {
    const record = await this.getConversation(externalId)
    return record?.messages ?? []
  }

  // ==========================================================================
  // 压缩态降级恢复（磁盘兜底）
  // ==========================================================================

  /** 同步查缓存中的完整消息（滚动热路径；未加载时返回 null，调用方可触发异步加载） */
  getCachedFullMessage(externalId: string, messageId: string): ChatMessage | null {
    const map = msgMapCache.get(externalId)
    if (!map) return null
    return map.get(messageId) ?? null
  }

  /** 会话消息映射是否已在缓存中 */
  hasMessageMapCache(externalId: string): boolean {
    return msgMapCache.has(externalId)
  }

  /**
   * 异步加载会话的 messageId → 完整消息 映射（去重并发，LRU 缓存）。
   * 用于压缩快照 LRU 淘汰后的磁盘兜底恢复。
   */
  async loadMessageMap(externalId: string): Promise<Map<string, ChatMessage> | null> {
    const cached = msgMapCache.get(externalId)
    if (cached) return cached

    const inflight = msgMapLoading.get(externalId)
    if (inflight) return inflight

    const task = (async () => {
      try {
        const record = await this.getConversation(externalId)
        if (!record) return null
        // 只缓存完整态消息：磁盘上已被污染的压缩态没有恢复价值
        const map = new Map<string, ChatMessage>()
        for (const m of record.messages) {
          if (!isCompacted(m)) map.set(m.id, m)
        }
        touchMsgMapCache(externalId, map)
        return map
      } catch (e) {
        log.warn('加载消息映射失败', { externalId, error: String(e) })
        return null
      } finally {
        msgMapLoading.delete(externalId)
      }
    })()

    msgMapLoading.set(externalId, task)
    return task
  }

  /** 会话是否存在 */
  async hasConversation(externalId: string): Promise<boolean> {
    const backend = getDialogBackend()
    const content = await backend.readFile(dialogFileName(externalId))
    return !!content
  }

  /** 删除会话 */
  async deleteConversation(externalId: string): Promise<void> {
    return enqueuePersist(externalId, async () => {
      const backend = getDialogBackend()
      await backend.deleteFile(dialogFileName(externalId))
      invalidateMetaCache()
      msgMapCache.delete(externalId)
      log.info('会话已删除', { externalId })
    })
  }
}

export const dialogStorageService = new DialogStorageServiceImpl()
