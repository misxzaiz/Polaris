/**
 * gitNlQuery 单元测试（AI-6 v0：NL → searchLog filter 编译器，无 LLM）
 *
 * 规格即测试：同输入恒同输出；编不出 → 整句 grep fixedStrings。
 */

import { describe, it, expect } from 'vitest'
import { compileGitQuery } from './gitNlQuery'

describe('compileGitQuery', () => {
  it('空串 → 空 filter（无副作用）', () => {
    expect(compileGitQuery('')).toEqual({ filter: {}, hints: [] })
    expect(compileGitQuery('   ')).toEqual({ filter: {}, hints: [] })
  })

  it('纯文本 → 整句 grep fixedStrings（行为不比旧路径差）', () => {
    const { filter, hints } = compileGitQuery('fix login bug')
    expect(filter).toEqual({ grep: 'fix login bug', fixedStrings: true })
    expect(hints).toEqual(['grep'])
  })

  it('显式键 author:/path:/pickaxe:/since: 全编译', () => {
    const { filter, hints } = compileGitQuery('author:alice path:src/main.ts pickaxe:hooks since:3 days ago')
    expect(filter.author).toBe('alice')
    expect(filter.path).toBe('src/main.ts')
    expect(filter.pickaxe).toBe('hooks')
    expect(filter.since).toContain('days ago')
    for (const h of ['author', 'path', 'pickaxe', 'since']) {
      expect(hints).toContain(h)
    }
  })

  it('双引号短语 → grep fixedStrings；其余文本继续编译', () => {
    const { filter } = compileGitQuery('"sign in flow" 上周')
    expect(filter.grep).toBe('sign in flow')
    expect(filter.fixedStrings).toBe(true)
    expect(filter.since).toBe('2 weeks ago')
  })

  it('中文作者「作者张三」→ author', () => {
    const { filter, hints } = compileGitQuery('作者张三 提交的重构')
    expect(filter.author).toBe('张三')
    expect(hints).toContain('author')
    expect(filter.grep).toContain('提交的重构')
  })

  it('英文 by 短语 → author', () => {
    const { filter } = compileGitQuery('by alice refactor')
    expect(filter.author).toBe('alice')
  })

  it('中文相对时间：上周/N天前 → since', () => {
    expect(compileGitQuery('登录 上周').filter.since).toBe('2 weeks ago')
    expect(compileGitQuery('登录 3天前').filter.since).toBe('3 days ago')
    expect(compileGitQuery('登录 2周前').filter.since).toBe('2 weeks ago')
    expect(compileGitQuery('配置 6个月前').filter.since).toBe('6 months ago')
    expect(compileGitQuery('登录 昨天').filter.since).toBe('2 days ago')
  })

  it('路径词（含 / 或扩展名）→ path，不污染 grep', () => {
    const { filter, hints } = compileGitQuery('重构 src/hooks 目录')
    expect(hints).toContain('path')
    expect(filter.path).toBe('src/hooks')
  })

  it('组合：作者+时间+文本全命中', () => {
    const { filter } = compileGitQuery('作者张三 上周 缓存')
    expect(filter.author).toBe('张三')
    expect(filter.since).toBe('2 weeks ago')
    // 余句仍兜底 grep
    expect(filter.fixedStrings).toBe(true)
    expect(String(filter.grep).length).toBeGreaterThan(0)
  })

  it('since: 显式键含空格短语（"2 weeks ago"）', () => {
    const { filter } = compileGitQuery('bug since:2 weeks ago')
    expect(filter.since).toBe('2 weeks ago')
  })
})
