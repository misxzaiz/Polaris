/**
 * AgnesPanel - Agnes 多模态插件主面板。
 *
 * 三个 Tab：
 *  - 生图（文生图 / 图生图）
 *  - 生视频（文生 / 图生 / 多图 / 关键帧，异步轮询）
 *  - 设置（base_url / api_key / 默认模型与尺寸）
 *
 * 直接调用 src-tauri/src/commands/agnes.rs 暴露的 Tauri command，
 * 与 MCP server 共享 <appConfigDir>/agnes/config.json。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Image as ImageIcon,
  Video as VideoIcon,
  Settings as SettingsIcon,
  Loader2,
  AlertCircle,
  Download,
  Send,
  Upload,
  X,
  Sparkles,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  agnesCreateVideo,
  agnesGenerateImage,
  agnesGetConfig,
  agnesQueryVideo,
  agnesSaveConfig,
  fileToDataUrl,
  FRAME_PRESETS,
  IMAGE_SIZE_PRESETS,
  toDataUrl,
  type AgnesConfigView,
  type AgnesImageResult,
  type AgnesVideoTask,
} from './api'
import type { PluginPanelComponent } from '@/plugin-system/types'

type Tab = 'image' | 'video' | 'settings'

// ============================================================================
// 主组件
// ============================================================================

const AgnesPanel: PluginPanelComponent = ({ pluginId, onSendToChat }) => {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('image')
  const [config, setConfig] = useState<AgnesConfigView | null>(null)
  const [configLoading, setConfigLoading] = useState(true)

  const refreshConfig = useCallback(async () => {
    setConfigLoading(true)
    try {
      setConfig(await agnesGetConfig())
    } catch (e) {
      console.error('[Agnes] load config failed', e)
    } finally {
      setConfigLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshConfig()
  }, [refreshConfig])

  const noKey = !!config && !config.hasApiKey

  return (
    <div className="flex h-full flex-col">
      {/* Tab 头 */}
      <div className="flex shrink-0 border-b border-border-subtle">
        <TabButton active={tab === 'image'} onClick={() => setTab('image')} icon={<ImageIcon size={13} />} label={t('agnes.tabImage', { defaultValue: '生图' })} />
        <TabButton active={tab === 'video'} onClick={() => setTab('video')} icon={<VideoIcon size={13} />} label={t('agnes.tabVideo', { defaultValue: '生视频' })} />
        <TabButton active={tab === 'settings'} onClick={() => setTab('settings')} icon={<SettingsIcon size={13} />} label={t('agnes.tabSettings', { defaultValue: '设置' })} />
      </div>

      {/* 无 API Key 提示 */}
      {noKey && tab !== 'settings' && (
        <div className="flex shrink-0 items-start gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span>{t('agnes.noKeyHint', { defaultValue: '未配置 API Key，请先到“设置”填写。' })}</span>
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        {tab === 'image' && <ImageTab disabled={noKey} onSendToChat={onSendToChat} defaultSize={config?.defaultSize} />}
        {tab === 'video' && <VideoTab disabled={noKey} onSendToChat={onSendToChat} />}
        {tab === 'settings' && <SettingsTab config={config} loading={configLoading} onSaved={refreshConfig} />}
      </div>

      <div className="shrink-0 border-t border-border-subtle px-3 py-1.5 text-[10px] text-text-muted">
        {pluginId}
      </div>
    </div>
  )
}

