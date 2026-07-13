/**
 * AI 对话存储服务（JSONL 文件版）
 *
 * 职责：会话的保存 / 列举 / 读取 / 删除，基于 JSONL 文件存储。
 * 整存整取 → 幂等、保序、不重复，根治此前 IndexedDB 方案的"对话错乱"。
 */

import { createLogger } from '@/utils/logger'
import type { ChatMessage } from '@/types'
import { getDialogBackend, dialogFileName, type DialogBackend } from './dialogBackend'
import { serializeDialog, parseDialog, parseMeta, buildMeta } from './jsonlCodec'
import type {
  DialogMeta,
  DialogRecord,
  DialogSummary,
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

class DialogStorageServiceImpl {
  /**
   * 保存会话（整体覆写）
   *
   * 以 externalId 为文件名，全量重写。多次保存同一会话 → 幂等，不会重复累积。
   * 创建时间在已存在的文件中保留（读旧 meta 取 createdAt）。
   */
  async saveConversation(input: SaveDialogInput): Promise<void> {
    if (!input.externalId || input.messages.length === 0) return

    const backend = getDialogBackend()
    const fileName = dialogFileName(input.externalId)

    // 保留已有 createdAt
    let createdAt: string | undefined
    try {
      const existing = await backend.readFile(fileName)
      if (existing) {
        const existingMeta = parseMeta(existing)
        if (existingMeta) createdAt = existingMeta.createdAt
      }
    } catch {
      /* 忽略，按新建处理 */
    }

    const meta = buildMeta({
      externalId: input.externalId,
      engineId: input.engineId,
      title: input.title,
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      messages: input.messages,
      createdAt,
      updatedAt: new Date().toISOString(),
    })

    const jsonl = serializeDialog(meta, input.messages)
    await backend.writeFile(fileName, jsonl)
    invalidateMetaCache()
    log.info('会话已保存到 JSONL', {
      externalId: input.externalId,
      messageCount: input.messages.length,
      backend: backend.kind,
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

  /** 读取单个会话的有序消息列表（恢复/Fork 用） */
  async getConversationMessages(externalId: string): Promise<ChatMessage[]> {
    const record = await this.getConversation(externalId)
    return record?.messages ?? []
  }

  /** 会话是否存在 */
  async hasConversation(externalId: string): Promise<boolean> {
    const backend = getDialogBackend()
    const content = await backend.readFile(dialogFileName(externalId))
    return !!content
  }

  /** 删除会话 */
  async deleteConversation(externalId: string): Promise<void> {
    const backend = getDialogBackend()
    await backend.deleteFile(dialogFileName(externalId))
    invalidateMetaCache()
    log.info('会话已删除', { externalId })
  }
}

export const dialogStorageService = new DialogStorageServiceImpl()
