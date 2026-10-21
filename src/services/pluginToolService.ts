/**
 * P3 工具注入管理面 — cap.mcp list_plugin_tools / set_plugin_tools 前端桥
 *
 * 对应 `plans/plugin-cap-inject-render-v1.md` §2.3：插件 → AI 工具的注入管理。
 * 复用 `router_dispatch`（RouterBus 统一权限 + 审计），对齐 voiceBroadcast/voiceService.ts 模式。
 *
 * 返回形状（后端 mcp_capability.rs invoke）：
 * - list_plugin_tools → { ok, pluginId, servers: [{ pluginId, server, tools, injected, gate, via }] }
 * - set_plugin_tools   → { ok, pluginId, enabled, effectiveFrom: 'nextTurn' }
 */
import { invoke } from '@/services/transport'

/** router_dispatch 统一返回（与 aiChatDispatch 的 AiDispatchResponse 对齐） */
export interface RouterDispatchResponse {
  msgId: string
  ok: boolean
  result: unknown
  error: string | null
  trace: string
}

/** cap.mcp list_plugin_tools 单个 server 条目 */
export interface PluginToolServerInfo {
  pluginId: string
  server: string
  tools: string[]
  /** per-tool 注入开关（缺省 true = 全放行；显式 false = 关闭） */
  toolGates: Record<string, boolean>
  /** "injected"（已拉起可见）| "lazy"（声明未拉起，下一轮注入后可见） */
  injected: string
  gate: string
  via: string
}

/** cap.mcp list_plugin_tools 返回 */
export interface ListPluginToolsResult {
  ok: boolean
  pluginId: string
  servers: PluginToolServerInfo[]
  error?: string
}

/** cap.mcp set_plugin_tools 返回 */
export interface SetPluginToolsResult {
  ok: boolean
  pluginId: string
  enabled: boolean
  effectiveFrom: string
  error?: string
}

/**
 * 列出插件注入 AI 的工具（只读诊断）。
 * @param pluginId 空 = 全部插件
 */
export async function listPluginTools(pluginId?: string): Promise<ListPluginToolsResult> {
  const payload = { action: 'list_plugin_tools', ...(pluginId ? { pluginId } : {}) }
  let res: RouterDispatchResponse
  try {
    res = await invoke<RouterDispatchResponse>('router_dispatch', {
      req: { target: 'cap.mcp', payload },
    })
  } catch (e) {
    return { ok: false, pluginId: pluginId ?? '', servers: [], error: `cap.mcp 调用失败: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!res.ok) {
    return { ok: false, pluginId: pluginId ?? '', servers: [], error: res.error ?? 'cap.mcp 调用失败' }
  }
  return (res.result as ListPluginToolsResult) ?? { ok: false, pluginId: pluginId ?? '', servers: [], error: 'cap.mcp 未返回数据' }
}

/**
 * 设置插件 AI 工具注入开关（下一轮生效）。
 * @param pluginId 插件 id
 * @param enabled true 注入 / false 移除
 * @param tools 可选工具名单；缺省 = 整插件 mcpEnabled 开关
 */
export async function setPluginTools(
  pluginId: string,
  enabled: boolean,
  tools?: string[],
): Promise<SetPluginToolsResult> {
  const payload = { action: 'set_plugin_tools', pluginId, enabled, ...(tools && tools.length > 0 ? { tools } : {}) }
  let res: RouterDispatchResponse
  try {
    res = await invoke<RouterDispatchResponse>('router_dispatch', {
      req: { target: 'cap.mcp', payload },
    })
  } catch (e) {
    return { ok: false, pluginId, enabled, effectiveFrom: '', error: `cap.mcp 调用失败: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!res.ok) {
    return { ok: false, pluginId, enabled, effectiveFrom: '', error: res.error ?? 'cap.mcp 调用失败' }
  }
  return (res.result as SetPluginToolsResult) ?? { ok: false, pluginId, enabled, effectiveFrom: '', error: 'cap.mcp 未返回数据' }
}
