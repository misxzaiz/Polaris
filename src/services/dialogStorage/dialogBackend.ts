/**
 * 对话存储后端（异步文件抽象）
 *
 * 提供统一的 文件读写/列举/删除 接口，屏蔽底层存储差异。
 *
 * 实现优先级（首次调用时确定）：
 * 1. **RemoteBackend** —— 只要 transport 可达（Tauri IPC 或 Web/HTTP）即首选，
 *    落到服务端 `<DataRoot>/dialogs/`：用户可见、可备份、**全端共享**
 *    （桌面 / 任意浏览器 / 移动 WebView 看到同一份历史）。
 * 2. **OPFSBackend** —— 仅后端完全不可达时的离线兜底（纯静态 Web 场景），按浏览器隔离。
 * 3. **LocalStorageBackend** —— 极端兜底（OPFS 不可用 + 非 Tauri 环境，主要用于测试）。
 *
 * 文件名约定：{externalId}.jsonl
 */

import { invoke } from '@/services/transport'
import { isTauri, isWeb } from '@/utils/platform'
import { createLogger } from '@/utils/logger'

const log = createLogger('DialogBackend')

const DIALOG_DIR = 'dialogs'
const LS_PREFIX = 'polaris_dialog_'
const FILE_EXT = '.jsonl'

/**
 * 列表 meta 条目：文件名 + 该文件首行(DialogMeta JSON 字符串)。
 * 仅需首行即可渲染会话列表,避免读取整份 jsonl(可能数 MB)。
 */
export interface DialogMetaEntry {
  name: string
  metaLine: string
}

/** 尾部优先分页读取的原始结果（行未解析,由 service 层按需 parse） */
export interface DialogPageRaw {
  metaLine: string
  /** 本页消息行（seq 升序,原始 JSON 字符串） */
  lines: string[]
  /** 消息行总数 */
  total: number
  /** 本页之前是否还有更早的消息 */
  hasMore: boolean
}

/** OPFS/localStorage 提取首行时读取的最大字节数(meta 行远小于此，足够安全) */
const META_SLICE_BYTES = 262144 // 256KB

/** 从整份文本中提取并 trim 首行 */
function extractFirstLine(content: string): string {
  const nl = content.indexOf('\n')
  return (nl === -1 ? content : content.slice(0, nl)).trim()
}

/** 存储后端接口 */
export interface DialogBackend {
  readonly kind: 'remote' | 'opfs' | 'localstorage'
  /** 写入文件（整体覆写） */
  writeFile(name: string, content: string): Promise<void>
  /** 读取文件内容，不存在返回 null */
  readFile(name: string): Promise<string | null>
  /** 列出所有 .jsonl 文件名（不含路径） */
  listFiles(): Promise<string[]>
  /** 删除文件 */
  deleteFile(name: string): Promise<void>
  /**
   * 高效列举：仅读取每个文件首行(meta)，用于会话列表。
   * 可选：旧的测试 mock 后端可不实现，service 层会自动降级到 readFile 循环。
   */
  listMeta?(): Promise<DialogMetaEntry[]>
  /**
   * 增量追加消息行（WAL 式崩溃保护）。文件不存在时用 metaLine 建档。
   * 可选：不实现时 service 层降级为 读-拼-写。
   */
  appendFile?(name: string, metaLine: string, lines: string[]): Promise<void>
  /**
   * 尾部优先分页读取（大会话恢复只取一页）。
   * 可选：不实现时 service 层降级为整读 + 内存分页。
   */
  readPage?(name: string, beforeSeq: number | null, limit: number): Promise<DialogPageRaw | null>
}

// ============================================================================
// 远程后端（首选：Tauri IPC / Web HTTP 同一套命令,落服务端磁盘,全端共享）
// ============================================================================

export class RemoteBackend implements DialogBackend {
  readonly kind = 'remote' as const

  async writeFile(name: string, content: string): Promise<void> {
    await invoke<void>('dialog_write', { name, content })
  }

