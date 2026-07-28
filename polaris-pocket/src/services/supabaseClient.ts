/**
 * Pocket Supabase 客户端（个人空间云同步）
 *
 * 与主项目 Personal Hub 共享同一 Supabase 后端（默认 URL/anon key 一致），
 * 配置从 Pocket localStorage 读取（设置页填写），留空回退默认。
 * 登录态用 Pocket 自己的 localStorage key，不依赖桌面端 configStore。
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** 与主项目一致的默认配置（personal-hub 既有项目） */
export const DEFAULT_SUPABASE_URL = "https://nynpqrwsautudqblxoir.supabase.co";
export const DEFAULT_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55bnBxcndzYXV0dWRxYmx4b2lyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI3MDkzMDksImV4cCI6MjA3ODI4NTMwOX0.rz79QkbbSEQPsrSdbYYFL-nuV_MwdAWhf4-gQ0j_fz4";

interface PocketHubConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  encryptionKey: string;
}

export function getPersonalHubConfig(): PocketHubConfig {
  const cfg = (() => { try { return JSON.parse(localStorage.getItem("pocket-config") || "{}"); } catch { return {}; } })();
  return {
    supabaseUrl: (cfg.supabaseUrl || "").trim() || DEFAULT_SUPABASE_URL,
    supabaseAnonKey: (cfg.supabaseKey || "").trim() || DEFAULT_SUPABASE_ANON_KEY,
    encryptionKey: cfg.encryptionKey || "",
  };
}

export function isSupabaseConfigured(): boolean {
  const { supabaseUrl, supabaseAnonKey } = getPersonalHubConfig();
  return supabaseUrl.length > 0 && supabaseAnonKey.length > 0;
}

let client: SupabaseClient | null = null;
let cachedKey = "";

/** 获取 Supabase 客户端，配置变更时自动重建 */
export function getSupabase(): SupabaseClient {
  const { supabaseUrl, supabaseAnonKey } = getPersonalHubConfig();
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Supabase 未配置，请先在设置中填写 URL 与 anon key");
  }
  const key = `${supabaseUrl}::${supabaseAnonKey}`;
  if (!client || key !== cachedKey) {
    client = createClient(supabaseUrl, supabaseAnonKey);
    cachedKey = key;
  }
  return client;
}

/** 清除缓存的客户端（配置变更后调用） */
export function resetSupabaseClient() {
  client = null;
  cachedKey = "";
}
