/**
 * 对话存储后端（异步文件抽象）
 *
 * 提供统一的 文件读写/列举/删除 接口，屏蔽底层存储差异。
 *
 * 实现优先级：
 * 1. OPFS（Origin Private File System）—— 浏览器原生文件系统，磁盘级容量，
 *    Tauri WebView2 / WKWebView 均支持。存储为真实 .jsonl 文件。
 * 2. localStorage —— 兜底方案（OPFS 不可用时，如旧环境/测试环境）。
 *    每个会话一个 key，前缀 polaris_dialog_。
 *
 * 文件名约定：{externalId}.jsonl
 */

import { createLogger } from '@/utils/logger'

const log = createLogger('DialogBackend')

const DIALOG_DIR = 'dialogs'
const LS_PREFIX = 'polaris_dialog_'
const FILE_EXT = '.jsonl'

/** 存储后端接口 */
export interface DialogBackend {
  readonly kind: 'opfs' | 'localstorage'
  /** 写入文件（整体覆写） */
  writeFile(name: string, content: string): Promise<void>
  /** 读取文件内容，不存在返回 null */
  readFile(name: string): Promise<string | null>
  /** 列出所有 .jsonl 文件名（不含路径） */
  listFiles(): Promise<string[]>
  /** 删除文件 */
  deleteFile(name: string): Promise<void>
}

// ============================================================================
// OPFS 后端
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

  async deleteFile(name: string): Promise<void> {
    localStorage.removeItem(this.keyFor(name))
  }
}

// ============================================================================
// 后端选择
// ============================================================================

let backendInstance: DialogBackend | null = null

/** 获取存储后端单例（首次调用时探测 OPFS 可用性） */
export function getDialogBackend(): DialogBackend {
  if (backendInstance) return backendInstance

  if (isOPFSAvailable()) {
    backendInstance = new OPFSBackend()
    log.info('对话存储使用 OPFS 后端')
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
