import { describe, expect, it } from 'vitest'
import { formatTokens, formatTokensStrict } from './formatTokens'

describe('formatTokens 中文单位格式化', () => {
  it('千以内原样输出', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  it('千级输出「千」', () => {
    expect(formatTokens(1000)).toBe('1千')
    expect(formatTokens(1234)).toBe('1.2千')
  })

  it('千位满十进万（临界进位）', () => {
    expect(formatTokens(9999)).toBe('1万')
    expect(formatTokens(9949)).toBe('9.9千')
  })

  it('万级输出「万」', () => {
    expect(formatTokens(10_000)).toBe('1万')
    expect(formatTokens(12_345)).toBe('1.2万')
    expect(formatTokens(999_999)).toBe('100万')
  })

  it('万位满十进亿（临界进位）', () => {
    expect(formatTokens(99_999_999)).toBe('1亿')
    expect(formatTokens(99_994_999)).toBe('9999.5万')
  })

  it('亿级输出「亿」', () => {
    expect(formatTokens(100_000_000)).toBe('1亿')
    expect(formatTokens(123_456_789)).toBe('1.2亿')
  })

  it('可空输入返回 0', () => {
    expect(formatTokens(null)).toBe('0')
    expect(formatTokens(undefined)).toBe('0')
  })

  it('strict 版与非空格式一致', () => {
    expect(formatTokensStrict(12_345)).toBe('1.2万')
    expect(formatTokensStrict(999)).toBe('999')
  })
})