/**
 * SessionStore 多会话隔离性测试
 *
 * 测试核心场景：
 * 1. 多会话创建不互相影响
 * 2. 会话切换正确更改 activeSessionId
 * 3. 会话消息隔离
 * 4. 工作区切换不影响其他会话
 * 5. 删除会话的清理逻辑
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock localStorage before importing the store
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key]
    }),
    clear: vi.fn(() => {
      store = {}
    }),
  }
})()

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
})

// Import after mocking
import { useSessionStore, getSessionEffectiveWorkspace } from './index'
import type { SessionMessageState } from '@/types/session'

describe('SessionStore 多会话隔离性', () => {
  beforeEach(() => {
    // Clear localStorage and reset store before each test
    localStorageMock.clear()
    vi.clearAllMocks()

    // Reset the store to initial state
    useSessionStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      recentSessionIds: [],
      isIslandExpanded: false,
      islandExpandMode: null,
      sessionMessages: new Map(),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('会话创建独立性', () => {
    it('创建多个会话时，每个会话应独立存在', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-1' })
      const id2 = useSessionStore.getState().createSession({ type: 'free' })
      const id3 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-2', title: '自定义标题' })

      const store = useSessionStore.getState()

      // 验证三个会话都存在
      expect(store.sessions.size).toBe(3)
      expect(store.sessions.has(id1)).toBe(true)
      expect(store.sessions.has(id2)).toBe(true)
      expect(store.sessions.has(id3)).toBe(true)

      // 验证每个会话的属性独立
      const session1 = store.sessions.get(id1)!
      const session2 = store.sessions.get(id2)!
      const session3 = store.sessions.get(id3)!

      expect(session1.type).toBe('project')
      expect(session1.workspaceId).toBe('ws-1')
      expect(session1.temporaryWorkspaceId).toBeNull()

      expect(session2.type).toBe('free')
      expect(session2.workspaceId).toBeNull()

      expect(session3.type).toBe('project')
      expect(session3.workspaceId).toBe('ws-2')
      expect(session3.title).toBe('自定义标题')
    })

    it('创建会话时应同时创建独立的消息状态', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-1' })
      const id2 = useSessionStore.getState().createSession({ type: 'free' })

      const store = useSessionStore.getState()

      // 验证消息状态独立创建
      expect(store.sessionMessages.has(id1)).toBe(true)
      expect(store.sessionMessages.has(id2)).toBe(true)

      const msgState1 = store.sessionMessages.get(id1)!
      const msgState2 = store.sessionMessages.get(id2)!

      // 验证初始状态
      expect(msgState1.messages).toEqual([])
      expect(msgState1.archivedMessages).toEqual([])
      expect(msgState1.conversationId).toBeNull()

      expect(msgState2.messages).toEqual([])
      expect(msgState2.archivedMessages).toEqual([])
      expect(msgState2.conversationId).toBeNull()
    })

    it('最新创建的会话应成为活跃会话', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-1' })
      expect(useSessionStore.getState().activeSessionId).toBe(id1)

      const id2 = useSessionStore.getState().createSession({ type: 'free' })
      expect(useSessionStore.getState().activeSessionId).toBe(id2)

      // 验证 getActiveSession 返回正确的会话
      const activeSession = useSessionStore.getState().getActiveSession()
      expect(activeSession?.id).toBe(id2)
    })
  })

  describe('会话切换隔离性', () => {
    it('切换会话应正确更新活跃会话 ID', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-1' })
      const id2 = useSessionStore.getState().createSession({ type: 'free' })

      // 当前活跃是 id2
      expect(useSessionStore.getState().activeSessionId).toBe(id2)

      // 切换到 id1
      useSessionStore.getState().switchSession(id1)
      expect(useSessionStore.getState().activeSessionId).toBe(id1)

      // 切换回 id2
      useSessionStore.getState().switchSession(id2)
      expect(useSessionStore.getState().activeSessionId).toBe(id2)
    })

    it('切换会话应更新最近使用列表', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-1' })
      const id2 = useSessionStore.getState().createSession({ type: 'free' })
      const id3 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-2' })

      // 创建顺序：id1 -> id2 -> id3，recentSessionIds 应为 [id3, id2, id1]
      expect(useSessionStore.getState().recentSessionIds).toEqual([id3, id2, id1])

      // 切换到 id1
      useSessionStore.getState().switchSession(id1)
      expect(useSessionStore.getState().recentSessionIds).toEqual([id1, id3, id2])

      // 切换到 id2
      useSessionStore.getState().switchSession(id2)
      expect(useSessionStore.getState().recentSessionIds).toEqual([id2, id1, id3])
    })

    it('切换会话不应影响其他会话的状态', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-1' })
      const id2 = useSessionStore.getState().createSession({ type: 'free' })

      // 更新 id1 的状态
      useSessionStore.getState().updateSessionStatus(id1, 'running')
      useSessionStore.getState().incrementMessageCount(id1)

      // 切换到 id2
      useSessionStore.getState().switchSession(id2)

      const store = useSessionStore.getState()

      // 验证 id1 的状态未改变
      const session1 = store.sessions.get(id1)!
      expect(session1.status).toBe('running')
      expect(session1.messageCount).toBe(1)

      // 验证 id2 的状态是初始状态
      const session2 = store.sessions.get(id2)!
      expect(session2.status).toBe('idle')
      expect(session2.messageCount).toBe(0)
    })

    it('切换不存在的会话应无效果', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-1' })
      expect(useSessionStore.getState().activeSessionId).toBe(id1)

      // 尝试切换到不存在的会话
      useSessionStore.getState().switchSession('non-existent-id')
      expect(useSessionStore.getState().activeSessionId).toBe(id1) // 应保持不变
    })
  })

  describe('会话消息隔离性', () => {
    it('不同会话的消息状态应完全隔离', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-1' })
      const id2 = useSessionStore.getState().createSession({ type: 'free' })

      // 设置 id1 的消息状态
      const msgState1: SessionMessageState = {
        messages: [{ id: 'msg-1', content: '消息1' } as any],
        archivedMessages: [],
        conversationId: 'conv-1',
      }
      useSessionStore.getState().setSessionMessages(id1, msgState1)

      // 设置 id2 的消息状态
      const msgState2: SessionMessageState = {
        messages: [{ id: 'msg-3', content: '消息2' } as any],
        archivedMessages: [{ id: 'msg-0', content: '归档消息' } as any],
        conversationId: null,
      }
      useSessionStore.getState().setSessionMessages(id2, msgState2)

      // 验证隔离性
      expect(useSessionStore.getState().getSessionMessages(id1)).toEqual(msgState1)
      expect(useSessionStore.getState().getSessionMessages(id2)).toEqual(msgState2)

      // 更新 id1 不应影响 id2
      const updatedState1: SessionMessageState = {
        messages: [{ id: 'msg-1', content: '消息1' } as any, { id: 'msg-4', content: '新消息' } as any],
        archivedMessages: [],
        conversationId: 'conv-1',
      }
      useSessionStore.getState().setSessionMessages(id1, updatedState1)

      // id2 应保持不变
      expect(useSessionStore.getState().getSessionMessages(id2)).toEqual(msgState2)
      expect(useSessionStore.getState().getSessionMessages(id1)).toEqual(updatedState1)
    })

    it('删除会话应同时删除其消息状态', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-1' })
      const id2 = useSessionStore.getState().createSession({ type: 'free' })

      // 设置消息状态
      useSessionStore.getState().setSessionMessages(id1, {
        messages: [{ id: 'msg-1', content: '消息' } as any],
        archivedMessages: [],
        conversationId: null,
      })

      // 删除 id1
      useSessionStore.getState().deleteSession(id1)

      const store = useSessionStore.getState()

      // 验证消息状态也被删除
      expect(store.sessionMessages.has(id1)).toBe(false)
      expect(store.sessionMessages.has(id2)).toBe(true)
    })
  })

  describe('工作区切换隔离性', () => {
    it('临时切换工作区不应影响其他会话', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'free' })
      const id2 = useSessionStore.getState().createSession({ type: 'free' })

      // id1 临时切换到 ws-temp
      useSessionStore.getState().switchSessionWorkspace(id1, 'ws-temp', 'temporary')

      const store = useSessionStore.getState()

      // 验证 id1 的临时工作区已设置
      const session1 = store.sessions.get(id1)!
      expect(session1.temporaryWorkspaceId).toBe('ws-temp')

      // 验证 id2 不受影响
      const session2 = store.sessions.get(id2)!
      expect(session2.temporaryWorkspaceId).toBeNull()
    })

    it('添加关联工作区不应影响其他会话', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-1' })
      const id2 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-2' })

      // id1 添加关联工作区
      useSessionStore.getState().addContextWorkspace(id1, 'ws-context-1')
      useSessionStore.getState().addContextWorkspace(id1, 'ws-context-2')

      const store = useSessionStore.getState()

      // 验证 id1 的关联工作区
      const session1 = store.sessions.get(id1)!
      expect(session1.contextWorkspaceIds).toEqual(['ws-context-1', 'ws-context-2'])

      // 验证 id2 不受影响
      const session2 = store.sessions.get(id2)!
      expect(session2.contextWorkspaceIds).toEqual([])
    })

    it('移除关联工作区不应影响其他会话', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-1' })
      const id2 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-2' })

      // 两个会话都添加相同的关联工作区
      useSessionStore.getState().addContextWorkspace(id1, 'ws-shared')
      useSessionStore.getState().addContextWorkspace(id2, 'ws-shared')

      // id1 移除关联
      useSessionStore.getState().removeContextWorkspace(id1, 'ws-shared')

      const store = useSessionStore.getState()

      // 验证 id1 移除成功
      const session1 = store.sessions.get(id1)!
      expect(session1.contextWorkspaceIds).toEqual([])

      // 验证 id2 不受影响
      const session2 = store.sessions.get(id2)!
      expect(session2.contextWorkspaceIds).toEqual(['ws-shared'])
    })
  })

  describe('会话删除清理', () => {
    it('删除会话应正确清理所有相关状态', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-1' })
      const id2 = useSessionStore.getState().createSession({ type: 'free' })

      // 设置一些状态
      useSessionStore.getState().updateSessionStatus(id1, 'running')
      useSessionStore.getState().setSessionMessages(id1, {
        messages: [{ id: 'msg-1' } as any],
        archivedMessages: [],
        conversationId: null,
      })

      // 删除 id1
      useSessionStore.getState().deleteSession(id1)

      const store = useSessionStore.getState()

      // 验证清理
      expect(store.sessions.has(id1)).toBe(false)
      expect(store.sessionMessages.has(id1)).toBe(false)
      expect(store.recentSessionIds.includes(id1)).toBe(false)

      // 如果删除的是活跃会话，应切换到其他会话
      expect(store.activeSessionId).toBe(id2)
    })

    it('删除唯一活跃会话应将活跃 ID 设为 null', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'free' })
      expect(useSessionStore.getState().activeSessionId).toBe(id1)

      // 删除唯一的会话
      useSessionStore.getState().deleteSession(id1)

      const store = useSessionStore.getState()

      expect(store.sessions.size).toBe(0)
      expect(store.activeSessionId).toBeNull()
      expect(store.recentSessionIds).toEqual([])
    })

    it('关闭会话应仅从最近列表移除，不删除会话本身', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-1' })
      const id2 = useSessionStore.getState().createSession({ type: 'free' })

      // 关闭 id1
      useSessionStore.getState().closeSession(id1)

      const store = useSessionStore.getState()

      // 验证会话仍存在
      expect(store.sessions.has(id1)).toBe(true)
      expect(store.sessionMessages.has(id1)).toBe(true)

      // 验证从最近列表移除
      expect(store.recentSessionIds.includes(id1)).toBe(false)

      // 如果关闭的是活跃会话，应切换
      useSessionStore.getState().switchSession(id1)
      expect(useSessionStore.getState().activeSessionId).toBe(id1)
      useSessionStore.getState().closeSession(id1)
      expect(useSessionStore.getState().activeSessionId).toBe(id2)
    })
  })

  describe('悬浮岛状态管理', () => {
    it('悬浮岛展开状态独立管理，切换会话时会自动收起', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'free' })
      const id2 = useSessionStore.getState().createSession({ type: 'free' })

      // 展开悬浮岛
      useSessionStore.getState().toggleIsland()
      expect(useSessionStore.getState().isIslandExpanded).toBe(true)
      expect(useSessionStore.getState().islandExpandMode).toBe('sessions')

      // 切换会话会自动收起悬浮岛（这是设计决策）
      useSessionStore.getState().switchSession(id1)
      expect(useSessionStore.getState().isIslandExpanded).toBe(false)
      expect(useSessionStore.getState().islandExpandMode).toBeNull()

      // 再次展开悬浮岛
      useSessionStore.getState().setIslandExpandMode('workspaces')
      expect(useSessionStore.getState().isIslandExpanded).toBe(true)
      expect(useSessionStore.getState().islandExpandMode).toBe('workspaces')

      // 收起悬浮岛
      useSessionStore.getState().collapseIsland()
      expect(useSessionStore.getState().isIslandExpanded).toBe(false)
      expect(useSessionStore.getState().islandExpandMode).toBeNull()
    })

    it('设置悬浮岛展开模式应正确工作', () => {
      useSessionStore.getState().setIslandExpandMode('sessions')
      expect(useSessionStore.getState().isIslandExpanded).toBe(true)
      expect(useSessionStore.getState().islandExpandMode).toBe('sessions')

      useSessionStore.getState().setIslandExpandMode('workspaces')
      expect(useSessionStore.getState().isIslandExpanded).toBe(true)
      expect(useSessionStore.getState().islandExpandMode).toBe('workspaces')

      useSessionStore.getState().setIslandExpandMode(null)
      expect(useSessionStore.getState().isIslandExpanded).toBe(false)
      expect(useSessionStore.getState().islandExpandMode).toBeNull()
    })
  })

  describe('会话状态更新', () => {
    it('更新会话状态不应影响其他会话', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-1' })
      const id2 = useSessionStore.getState().createSession({ type: 'free' })

      // 更新 id1 状态
      useSessionStore.getState().updateSessionStatus(id1, 'running')
      useSessionStore.getState().updateSessionStatus(id1, 'waiting')

      const store = useSessionStore.getState()

      // 验证 id1 状态
      const session1 = store.sessions.get(id1)!
      expect(session1.status).toBe('waiting')

      // 验证 id2 不受影响
      const session2 = store.sessions.get(id2)!
      expect(session2.status).toBe('idle')
    })

    it('重命名会话不应影响其他会话', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-1', title: '原标题' })
      const id2 = useSessionStore.getState().createSession({ type: 'free', title: '另一个标题' })

      // 重命名 id1
      useSessionStore.getState().renameSession(id1, '新标题')

      const store = useSessionStore.getState()

      // 验证 id1
      const session1 = store.sessions.get(id1)!
      expect(session1.title).toBe('新标题')

      // 验证 id2 不受影响
      const session2 = store.sessions.get(id2)!
      expect(session2.title).toBe('另一个标题')
    })

    it('增加消息计数应独立计数', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-1' })
      const id2 = useSessionStore.getState().createSession({ type: 'free' })

      // id1 增加多次消息计数
      useSessionStore.getState().incrementMessageCount(id1)
      useSessionStore.getState().incrementMessageCount(id1)
      useSessionStore.getState().incrementMessageCount(id1)

      // id2 增加一次
      useSessionStore.getState().incrementMessageCount(id2)

      const store = useSessionStore.getState()

      // 验证独立计数
      const session1 = store.sessions.get(id1)!
      expect(session1.messageCount).toBe(3)

      const session2 = store.sessions.get(id2)!
      expect(session2.messageCount).toBe(1)
    })
  })

  describe('getSessionEffectiveWorkspace 辅助函数', () => {
    it('应正确计算有效工作区：临时 > 绑定 > 全局', () => {
      // 创建会话
      const id1 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-bound' })

      // 只有绑定工作区，全局工作区被忽略
      let session1 = useSessionStore.getState().sessions.get(id1)!
      expect(getSessionEffectiveWorkspace(session1, 'ws-global')).toBe('ws-bound')
      expect(getSessionEffectiveWorkspace(session1, null)).toBe('ws-bound')

      // 设置临时工作区，临时工作区优先级最高
      useSessionStore.getState().switchSessionWorkspace(id1, 'ws-temp', 'temporary')
      session1 = useSessionStore.getState().sessions.get(id1)!
      expect(getSessionEffectiveWorkspace(session1, 'ws-global')).toBe('ws-temp')
      expect(getSessionEffectiveWorkspace(session1, null)).toBe('ws-temp')

      // 自由会话无绑定工作区，使用全局工作区
      const id2 = useSessionStore.getState().createSession({ type: 'free' })
      let session2 = useSessionStore.getState().sessions.get(id2)!
      expect(getSessionEffectiveWorkspace(session2, 'ws-global')).toBe('ws-global')
      expect(getSessionEffectiveWorkspace(session2, null)).toBeNull()

      // 自由会话设置临时工作区，临时优先
      useSessionStore.getState().switchSessionWorkspace(id2, 'ws-temp-free', 'temporary')
      session2 = useSessionStore.getState().sessions.get(id2)!
      expect(getSessionEffectiveWorkspace(session2, 'ws-global')).toBe('ws-temp-free')
      expect(getSessionEffectiveWorkspace(session2, null)).toBe('ws-temp-free')
    })
  })

  describe('最近会话列表', () => {
    it('getRecentSessions 应返回正确顺序的会话', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-1' })
      const id2 = useSessionStore.getState().createSession({ type: 'free' })
      const id3 = useSessionStore.getState().createSession({ type: 'project', workspaceId: 'ws-2' })

      // 创建顺序：id1 -> id2 -> id3
      // recentSessionIds: [id3, id2, id1]

      const recentSessions = useSessionStore.getState().getRecentSessions(3)
      expect(recentSessions.length).toBe(3)
      expect(recentSessions[0].id).toBe(id3)
      expect(recentSessions[1].id).toBe(id2)
      expect(recentSessions[2].id).toBe(id1)
    })

    it('getRecentSessions 应正确处理 limit 参数', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'free' })
      const id2 = useSessionStore.getState().createSession({ type: 'free' })
      const id3 = useSessionStore.getState().createSession({ type: 'free' })
      const id4 = useSessionStore.getState().createSession({ type: 'free' })

      // 请求 2 个
      const recent2 = useSessionStore.getState().getRecentSessions(2)
      expect(recent2.length).toBe(2)
      expect(recent2[0].id).toBe(id4)
      expect(recent2[1].id).toBe(id3)

      // 请求 10 个（只有 4 个会话）
      const recent10 = useSessionStore.getState().getRecentSessions(10)
      expect(recent10.length).toBe(4)
    })

    it('删除会话后 getRecentSessions 应正确返回', () => {
      const id1 = useSessionStore.getState().createSession({ type: 'free' })
      const id2 = useSessionStore.getState().createSession({ type: 'free' })
      const id3 = useSessionStore.getState().createSession({ type: 'free' })

      // 删除中间的会话
      useSessionStore.getState().deleteSession(id2)

      const recentSessions = useSessionStore.getState().getRecentSessions(10)
      expect(recentSessions.length).toBe(2)
      expect(recentSessions.find(s => s.id === id2)).toBeUndefined()
    })
  })

  describe('Map 序列化/反序列化', () => {
    it('Map 序列化应正确转换为数组', () => {
      const sessions = new Map<string, { id: string; title: string }>()
      sessions.set('s1', { id: 's1', title: '会话1' })
      sessions.set('s2', { id: 's2', title: '会话2' })

      // replacer 逻辑
      const serialized = JSON.stringify({ sessions }, (key, value) => {
        if (key === 'sessions' && value instanceof Map) {
          return Array.from(value.entries())
        }
        return value
      })

      const parsed = JSON.parse(serialized)
      expect(Array.isArray(parsed.sessions)).toBe(true)
      expect(parsed.sessions.length).toBe(2)
      expect(parsed.sessions[0]).toEqual(['s1', { id: 's1', title: '会话1' }])
      expect(parsed.sessions[1]).toEqual(['s2', { id: 's2', title: '会话2' }])
    })

    it('Map 反序列化应正确从数组恢复', () => {
      const serializedData = {
        sessions: [
          ['s1', { id: 's1', title: '会话1' }],
          ['s2', { id: 's2', title: '会话2' }],
        ],
      }

      // reviver 逻辑
      const revived = JSON.parse(JSON.stringify(serializedData), (key, value) => {
        if (key === 'sessions' && Array.isArray(value)) {
          return new Map(value)
        }
        return value
      })

      expect(revived.sessions instanceof Map).toBe(true)
      expect(revived.sessions.size).toBe(2)
      expect(revived.sessions.get('s1')).toEqual({ id: 's1', title: '会话1' })
      expect(revived.sessions.get('s2')).toEqual({ id: 's2', title: '会话2' })
    })

    it('空 Map 序列化后应为空数组', () => {
      const sessions = new Map()

      const serialized = JSON.stringify({ sessions }, (key, value) => {
        if (key === 'sessions' && value instanceof Map) {
          return Array.from(value.entries())
        }
        return value
      })

      const parsed = JSON.parse(serialized)
      expect(Array.isArray(parsed.sessions)).toBe(true)
      expect(parsed.sessions.length).toBe(0)

      // 反序列化
      const revived = JSON.parse(JSON.stringify(parsed), (key, value) => {
        if (key === 'sessions' && Array.isArray(value)) {
          return new Map(value)
        }
        return value
      })

      expect(revived.sessions instanceof Map).toBe(true)
      expect(revived.sessions.size).toBe(0)
    })

    it('sessionMessages Map 应正确序列化和反序列化', () => {
      const sessionMessages = new Map<string, { messages: any[]; isStreaming: boolean }>()
      sessionMessages.set('s1', { messages: [{ id: 'm1' }], isStreaming: true })
      sessionMessages.set('s2', { messages: [], isStreaming: false })

      // 序列化
      const serialized = JSON.stringify({ sessionMessages }, (key, value) => {
        if (key === 'sessionMessages' && value instanceof Map) {
          return Array.from(value.entries())
        }
        return value
      })

      const parsed = JSON.parse(serialized)
      expect(Array.isArray(parsed.sessionMessages)).toBe(true)
      expect(parsed.sessionMessages.length).toBe(2)

      // 反序列化
      const revived = JSON.parse(JSON.stringify(parsed), (key, value) => {
        if (key === 'sessionMessages' && Array.isArray(value)) {
          return new Map(value)
        }
        return value
      })

      expect(revived.sessionMessages instanceof Map).toBe(true)
      expect(revived.sessionMessages.size).toBe(2)
      expect(revived.sessionMessages.get('s1')).toEqual({ messages: [{ id: 'm1' }], isStreaming: true })
      expect(revived.sessionMessages.get('s2')).toEqual({ messages: [], isStreaming: false })
    })
  })
})