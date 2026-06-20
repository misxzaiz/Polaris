/**
 * Supabase 客户端单例（按配置懒加载）
 *
 * 与 personal-hub 不同：URL/key 不再来自 env，而是来自 Polaris Config（personalHub 字段）。
 * 当用户在设置页变更 url/key 后，下次调用会自动重建客户端。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { useConfigStore } from '@/stores/configStore'
import type { PersonalHubConfig } from '@/types'

/** Supabase 默认配置（personal-hub 既有项目），用户在设置页留空时回退使用 */
export const DEFAULT_SUPABASE_URL = 'https://nynpqrwsautudqblxoir.supabase.co'
export const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55bnBxcndzYXV0dWRxYmx4b2lyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI3MDkzMDksImV4cCI6MjA3ODI4NTMwOX0.rz79QkbbSEQPsrSdbYYFL-nuV_MwdAWhf4-gQ0j_fz4'

/**
 * 读取生效的 personalHub 配置（从 configStore，空值回退内置默认）。
 * 注意：加密密钥不回退默认（默认无加密）。
 */
export function getPersonalHubConfig(): PersonalHubConfig {
  const cfg = useConfigStore.getState().config?.personalHub
  return {
    supabaseUrl: cfg?.supabaseUrl?.trim() || DEFAULT_SUPABASE_URL,
    supabaseAnonKey: cfg?.supabaseAnonKey?.trim() || DEFAULT_SUPABASE_ANON_KEY,
    encryptionKey: cfg?.encryptionKey ?? '',
  }
}

/**
 * 读取原始配置（不回退默认），用于设置页判断用户是否自定义过。
 * 返回空字符串表示用户未填，将使用默认。
 */
export function getRawPersonalHubConfig(): PersonalHubConfig {
  const cfg = useConfigStore.getState().config?.personalHub
  return {
    supabaseUrl: cfg?.supabaseUrl ?? '',
    supabaseAnonKey: cfg?.supabaseAnonKey ?? '',
    encryptionKey: cfg?.encryptionKey ?? '',
  }
}

/** 是否已完成 Supabase 配置（默认值或自定义值任一非空即视为已配置） */
export function isSupabaseConfigured(): boolean {
  const { supabaseUrl, supabaseAnonKey } = getPersonalHubConfig()
  return supabaseUrl.trim().length > 0 && supabaseAnonKey.trim().length > 0
}

let client: SupabaseClient | null = null
let cachedKey = ''

/** 获取 Supabase 客户端，配置变更时自动重建 */
export function getSupabase(): SupabaseClient {
  const { supabaseUrl, supabaseAnonKey } = getPersonalHubConfig()
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase 未配置，请先在设置 → 个人空间中填写 URL 与 anon key')
  }
  const key = `${supabaseUrl}::${supabaseAnonKey}`
  if (!client || key !== cachedKey) {
    client = createClient(supabaseUrl, supabaseAnonKey)
    cachedKey = key
  }
  return client
}
