/**
 * voiceBroadcast — cap.mcp 调用桥（前端 → 后端 RouterBus cap.mcp → 插件 MCP 工具）
 *
 * 唯一声音后端：mimo-tts 插件（小米 MiMo-V2.5-TTS）。本文件封装
 *   invoke('router_dispatch', { target: 'cap.mcp', payload: { action: 'call', ... } })
 * 返回形状（后端 mcp_capability.rs）：
 *   { ok, resultJson?: string, error?: string, isError?: boolean }
 * 其中 resultJson 是 MCP content[0].text，即插件 JSON.stringify 的字符串。
 */
import { invoke } from '@/services/transport'

/** router_dispatch 统一返回（与 aiChatDispatch 的 AiDispatchResponse 对齐） */
export interface DispatchResponse {
  msgId: string
  ok: boolean
  result: unknown
  error: string | null
  trace: string
}

/** cap.mcp call 的返回（后端能力层） */
export interface McpCallResponse {
  ok: boolean
  resultJson?: string | null
  error?: string
  isError?: boolean
}

/** mimo_tts_synthesize 的参数 */
export interface MimoTtsSynthesizeArgs {
  text: string
  voice?: string
  style?: string
  /** 桌面走 file(url)；移动端走 base64(audioDataUrl)。缺省由插件配置决定 */
  outputMode?: 'file' | 'base64'
}

/** 合成结果（归一化：url 与 audioDataUrl 二选一） */
export interface MimoTtsResult {
  ok: boolean
  /** 可播放地址：桌面为插件本地托管 url，base64 模式为 data URL */
  url?: string
  /** 音频格式（wav） */
  format?: string
  /** 合成文本回显 */
  text?: string
  error?: string
}

/** 预置音色 id → voice 参数（与插件默认对齐） */
export const DEFAULT_MIMO_VOICE = '冰糖'

/**
 * 调用 mimo-tts 插件合成语音。
 *
 * - 后端按 mcpServerId 精确匹配/惰性拉起插件 stdio client，防重复拉进程。
 * - 返回 `{ ok:true, url }`（file 模式）或 `{ ok:true, url: audioDataUrl }`（base64 模式）；
 *   失败 `{ ok:false, error }`。error 含插件/网络/未配置 Key 等失败原因。
 */
export async function callMimoTts(args: MimoTtsSynthesizeArgs): Promise<MimoTtsResult> {
  const payload = {
    action: 'call',
    mcpServerId: 'mimo-tts',
    tool: 'mimo_tts_synthesize',
    arguments: {
      text: args.text,
      voice: args.voice ?? DEFAULT_MIMO_VOICE,
      ...(args.style ? { style: args.style } : {}),
      ...(args.outputMode ? { outputMode: args.outputMode } : {}),
    },
  }

  let res: DispatchResponse
  try {
    res = await invoke<DispatchResponse>('router_dispatch', { req: { target: 'cap.mcp', payload } })
  } catch (e) {
    return { ok: false, error: `cap.mcp 调用失败: ${e instanceof Error ? e.message : String(e)}` }
  }

  if (!res.ok) {
    return { ok: false, error: res.error ?? 'cap.mcp 调用失败' }
  }

  const cap = res.result as McpCallResponse | undefined
  if (!cap?.ok) {
    return { ok: false, error: cap?.error ?? 'cap.mcp 未返回成功' }
  }

  // resultJson 是插件 JSON.stringify 的字符串（success / error）
  let parsed: Record<string, unknown> | null = null
  if (typeof cap.resultJson === 'string' && cap.resultJson.trim()) {
    try {
      parsed = JSON.parse(cap.resultJson) as Record<string, unknown>
    } catch {
      return { ok: false, error: `无法解析 TTS 合成结果: ${cap.resultJson.slice(0, 80)}` }
    }
  }

  if (!parsed || parsed.success !== true) {
    const errMsg = (parsed?.error as string) ?? 'TTS 合成未成功（可能是 API Key 未配置）'
    return { ok: false, error: errMsg }
  }

  const url = (parsed.url as string) ?? (parsed.audioDataUrl as string)
  if (!url) {
    return { ok: false, error: 'TTS 合成结果缺少音频地址' }
  }

  return {
    ok: true,
    url,
    format: (parsed.format as string) ?? undefined,
    text: (parsed.text as string) ?? undefined,
  }
}

/**
 * 列出 mimo-tts 预置音色（P0-6：面板动态渲染，预置列表作兜底）。
 */
export interface MimoVoiceInfo {
  name: string
  voiceId: string
  language?: string
  gender?: string
}

export async function listMimoVoices(): Promise<{ ok: boolean; voices: MimoVoiceInfo[]; error?: string }> {
  let res: DispatchResponse
  try {
    res = await invoke<DispatchResponse>('router_dispatch', {
      req: { target: 'cap.mcp', payload: { action: 'call', mcpServerId: 'mimo-tts', tool: 'mimo_tts_list_voices', arguments: {} } },
    })
  } catch (e) {
    return { ok: false, voices: [], error: `cap.mcp 调用失败: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!res.ok) return { ok: false, voices: [], error: res.error ?? 'cap.mcp 调用失败' }
  const cap = res.result as McpCallResponse | undefined
  if (!cap?.ok) return { ok: false, voices: [], error: cap?.error ?? 'cap.mcp 未返回成功' }

  let parsed: { voices?: MimoVoiceInfo[] } | null = null
  if (typeof cap.resultJson === 'string' && cap.resultJson.trim()) {
    try {
      parsed = JSON.parse(cap.resultJson) as { voices?: MimoVoiceInfo[] }
    } catch {
      return { ok: false, voices: [], error: '无法解析音色列表' }
    }
  }
  if (!parsed?.voices || !Array.isArray(parsed.voices)) {
    return { ok: false, voices: [], error: '音色列表为空' }
  }
  return { ok: true, voices: parsed.voices }
}

/**
 * 探测 mimo-tts 可用性（开始播报前的快速预检，避免无谓进 error 态）。
 *
 * 用最小文本合成一次；成功即返回 true。失败返回 false（原因可在 error 中看到）。
 * 不做重试——预检失败直接引导用户配置插件。
 */
export async function probeMimoTts(voice?: string): Promise<{ ok: boolean; error?: string }> {
  const res = await callMimoTts({ text: '。', voice, outputMode: 'base64' })
  if (res.ok) return { ok: true }
  return { ok: false, error: res.error }
}
