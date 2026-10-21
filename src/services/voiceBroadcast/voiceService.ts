/**
 * voiceService — cap.voice 类型化客户端（前端 → RouterBus cap.voice → 音色库/内容库/缓存）
 *
 * P1 无限畅听电台资产层：前端不再感知插件名（mcpBridge 已退役），一切语义能力
 * 走本文件。合成结果统一供给 file 绝对路径 + dataUrl（base64 模式），播放 URL
 * 由 buildAudioPlayUrl 按端构建（Tauri asset 协议 / Web /api/files?token=）。
 */
import { invoke } from '@/services/transport'
import { buildFilePreviewUrl } from '@/services/tauri/fileService'

/** router_dispatch 统一返回 */
export interface DispatchResponse {
  msgId: string
  ok: boolean
  result: unknown
  error: string | null
  trace: string
}

/** 自定义音色（design/clone；预置音色由 voices.presets 下发 + 静态兜底） */
export interface CustomVoice {
  id: string
  name: string
  type: 'design' | 'clone'
  engine: string
  description?: string
  sampleFile?: string
  createdAt: number
}

/** 预置音色（插件下发） */
export interface PresetVoiceInfo {
  name: string
  voiceId: string
  language?: string
  gender?: string
}

/** 库单集句子引用 */
export interface SentenceRef {
  text: string
  audioId?: string
  file?: string
}

/** 内容库单集（一段播报 = 一个 item） */
export interface LibraryItem {
  id: string
  title: string
  topic: string
  engine: string
  voiceRef: string
  style?: string
  createdAt: number
  favorite: boolean
  tags: string[]
  source: string
  sentences: SentenceRef[]
  /** 后端可能未回传 sizeBytes（saved 列表旧字段），保留可选 */
  sizeBytes?: number
}

/** cap.voice 合成结果（file 模式给 file；base64 模式给 dataUrl；都给 file 以便入库） */
export interface SynthResult {
  ok: boolean
  audioId?: string
  cached?: boolean
  format?: string
  sizeBytes?: number
  file?: string
  dataUrl?: string
  error?: string
}

/** 库统计 */
export interface LibraryStats {
  ok: boolean
  count: number
  totalBytes: number
  cacheBytes: number
}

