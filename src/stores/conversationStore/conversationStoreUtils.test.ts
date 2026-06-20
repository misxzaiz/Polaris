import { describe, it, expect, beforeEach } from 'vitest'
import { resolveEffectiveProfileId, hydrateFromLocalStorage } from './conversationStoreUtils'
import { OFFICIAL_API_PROFILE } from '@/types/modelProfile'
import type { ChatMessage } from '@/types/chat'

/**
 * 会话级模型 Profile 的三态解析。
 *
 * 优先级：会话覆盖（SessionMetadata）> 状态栏镜像（sessionConfig）> 全局默认（设置页激活）。
 * 关键修复点：会话级「明确选官方 API」（哨兵）必须优先于全局默认，且哨兵绝不能作为
 * 结果返回（否则会透传后端命中 notFoundRuntime）。
 */
describe('resolveEffectiveProfileId', () => {
  // ===== 会话级覆盖：最高优先级 =====

  it('会话指定具体 Profile 时，优先于状态栏镜像与全局默认', () => {
    expect(
      resolveEffectiveProfileId('profile_session', 'profile_mirror', 'profile_global'),
    ).toBe('profile_session')
  })

  it('【回归】会话明确选官方（哨兵）时返回 undefined，优先于全局默认（不再静默回退）', () => {
    // 旧实现用 || 短路：哨兵前是空值 → 一路回退到 profile_global，造成「答非所选 / 意外费用」。
    expect(
      resolveEffectiveProfileId(OFFICIAL_API_PROFILE, 'profile_mirror', 'profile_global'),
    ).toBeUndefined()
  })

  it('会话明确选官方且无全局默认时返回 undefined', () => {
    expect(resolveEffectiveProfileId(OFFICIAL_API_PROFILE, undefined, undefined)).toBeUndefined()
  })

  it('会话级空串等同于明确选官方，返回 undefined', () => {
    expect(
      resolveEffectiveProfileId('', 'profile_mirror', 'profile_global'),
    ).toBeUndefined()
  })

  // ===== 未设置会话覆盖：向下降级 =====

  it('会话未设置时降级到状态栏镜像', () => {
    expect(
      resolveEffectiveProfileId(undefined, 'profile_mirror', 'profile_global'),
    ).toBe('profile_mirror')
  })

  it('会话未设置、镜像为空串时降级到全局默认', () => {
    expect(resolveEffectiveProfileId(undefined, '', 'profile_global')).toBe('profile_global')
  })

  it('会话未设置、镜像为 undefined 时降级到全局默认', () => {
    expect(
      resolveEffectiveProfileId(undefined, undefined, 'profile_global'),
    ).toBe('profile_global')
  })

  it('三档全空时返回 undefined（走官方端点）', () => {
    expect(resolveEffectiveProfileId(undefined, undefined, undefined)).toBeUndefined()
    expect(resolveEffectiveProfileId(undefined, '', undefined)).toBeUndefined()
  })

  // ===== 健壮性：哨兵绝不透传后端 =====

  it('哨兵即便误入镜像 / 全局档也绝不作为结果返回', () => {
    expect(
      resolveEffectiveProfileId(undefined, OFFICIAL_API_PROFILE, undefined),
    ).toBeUndefined()
    expect(
      resolveEffectiveProfileId(undefined, undefined, OFFICIAL_API_PROFILE),
    ).toBeUndefined()
  })
})

/**
 * hydrateFromLocalStorage 解析缓存
 *
 * 该函数是压缩消息的二级降级恢复路径（MessageCompactor 内存快照被 LRU 淘汰后
 * 走这里）。长会话快速滚动时被频繁触发，旧实现每次都 JSON.parse 整段历史
 * （最多 50 会话完整消息，数十 MB），阻塞主线程。缓存以 raw 字符串值相等为
 * 失效条件，同一 raw 下只 parse 一次。
 */
const HISTORY_KEY = 'event_chat_session_history'

function makeUser(id: string, content = 'hello'): ChatMessage {
  return {
    id,
    type: 'user',
    timestamp: '2026-01-01T00:00:00.000Z',
    content,
  } as ChatMessage
}

function writeHistory(entries: Array<{ id: string; messages: ChatMessage[] }>) {
  localStorage.setItem(
    HISTORY_KEY,
    JSON.stringify(
      entries.map((e) => ({
        id: e.id,
        title: e.id,
        timestamp: '2026-01-01T00:00:00.000Z',
        messageCount: e.messages.length,
        engineId: 'claude-code',
        data: { messages: e.messages },
      })),
    ),
  )
}

describe('hydrateFromLocalStorage 缓存', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('同一 raw 下多次调用返回同一引用（命中缓存，不重复 parse）', () => {
    writeHistory([{ id: 'conv-1', messages: [makeUser('m1', 'original')] }])

    const a = hydrateFromLocalStorage('conv-1', 'm1')
    const b = hydrateFromLocalStorage('conv-1', 'm1')

    expect(a).not.toBeNull()
    // 旧实现每次重新 JSON.parse 产生新对象，引用不同；
    // 缓存命中时复用同一解析结果，引用必须一致。
    expect(b).toBe(a)
  })

  it('raw 变化后自动失效重建，返回新内容', () => {
    writeHistory([{ id: 'conv-1', messages: [makeUser('m1', 'v1')] }])
    expect(hydrateFromLocalStorage('conv-1', 'm1')).not.toBeNull()

    // 模拟 historyService.saveToHistory 写入新历史（raw 改变）
    writeHistory([{ id: 'conv-1', messages: [makeUser('m1', 'v2'), makeUser('m2', 'new')] }])

    const after = hydrateFromLocalStorage('conv-1', 'm2')
    expect(after).not.toBeNull()
    // 新写入的消息可被检索到，证明缓存已重建
    expect((after as { content: string }).content).toBe('new')
  })

  it('跨会话查找：不同 conversationId 互不干扰', () => {
    writeHistory([
      { id: 'conv-1', messages: [makeUser('shared', 'in-conv-1')] },
      { id: 'conv-2', messages: [makeUser('shared', 'in-conv-2')] },
    ])

    const a = hydrateFromLocalStorage('conv-1', 'shared')
    const b = hydrateFromLocalStorage('conv-2', 'shared')

    expect((a as { content: string }).content).toBe('in-conv-1')
    expect((b as { content: string }).content).toBe('in-conv-2')
    expect(a).not.toBe(b)
  })

  it('不存在的消息 / 会话返回 null，不抛错', () => {
    writeHistory([{ id: 'conv-1', messages: [makeUser('m1')] }])
    expect(hydrateFromLocalStorage('conv-1', 'nope')).toBeNull()
    expect(hydrateFromLocalStorage('unknown', 'm1')).toBeNull()
    expect(hydrateFromLocalStorage(null, 'm1')).toBeNull()
  })

  it('空历史 / 损坏 JSON 优雅降级，且后续正常写入可恢复', () => {
    expect(hydrateFromLocalStorage('conv-1', 'm1')).toBeNull()

    localStorage.setItem(HISTORY_KEY, '{not valid json')
    expect(hydrateFromLocalStorage('conv-1', 'm1')).toBeNull()

    // 损坏后写入正常历史，缓存应从「损坏态」重建为正常态
    writeHistory([{ id: 'conv-1', messages: [makeUser('m1', 'recovered')] }])
    expect((hydrateFromLocalStorage('conv-1', 'm1') as { content: string }).content).toBe('recovered')
  })
})
