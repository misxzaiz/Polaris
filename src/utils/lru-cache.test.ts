import { describe, it, expect, beforeEach } from 'vitest'
import { LRUCache } from './lru-cache'

describe('LRUCache', () => {
  let cache: LRUCache<string, string>

  beforeEach(() => {
    cache = new LRUCache<string, string>({ maxSize: 3 })
  })

  describe('基本操作', () => {
    it('应该正确设置和获取值', () => {
      cache.set('key1', 'value1')
      expect(cache.get('key1')).toBe('value1')
    })

    it('应该在键不存在时返回 undefined', () => {
      expect(cache.get('nonexistent')).toBeUndefined()
    })

    it('应该正确检查键是否存在', () => {
      cache.set('key1', 'value1')
      expect(cache.has('key1')).toBe(true)
      expect(cache.has('key2')).toBe(false)
    })

    it('应该正确删除键', () => {
      cache.set('key1', 'value1')
      expect(cache.delete('key1')).toBe(true)
      expect(cache.get('key1')).toBeUndefined()
      expect(cache.delete('nonexistent')).toBe(false)
    })

    it('应该正确清空缓存', () => {
      cache.set('key1', 'value1')
      cache.set('key2', 'value2')
      cache.clear()
      expect(cache.size).toBe(0)
      expect(cache.get('key1')).toBeUndefined()
    })

    it('应该正确返回缓存大小', () => {
      expect(cache.size).toBe(0)
      cache.set('key1', 'value1')
      expect(cache.size).toBe(1)
      cache.set('key2', 'value2')
      expect(cache.size).toBe(2)
    })
  })

  describe('容量限制', () => {
    it('应该在超过容量时淘汰最久未使用的项', () => {
      cache.set('key1', 'value1')
      cache.set('key2', 'value2')
      cache.set('key3', 'value3')
      cache.set('key4', 'value4') // 触发淘汰

      expect(cache.size).toBe(3)
      expect(cache.get('key1')).toBeUndefined() // 最久未使用，被淘汰
      expect(cache.get('key2')).toBe('value2')
      expect(cache.get('key3')).toBe('value3')
      expect(cache.get('key4')).toBe('value4')
    })

    it('访问操作应该更新使用顺序', () => {
      cache.set('key1', 'value1')
      cache.set('key2', 'value2')
      cache.set('key3', 'value3')

      // 访问 key1，使其成为最近使用
      cache.get('key1')

      cache.set('key4', 'value4') // 触发淘汰

      expect(cache.get('key1')).toBe('value1') // 被访问过，保留
      expect(cache.get('key2')).toBeUndefined() // 最久未使用，被淘汰
    })

    it('更新现有键应该更新使用顺序', () => {
      cache.set('key1', 'value1')
      cache.set('key2', 'value2')
      cache.set('key3', 'value3')

      // 更新 key1
      cache.set('key1', 'value1-updated')

      cache.set('key4', 'value4') // 触发淘汰

      expect(cache.get('key1')).toBe('value1-updated') // 被更新过，保留
      expect(cache.get('key2')).toBeUndefined() // 最久未使用，被淘汰
    })
  })

  describe('迭代方法', () => {
    it('应该返回所有键', () => {
      cache.set('key1', 'value1')
      cache.set('key2', 'value2')
      cache.set('key3', 'value3')

      const keys = cache.keys()
      expect(keys).toHaveLength(3)
      expect(keys).toContain('key1')
      expect(keys).toContain('key2')
      expect(keys).toContain('key3')
    })

    it('应该按使用顺序返回值', () => {
      cache.set('key1', 'value1')
      cache.set('key2', 'value2')
      cache.set('key3', 'value3')

      // 访问顺序：key3, key1, key2
      cache.get('key3')
      cache.get('key1')
      cache.get('key2')

      const values = cache.values()
      expect(values).toEqual(['value2', 'value1', 'value3'])
    })

    it('应该按使用顺序返回键值对', () => {
      cache.set('key1', 'value1')
      cache.set('key2', 'value2')

      const entries = cache.entries()
      expect(entries).toEqual([
        ['key2', 'value2'],
        ['key1', 'value1'],
      ])
    })
  })

  describe('统计信息', () => {
    it('应该返回正确的统计信息', () => {
      cache.set('key1', 'value1')
      cache.set('key2', 'value2')

      const stats = cache.getStats()
      expect(stats.size).toBe(2)
      expect(stats.capacity).toBe(3)
      expect(stats.usage).toBe('2/3')
      expect(stats.utilizationPercent).toBe(67)
    })
  })

  describe('默认配置', () => {
    it('应该使用默认容量 100', () => {
      const defaultCache = new LRUCache<string, string>()
      expect(defaultCache.getStats().capacity).toBe(100)
    })
  })

  describe('边界情况', () => {
    it('应该处理容量为 1 的缓存', () => {
      const tinyCache = new LRUCache<string, string>({ maxSize: 1 })

      tinyCache.set('key1', 'value1')
      expect(tinyCache.get('key1')).toBe('value1')

      tinyCache.set('key2', 'value2')
      expect(tinyCache.get('key1')).toBeUndefined()
      expect(tinyCache.get('key2')).toBe('value2')
    })

    it('应该处理重复设置同一个键', () => {
      cache.set('key1', 'value1')
      cache.set('key1', 'value2')
      cache.set('key1', 'value3')

      expect(cache.size).toBe(1)
      expect(cache.get('key1')).toBe('value3')
    })

    it('应该处理空缓存的迭代方法', () => {
      expect(cache.keys()).toEqual([])
      expect(cache.values()).toEqual([])
      expect(cache.entries()).toEqual([])
    })
  })

  describe('类型支持', () => {
    it('应该支持不同的键值类型', () => {
      const numberCache = new LRUCache<number, { name: string }>()

      numberCache.set(1, { name: 'one' })
      numberCache.set(2, { name: 'two' })

      expect(numberCache.get(1)).toEqual({ name: 'one' })
      expect(numberCache.get(2)).toEqual({ name: 'two' })
    })
  })
})
