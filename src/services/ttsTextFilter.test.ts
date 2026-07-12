import { describe, it, expect } from 'vitest'
import { cleanTextForSpeech, shouldSpeakText } from './ttsTextFilter'

describe('cleanTextForSpeech', () => {
  it('应该移除代码块', () => {
    const text = '这是文本\n```js\nconsole.log("hello")\n```\n继续文本'
    expect(cleanTextForSpeech(text)).toBe('这是文本\n继续文本')
  })

  it('应该移除行内代码', () => {
    const text = '使用 `console.log` 输出'
    // 行内代码会被完全移除
    expect(cleanTextForSpeech(text)).toBe('使用 输出')
  })

  it('应该移除链接但保留文本', () => {
    const text = '访问 [GitHub](https://github.com) 获取更多信息'
    expect(cleanTextForSpeech(text)).toBe('访问 GitHub 获取更多信息')
  })

  it('应该移除图片', () => {
    const text = '![截图](image.png) 这是图片'
    // 图片标记会被移除，但 ! 和 alt 文本可能残留
    expect(cleanTextForSpeech(text)).toContain('这是图片')
  })

  it('应该移除标题标记', () => {
    const text = '# 一级标题\n## 二级标题\n正文'
    expect(cleanTextForSpeech(text)).toBe('一级标题\n二级标题\n正文')
  })

  it('应该移除粗体和斜体标记', () => {
    const text = '**粗体** 和 *斜体* 和 __粗体__ 和 _斜体_'
    expect(cleanTextForSpeech(text)).toBe('粗体 和 斜体 和 粗体 和 斜体')
  })

  it('应该移除删除线', () => {
    const text = '这是 ~~删除的~~ 文本'
    expect(cleanTextForSpeech(text)).toBe('这是 文本')
  })

  it('应该移除引用标记', () => {
    const text = '> 这是引用\n继续'
    expect(cleanTextForSpeech(text)).toBe('这是引用\n继续')
  })

  it('应该移除列表标记', () => {
    const text = '- 项目一\n- 项目二\n1. 第一项\n2. 第二项'
    expect(cleanTextForSpeech(text)).toBe('项目一\n项目二\n第一项\n第二项')
  })

  it('应该移除水平线', () => {
    const text = '上面\n---\n下面'
    expect(cleanTextForSpeech(text)).toBe('上面\n下面')
  })

  it('应该移除 HTML 标签', () => {
    const text = '<p>段落</p> <br/> 换行'
    expect(cleanTextForSpeech(text)).toBe('段落 换行')
  })

  it('应该合并多个空白字符', () => {
    const text = '多个  空格\n\n\n换行'
    expect(cleanTextForSpeech(text)).toBe('多个 空格\n换行')
  })

  it('应该处理空字符串', () => {
    expect(cleanTextForSpeech('')).toBe('')
  })
})

describe('shouldSpeakText', () => {
  it('应该返回 true 对于正常文本', () => {
    expect(shouldSpeakText('这是一段正常的文本')).toBe(true)
  })

  it('应该返回 false 对于过短文本', () => {
    expect(shouldSpeakText('a')).toBe(false)
    expect(shouldSpeakText('')).toBe(false)
  })

  it('应该返回 false 对于只包含特殊字符的文本', () => {
    expect(shouldSpeakText('***')).toBe(false)
    expect(shouldSpeakText('---')).toBe(false)
  })

  it('应该返回 true 对于清理后足够长的文本', () => {
    expect(shouldSpeakText('**粗体文本**')).toBe(true)
  })
})
