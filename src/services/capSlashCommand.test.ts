import { describe, expect, it } from 'vitest'
import {
  buildCapDetailBlock,
  buildCapDigestBlock,
  matchCaps,
  parseCapSlashCommand,
  type CapCatalogEntry,
} from './capSlashCommand'

const CAPS: CapCatalogEntry[] = [
  {
    id: 'cap.todo',
    name: '待办',
    summary: '待办事项 CRUD',
    streaming: false,
    describe: { id: 'cap.todo', name: '待办', summary: '待办事项 CRUD', actions: {} },
  },
  {
    id: 'cap.ui.theme',
    name: '主题控制',
    summary: '界面主题配色',
    streaming: false,
    describe: null,
  },
  {
    id: 'cap.stream.echo',
    name: '流式回显',
    summary: 'WS 流式骨架',
    streaming: true,
    describe: { id: 'cap.stream.echo', name: '流式回显', actions: {} },
  },
]

describe('parseCapSlashCommand', () => {
  it('非 /cap 开头返回 null', () => {
    expect(parseCapSlashCommand('hello /cap')).toBeNull()
    expect(parseCapSlashCommand('/caps x')).toBeNull()
  })

  it('裸 /cap（含前后空白）', () => {
    expect(parseCapSlashCommand('/cap')).toEqual({ rest: '', firstToken: '', remainder: '' })
    expect(parseCapSlashCommand('  /cap  ')).toEqual({ rest: '', firstToken: '', remainder: '' })
  })

  it('/cap 待办 建三个任务 → 查询与正文分离', () => {
    expect(parseCapSlashCommand('/cap 待办 建三个任务')).toEqual({
      rest: '待办 建三个任务',
      firstToken: '待办',
      remainder: '建三个任务',
    })
  })

  it('/cap 多 token 查询不命中时整体留作正文', () => {
    expect(parseCapSlashCommand('/cap 帮我建待办')).toEqual({
      rest: '帮我建待办',
      firstToken: '帮我建待办',
      remainder: '',
    })
  })
})

describe('matchCaps', () => {
  it('空查询返回全量', () => {
    expect(matchCaps(CAPS, '')).toHaveLength(3)
  })

  it('中文短名精确命中', () => {
    expect(matchCaps(CAPS, '待办').map((c) => c.id)).toEqual(['cap.todo'])
  })

  it('id 后缀命中（ui.theme）', () => {
    expect(matchCaps(CAPS, 'ui.theme').map((c) => c.id)).toEqual(['cap.ui.theme'])
  })

  it('id 精确优先于子串', () => {
    // cap.todo 是 cap.stream.echo summary（无）… 构造：id 精确命中 cap.todo，
    // 同时 'todo' 也是其子串——精确分应让它排第一且唯一4分
    const hits = matchCaps(CAPS, 'cap.todo')
    expect(hits[0]?.id).toBe('cap.todo')
    expect(hits).toHaveLength(1)
  })

  it('无命中返回空', () => {
    expect(matchCaps(CAPS, '不存在')).toEqual([])
  })
})

describe('注入块', () => {
  it('速查块含 id、中文名与流式标注', () => {
    const block = buildCapDigestBlock(CAPS)
    expect(block).toContain('[cap 能力速查 · 3 项')
    expect(block).toContain('- cap.todo（待办）：待办事项 CRUD')
    expect(block).toContain('cap.stream.echo（流式回显）（流式，同步 cap_dispatch 不可调）')
  })

  it('详情块含 describe JSON；无 describe 时给 cap_list 指引', () => {
    const detail = buildCapDetailBlock(CAPS[0]!)
    expect(detail).toContain('[cap 协议 · cap.todo（待办）')
    expect(detail).toContain('"actions"')
    const noDescribe = buildCapDetailBlock(CAPS[1]!)
    expect(noDescribe).toContain('cap_list 实时查询')
  })
})