// ============================================================================
// Tab 按钮
// ============================================================================

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium transition-colors ${
        active ? 'border-b-2 border-accent text-text-primary' : 'border-b-2 border-transparent text-text-secondary hover:text-text-primary hover:bg-background-hover'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

// ============================================================================
// 生图 Tab
// ============================================================================

interface ImageHistoryItem {
  prompt: string
  size: string
  src: string // url 或 data URL
  model: string
}

function ImageTab({ disabled, onSendToChat, defaultSize }: { disabled: boolean; onSendToChat?: (m: string) => void | Promise<void>; defaultSize?: string }) {
  const { t } = useTranslation()
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState(defaultSize ?? '1024x1024')
  const [mode, setMode] = useState<'text' | 'image'>('text')
  const [inputImages, setInputImages] = useState<string[]>([])
  const [responseFormat, setResponseFormat] = useState<'url' | 'b64_json'>('url')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<ImageHistoryItem[]>([])

  useEffect(() => {
    if (defaultSize) setSize(defaultSize)
  }, [defaultSize])

  const handleUpload = useCallback(async (files: FileList | null) => {
    if (!files) return
    const datas = await Promise.all(Array.from(files).slice(0, 4).map(fileToDataUrl))
    setInputImages((prev) => [...prev, ...datas].slice(0, 4))
  }, [])

  const handleGenerate = useCallback(async () => {
    if (disabled || !prompt.trim()) return
    setLoading(true)
    setError(null)
    try {
      const result: AgnesImageResult = await agnesGenerateImage({
        prompt: prompt.trim(),
        size,
        images: mode === 'image' ? inputImages : undefined,
        responseFormat,
      })
      const src = result.url ?? (result.base64 ? toDataUrl(result.base64, result.mimeType ?? 'image/png') : '')
      if (!src) throw new Error('响应缺少 url 或 base64')
      setHistory((prev) => [{ prompt: prompt.trim(), size, src, model: result.model }, ...prev].slice(0, 12))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [disabled, prompt, size, mode, inputImages, responseFormat])

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3">
      {/* 模式切换 */}
      <div className="flex gap-1 rounded-md bg-background-hover p-0.5 text-xs">
        <ModeChip active={mode === 'text'} onClick={() => setMode('text')} label={t('agnes.textToImage', { defaultValue: '文生图' })} />
        <ModeChip active={mode === 'image'} onClick={() => setMode('image')} label={t('agnes.imageToImage', { defaultValue: '图生图' })} />
      </div>

      {/* 图生图输入 */}
      {mode === 'image' && (
        <div className="space-y-2">
          <label className="block text-xs font-medium text-text-secondary">
            {t('agnes.inputImages', { defaultValue: '输入图（最多 4 张）' })}
          </label>
          <div className="flex flex-wrap gap-2">
            {inputImages.map((src, i) => (
              <div key={i} className="relative h-16 w-16 overflow-hidden rounded border border-border-subtle">
                <img src={src} alt="" className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => setInputImages((prev) => prev.filter((_, idx) => idx !== i))}
                  className="absolute right-0 top-0 bg-background-elevated/80 p-0.5 text-text-secondary hover:text-text-primary"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
            <label className="flex h-16 w-16 cursor-pointer items-center justify-center rounded border border-dashed border-border-subtle text-text-muted hover:border-accent hover:text-accent">
              <Upload size={14} />
              <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => handleUpload(e.target.files)} />
            </label>
          </div>
        </div>
      )}

      {/* 提示词 */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-text-secondary">{t('agnes.prompt', { defaultValue: '提示词' })}</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          placeholder={t('agnes.promptPlaceholder', { defaultValue: '描述要生成的图片内容…' })}
          className="w-full resize-none rounded-md border border-border-subtle bg-background-elevated px-2.5 py-2 text-xs text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </div>

      {/* 参数 */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="block text-[11px] text-text-secondary">{t('agnes.size', { defaultValue: '尺寸' })}</label>
          <select value={size} onChange={(e) => setSize(e.target.value)} className="w-full rounded-md border border-border-subtle bg-background-elevated px-2 py-1.5 text-xs text-text-primary">
            {IMAGE_SIZE_PRESETS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <label className="block text-[11px] text-text-secondary">{t('agnes.format', { defaultValue: '返回格式' })}</label>
          <select value={responseFormat} onChange={(e) => setResponseFormat(e.target.value as 'url' | 'b64_json')} className="w-full rounded-md border border-border-subtle bg-background-elevated px-2 py-1.5 text-xs text-text-primary">
            <option value="url">URL</option>
            <option value="b64_json">Base64</option>
          </select>
        </div>
      </div>

      {error && <ErrorBar message={error} />}

      <button
        type="button"
        onClick={handleGenerate}
        disabled={disabled || loading || !prompt.trim()}
        className="flex items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
        {loading ? t('agnes.generating', { defaultValue: '生成中…' }) : t('agnes.generate', { defaultValue: '生成' })}
      </button>

      {/* 历史 */}
      {history.length > 0 && (
        <div className="space-y-2">
          <div className="text-[11px] font-medium text-text-secondary">{t('agnes.history', { defaultValue: '历史' })}</div>
          <div className="grid grid-cols-2 gap-2">
            {history.map((item, i) => (
              <div key={i} className="group relative overflow-hidden rounded-md border border-border-subtle">
                <img src={item.src} alt={item.prompt} className="aspect-square w-full object-cover" />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <div className="line-clamp-2 text-[10px] text-white/90">{item.prompt}</div>
                  <div className="mt-1 flex gap-1">
                    <a href={item.src} download={`agnes-${i}.png`} className="rounded bg-white/20 p-1 text-white hover:bg-white/30"><Download size={10} /></a>
                    {onSendToChat && (
                      <button type="button" onClick={() => onSendToChat(item.src)} className="rounded bg-white/20 p-1 text-white hover:bg-white/30"><Send size={10} /></button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// 生视频 Tab
// ============================================================================

interface VideoHistoryItem {
  prompt: string
  videoId: string
  status: string
  progress: number
  url: string | null
  seconds: string | null
}

function VideoTab({ disabled, onSendToChat }: { disabled: boolean; onSendToChat?: (m: string) => void | Promise<void> }) {
  const { t } = useTranslation()
  const [prompt, setPrompt] = useState('')
  const [presetIdx, setPresetIdx] = useState(1) // 默认约 5 秒
  const [mode, setMode] = useState<'text' | 'image' | 'multi' | 'keyframes'>('text')
  const [image, setImage] = useState<string | null>(null)
  const [images, setImages] = useState<string[]>([])
  const [negativePrompt, setNegativePrompt] = useState('')
  const [seed, setSeed] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<VideoHistoryItem[]>([])
  const pollTimers = useRef<Record<string, ReturnType<typeof setInterval>>>({})

  // 卸载时清理轮询
  useEffect(() => {
    return () => {
      Object.values(pollTimers.current).forEach(clearInterval)
    }
  }, [])

  const handleUploadSingle = useCallback(async (files: FileList | null) => {
    if (!files?.[0]) return
    setImage(await fileToDataUrl(files[0]))
  }, [])

  const handleUploadMulti = useCallback(async (files: FileList | null) => {
    if (!files) return
    const datas = await Promise.all(Array.from(files).slice(0, 4).map(fileToDataUrl))
    setImages((prev) => [...prev, ...datas].slice(0, 4))
  }, [])

  const updateHistoryItem = useCallback((videoId: string, patch: Partial<VideoHistoryItem>) => {
    setHistory((prev) => prev.map((item) => (item.videoId === videoId ? { ...item, ...patch } : item)))
  }, [])

  const startPolling = useCallback((videoId: string) => {
    if (pollTimers.current[videoId]) return
    const tick = async () => {
      try {
        const task = await agnesQueryVideo(videoId)
        updateHistoryItem(videoId, { status: task.status, progress: task.progress, url: task.url, seconds: task.seconds })
        if (task.status === 'completed' || task.status === 'failed') {
          clearInterval(pollTimers.current[videoId])
          delete pollTimers.current[videoId]
        }
      } catch (e) {
        console.error('[Agnes] poll failed', e)
      }
    }
    pollTimers.current[videoId] = setInterval(tick, 5000)
    // 首次立即查一次
    tick()
  }, [updateHistoryItem])

  const handleCreate = useCallback(async () => {
    if (disabled || !prompt.trim()) return
    setLoading(true)
    setError(null)
    try {
      const preset = FRAME_PRESETS[presetIdx]
      const task: AgnesVideoTask = await agnesCreateVideo({
        prompt: prompt.trim(),
        numFrames: preset.frames,
        frameRate: preset.rate,
        image: mode === 'image' && image ? image : undefined,
        images: (mode === 'multi' || mode === 'keyframes') ? images : undefined,
        mode: mode === 'image' ? 'ti2vid' : mode === 'keyframes' ? 'keyframes' : undefined,
        negativePrompt: negativePrompt.trim() || undefined,
        seed: seed.trim() ? Number(seed) : undefined,
      })
      if (task.framesNormalized) {
        setError(t('agnes.framesNormalized', { defaultValue: '帧数已自动纠正为合法值 8n+1。' }))
      }
      const item: VideoHistoryItem = {
        prompt: prompt.trim(),
        videoId: task.videoId,
        status: task.status,
        progress: task.progress,
        url: null,
        seconds: task.seconds,
      }
      setHistory((prev) => [item, ...prev].slice(0, 8))
      startPolling(task.videoId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [disabled, prompt, presetIdx, mode, image, images, negativePrompt, seed, t, startPolling])

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3">
      {/* 模式 */}
      <div className="flex flex-wrap gap-1 rounded-md bg-background-hover p-0.5 text-xs">
        <ModeChip active={mode === 'text'} onClick={() => setMode('text')} label={t('agnes.textToVideo', { defaultValue: '文生视频' })} />
        <ModeChip active={mode === 'image'} onClick={() => setMode('image')} label={t('agnes.imageToVideo', { defaultValue: '图生视频' })} />
        <ModeChip active={mode === 'multi'} onClick={() => setMode('multi')} label={t('agnes.multiImage', { defaultValue: '多图' })} />
        <ModeChip active={mode === 'keyframes'} onClick={() => setMode('keyframes')} label={t('agnes.keyframes', { defaultValue: '关键帧' })} />
      </div>

      {/* 图输入 */}
      {mode === 'image' && (
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-text-secondary">{t('agnes.inputImage', { defaultValue: '输入图' })}</label>
          {image ? (
            <div className="relative h-20 w-32 overflow-hidden rounded border border-border-subtle">
              <img src={image} alt="" className="h-full w-full object-cover" />
              <button type="button" onClick={() => setImage(null)} className="absolute right-0 top-0 bg-background-elevated/80 p-0.5 text-text-secondary hover:text-text-primary"><X size={10} /></button>
            </div>
          ) : (
            <label className="flex h-20 w-32 cursor-pointer items-center justify-center rounded border border-dashed border-border-subtle text-text-muted hover:border-accent hover:text-accent">
              <Upload size={14} />
              <input type="file" accept="image/*" className="hidden" onChange={(e) => handleUploadSingle(e.target.files)} />
            </label>
          )}
        </div>
      )}
      {(mode === 'multi' || mode === 'keyframes') && (
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-text-secondary">{t('agnes.inputImages', { defaultValue: '输入图（2-4 张）' })}</label>
          <div className="flex flex-wrap gap-2">
            {images.map((src, i) => (
              <div key={i} className="relative h-16 w-16 overflow-hidden rounded border border-border-subtle">
                <img src={src} alt="" className="h-full w-full object-cover" />
                <button type="button" onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))} className="absolute right-0 top-0 bg-background-elevated/80 p-0.5 text-text-secondary hover:text-text-primary"><X size={10} /></button>
              </div>
            ))}
            <label className="flex h-16 w-16 cursor-pointer items-center justify-center rounded border border-dashed border-border-subtle text-text-muted hover:border-accent hover:text-accent">
              <Upload size={14} />
              <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => handleUploadMulti(e.target.files)} />
            </label>
          </div>
        </div>
      )}

      {/* 提示词 */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-text-secondary">{t('agnes.prompt', { defaultValue: '提示词' })}</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder={t('agnes.videoPromptPlaceholder', { defaultValue: '描述视频内容、镜头运动、光线…' })}
          className="w-full resize-none rounded-md border border-border-subtle bg-background-elevated px-2.5 py-2 text-xs text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </div>

      {/* 时长预设 */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-text-secondary">{t('agnes.duration', { defaultValue: '时长' })}</label>
        <div className="grid grid-cols-4 gap-1">
          {FRAME_PRESETS.map((p, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setPresetIdx(i)}
              className={`rounded border px-1 py-1.5 text-[11px] ${presetIdx === i ? 'border-accent bg-accent/10 text-accent' : 'border-border-subtle text-text-secondary hover:bg-background-hover'}`}
            >
              {p.label}
              <div className="text-[9px] text-text-muted">{p.frames}f</div>
            </button>
          ))}
        </div>
      </div>

      {/* 高级 */}
      <details className="text-xs">
        <summary className="cursor-pointer text-text-secondary">{t('agnes.advanced', { defaultValue: '高级' })}</summary>
        <div className="mt-2 space-y-2">
          <input
            value={negativePrompt}
            onChange={(e) => setNegativePrompt(e.target.value)}
            placeholder={t('agnes.negativePrompt', { defaultValue: '反向提示词' })}
            className="w-full rounded-md border border-border-subtle bg-background-elevated px-2 py-1.5 text-xs text-text-primary placeholder:text-text-muted"
          />
          <input
            value={seed}
            onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder={t('agnes.seed', { defaultValue: '随机种子（可选）' })}
            className="w-full rounded-md border border-border-subtle bg-background-elevated px-2 py-1.5 text-xs text-text-primary placeholder:text-text-muted"
          />
        </div>
      </details>

      {error && <ErrorBar message={error} />}

      <button
        type="button"
        onClick={handleCreate}
        disabled={disabled || loading || !prompt.trim()}
        className="flex items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? <Loader2 size={13} className="animate-spin" /> : <VideoIcon size={13} />}
        {loading ? t('agnes.creating', { defaultValue: '创建中…' }) : t('agnes.createVideo', { defaultValue: '创建视频' })}
      </button>

      {/* 任务列表 */}
      {history.length > 0 && (
        <div className="space-y-2">
          <div className="text-[11px] font-medium text-text-secondary">{t('agnes.tasks', { defaultValue: '任务' })}</div>
          {history.map((item) => (
            <div key={item.videoId} className="rounded-md border border-border-subtle p-2">
              <div className="line-clamp-1 text-[11px] text-text-primary">{item.prompt}</div>
              {item.url ? (
                <div className="mt-1.5">
                  <video src={item.url} controls className="w-full rounded" />
                  <div className="mt-1 flex gap-1">
                    <a href={item.url} download={`agnes-${item.videoId.slice(0, 12)}.mp4`} className="flex items-center gap-1 rounded bg-background-hover px-1.5 py-0.5 text-[10px] text-text-secondary hover:text-text-primary"><Download size={10} />{t('agnes.download', { defaultValue: '下载' })}</a>
                    {onSendToChat && (
                      <button type="button" onClick={() => onSendToChat(item.url!)} className="flex items-center gap-1 rounded bg-background-hover px-1.5 py-0.5 text-[10px] text-text-secondary hover:text-text-primary"><Send size={10} />{t('agnes.send', { defaultValue: '发送' })}</button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="mt-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-text-secondary">
                    {item.status === 'failed' ? <AlertCircle size={11} className="text-danger" /> : <Loader2 size={11} className="animate-spin" />}
                    <span>{item.status}</span>
                    {item.seconds && <span className="text-text-muted">· {item.seconds}s</span>}
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded bg-background-hover">
                    <div className="h-full bg-accent transition-all" style={{ width: `${item.progress}%` }} />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// 设置 Tab
// ============================================================================

function SettingsTab({ config, loading, onSaved }: { config: AgnesConfigView | null; loading: boolean; onSaved: () => void }) {
  const { t } = useTranslation()
  const [apiKey, setApiKey] = useState('')
  const [apiBase, setApiBase] = useState('')
  const [imageModel, setImageModel] = useState('')
  const [videoModel, setVideoModel] = useState('')
  const [defaultSize, setDefaultSize] = useState('1024x1024')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    if (config) {
      setApiBase(config.apiBase)
      setImageModel(config.imageModel)
      setVideoModel(config.videoModel)
      setDefaultSize(config.defaultSize)
    }
  }, [config])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setMsg(null)
    try {
      await agnesSaveConfig({
        apiKey: apiKey || undefined, // 留空则不改
        apiBase,
        imageModel,
        videoModel,
        defaultSize,
      })
      setApiKey('')
      setMsg({ type: 'ok', text: t('agnes.saveOk', { defaultValue: '已保存' }) })
      onSaved()
    } catch (e) {
      setMsg({ type: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }, [apiKey, apiBase, imageModel, videoModel, defaultSize, onSaved, t])

  if (loading) {
    return <div className="flex h-full items-center justify-center text-xs text-text-muted"><Loader2 size={14} className="mr-1.5 animate-spin" />{t('status.loading', { defaultValue: '加载中…' })}</div>
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3 text-xs">
      <Field label={t('agnes.apiKey', { defaultValue: 'API Key' })} hint={config ? (config.hasApiKey ? `已配置（${config.apiKeyMasked}）` : '未配置') : ''}>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={config?.hasApiKey ? '留空则不修改' : 'sk-...'}
          className="w-full rounded-md border border-border-subtle bg-background-elevated px-2 py-1.5 text-xs text-text-primary placeholder:text-text-muted"
        />
      </Field>
      <Field label={t('agnes.apiBase', { defaultValue: 'API Base URL' })}>
        <input value={apiBase} onChange={(e) => setApiBase(e.target.value)} className="w-full rounded-md border border-border-subtle bg-background-elevated px-2 py-1.5 text-xs text-text-primary" />
      </Field>
      <Field label={t('agnes.imageModel', { defaultValue: '图片模型' })}>
        <input value={imageModel} onChange={(e) => setImageModel(e.target.value)} className="w-full rounded-md border border-border-subtle bg-background-elevated px-2 py-1.5 text-xs text-text-primary" />
      </Field>
      <Field label={t('agnes.videoModel', { defaultValue: '视频模型' })}>
        <input value={videoModel} onChange={(e) => setVideoModel(e.target.value)} className="w-full rounded-md border border-border-subtle bg-background-elevated px-2 py-1.5 text-xs text-text-primary" />
      </Field>
      <Field label={t('agnes.defaultSize', { defaultValue: '默认图片尺寸' })}>
        <select value={defaultSize} onChange={(e) => setDefaultSize(e.target.value)} className="w-full rounded-md border border-border-subtle bg-background-elevated px-2 py-1.5 text-xs text-text-primary">
          {IMAGE_SIZE_PRESETS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>

      {msg && (
        <div className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] ${msg.type === 'ok' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>
          {msg.type === 'ok' ? <Sparkles size={11} /> : <AlertCircle size={11} />}
          {msg.text}
        </div>
      )}

      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="flex items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? <Loader2 size={13} className="animate-spin" /> : <SettingsIcon size={13} />}
        {t('agnes.save', { defaultValue: '保存' })}
      </button>

      <div className="mt-1 rounded-md border border-border-subtle bg-background-elevated/50 p-2 text-[10px] leading-relaxed text-text-muted">
        {t('agnes.tip', { defaultValue: 'API Key 存储在 <appConfigDir>/agnes/config.json，MCP server 与面板共享。配置变更即时生效，无需重启。' })}
      </div>
    </div>
  )
}

// ============================================================================
// 通用小组件
// ============================================================================

function ModeChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded px-2 py-1 text-[11px] transition-colors ${active ? 'bg-background-elevated text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}
    >
      {label}
    </button>
  )
}

function ErrorBar({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-1.5 rounded-md bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
      <AlertCircle size={12} className="mt-0.5 shrink-0" />
      <span className="break-all">{message}</span>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-[11px] font-medium text-text-secondary">{label}</label>
        {hint && <span className="text-[10px] text-text-muted">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

export default AgnesPanel