/** 统一 dispatch（cap.voice） */
async function dispatchVoice(payload: Record<string, unknown>): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  let res: DispatchResponse
  try {
    res = await invoke<DispatchResponse>('router_dispatch', {
      req: { target: 'cap.voice', payload },
    })
  } catch (e) {
    return { ok: false, error: `cap.voice 调用失败: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!res.ok) return { ok: false, error: res.error ?? 'cap.voice 调用失败' }
  const result = res.result as Record<string, unknown> | null
  if (!result || result.ok !== true) {
    return { ok: false, result: result ?? undefined, error: (result?.error as string) ?? 'cap.voice 未返回成功' }
  }
  return { ok: true, result }
}

// ── 合成 ──

/**
 * 合成一句（带持久缓存；voiceRef = 预置名或自定义音色 id）。
 * 返回 file（绝对路径，持续可播）+ dataUrl（base64 模式）。
 */
export async function synthesizeVoice(args: {
  text: string
  voiceRef?: string
  style?: string
  outputMode?: 'file' | 'base64'
}): Promise<SynthResult> {
  const res = await dispatchVoice({
    action: 'synthesize',
    text: args.text,
    voiceRef: args.voiceRef ?? '冰糖',
    ...(args.style ? { style: args.style } : {}),
    ...(args.outputMode ? { outputMode: args.outputMode } : {}),
  })
  if (!res.ok || !res.result) return { ok: false, error: res.error }
  return {
    ok: true,
    audioId: res.result.audioId as string,
    cached: res.result.cached as boolean,
    format: res.result.format as string,
    sizeBytes: res.result.sizeBytes as number,
    file: res.result.file as string | undefined,
    dataUrl: res.result.dataUrl as string | undefined,
  }
}

/**
 * 按端构建音频播放 URL（file 绝对路径 → Tauri asset 协议 / Web /api/files?token=）。
 * 复用 fileService 文件预览链（鉴权 + Range 支持齐备，手机可达）。
 */
export function buildAudioPlayUrl(file: string): string {
  return buildFilePreviewUrl(file)
}

// ── 音色库 ──

/** 自定义音色列表（design/clone） */
export async function listCustomVoices(): Promise<{ ok: boolean; voices: CustomVoice[]; error?: string }> {
  const res = await dispatchVoice({ action: 'voices.list' })
  if (!res.ok) return { ok: false, voices: [], error: res.error }
  return { ok: true, voices: (res.result?.voices as CustomVoice[]) ?? [] }
}

/** 预置音色（委托引擎插件拉取；失败走前端静态兜底） */
export async function listPresetVoices(): Promise<{ ok: boolean; voices: PresetVoiceInfo[]; error?: string }> {
  const res = await dispatchVoice({ action: 'voices.presets' })
  if (!res.ok) return { ok: false, voices: [], error: res.error }
  return { ok: true, voices: (res.result?.voices as PresetVoiceInfo[]) ?? [] }
}

/** 新增设计音色（描述持久化，命名入库） */
export async function addDesignVoice(name: string, description: string): Promise<{ ok: boolean; voice?: CustomVoice; error?: string }> {
  const res = await dispatchVoice({ action: 'voices.add', type: 'design', name, description })
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, voice: res.result?.voice as CustomVoice }
}

/** 新增克隆音色（样本 base64 落盘 data root，≤10MB） */
export async function addCloneVoice(name: string, sampleBase64: string, sampleName?: string): Promise<{ ok: boolean; voice?: CustomVoice; error?: string }> {
  const res = await dispatchVoice({ action: 'voices.add', type: 'clone', name, sampleBase64, ...(sampleName ? { sampleName } : {}) })
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, voice: res.result?.voice as CustomVoice }
}

export async function updateVoice(voiceId: string, patch: { name?: string; description?: string }): Promise<{ ok: boolean; voice?: CustomVoice; error?: string }> {
  const res = await dispatchVoice({ action: 'voices.update', voiceId, ...patch })
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, voice: res.result?.voice as CustomVoice }
}

export async function deleteVoice(voiceId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await dispatchVoice({ action: 'voices.delete', voiceId })
  return { ok: res.ok, error: res.error }
}

/** 试听（现场合成欢迎语；design/clone 现场参数不入库；返回 dataUrl 直接可播） */
export async function probeVoice(args: {
  kind: 'preset' | 'design' | 'clone'
  voice?: string
  description?: string
  sampleBase64?: string
  sampleName?: string
  text?: string
}): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
  const res = await dispatchVoice({
    action: 'voices.probe',
    kind: args.kind,
    voice: args.voice,
    description: args.description,
    sampleBase64: args.sampleBase64,
    sampleName: args.sampleName,
    ...(args.text ? { text: args.text } : {}),
  })
  if (!res.ok || !res.result) return { ok: false, error: res.error }
  return { ok: true, dataUrl: res.result.dataUrl as string | undefined }
}

// ── 内容库 ──

export async function listLibraryItems(filter?: { favorite?: boolean }): Promise<{ ok: boolean; items: LibraryItem[]; error?: string }> {
  const res = await dispatchVoice({ action: 'library.list', ...(filter ? { filter } : {}) })
  if (!res.ok) return { ok: false, items: [], error: res.error }
  return { ok: true, items: (res.result?.items as LibraryItem[]) ?? [] }
}

export async function getLibraryItem(itemId: string): Promise<{ ok: boolean; item?: LibraryItem; error?: string }> {
  const res = await dispatchVoice({ action: 'library.get', itemId })
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, item: res.result?.item as LibraryItem }
}

/** 段入库（播报完成自动调用 / 面板手动导入；句子音频复制入库自持） */
export async function addLibraryItem(args: {
  title: string
  topic?: string
  engine?: string
  voiceRef?: string
  style?: string
  source?: string
  sentences: Array<{ text: string; audioId?: string; file?: string }>
}): Promise<{ ok: boolean; item?: LibraryItem; error?: string }> {
  const res = await dispatchVoice({ action: 'library.add', ...args })
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, item: res.result?.item as LibraryItem }
}

export async function updateLibraryItem(itemId: string, patch: { title?: string; favorite?: boolean; tags?: string[] }): Promise<{ ok: boolean; item?: LibraryItem; error?: string }> {
  const res = await dispatchVoice({ action: 'library.update', itemId, ...patch })
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, item: res.result?.item as LibraryItem }
}

export async function deleteLibraryItem(itemId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await dispatchVoice({ action: 'library.delete', itemId })
  return { ok: res.ok, error: res.error }
}

export async function getLibraryStats(): Promise<LibraryStats | { ok: false }> {
  const res = await dispatchVoice({ action: 'library.stats' })
  if (!res.ok || !res.result) return { ok: false }
  return res.result as unknown as LibraryStats
}
