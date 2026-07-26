/**
 * Personal Hub 认证状态管理
 *
 * zustand 版（替代 personal-hub 的 Pinia auth store）。
 * 依赖 Supabase SDK 自动持久化/刷新 session（localStorage sb-<ref>-auth-token），
 * 此处只缓存 { id, email }。
 */
import { create } from 'zustand'
import { getSupabase, isSupabaseConfigured } from '@/services/personalHub/supabase'
import { setPersonalHubSession } from '@/services/tauri/configService'
import type { User } from '@/services/personalHub/types'
import { createLogger } from '@/utils/logger'

const log = createLogger('PersonalHubAuth')

/** 同步 Supabase access_token 到后端 config，供 MCP server 认证使用 */
async function syncAuthToken(): Promise<void> {
  try {
    const supabase = getSupabase()
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token ?? ''
    await setPersonalHubSession(token)
    log.info('已同步 Personal Hub session token', { hasToken: !!token })
  } catch (e) {
    log.warn('syncAuthToken 失败', { error: e instanceof Error ? e.message : String(e) })
  }
}

/** 清除后端的 session token */
async function clearAuthToken(): Promise<void> {
  try {
    await setPersonalHubSession('')
  } catch (e) {
    log.warn('clearAuthToken 失败', { error: e instanceof Error ? e.message : String(e) })
  }
}

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
      // 登录成功后同步 token 到后端 config
      await syncAuthToken()
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
      // 登出时清除后端 token
      await clearAuthToken()
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
        // 恢复 session 时同步 token 到后端
        await syncAuthToken()
      }
      supabase.auth.onAuthStateChange((_event, session) => {
        if (session?.user) {
          set({ user: { id: session.user.id, email: session.user.email! } })
          // 任何认证状态变更时也同步 token（如 token 刷新后）
          syncAuthToken().catch(() => {})
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
