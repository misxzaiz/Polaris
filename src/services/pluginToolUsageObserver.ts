/**
 * 插件 MCP 工具调用观测服务（宿主自有，AI 工具调用自动记账）
 *
 * 见 needs/027（守望台补记其他插件工具调用次数）。宿主在全局 AIEvent 总线
 * （getEventBus）订阅 tool_call_end，把"AI 调用了某插件 MCP 工具一次"落
 * cap.kv 宿主自有键空间 `plugin.toolusage.<pluginId>`，供守望台（watchtower）
 * 读时合并进 mcp 通道——与面板打开观测（pluginUsageObserver，`plugin.usage.*`）
 * 平行，两键语义互不混淆。
 *
 * 工具名 → 插件归属映射不猜命名约定：用 cap.mcp list_plugin_tools 的真实
 * 注册表构建 bareToolName → pluginId 映射，兼容三种事件形状（裸名 / Claude
 * Code `mcp__<server>__<tool>` / 末段匹配），都不中则跳过（宁缺毋滥不污染）。
 *
 * 写入路径唯一：本服务 read-merge-write；经 router_dispatch → cap.kv 走统一
 * 权限 gate + 审计。失败语义与面板观测一致：观测是纯增量信号，任何失败静默
 * 降级（debug 日志），绝不影响 AI 会话主链路。
 */

import { invoke } from '@/services/transport'
import { getEventBus } from '@/ai-runtime'
import { createLogger } from '@/utils/logger'
import type { ToolCallEndEvent } from '@/ai-runtime'

const log = createLogger('PluginToolUsageObserver')

/** 观测记录保留的日趋势窗口（天）；count/tools/firstUsed/lastUsed 累计语义不随裁剪丢失 */
const OBSERVATION_DAY_WINDOW = 90

/** (sessionId, callId) 去重窗口大小：流式引擎可能对同一次调用重发 end 事件 */
const DEDUP_WINDOW = 512

/** 工具映射表刷新间隔（毫秒）；插件安装/启停后最迟一个间隔生效 */
const MAP_REFRESH_MS = 5 * 60 * 1000

/** plugin.toolusage.<pluginId> 落盘形态 */
export interface HostToolUsageObservation {
  v: 1
  pluginId: string
  /** 累计工具调用次数（跨会话累计，days 裁剪不影响本字段） */
  count: number
  /** 工具名 → 累计调用次数 */
  tools: Record<string, number>
  firstUsed: number
  lastUsed: number
  /** 'YYYY-MM-DD' → 当日调用次数（只保留近 OBSERVATION_DAY_WINDOW 天） */
  days: Record<string, number>
}

/** cap.mcp list_plugin_tools 返回（对齐 pluginToolService.ts PluginToolServerInfo） */
interface PluginToolServerInfo {
  pluginId: string
  server: string
  tools: string[]
}

const TOOL_USAGE_PREFIX = 'plugin.toolusage.'

function observationKey(pluginId: string): string {
  return `${TOOL_USAGE_PREFIX}${pluginId}`
}