  async readFile(name: string): Promise<string | null> {
    const result = await invoke<string | null>('dialog_read', { name })
    return result ?? null
  }

  async listFiles(): Promise<string[]> {
    return invoke<string[]>('dialog_list')
  }

  async listMeta(): Promise<DialogMetaEntry[]> {
    return invoke<DialogMetaEntry[]>('dialog_list_meta')
  }

  async appendFile(name: string, metaLine: string, lines: string[]): Promise<void> {
    await invoke<void>('dialog_append', { name, metaLine, lines })
  }

  async readPage(
    name: string,
    beforeSeq: number | null,
    limit: number,
  ): Promise<DialogPageRaw | null> {
    const result = await invoke<DialogPageRaw | null>('dialog_read_page', {
      name,
      beforeSeq: beforeSeq ?? undefined,
      limit,
    })
    return result ?? null
  }

  async deleteFile(name: string): Promise<void> {
    await invoke<void>('dialog_delete', { name })
  }
}

// ============================================================================
// OPFS 后端（离线兜底）
// ============================================================================

function isOPFSAvailable(): boolean {
  try {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.storage &&
      typeof navigator.storage.getDirectory === 'function'
    )
  } catch {
    return false
  }
}

export class OPFSBackend implements DialogBackend {
  readonly kind = 'opfs' as const

  private async getDir(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory()
    return root.getDirectoryHandle(DIALOG_DIR, { create: true })
  }

  async writeFile(name: string, content: string): Promise<void> {
    const dir = await this.getDir()
    const fileHandle = await dir.getFileHandle(name, { create: true })
    const writable = await fileHandle.createWritable()
    try {
      await writable.write(content)
    } finally {
      await writable.close()
    }
  }

  async readFile(name: string): Promise<string | null> {
    try {
      const dir = await this.getDir()
      const fileHandle = await dir.getFileHandle(name, { create: false })
      const file = await fileHandle.getFile()
      return await file.text()
    } catch {
      // 文件不存在
      return null
    }
  }

  async appendFile(name: string, metaLine: string, lines: string[]): Promise<void> {
    const dir = await this.getDir()
    let exists = true
    let size = 0
    let endsWithNewline = true
    try {
      const fh = await dir.getFileHandle(name, { create: false })
      const file = await fh.getFile()
      size = file.size
      if (size > 0) {
        const tailText = await file.slice(size - 1).text()
        endsWithNewline = tailText.endsWith('\n')
      }
    } catch {
      exists = false
    }

    const fileHandle = await dir.getFileHandle(name, { create: true })
    // keepExistingData + 定位到文件尾：真 append,不整读旧内容
    const writable = await fileHandle.createWritable({ keepExistingData: exists })
    try {
      let payload = ''
      if (!exists) {
        payload += metaLine.trim() + '\n'
      } else if (size > 0 && !endsWithNewline) {
        payload += '\n'
      }
      payload += lines.join('\n') + '\n'
      await writable.write({ type: 'write', position: exists ? size : 0, data: payload })
    } finally {
      await writable.close()
    }
  }

  async listFiles(): Promise<string[]> {
    const dir = await this.getDir()
    const names: string[] = []
    // FileSystemDirectoryHandle 是异步可迭代的；keys() 在部分 TS DOM lib 版本中类型缺失，
    // 用类型断言而非 @ts-expect-error（后者在 lib 已含类型时会变成 unused-directive 错误）
    const iterable = dir as unknown as { keys(): AsyncIterable<string> }
    for await (const name of iterable.keys()) {
      if (typeof name === 'string' && name.endsWith(FILE_EXT)) {
        names.push(name)
      }
    }
    return names
  }

