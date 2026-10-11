/**
 * WorkspaceSessionSlice 桶管理测试（S2）
 *
 * 验收对齐 spec §5：
 * 1. 桶内活跃会话独立（多窗口不互踩）
 * 2. 切换 workspace 各桶独立
 * 3. 未知桶 ensureBucket 懒加载
 * 4. register/unregister 生命周期
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { workspaceSessionSlice } from './workspaceSessionSlice'
import { FREE_WORKSPACE_KEY } from './types'
import type { SessionMetadata } from '../conversationStore/types'

function makeMetadata(id: string, title?: string): SessionMetadata {
  return {
    id,
    title: title ?? `Session ${id}`,
    type: 'project',
    engineId: 'codex',
    workspaceId: null,
    contextWorkspaceIds: [],
    workspaceLocked: false,
    status: 'idle',
    silentMode: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

describe('WorkspaceSessionSlice', () => {
  beforeEach(() => {
    workspaceSessionSlice.getState().reset()
  })

  describe('ensureBucket', () => {
    it('首次访问创建桶，第二次返回同一引用', () => {
      const b1 = workspaceSessionSlice.getState().ensureBucket('/ws/A')
      const b2 = workspaceSessionSlice.getState().ensureBucket('/ws/A')
      expect(b1).toBe(b2)
      expect(b1.workspaceKey).toBe('/ws/A')
    })

    it('初始含 FREE_WORKSPACE_KEY 桶', () => {
      const free = workspaceSessionSlice.getState().getBucket(FREE_WORKSPACE_KEY)
      expect(free).not.toBeNull()
    })
  })

  describe('registerSession / unregisterSession', () => {
    it('注册会话到桶，sessions + sessionMetadata 各加一条', () => {
      const slice = workspaceSessionSlice.getState()
      slice.registerSession('/ws/A', 's1', makeMetadata('s1'))
      const bucket = slice.getBucket('/ws/A')!
      expect(bucket.sessions.has('s1')).toBe(true)
      expect(bucket.sessionMetadata.get('s1')?.title).toBe('Session s1')
    })

    it('unregister 清理 sessions/metadata/background/notifications', () => {
      const slice = workspaceSessionSlice.getState()
      slice.registerSession('/ws/A', 's1', makeMetadata('s1'))
      slice.switchSessionInBucket('/ws/A', 's1')
      const bucket = slice.getBucket('/ws/A')!
      bucket.backgroundSessionIds.push('s1')
      bucket.completedNotifications.push('s1')

      slice.unregisterSession('/ws/A', 's1')

      const after = slice.getBucket('/ws/A')!
      expect(after.sessions.has('s1')).toBe(false)
      expect(after.sessionMetadata.has('s1')).toBe(false)
      expect(after.backgroundSessionIds).not.toContain('s1')
      expect(after.completedNotifications).not.toContain('s1')
      expect(after.activeSessionId).toBeNull()
    })
  })

  describe('switchSessionInBucket', () => {
    it('桶内切换活跃会话不互踩（验收 §5 #1）', () => {
      const slice = workspaceSessionSlice.getState()
      slice.ensureBucket('/ws/A')
      slice.ensureBucket('/ws/B')
      slice.registerSession('/ws/A', 'a1', makeMetadata('a1'))
      slice.registerSession('/ws/B', 'b1', makeMetadata('b1'))

      slice.switchSessionInBucket('/ws/A', 'a1')
      slice.switchSessionInBucket('/ws/B', 'b1')

      expect(slice.getActiveSessionId('/ws/A')).toBe('a1')
      expect(slice.getActiveSessionId('/ws/B')).toBe('b1')
    })

    it('切换 workspace 各桶草稿/运行态独立（验收 §5 #2）', () => {
      const slice = workspaceSessionSlice.getState()
      slice.registerSession('/ws/A', 'a1', makeMetadata('a1'))
      slice.registerSession('/ws/B', 'b1', makeMetadata('b1'))
      slice.switchSessionInBucket('/ws/A', 'a1')
      slice.switchSessionInBucket('/ws/B', 'b1')

      slice.setActiveWorkspace('/ws/A')
      expect(workspaceSessionSlice.getState().activeWorkspaceKey).toBe('/ws/A')
      slice.setActiveWorkspace('/ws/B')
      expect(workspaceSessionSlice.getState().activeWorkspaceKey).toBe('/ws/B')

      // A 桶活跃没被 B 切换影响
      expect(slice.getActiveSessionId('/ws/A')).toBe('a1')
      expect(slice.getActiveSessionId('/ws/B')).toBe('b1')
    })

    it('切换到不存在的会话被拒绝（warn 日志，不改活跃指针）', () => {
      const slice = workspaceSessionSlice.getState()
      slice.registerSession('/ws/A', 'a1', makeMetadata('a1'))
      slice.switchSessionInBucket('/ws/A', 'a1')

      // 不存在的会话
      slice.switchSessionInBucket('/ws/A', 'nonexistent')
      expect(slice.getActiveSessionId('/ws/A')).toBe('a1')

      // null 允许（清空活跃）
      slice.switchSessionInBucket('/ws/A', null)
      expect(slice.getActiveSessionId('/ws/A')).toBeNull()
    })
  })

  describe('getAllActive', () => {
    it('返回所有桶的活跃会话', () => {
      const slice = workspaceSessionSlice.getState()
      slice.registerSession('/ws/A', 'a1', makeMetadata('a1'))
      slice.registerSession('/ws/B', 'b1', makeMetadata('b1'))
      slice.switchSessionInBucket('/ws/A', 'a1')
      slice.switchSessionInBucket('/ws/B', 'b1')

      const all = slice.getAllActive()
      const map = new Map(all.map((x) => [x.workspaceKey, x.activeSessionId]))
      expect(map.get('/ws/A')).toBe('a1')
      expect(map.get('/ws/B')).toBe('b1')
    })
  })

  describe('未知桶懒加载（验收 §5 #3）', () => {
    it('getBucket 不创建，ensureBucket 创建', () => {
      const slice = workspaceSessionSlice.getState()
      expect(slice.getBucket('/unknown')).toBeNull()
      const b = slice.ensureBucket('/unknown')
      expect(b.workspaceKey).toBe('/unknown')
      expect(slice.getBucket('/unknown')).not.toBeNull()
    })
  })
})
