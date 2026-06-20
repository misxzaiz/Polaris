/**
 * Personal Hub 认证状态管理
 *
 * zustand 版（替代 personal-hub 的 Pinia auth store）。
 * 依赖 Supabase SDK 自动持久化/刷新 session（localStorage sb-<ref>-auth-token），
 * 此处只缓存 { id, email }。
 */
import { create } from 'zustand'
import { getSupabase, isSupabaseConfigured } from '@/services/personalHub/supabase'
import type { User } from '@/services/personalHub/types'
import { createLogger } from '@/utils/logger'

const log = createLogger('PersonalHubAuth')

interface AuthState {
  user: User | null
  loading: boolean
  initialized: boolean
}

interface AuthActions {
  signIn: (email: string, password: string) => Promise<{ success: boolean; error?: string }>
  signUp: (email: string, password: string) => Promise<{ success: boolean; error?: string }>
  signOut: () => Promise<void>
  initAuth: () => Promise<void>
}

export type PersonalHubAuthStore = AuthState & AuthActions

export const usePersonalHubAuthStore = create<PersonalHubAuthStore>((set, get) => ({
  user: null,
  loading: false,
  initialized: false,

  signIn: async (email, password) => {
    set({ loading: true })
    try {
      const { data, error } = await getSupabase().auth.signInWithPassword({ email, password })
      if (error) throw error
      if (data.user) {
        set({ user: { id: data.user.id, email: data.user.email! } })
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      set({ loading: false })
    }
  },

  signUp: async (email, password) => {
    set({ loading: true })
    try {
      const { error } = await getSupabase().auth.signUp({ email, password })
      if (error) throw error
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      set({ loading: false })
    }
  },

  signOut: async () => {
    try {
      await getSupabase().auth.signOut()
    } catch (error) {
      log.warn('signOut failed', { error: error instanceof Error ? error.message : String(error) })
    } finally {
      set({ user: null })
    }
  },

  initAuth: async () => {
    if (get().initialized) return
    if (!isSupabaseConfigured()) {
      // 未配置时直接标记完成，不报错；面板会提示去设置页配置
      set({ initialized: true })
      return
    }
    try {
      const supabase = getSupabase()
      const { data } = await supabase.auth.getSession()
      if (data.session?.user) {
        set({ user: { id: data.session.user.id, email: data.session.user.email! } })
      }
      supabase.auth.onAuthStateChange((_event, session) => {
        if (session?.user) {
          set({ user: { id: session.user.id, email: session.user.email! } })
        } else {
          set({ user: null })
        }
      })
    } catch (error) {
      log.warn('initAuth failed', { error: error instanceof Error ? error.message : String(error) })
    } finally {
      set({ initialized: true })
    }
  },
}))
