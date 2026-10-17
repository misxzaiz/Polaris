/**
 * parseCardData — opencode Code Mode artifact 拆包回归测试
 *
 * 方案：plans/opencode-prd-preview-card-fix.md（A 项）。
 *
 * 背景：Code Mode 下 tool_call_end.result 是 execute 载体工具的 return 值，
 * 无 MCP structuredContent 信封。修复前 { step1_created: artifact } 形态
 * 拿不到 artifact → PrdPreviewCard isPreviewArtifact 失败 → 文本兜底。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/services/dialogStorage', () => ({ dialogStorageService: {} }))
vi.mock('@/services/voiceNotificationService', () => ({ voiceNotificationService: {} }))
vi.mock('./sessionStoreManager', () => ({ sessionStoreManager: {} }))
vi.mock('@/stores/workspaceStore', () => ({ useWorkspaceStore: { getState: () => ({}) } }))
vi.mock('@/stores/cliInfoStore', () => ({
  useCliInfoStore: { getState: () => ({ updateFromInit: () => {} }) },
}))
vi.mock('@/plugin-system/chatCardRegistry', () => ({ chatCardRegistry: { get: () => undefined } }))

import { parseCardData } from './eventHandler'

const artifact = {
  artifactType: 'polaris.preview',
  previewId: 'p1',
  title: '测试预览',
  contentType: 'html',
  html: '<h1>x</h1>',
  createdAt: '2026-10-17T00:00:00Z',
  version: 1,
}
const listResult = { previews: [{ title: '列表无关项' }] }

/** Code Mode 载体 blockInput：execute 的 input.code 内嵌 MCP 调用 */
function codeModeInput(code = 'const r = await tools["polaris-prd-preview"].preview_html({}); return r;') {
  return { code }
}

describe('parseCardData — 结构化信封（simpleai 原生 MCP 路径回归）', () => {
  it('structuredContent 存在时优先返回，且不受 Code Mode 分支影响', () => {
    const result = { content: [{ type: 'text', text: 'ignored' }], structuredContent: artifact }
    expect(parseCardData(result, codeModeInput())).toBe(artifact)
  })

  it('非 Code Mode 输入（无 blockInput）保持旧行为', () => {
    const result = { content: [], structuredContent: artifact }
    expect(parseCardData(result)).toBe(artifact)
  })
})

describe('parseCardData — Code Mode 拆包', () => {
  it('裸 return artifact 本体 → 原样命中', () => {
    expect(parseCardData(artifact, codeModeInput())).toBe(artifact)
  })

  it('字符串化 artifact（execute 返回 JSON 文本）→ 拆出对象', () => {
    const str = JSON.stringify(artifact)
    expect(parseCardData(str, codeModeInput())).toEqual(artifact)
  })

  it('聚合返回 { step1_created: artifact } → 一层成员拆出', () => {
    const result = { step1_created: artifact, note: 'ok' }
    expect(parseCardData(result, codeModeInput())).toBe(artifact)
  })

  it('聚合返回含数组成员 → 数组元素内命中', () => {
    const result = { step1: listResult, created: [artifact] }
    expect(parseCardData(result, codeModeInput())).toBe(artifact)
  })

  it('Promise.allSettled 形态 { status, value: artifact } → .value 拆出', () => {
    const result = { step1: { status: 'fulfilled', value: artifact } }
    expect(parseCardData(result, codeModeInput())).toBe(artifact)
  })

  it('数组顶层返回 [listResult, artifact] → 命中数组元素', () => {
    expect(parseCardData([listResult, artifact], codeModeInput())).toBe(artifact)
  })

  it('无 artifact-like 成员 → 返回原解析结果（不误拆）', () => {
    const result = { step1: listResult, status: 'fulfilled', value: { status: 'fulfilled' } }
    expect(parseCardData(result, codeModeInput())).toBe(result)
  })

  it('blockInput 非 code 载体（普通工具输入）→ 不拆包', () => {
    const result = { step1: artifact }
    expect(parseCardData(result, { command: 'ls', code: 42 })).toBe(result)
    expect(parseCardData(result, { input: 'preview_html(...)', code: 123 })).toBe(result)
  })

  it('html+previewId 双字段识别（artifactType 缺失）也命中 — 与 PrdPreviewCard 口径对齐', () => {
    const untyped = { html: '<b>y</b>', previewId: 'p2' }
    const result = { unwrap: true, step: untyped }
    expect(parseCardData(result, codeModeInput())).toBe(untyped)
  })
})

describe('parseCardData — fenced json 与失败兜底回归', () => {
  it('fenced json 块仍按旧口径解析', () => {
    const str = '前置说明\n```json\n{"html":"<i>z</i>","previewId":"p3"}\n```\n'
    expect(parseCardData(str, codeModeInput())).toEqual({ html: '<i>z</i>', previewId: 'p3' })
  })

  it('不可解析字符串 → 原样返回', () => {
    const str = '普通文本输出'
    expect(parseCardData(str, codeModeInput())).toBe(str)
  })
})
