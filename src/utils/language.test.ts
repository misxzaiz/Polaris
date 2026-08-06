import { describe, it, expect } from 'vitest'
import { getLanguageFromPath, isHighlightableLanguage } from './language'

describe('getLanguageFromPath', () => {
  it('returns plaintext for normal unknown extension', () => {
    expect(getLanguageFromPath('foo.unknownext')).toBe('plaintext')
  })

  it('maps known extensions', () => {
    expect(getLanguageFromPath('src/App.tsx')).toBe('javascript')
    expect(getLanguageFromPath('main.py')).toBe('python')
    expect(getLanguageFromPath('Cargo.toml')).toBe('plaintext')
  })

  it('returns plaintext for undefined / null / empty (compactor 压缩后 input 置空场景)', () => {
    // MessageCompactor 把 ToolCallBlock.input 设为 {}，调用方传入的 filePath 可能为 undefined。
    // 此前会触发 `Cannot read properties of undefined (reading 'split')`（scroll 重渲染路径）。
    expect(getLanguageFromPath(undefined)).toBe('plaintext')
    expect(getLanguageFromPath(null)).toBe('plaintext')
    expect(getLanguageFromPath('')).toBe('plaintext')
  })

  it('isHighlightableLanguage handles plaintext', () => {
    expect(isHighlightableLanguage('plaintext')).toBe(false)
    expect(isHighlightableLanguage('python')).toBe(true)
  })
})
