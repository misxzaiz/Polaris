import { describe, it, expect } from 'vitest'
import { resolveImageDataUrl } from './image'

/**
 * 图像数据 → 可渲染地址 的解析。
 * 关键修复：仅返回 b64_json（裸 base64）的图像模型，必须包装为 data URL，
 * 否则 <img src> 无法渲染（内联图像裂图）。
 */
describe('resolveImageDataUrl', () => {
  it('优先返回 url', () => {
    expect(resolveImageDataUrl({ url: 'https://cdn.example.com/a.png' })).toBe(
      'https://cdn.example.com/a.png',
    )
  })

  it('url 与 b64_json 同时存在时优先 url', () => {
    expect(resolveImageDataUrl({ url: 'https://x/a.png', b64_json: 'AAAA' })).toBe(
      'https://x/a.png',
    )
  })

  it('【回归】仅 b64_json 时包装为 data URL（裸 base64 不能直接当 img src）', () => {
    expect(resolveImageDataUrl({ b64_json: 'iVBORw0KGgo=' })).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    )
  })

  it('两者皆无时返回 undefined', () => {
    expect(resolveImageDataUrl({})).toBeUndefined()
  })

  it('url 为空串时回退到 b64_json（空串不应被当作有效地址）', () => {
    expect(resolveImageDataUrl({ url: '', b64_json: 'AAAA' })).toBe('data:image/png;base64,AAAA')
  })
})
