/**
 * chatCardRegistry.resolve — opencode Code Mode 卡片匹配回归测试
 *
 * 背景（plans/opencode-code-mode-chatcard-adaptation.md）：
 * Claude Code 等引擎把 MCP 调用暴露为原生工具（mcp__server__tool），按名直查注册表；
 * opencode Code Mode 里 MCP 调用包在 execute 载体工具内（tools["server"].tool(...)），
 * 必须从 block.input.code 提取内嵌调用再按完整名匹配，否则交互面板等 result 卡不渲染。
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
  register('polaris-interactive', ['preview_html', 'read_preview'])
})

describe('resolveWithKey — 命中 key 导出（宿主 load 依赖）', () => {
  it('原生工具名 → key = toolName 本身', () => {
    const r = chatCardRegistry.resolveWithKey('mcp__polaris-interactive__preview_html', {})
    expect(r?.key).toBe('mcp__polaris-interactive__preview_html')
  })

  it('execute 载体 → key 为解析出的完整名（存入 PluginCardBlock.cardKey）', () => {
    const code = 'return await tools["polaris-interactive"].preview_html({});'
    const r = chatCardRegistry.resolveWithKey('execute', { code })
    expect(r?.key).toBe('mcp__polaris-interactive__preview_html')

    chatCardRegistry.unregisterAll('test-plugin')
    const miss = chatCardRegistry.resolveWithKey('execute', { code })
    expect(miss).toBeUndefined()
  })
})

describe('resolve — 原生 MCP 工具名直查（现状不变）', () => {
  it('完整名直接命中', () => {
    const entry = chatCardRegistry.resolve('mcp__polaris-interactive__preview_html', {})
    expect(entry?.mcpServerId).toBe('polaris-interactive')
  })

  it('未注册工具名 → undefined', () => {
    expect(chatCardRegistry.resolve('mcp__polaris-interactive__list_previews', {})).toBeUndefined()
    expect(chatCardRegistry.resolve('bash', {})).toBeUndefined()
  })
})

describe('resolve — opencode execute 载体从 code 提取内嵌调用', () => {
  it('单次调用 → 命中对应卡片', () => {
    const code = `const r = await tools["polaris-interactive"].preview_html({ html: "<h1>x</h1>" });
return r;`
    const entry = chatCardRegistry.resolve('execute', { code })
    expect(entry?.mcpServerId).toBe('polaris-interactive')
  })

  it('载体名为 xecute 同样支持', () => {
    const code = 'return await tools["polaris-interactive"].read_preview({ previewId: "p1" });'
    const entry = chatCardRegistry.resolve('xecute', { code })
    expect(entry?.mcpServerId).toBe('polaris-interactive')
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
    register('example-agnes', ['query_video'])
    const code = `await tools["example-agnes"].query_video({ videoId: "v" });
return await tools["polaris-interactive"].read_preview({ previewId: "p1" });`
    const entry = chatCardRegistry.resolve('execute', { code })
    expect(entry).toBeDefined()
    expect(buildMcpToolName(entry!.mcpServerId, 'read_preview')).toBe('mcp__polaris-interactive__read_preview')
  })

  it('多命中且 return 无对齐 → 首个命中兜底', () => {
    register('example-agnes', ['query_video'])
    const code = `const a = await tools["example-agnes"].query_video({});
const b = await tools["polaris-interactive"].read_preview({});`
    expect(chatCardRegistry.resolve('execute', { code })?.mcpServerId).toBe('example-agnes')
  })
})

describe('matchBlock / blockToCardKey — 内容块覆盖渲染（spec chat-block-renderer-registry）', () => {
  beforeEach(() => {
    chatCardRegistry.unregisterAll('test-plugin')
  })

  it('matchBy=block 注册 → block:{type} key 命中', () => {
    chatCardRegistry.register('test-plugin', {
      id: 'question-card',
      matchBy: 'block',
      blockTypes: ['question'],
      tools: [],
      mode: 'interaction',
    })
    const q = { type: 'question', id: 'q1', question: 'x', questions: [] } as any
    expect(chatCardRegistry.blockToCardKey(q)).toBe('block:question')
    expect(chatCardRegistry.matchBlock(q)?.cardId).toBe('question-card')
  })

  it('matchBy=tool 注册 → tool:{name} key 命中', () => {
    chatCardRegistry.register('test-plugin', {
      id: 'bash-card',
      matchBy: 'tool',
      toolNames: ['Bash'],
      tools: [],
      mode: 'result',
    })
    const b = { type: 'tool_call', id: 't1', name: 'Bash', input: {}, status: 'completed', startedAt: '' } as any
    expect(chatCardRegistry.blockToCardKey(b)).toBe('tool:Bash')
    expect(chatCardRegistry.matchBlock(b)?.cardId).toBe('bash-card')
  })

  it('tool_call 精确名未命中 → 回退 block:tool_call 兜底 key', () => {
    chatCardRegistry.register('test-plugin', {
      id: 'fallback-tool',
      matchBy: 'block',
      blockTypes: ['tool_call'],
      tools: [],
      mode: 'result',
    })
    const b = { type: 'tool_call', id: 't1', name: 'Grep', input: {}, status: 'completed', startedAt: '' } as any
    expect(chatCardRegistry.matchBlock(b)?.cardId).toBe('fallback-tool')
  })

  it('未注册类型 → undefined（宿主默认兜底）', () => {
    const t = { type: 'thinking', id: 'th1', content: 'x' } as any
    expect(chatCardRegistry.matchBlock(t)).toBeUndefined()
    const f = { type: 'form', id: 'f1', fields: [] } as any
    expect(chatCardRegistry.matchBlock(f)).toBeUndefined()
  })

  it('plugin_card 不参与 matchBlock（走 PluginCardHost 既有路径）', () => {
    const p = { type: 'plugin_card', id: 'p1', pluginId: 'x', cardId: 'c', toolName: 'mcp__a__b', mode: 'result', status: 'ready', data: null, createdAt: '' } as any
    expect(chatCardRegistry.blockToCardKey(p)).toBe('block:plugin_card')
    expect(chatCardRegistry.matchBlock(p)).toBeUndefined()
  })
})

describe('resolveBlockCard — key 与 entry 一致性（宿主 load 不空转）', () => {
  beforeEach(() => {
    chatCardRegistry.unregisterAll('test-plugin')
  })

  it('tool_call 精确名命中 → key = tool:{name}', () => {
    chatCardRegistry.register('test-plugin', {
      id: 'bash-card', matchBy: 'tool', toolNames: ['Bash'], tools: [], mode: 'result',
    })
    const b = { type: 'tool_call', id: 't1', name: 'Bash', input: {}, status: 'completed', startedAt: '' } as any
    const r = chatCardRegistry.resolveBlockCard(b)
    expect(r?.key).toBe('tool:Bash')
    expect(r?.entry.cardId).toBe('bash-card')
  })

  it('tool_call 精确名未命中 → 兜底 key = block:tool_call（与 entry 一致）', () => {
    chatCardRegistry.register('test-plugin', {
      id: 'fallback', matchBy: 'block', blockTypes: ['tool_call'], tools: [], mode: 'result',
    })
    const b = { type: 'tool_call', id: 't1', name: 'Grep', input: {}, status: 'completed', startedAt: '' } as any
    const r = chatCardRegistry.resolveBlockCard(b)
    expect(r?.key).toBe('block:tool_call')
    expect(r?.entry.cardId).toBe('fallback')
  })

  it('未注册 → undefined（宿主默认）', () => {
    const f = { type: 'form', id: 'f1', fields: [] } as any
    expect(chatCardRegistry.resolveBlockCard(f)).toBeUndefined()
  })
})
