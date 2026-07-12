import { describe, it, expect } from 'vitest'
import { generateUUID } from './uuid'

describe('generateUUID', () => {
  it('应该生成有效格式的 UUID', () => {
    const uuid = generateUUID()
    // UUID v4 格式: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    expect(uuid).toMatch(uuidRegex)
  })

  it('应该生成唯一的 UUID', () => {
    const uuids = new Set<string>()
    const count = 1000

    for (let i = 0; i < count; i++) {
      uuids.add(generateUUID())
    }

    // 1000 个 UUID 应该都是唯一的
    expect(uuids.size).toBe(count)
  })

  it('生成的 UUID 应该是字符串类型', () => {
    const uuid = generateUUID()
    expect(typeof uuid).toBe('string')
  })

  it('生成的 UUID 长度应该是 36 个字符', () => {
    const uuid = generateUUID()
    expect(uuid.length).toBe(36)
  })

  it('生成的 UUID 应该包含 5 个连字符', () => {
    const uuid = generateUUID()
    const dashCount = (uuid.match(/-/g) || []).length
    expect(dashCount).toBe(4)
  })

  it('生成的 UUID 版本应该是 4', () => {
    const uuid = generateUUID()
    // 第 13 个字符（索引 14）应该是 '4'
    expect(uuid[14]).toBe('4')
  })

  it('生成的 UUID variant 应该是正确的', () => {
    const uuid = generateUUID()
    // 第 17 个字符（索引 19）应该是 8, 9, a, 或 b
    const variantChar = uuid[19]
    expect(['8', '9', 'a', 'b']).toContain(variantChar.toLowerCase())
  })
})
