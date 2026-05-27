import { describe, it, expect } from 'vitest'
import { cn } from './cn'

describe('cn', () => {
  it('应该合并单个类名', () => {
    expect(cn('foo')).toBe('foo')
  })

  it('应该合并多个类名', () => {
    expect(cn('foo', 'bar')).toBe('foo bar')
  })

  it('应该过滤假值', () => {
    expect(cn('foo', false, null, undefined, 'bar')).toBe('foo bar')
  })

  it('应该处理条件类名', () => {
    const isActive = true
    const isDisabled = false

    expect(cn('base', isActive && 'active', isDisabled && 'disabled')).toBe('base active')
  })

  it('应该处理对象语法', () => {
    expect(cn({ foo: true, bar: false })).toBe('foo')
  })

  it('应该处理混合语法', () => {
    expect(cn('base', { active: true, disabled: false }, 'extra')).toBe('base active extra')
  })

  it('应该处理空输入', () => {
    expect(cn()).toBe('')
  })

  it('应该处理数组输入', () => {
    expect(cn(['foo', 'bar'])).toBe('foo bar')
  })

  it('应该处理嵌套数组', () => {
    expect(cn(['foo', ['bar', 'baz']])).toBe('foo bar baz')
  })

  it('应该处理重复类名', () => {
    // cn 不会去重，这是 clsx 的行为
    expect(cn('foo', 'foo')).toBe('foo foo')
  })
})