function dayString(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function capKv<T>(payload: Record<string, unknown>): Promise<T | null> {
  const res = await invoke<DispatchResponse>('router_dispatch', {
    req: { target: 'cap.kv', payload },
  })
  if (!res?.ok) throw new Error(res?.error || 'cap.kv dispatch 失败')
  return (res.result ?? null) as T | null
}

/** router_dispatch 返回形态（与 pluginToolService.ts RouterDispatchResponse 对齐） */
interface DispatchResponse {
  msgId: string
  ok: boolean
  result: Record<string, unknown> | null
  error: string | null
  trace: string
}

// ── 工具名 → 插件映射（真实注册表，零猜测）──────────────────────────────────

let toolMap: Map<string, string> | null = null
let toolMapServerHint: Map<string, string> | null = null // server 名 → pluginId（辅助 mcp__ 形状解析）
let toolMapRefreshedAt = 0
let toolMapRefreshing: Promise<void> | null = null

/**
 * 从 list_plugin_tools 返回构建映射表（纯函数，单测覆盖）：
 * bareToolName → pluginId 与 server 名 → pluginId。
 */
export function buildToolMaps(
  servers: PluginToolServerInfo[] | undefined,
): { bare: Map<string, string>; byServer: Map<string, string> } {
  const bare = new Map<string, string>()
  const byServer = new Map<string, string>()
  for (const s of Array.isArray(servers) ? servers : []) {
    if (!s || typeof s.pluginId !== 'string' || !s.pluginId) continue
    if (typeof s.server === 'string' && s.server) byServer.set(s.server, s.pluginId)
    for (const t of Array.isArray(s.tools) ? s.tools : []) {
      if (typeof t === 'string' && t) bare.set(t, s.pluginId)
    }
  }
  return { bare, byServer }
}

async function refreshToolMap(): Promise<void> {
  const res = await invoke<DispatchResponse>('router_dispatch', {
    req: { target: 'cap.mcp', payload: { action: 'list_plugin_tools' } },
  })
  if (!res?.ok) throw new Error(res?.error || 'cap.mcp list_plugin_tools 失败')
  const result = res.result as { servers?: PluginToolServerInfo[] } | null
  const maps = buildToolMaps(result?.servers)
  toolMap = maps.bare
  toolMapServerHint = maps.byServer
  toolMapRefreshedAt = Date.now()
}

function ensureToolMap(): Promise<void> {
  if (toolMap && Date.now() - toolMapRefreshedAt < MAP_REFRESH_MS) return Promise.resolve()
  if (!toolMapRefreshing) {
    toolMapRefreshing = refreshToolMap()
      .catch((e) => {
        log.debug(`插件工具映射刷新失败（沿用旧表/空表）: ${e instanceof Error ? e.message : String(e)}`)
      })
      .finally(() => {
        toolMapRefreshing = null
      })
  }
  return toolMapRefreshing
}

/**
 * 从事件 tool 名解析插件归属（真实注册表精确匹配，三种形状兼容）：
 * 1) 裸名精确匹配（zcode/simple-ai 等直接用注册名）
 * 2) Claude Code MCP 形状 `mcp__<server>__<tool>`：按 server 段查插件，工具末段须在注册表中
 * 3) 兜底 `__` 分段取末段裸名匹配
 * 解析不出归属返回 null（宁缺毋滥，不污染计量）。
 */
export function resolvePluginIdForTool(toolName: string): string | null {
  if (!toolMap) return null
  const raw = String(toolName || '')
  if (!raw) return null
  if (toolMap.has(raw)) return toolMap.get(raw) ?? null
  const parts = raw.split('__')
  if (parts.length >= 3 && parts[0] === 'mcp') {
    const server = parts[1]
    const bare = parts.slice(2).join('__')
    const byServer = toolMapServerHint?.get(server)
    if (byServer && toolMap.has(bare)) return byServer
  }
  const last = parts[parts.length - 1]
  if (last && last !== raw && toolMap.has(last)) return toolMap.get(last) ?? null
  return null
}

// ── 记账 ───────────────────────────────────────────────────────────────────

/** 纯合并函数（单测覆盖）：把一次工具调用并入既有观测；90 天窗口裁剪只作用于 days */
export function mergeToolCall(
  prev: HostToolUsageObservation | null,
  pluginId: string,
  toolName: string,
  now: number,
): HostToolUsageObservation {
  const base: HostToolUsageObservation =
    prev && prev.v === 1 && prev.pluginId === pluginId
      ? prev
      : { v: 1, pluginId, count: 0, tools: {}, firstUsed: now, lastUsed: now, days: {} }
  const day = dayString(now)
  const cutoff = now - OBSERVATION_DAY_WINDOW * 24 * 60 * 60 * 1000
  const days: Record<string, number> = {}
  for (const [d, n] of Object.entries(base.days)) {
    const [y, m, dd] = d.split('-').map(Number)
    if (new Date(y, m - 1, dd).getTime() >= cutoff) days[d] = n
  }
  days[day] = (days[day] ?? 0) + 1
  const bare = String(toolName || '').split('__').pop() || toolName
  const tools = { ...base.tools }
  tools[bare] = (tools[bare] ?? 0) + 1
  return {
    v: 1,
    pluginId,
    count: base.count + 1,
    tools,
    firstUsed: Math.min(base.firstUsed || now, now),
    lastUsed: now,
    days,
  }
}

// (sessionId, callId) 去重：同一次调用只记一次（重发 end / 多订阅者幂等）
const recentCalls: string[] = []
const recentCallSet = new Set<string>()

function seenAlready(sessionId: string, callId: string | undefined): boolean {
  const key = `${sessionId}|${callId ?? ''}`
  if (recentCallSet.has(key)) return true
  recentCalls.push(key)
  recentCallSet.add(key)
  if (recentCalls.length > DEDUP_WINDOW) {
    const dropped = recentCalls.shift()
    if (dropped) recentCallSet.delete(dropped)
  }
  return false
}

/** 记一次插件工具调用（fire-and-forget，失败静默） */
function notePluginToolCall(event: ToolCallEndEvent): void {
  const now = Date.now()
  void (async () => {
    try {
      await ensureToolMap()
      // 映射表刷新前先按旧表解析一次（首次启动表可能为空——跳过本轮，下轮生效）
      const pluginId = resolvePluginIdForTool(event.tool)
      if (!pluginId) return
      if (seenAlready(event.sessionId, event.callId)) return
      const key = observationKey(pluginId)
      const prev = await capKv<{ value?: HostToolUsageObservation | null }>({ action: 'get', key })
      const next = mergeToolCall(prev?.value ?? null, pluginId, event.tool, now)
      await capKv({ action: 'set', key, value: next })
    } catch (e) {
      log.debug(`记录插件工具调用失败（静默降级）: ${event.tool} ${e instanceof Error ? e.message : String(e)}`)
    }
  })()
}

let initialized = false

/**
 * 启动观测（应用启动调用一次；重复调用幂等）。
 * 只在成功解析过映射表后才开始记账（ensureToolMap 首刷完成前的事件跳过）。
 */
export function initPluginToolUsageObserver(): void {
  if (initialized) return
  initialized = true
  try {
    getEventBus().on('tool_call_end', (event) => {
      const end = event as ToolCallEndEvent
      if (end.success) notePluginToolCall(end)
    }, { namespace: 'pluginToolUsageObserver' })
    void ensureToolMap() // 启动即预刷新映射表
  } catch (e) {
    initialized = false
    log.debug(`工具调用观测初始化失败（静默降级）: ${e instanceof Error ? e.message : String(e)}`)
  }
}
