/**
 * LRU Cache - 最近最少使用缓存
 *
 * 基于哈希表和双向链表的 LRU 缓存实现
 * 用于缓存 Skills Body、匹配结果、系统提示词等
 *
 * @author Polaris Team
 * @since 2025-02-01
 */

import { createLogger } from './logger'

const log = createLogger('LRUCache')

/**
 * LRU 缓存节点
 */
interface LRUNode<K, V> {
  key: K
  value: V
  prev: LRUNode<K, V> | null
  next: LRUNode<K, V> | null
}

/**
 * LRU 缓存配置
 */
export interface LRUCacheConfig {
  /** 最大容量 */
  maxSize?: number
  /** 是否启用详细日志 */
  verbose?: boolean
}

/**
 * LRU 缓存实现
 *
 * @example
 * ```typescript
 * const cache = new LRUCache<string, string>({ maxSize: 10 })
 * cache.set('key1', 'value1')
 * cache.get('key1')  // 'value1'
 * cache.has('key1')  // true
 * cache.delete('key1')
 * cache.clear()
 * cache.size  // 0
 * ```
 */
export class LRUCache<K, V> {
  private capacity: number
  private cache: Map<K, LRUNode<K, V>>
  private head: LRUNode<K, V> | null
  private tail: LRUNode<K, V> | null
  private verbose: boolean

  constructor(config?: LRUCacheConfig) {
    this.capacity = config?.maxSize ?? 100
    this.cache = new Map()
    this.head = null
    this.tail = null
    this.verbose = config?.verbose ?? false
  }

  /**
   * 获取缓存值
   */
  get(key: K): V | undefined {
    const node = this.cache.get(key)

    if (!node) {
      return undefined
    }

    // 访问命中，移动到头部（最近使用）
    this.moveToHead(node)

    if (this.verbose) {
      log.debug('Cache hit', { key: String(key) })
    }

    return node.value
  }

  /**
   * 设置缓存值
   */
  set(key: K, value: V): void {
    const node = this.cache.get(key)

    if (node) {
      // 更新现有节点
      node.value = value
      this.moveToHead(node)

      if (this.verbose) {
        log.debug('Cache updated', { key: String(key) })
      }
    } else {
      // 创建新节点
      const newNode: LRUNode<K, V> = {
        key,
        value,
        prev: null,
        next: null,
      }

      // 添加到头部
      this.addToFront(newNode)

      // 存入 Map
      this.cache.set(key, newNode)

      // 检查容量
      if (this.cache.size > this.capacity) {
        // 移除尾部（最久未使用）
        this.removeTail()
      }

      if (this.verbose) {
        log.debug('Cache added', { key: String(key), size: this.cache.size, capacity: this.capacity })
      }
    }
  }

  /**
   * 检查键是否存在
   */
  has(key: K): boolean {
    return this.cache.has(key)
  }

  /**
   * 删除缓存
   */
  delete(key: K): boolean {
    const node = this.cache.get(key)

    if (!node) {
      return false
    }

    // 从链表中移除
    if (node.prev) {
      node.prev.next = node.next
    } else {
      this.head = node.next
    }

    if (node.next) {
      node.next.prev = node.prev
    } else {
      this.tail = node.prev
    }

    // 从 Map 中移除
    this.cache.delete(key)

    if (this.verbose) {
      log.debug('Cache deleted', { key: String(key) })
    }

    return true
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear()
    this.head = null
    this.tail = null

    if (this.verbose) {
      log.debug('Cache cleared')
    }
  }

  /**
   * 获取缓存大小
   */
  get size(): number {
    return this.cache.size
  }

  /**
   * 获取所有键
   */
  keys(): K[] {
    return Array.from(this.cache.keys())
  }

  /**
   * 获取所有值
   */
  values(): V[] {
    const values: V[] = []
    let current = this.head

    while (current) {
      values.push(current.value)
      current = current.next
    }

    return values
  }

  /**
   * 获取所有键值对
   */
  entries(): Array<[K, V]> {
    const entries: Array<[K, V]> = []
    let current = this.head

    while (current) {
      entries.push([current.key, current.value])
      current = current.next
    }

    return entries
  }

  /**
   * 获取缓存统计
   */
  getStats() {
    return {
      size: this.size,
      capacity: this.capacity,
      usage: `${this.size}/${this.capacity}`,
      utilizationPercent: Math.round((this.size / this.capacity) * 100),
    }
  }

  /**
   * 移动节点到头部（最近使用）
   */
  private moveToHead(node: LRUNode<K, V>): void {
    // 如果已经是头部，无需移动
    if (node === this.head) {
      return
    }

    // 从链表中移除节点
    if (node.prev) {
      node.prev.next = node.next
    }

    if (node.next) {
      node.next.prev = node.prev
    } else {
      // 节点是尾部，更新 tail 指针
      this.tail = node.prev
    }

    // 添加到头部
    node.prev = null
    node.next = this.head

    if (this.head) {
      this.head.prev = node
    }

    this.head = node
  }

  /**
   * 添加节点到头部
   */
  private addToFront(node: LRUNode<K, V>): void {
    node.prev = null
    node.next = this.head

    if (this.head) {
      this.head.prev = node
    }

    this.head = node

    if (!this.tail) {
      this.tail = node
    }
  }

  /**
   * 移除尾部节点（最久未使用）
   */
  private removeTail(): void {
    if (!this.tail) {
      return
    }

    const removedKey = this.tail.key

    // 从链表中移除
    if (this.tail.prev) {
      this.tail.prev.next = null
    } else {
      this.head = null
    }

    this.tail = this.tail.prev

    // 从 Map 中移除
    this.cache.delete(removedKey)

    if (this.verbose) {
      log.debug('Cache evicted', { key: String(removedKey) })
    }
  }
}
