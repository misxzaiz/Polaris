/**
 * OPFSBackend 单元测试
 *
 * 生产环境（Tauri WebView2）使用 OPFS，但 jsdom 无 OPFS。
 * 这里用内存 mock 模拟 FileSystemDirectoryHandle / FileSystemFileHandle，
 * 验证 OPFSBackend 的 写/读/列/删 逻辑正确（含覆写语义、不存在返回 null）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { OPFSBackend } from './dialogBackend'

// ============================================================================
// 内存版 OPFS Mock
// ============================================================================

interface FakeFile {
  content: string
}

class FakeWritable {
  constructor(private file: FakeFile) {}
  async write(content: string): Promise<void> {
    // createWritable 默认 keepExistingData:false → 覆写
    this.file.content = content
  }
  async close(): Promise<void> {}
}

class FakeFileHandle {
  constructor(public file: FakeFile) {}
  async createWritable(): Promise<FakeWritable> {
    this.file.content = ''
    return new FakeWritable(this.file)
  }
  async getFile(): Promise<{ text: () => Promise<string> }> {
    const content = this.file.content
    return { text: async () => content }
  }
}

class FakeDirHandle {
  files = new Map<string, FakeFile>()
  subdirs = new Map<string, FakeDirHandle>()

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDirHandle> {
    if (!this.subdirs.has(name)) {
      if (!opts?.create) throw new DOMException('NotFoundError', 'NotFoundError')
      this.subdirs.set(name, new FakeDirHandle())
    }
    return this.subdirs.get(name)!
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    if (!this.files.has(name)) {
      if (!opts?.create) throw new DOMException('NotFoundError', 'NotFoundError')
      this.files.set(name, { content: '' })
    }
    return new FakeFileHandle(this.files.get(name)!)
  }

  async *keys(): AsyncGenerator<string> {
    for (const k of this.files.keys()) yield k
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name)) {
      throw new DOMException('NotFoundError', 'NotFoundError')
    }
  }
}

// ============================================================================
// 测试
// ============================================================================

let originalStorage: PropertyDescriptor | undefined
let root: FakeDirHandle

beforeEach(() => {
  root = new FakeDirHandle()
  originalStorage = Object.getOwnPropertyDescriptor(globalThis.navigator, 'storage')
  Object.defineProperty(globalThis.navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => root },
  })
})

afterEach(() => {
  if (originalStorage) {
    Object.defineProperty(globalThis.navigator, 'storage', originalStorage)
  } else {
    // @ts-expect-error 清理 mock
    delete globalThis.navigator.storage
  }
})

describe('OPFSBackend', () => {
  it('writeFile 后 readFile 返回相同内容', async () => {
    const backend = new OPFSBackend()
    await backend.writeFile('a.jsonl', 'hello\nworld')
    expect(await backend.readFile('a.jsonl')).toBe('hello\nworld')
  })

  it('readFile 不存在的文件返回 null', async () => {
    const backend = new OPFSBackend()
    expect(await backend.readFile('missing.jsonl')).toBeNull()
  })

  it('writeFile 覆写而非追加（幂等关键）', async () => {
    const backend = new OPFSBackend()
    await backend.writeFile('a.jsonl', '第一次')
    await backend.writeFile('a.jsonl', '第二次')
    expect(await backend.readFile('a.jsonl')).toBe('第二次')
  })

  it('listFiles 返回所有 .jsonl 文件', async () => {
    const backend = new OPFSBackend()
    await backend.writeFile('a.jsonl', '1')
    await backend.writeFile('b.jsonl', '2')
    const files = await backend.listFiles()
    expect(files.sort()).toEqual(['a.jsonl', 'b.jsonl'])
  })

  it('deleteFile 删除文件', async () => {
    const backend = new OPFSBackend()
    await backend.writeFile('a.jsonl', '1')
    await backend.deleteFile('a.jsonl')
    expect(await backend.readFile('a.jsonl')).toBeNull()
    expect(await backend.listFiles()).toEqual([])
  })

  it('deleteFile 不存在的文件不抛错', async () => {
    const backend = new OPFSBackend()
    await expect(backend.deleteFile('missing.jsonl')).resolves.toBeUndefined()
  })

  it('文件存储在 dialogs 子目录', async () => {
    const backend = new OPFSBackend()
    await backend.writeFile('a.jsonl', '1')
    // 根目录不应直接有文件，而是在 dialogs 子目录
    expect(root.files.size).toBe(0)
    expect(root.subdirs.has('dialogs')).toBe(true)
    expect(root.subdirs.get('dialogs')!.files.has('a.jsonl')).toBe(true)
  })
})
