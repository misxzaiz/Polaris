import { beforeEach, describe, expect, it, vi } from 'vitest'

// create_file 落盘走 @/services/tauri invoke——单测中 mock，验证落盘成功/失败两分支
vi.mock('@/services/tauri', () => ({
  invoke: vi.fn(),
}))

import { invoke } from '@/services/tauri'
import {
  formatContextBlock,
  getKindSpec,
  materializeContextBlocks,
  registerContextBlockKind,
  upsertContextBlock,
} from './contextBlockRegistry'
import { buildCapReferenceBlock, type CapCatalogEntry } from '@/services/capSlashCommand'
import type { ContextBlock } from '@/stores/conversationStore/types'

const ENTRY: CapCatalogEntry = {
  id: 'cap.todo',
  name: '待办',
  summary: '待办事项 CRUD',
  streaming: false,
  describe: { id: 'cap.todo', name: '待办', actions: { list: { params: {}, returns: '{ items }' } } },
}

function marqueeBlock(): ContextBlock {
  return {
    id: 'm1',
    kind: 'marquee-context',
    title: '浏览器圈选 · 示例页',
    source: 'browser-marquee',
    dedupeKey: 'example.com',
    data: { url: 'https://example.com' },
    url: 'https://example.com',
    regions: [{
      id: 1,
      rect: { x: 0, y: 0, width: 200, height: 80 },
      count: 1,
      elements: [{ index: 0, kind: 'button', text: '订阅', rect: { x: 10, y: 10, width: 60, height: 24 }, fillable: false, disabled: false }],
      htmlSnippet: '<div>要点</div>',
      textSnippet: '本周 AI 要点速览',
    }],
  }
}

beforeEach(() => {
  vi.mocked(invoke).mockReset()
})

describe('kind 注册表', () => {
  it('内置 kind 自注册（marquee / cap-help）', () => {
    expect(getKindSpec('marquee-context')?.icon).toBe('🎯')
    expect(getKindSpec('cap-help')?.icon).toBe('⚡')
  })

  it('registerContextBlockKind 覆盖同名注册（用测试 kind，不污染内置）', () => {
    registerContextBlockKind('test-kind-x', { icon: '🧪' })
    expect(getKindSpec('test-kind-x')?.icon).toBe('🧪')
    registerContextBlockKind('test-kind-x', { icon: '⚡' })
    expect(getKindSpec('test-kind-x')?.icon).toBe('⚡')
  })
})

describe('upsertContextBlock', () => {
  it('新块追加到末尾', () => {
    const a = marqueeBlock()
    const cap = buildCapReferenceBlock(ENTRY)
    const next = upsertContextBlock([a], cap)
    expect(next).toHaveLength(2)
    expect(next[1]?.id).toBe(cap.id)
  })

  it('同 source+dedupeKey 原位覆盖（快照刷新语义）', () => {
    const cap1 = buildCapReferenceBlock(ENTRY)
    const cap2 = buildCapReferenceBlock(ENTRY)
    const next = upsertContextBlock([cap1], cap2)
    expect(next).toHaveLength(1)
    expect(next[0]?.id).toBe(cap2.id)
  })

  it('无 dedupeKey 的块不去重、直接追加', () => {
    const plain: ContextBlock = { id: 'x1', kind: 'foo', title: 'X', data: { a: 1 } }
    const next = upsertContextBlock([plain], { ...plain, id: 'x2' })
    expect(next).toHaveLength(2)
  })
})

describe('formatContextBlock（注册表分发 + 降级）', () => {
  it('cap-help detail：describe JSON + 备注', () => {
    const block = { ...buildCapReferenceBlock(ENTRY), userNote: '只看 P0' }
    const text = formatContextBlock(block)
    expect(text).toContain('[cap 协议 · cap.todo（待办）')
    expect(text).toContain('（用户备注：只看 P0）')
    expect(text).toContain('"actions"')
  })

  it('cap-help digest：全量速查', () => {
    const block = buildCapReferenceBlock(undefined, [ENTRY])
    expect(formatContextBlock(block)).toContain('[cap 能力速查 · 1 项')
  })

  it('cap-help 数据缺失返回空串（不参与拼接，不走未知降级）', () => {
    const block: ContextBlock = { id: 'c0', kind: 'cap-help', title: 'cap 能力速查', source: 'cap-slash', data: { mode: 'digest' } }
    expect(formatContextBlock(block)).toBe('')
  })

  it('未注册 kind 降级为 data JSON', () => {
    const block: ContextBlock = { id: 'u1', kind: 'plugin-foo', title: '插件产物', data: { v: 1 } }
    expect(formatContextBlock(block)).toContain('【plugin-foo 上下文】')
    expect(formatContextBlock(block)).toContain('"v": 1')
  })
})

describe('materializeContextBlocks（末尾包含契约）', () => {
  it('空块 → 空串', async () => {
    expect((await materializeContextBlocks([], '/ws')).trailing).toBe('')
  })

  it('有工作区且落盘成功 → 末尾引导句 + @path（不含全文）', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined)
    const { trailing } = await materializeContextBlocks([buildCapReferenceBlock(ENTRY)], '/ws')
    expect(trailing).toContain('以下是随消息附带的引用内容（已保存为上下文文件）')
    expect(trailing).toContain('@.polaris-handoff/tcb-')
    expect(trailing).not.toContain('[随消息附带的引用内容 ·')
    expect(trailing).not.toContain('"actions"')
  })

  it('有工作区但落盘失败 → 降级末尾全文直拼', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('disk full'))
    const { trailing } = await materializeContextBlocks([buildCapReferenceBlock(ENTRY)], '/ws')
    expect(trailing).toContain('[随消息附带的引用内容 · 1 项]')
    expect(trailing).toContain('[cap 协议 · cap.todo（待办）')
  })

  it('无工作区 → 末尾全文直拼', async () => {
    const { trailing } = await materializeContextBlocks([buildCapReferenceBlock(ENTRY)])
    expect(trailing).toContain('[随消息附带的引用内容 · 1 项]')
    expect(trailing).toContain('[cap 协议 · cap.todo（待办）')
  })

  it('多引用按插入序合并（cap 与 marquee 混排不分组）', async () => {
    const { trailing } = await materializeContextBlocks([marqueeBlock(), buildCapReferenceBlock(ENTRY)])
    const marqueeIdx = trailing.indexOf('浏览器圈选')
    const capIdx = trailing.indexOf('[cap 协议')
    expect(marqueeIdx).toBeGreaterThanOrEqual(0)
    expect(capIdx).toBeGreaterThan(marqueeIdx)
  })
})
