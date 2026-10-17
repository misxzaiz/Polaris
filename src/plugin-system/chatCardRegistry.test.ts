/**
 * chatCardRegistry.resolve — opencode Code Mode 卡片匹配回归测试
 *
 * 背景（plans/opencode-code-mode-chatcard-adaptation.md）：
 * Claude Code 等引擎把 MCP 调用暴露为原生工具（mcp__server__tool），按名直查注册表；
 * opencode Code Mode 里 MCP 调用包在 execute 载体工具内（tools["server"].tool(...)），
 * 必须从 block.input.code 提取内嵌调用再按完整名匹配，否则 PRD 预览等 result 卡不渲染。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { chatCardRegistry } from './chatCardRegistry'
import { buildMcpToolName } from '@/utils/toolConfig'

function register(server: string, tools: string[]) {
  chatCardRegistry.register('test-plugin', {
    id: 'card-1',
    mcpServerId: server,
    tools,
    mode: 'result',
  })
}

beforeEach(() => {
  chatCardRegistry.unregisterAll('test-plugin')
  register('polaris-prd-preview', ['preview_html', 'read_preview'])
})

describe('resolveWithKey — 命中 key 导出（宿主 load 依赖）', () => {
  it('原生工具名 → key = toolName 本身', () => {
    const r = chatCardRegistry.resolveWithKey('mcp__polaris-prd-preview__preview_html', {})
    expect(r?.key).toBe('mcp__polaris-prd-preview__preview_html')
  })

  it('execute 载体 → key 为解析出的完整名（存入 PluginCardBlock.cardKey）', () => {
    const code = 'return await tools["polaris-prd-preview"].preview_html({});'
    const r = chatCardRegistry.resolveWithKey('execute', { code })
    expect(r?.key).toBe('mcp__polaris-prd-preview__preview_html')

    chatCardRegistry.unregisterAll('test-plugin')
    const miss = chatCardRegistry.resolveWithKey('execute', { code })
    expect(miss).toBeUndefined()
  })
})

describe('resolve — 原生 MCP 工具名直查（现状不变）', () => {
  it('完整名直接命中', () => {
    const entry = chatCardRegistry.resolve('mcp__polaris-prd-preview__preview_html', {})
    expect(entry?.mcpServerId).toBe('polaris-prd-preview')
  })

  it('未注册工具名 → undefined', () => {
    expect(chatCardRegistry.resolve('mcp__polaris-prd-preview__list_previews', {})).toBeUndefined()
    expect(chatCardRegistry.resolve('bash', {})).toBeUndefined()
  })
})

describe('resolve — opencode execute 载体从 code 提取内嵌调用', () => {
  it('单次调用 → 命中对应卡片', () => {
    const code = `const r = await tools["polaris-prd-preview"].preview_html({ html: "<h1>x</h1>" });
return r;`
    const entry = chatCardRegistry.resolve('execute', { code })
    expect(entry?.mcpServerId).toBe('polaris-prd-preview')
  })

  it('载体名为 xecute 同样支持', () => {
    const code = 'return await tools["polaris-prd-preview"].read_preview({ previewId: "p1" });'
    const entry = chatCardRegistry.resolve('xecute', { code })
    expect(entry?.mcpServerId).toBe('polaris-prd-preview')
  })

  it('code 缺失 / 非字符串 / 无 MCP 调用 → undefined', () => {
    expect(chatCardRegistry.resolve('execute', {})).toBeUndefined()
    expect(chatCardRegistry.resolve('execute', { code: 42 })).toBeUndefined()
    expect(chatCardRegistry.resolve('execute', { code: 'const x = 1; return x;' })).toBeUndefined()
  })

  it('内嵌调用的 server 未注册卡片 → 不误命中', () => {
    const code = 'return await tools["opencode"].session_create({});'
    expect(chatCardRegistry.resolve('execute', { code })).toBeUndefined()
  })

  it('多命中时优先 return 语句所指调用（execute 返回值与其卡片 data 同源）', () => {
    register('polaris-agnes', ['query_video'])
    const code = `await tools["polaris-agnes"].query_video({ videoId: "v" });
return await tools["polaris-prd-preview"].read_preview({ previewId: "p1" });`
    const entry = chatCardRegistry.resolve('execute', { code })
    expect(entry).toBeDefined()
    expect(buildMcpToolName(entry!.mcpServerId, 'read_preview')).toBe('mcp__polaris-prd-preview__read_preview')
  })

  it('多命中且 return 无对齐 → 首个命中兜底', () => {
    register('polaris-agnes', ['query_video'])
    const code = `const a = await tools["polaris-agnes"].query_video({});
const b = await tools["polaris-prd-preview"].read_preview({});`
    expect(chatCardRegistry.resolve('execute', { code })?.mcpServerId).toBe('polaris-agnes')
  })
})