  async listMeta(): Promise<DialogMetaEntry[]> {
    const dir = await this.getDir()
    const out: DialogMetaEntry[] = []
    const iterable = dir as unknown as { keys(): AsyncIterable<string> }
    for await (const name of iterable.keys()) {
      if (typeof name !== 'string' || !name.endsWith(FILE_EXT)) continue
      try {
        const fileHandle = await dir.getFileHandle(name, { create: false })
        const file = await fileHandle.getFile()
        // 只读文件首段：meta 行必在其中，避免把整份消息体读进内存
        const text = await file.slice(0, META_SLICE_BYTES).text()
        const metaLine = extractFirstLine(text)
        if (metaLine) out.push({ name, metaLine })
      } catch {
        /* 跳过坏文件 */
      }
    }
    return out
  }

  async deleteFile(name: string): Promise<void> {
    try {
      const dir = await this.getDir()
      await dir.removeEntry(name)
    } catch (e) {
      log.warn('OPFS 删除文件失败', { name, error: String(e) })
    }
  }
}

// ============================================================================
// localStorage 后端（兜底）
// ============================================================================

class LocalStorageBackend implements DialogBackend {
  readonly kind = 'localstorage' as const

  private keyFor(name: string): string {
    return `${LS_PREFIX}${name}`
  }

  async writeFile(name: string, content: string): Promise<void> {
    try {
      localStorage.setItem(this.keyFor(name), content)
    } catch (e) {
      // 容量超限等
      log.error('localStorage 写入失败', e instanceof Error ? e : new Error(String(e)))
      throw e
    }
  }

  async readFile(name: string): Promise<string | null> {
    return localStorage.getItem(this.keyFor(name))
  }

  async appendFile(name: string, metaLine: string, lines: string[]): Promise<void> {
    const existing = localStorage.getItem(this.keyFor(name))
    if (existing == null) {
      await this.writeFile(name, metaLine.trim() + '\n' + lines.join('\n') + '\n')
      return
    }
    const sep = existing.endsWith('\n') || existing.length === 0 ? '' : '\n'
    await this.writeFile(name, existing + sep + lines.join('\n') + '\n')
  }

  async listFiles(): Promise<string[]> {
    const names: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith(LS_PREFIX)) {
        const name = key.slice(LS_PREFIX.length)
        if (name.endsWith(FILE_EXT)) names.push(name)
      }
    }
    return names
  }

  async listMeta(): Promise<DialogMetaEntry[]> {
    const out: DialogMetaEntry[] = []
    const names = await this.listFiles()
    for (const name of names) {
      const content = localStorage.getItem(this.keyFor(name))
      if (!content) continue
      const metaLine = extractFirstLine(content)
      if (metaLine) out.push({ name, metaLine })
    }
    return out
  }

  async deleteFile(name: string): Promise<void> {
    localStorage.removeItem(this.keyFor(name))
  }
}

// ============================================================================
// 后端选择
// ============================================================================

let backendInstance: DialogBackend | null = null

/** 获取存储后端单例（首次调用时根据运行环境选择） */
export function getDialogBackend(): DialogBackend {
  if (backendInstance) return backendInstance

  if (isTauri() || isWeb()) {
    // transport 可达（Tauri IPC 或 HTTP）→ 统一落服务端磁盘,全端共享同一份历史
    backendInstance = new RemoteBackend()
    log.info('对话存储使用远程后端', { transport: isTauri() ? 'tauri' : 'http' })
  } else if (isOPFSAvailable()) {
    backendInstance = new OPFSBackend()
    log.info('对话存储使用 OPFS 后端（离线模式,数据仅存本浏览器）')
  } else {
    backendInstance = new LocalStorageBackend()
    log.info('对话存储使用 localStorage 后端（OPFS 不可用）')
  }
  return backendInstance
}

/** 测试用：强制注入后端 */
export function __setDialogBackendForTest(backend: DialogBackend | null): void {
  backendInstance = backend
}

/** 文件名工具 */
export function dialogFileName(externalId: string): string {
  // 清理文件名中的非法字符（externalId 通常是 UUID/session id，一般安全；兜底处理）
  const safe = externalId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return `${safe}${FILE_EXT}`
}
