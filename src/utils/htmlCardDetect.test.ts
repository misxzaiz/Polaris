/**
 * HTML 卡片检测层 —— 单测
 *
 * 覆盖 spec 4.1 / 4.2 中检测相关用例：
 * - 完整 / 非完整 / 纯文字 / 围栏包裹 / 特殊字符转义不误判
 */
import { describe, it, expect } from 'vitest'
import {
  isCompleteHtmlDoc,
  isHtmlOpening,
  extractHtmlCandidate,
  stripFence,
  guessTitle,
  splitAroundHtml,
  findLastTextBlockIndex,
} from './htmlCardDetect'

describe('isCompleteHtmlDoc', () => {
  it('识别带 doctype 的完整 HTML', () => {
    expect(isCompleteHtmlDoc('<!doctype html><html><body>hi</body></html>')).toBe(true)
  })
  it('识别无 doctype 的完整 HTML', () => {
    expect(isCompleteHtmlDoc('<html><body>hi</body></html>')).toBe(true)
  })
  it('允许开头前有空白', () => {
    expect(isCompleteHtmlDoc('  \n  <html></html>   ')).toBe(true)
  })
  it('未闭合的 HTML 不是完整文档', () => {
    expect(isCompleteHtmlDoc('<html><body>hi')).toBe(false)
    expect(isCompleteHtmlDoc('<html><body>hi</body></html>')).toBe(true)
  })
  it('纯文字不误判', () => {
    expect(isCompleteHtmlDoc('你好，这是一段纯文字')).toBe(false)
    expect(isCompleteHtmlDoc('打个招呼line2')).toBe(false)
  })
  it('含 <br> / <script> 字样但非文档不误判', () => {
    expect(isCompleteHtmlDoc('a<br>b')).toBe(false)
    expect(isCompleteHtmlDoc('const script = "<html>"')).toBe(false)
  })
  it('普通文本以 </html> 结尾但不以 <html> 开头不误判', () => {
    expect(isCompleteHtmlDoc('some text </html>')).toBe(false)
  })
  it('大小写不敏感', () => {
    expect(isCompleteHtmlDoc('<HTML><BODY></BODY></HTML>')).toBe(true)
    expect(isCompleteHtmlDoc('<!DOCTYPE HTML><html></html>')).toBe(true)
  })
})

describe('isHtmlOpening', () => {
  it('流式中命中开头即 true（即使未闭合）', () => {
    expect(isHtmlOpening('<html><div>部分</html')).toBe(true)
    expect(isHtmlOpening('<!doctype html>')).toBe(true)
  })
  it('非开头不误判', () => {
    expect(isHtmlOpening('前方文字 <html>')).toBe(false)
    expect(isHtmlOpening('普通文本')).toBe(false)
  })
})

describe('extractHtmlCandidate', () => {
  it('围栏包裹的完整 HTML 优先提取', () => {
    const text = '要做一个看板\n```html\n<html><body><h1>hi</h1></body></html>\n```\n以上就是。'
    expect(extractHtmlCandidate(text)).toBe('<html><body><h1>hi</h1></body></html>')
  })
  it('整体是完整 HTML 时直接返回', () => {
    expect(extractHtmlCandidate('<html><body>x</body></html>')).toBe('<html><body>x</body></html>')
  })
  it('无完整 HTML 返回 null', () => {
    expect(extractHtmlCandidate('普通回复')).toBe(null)
    expect(extractHtmlCandidate('<html>未闭合')).toBe(null)
  })
  it('```html 与 ``` 两种围栏都支持', () => {
    const t1 = '```html\n<html></html>\n```'
    const t2 = '```\n<html></html>\n```'
    expect(extractHtmlCandidate(t1)).toBe('<html></html>')
    expect(extractHtmlCandidate(t2)).toBe('<html></html>')
  })
  it('围栏内非完整 HTML 不误提取', () => {
    const text = '```html\n<html>没闭合\n```'
    expect(extractHtmlCandidate(text)).toBe(null)
  })
})

describe('stripFence', () => {
  it('剥离未闭合的 ```html 前缀', () => {
    expect(stripFence('```html\n<html>')).toBe('<html>')
    expect(stripFence('```\n<html>')).toBe('<html>')
  })
  it('无围栏时原样返回', () => {
    expect(stripFence('<html>')).toBe('<html>')
  })
})

describe('guessTitle', () => {
  it('提取 <title> 内容', () => {
    expect(guessTitle('<html><head><title>收听周报</title></head></html>')).toBe('收听周报')
  })
  it('缺省标题', () => {
    expect(guessTitle('<html><body></body></html>')).toBe('HTML 卡片')
  })
  it('title 带属性也提取', () => {
    expect(guessTitle('<html><head><title lang="zh">卡</title></head></html>')).toBe('卡')
  })
})

describe('splitAroundHtml', () => {
  it('围栏前文字作为 before，围栏后文字作为 after', () => {
    const text = '先给一句\n```html\n<html><b>x</b></html>\n```\n结尾一句'
    const r = splitAroundHtml(text)
    expect(r.before).toBe('先给一句\n')
    expect(r.html).toBe('<html><b>x</b></html>')
    expect(r.after).toBe('\n结尾一句')
  })
  it('整体就是文档时 before/after 为空', () => {
    const r = splitAroundHtml('<html></html>')
    expect(r.before).toBe('')
    expect(r.html).toBe('<html></html>')
    expect(r.after).toBe('')
  })
  it('无文档时 html 为 null', () => {
    const r = splitAroundHtml('纯文字')
    expect(r).toEqual({ before: '', html: null, after: '' })
  })
})

describe('findLastTextBlockIndex', () => {
  it('返回最后一段非空 text 块的 index', () => {
    const blocks = [
      { type: 'thinking', content: '思考' },
      { type: 'text', content: '先说话 ' },
      { type: 'text', content: '<html>x</html>' },
    ]
    expect(findLastTextBlockIndex(blocks)).toBe(2)
  })
  it('跳过空 text 块', () => {
    const blocks = [
      { type: 'text', content: '  ' },
      { type: 'tool_call', name: 'x' },
      { type: 'text', content: 'x' },
    ]
    expect(findLastTextBlockIndex(blocks)).toBe(2)
  })
  it('无 text 块返回 -1', () => {
    const blocks = [{ type: 'tool_call', name: 'x' }, { type: 'thinking', content: 't' }]
    expect(findLastTextBlockIndex(blocks)).toBe(-1)
  })
})