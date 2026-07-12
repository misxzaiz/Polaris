import { describe, it, expect, beforeEach } from 'vitest'
import { useModelProfileStore } from './modelProfileStore'
import type { ModelProfile, CreateModelProfileParams } from '../types/modelProfile'

describe('modelProfileStore', () => {
  beforeEach(() => {
    useModelProfileStore.getState().reset()
  })

  describe('setProfiles', () => {
    it('应该设置 Profile 列表', () => {
      const profiles: ModelProfile[] = [
        {
          id: 'profile-1',
          name: 'Test Profile',
          baseUrl: 'https://api.example.com',
          apiKey: 'key',
          model: 'claude-3',
          active: false,
          createdAt: '2026-05-27T00:00:00Z',
          updatedAt: '2026-05-27T00:00:00Z',
        },
      ]

      useModelProfileStore.getState().setProfiles(profiles)

      const state = useModelProfileStore.getState()
      expect(state.profiles).toEqual(profiles)
      expect(state.activeProfileId).toBeNull()
    })

    it('应该设置激活的 Profile ID', () => {
      const profiles: ModelProfile[] = [
        {
          id: 'profile-1',
          name: 'Active Profile',
          baseUrl: 'https://api.example.com',
          apiKey: 'key',
          model: 'claude-3',
          active: true,
          createdAt: '2026-05-27T00:00:00Z',
          updatedAt: '2026-05-27T00:00:00Z',
        },
      ]

      useModelProfileStore.getState().setProfiles(profiles)

      const state = useModelProfileStore.getState()
      expect(state.activeProfileId).toBe('profile-1')
    })
  })

  describe('addProfile', () => {
    it('应该添加 Profile', () => {
      const params: CreateModelProfileParams = {
        name: 'New Profile',
        baseUrl: 'https://api.example.com',
        apiKey: 'key',
        model: 'claude-3',
      }

      const profile = useModelProfileStore.getState().addProfile(params)

      expect(profile.name).toBe('New Profile')
      expect(profile.baseUrl).toBe('https://api.example.com')
      expect(profile.active).toBe(false)
      expect(profile.id).toBeDefined()

      const state = useModelProfileStore.getState()
      expect(state.profiles).toHaveLength(1)
    })
  })

  describe('updateProfile', () => {
    it('应该更新 Profile', () => {
      useModelProfileStore.getState().addProfile({
        name: 'Original',
        baseUrl: 'https://api.example.com',
        apiKey: 'key',
        model: 'claude-3',
      })

      const { profiles } = useModelProfileStore.getState()
      const updated = useModelProfileStore.getState().updateProfile({
        id: profiles[0].id,
        name: 'Updated',
      })

      expect(updated?.name).toBe('Updated')
      expect(updated?.baseUrl).toBe('https://api.example.com')
    })

    it('应该返回 null 当 Profile 不存在', () => {
      const result = useModelProfileStore.getState().updateProfile({
        id: 'nonexistent',
        name: 'Updated',
      })

      expect(result).toBeNull()
    })
  })

  describe('removeProfile', () => {
    it('应该删除 Profile', () => {
      useModelProfileStore.getState().addProfile({
        name: 'To Delete',
        baseUrl: 'https://api.example.com',
        apiKey: 'key',
        model: 'claude-3',
      })

      const { profiles } = useModelProfileStore.getState()
      useModelProfileStore.getState().removeProfile(profiles[0].id)

      expect(useModelProfileStore.getState().profiles).toHaveLength(0)
    })

    it('应该取消激活当删除激活的 Profile', () => {
      useModelProfileStore.getState().addProfile({
        name: 'Active',
        baseUrl: 'https://api.example.com',
        apiKey: 'key',
        model: 'claude-3',
      })

      const { profiles } = useModelProfileStore.getState()
      useModelProfileStore.getState().activateProfile(profiles[0].id)
      useModelProfileStore.getState().removeProfile(profiles[0].id)

      const state = useModelProfileStore.getState()
      expect(state.profiles).toHaveLength(0)
      expect(state.activeProfileId).toBeNull()
    })
  })

  describe('activateProfile', () => {
    it('应该激活指定 Profile', () => {
      useModelProfileStore.getState().addProfile({
        name: 'Profile 1',
        baseUrl: 'https://api1.example.com',
        apiKey: 'key1',
        model: 'claude-3',
      })
      useModelProfileStore.getState().addProfile({
        name: 'Profile 2',
        baseUrl: 'https://api2.example.com',
        apiKey: 'key2',
        model: 'claude-3',
      })

      const { profiles } = useModelProfileStore.getState()
      useModelProfileStore.getState().activateProfile(profiles[1].id)

      const state = useModelProfileStore.getState()
      expect(state.activeProfileId).toBe(profiles[1].id)
      expect(state.profiles[0].active).toBe(false)
      expect(state.profiles[1].active).toBe(true)
    })

    it('应该取消激活当传入 null', () => {
      useModelProfileStore.getState().addProfile({
        name: 'Profile',
        baseUrl: 'https://api.example.com',
        apiKey: 'key',
        model: 'claude-3',
      })

      const { profiles } = useModelProfileStore.getState()
      useModelProfileStore.getState().activateProfile(profiles[0].id)
      useModelProfileStore.getState().activateProfile(null)

      const state = useModelProfileStore.getState()
      expect(state.activeProfileId).toBeNull()
      expect(state.profiles[0].active).toBe(false)
    })
  })

  describe('getActiveProfile', () => {
    it('应该返回激活的 Profile', () => {
      useModelProfileStore.getState().addProfile({
        name: 'Profile',
        baseUrl: 'https://api.example.com',
        apiKey: 'key',
        model: 'claude-3',
      })

      const { profiles } = useModelProfileStore.getState()
      useModelProfileStore.getState().activateProfile(profiles[0].id)

      const active = useModelProfileStore.getState().getActiveProfile()
      expect(active?.name).toBe('Profile')
    })

    it('应该返回 undefined 当没有激活的 Profile', () => {
      const active = useModelProfileStore.getState().getActiveProfile()
      expect(active).toBeUndefined()
    })
  })

  describe('reset', () => {
    it('应该重置状态', () => {
      useModelProfileStore.getState().addProfile({
        name: 'Profile',
        baseUrl: 'https://api.example.com',
        apiKey: 'key',
        model: 'claude-3',
      })

      useModelProfileStore.getState().reset()

      const state = useModelProfileStore.getState()
      expect(state.profiles).toHaveLength(0)
      expect(state.activeProfileId).toBeNull()
      expect(state.loading).toBe(false)
      expect(state.error).toBeNull()
    })
  })
})
