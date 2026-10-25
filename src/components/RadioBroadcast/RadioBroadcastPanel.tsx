/**
 * RadioBroadcastPanel — AI 连续语音播报面板（左侧边栏，生产级）
 *
 * 形态：
 *  - 常驻左侧面板（ActivityBar 图标 + LeftPanel 挂载）。
 *  - 配置视图：4 个语义分组（内容/声音/模型/控制）+ 主按钮；播报中也可切到配置查看，播报不中断。
 *  - 播报中视图：正在朗读句 + 进度（句/段/累计时长/上限剩余）+ 暂停/停止。
 *  - 配置持久化（radioBroadcastPrefsStore localStorage）；Toast 反馈；输入校验；i18n；aria。
 *
 * 消费：useRadioBroadcast()（状态 + action）+ useRadioBroadcastPrefsStore()（配置偏好）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import {
  Bot,
  Zap,
  AudioWaveform,
  Play,
  Square,
  Pause,
  Loader2,
  RefreshCw,
  Settings2,
  ArrowLeft,
  Volume2,
  CircleDot,
  Gauge,
  Timer,
  Radio,
  Library,
  Mic,
  Star,
  Trash2,
  Sparkles,
  Upload,
  RotateCcw,
  MessageCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useRadioBroadcast } from '@/hooks/useRadioBroadcast'
import type { DirectionKind, RadioBroadcastStatus, RadioBroadcastTranscript, VoiceId } from '@/services/voiceBroadcast/types'
import {
  listLibraryItems,
  deleteLibraryItem,
  updateLibraryItem,
  listCustomVoices,
  listPresetVoices,
  addDesignVoice,
  addCloneVoice,
  deleteVoice,
  probeVoice,
} from '@/services/voiceBroadcast/voiceService'
import type { LibraryItem, CustomVoice, PresetVoiceInfo } from '@/services/voiceBroadcast/voiceService'
import { MIMO_VOICES, normalizeVoiceId } from '@/services/voiceBroadcast/constants'
import { useEngineMetadataStore } from '@/stores/engineMetadataStore'
import { useConfigStore } from '@/stores/configStore'
import { SessionConfigSelector } from '@/components/Chat/session/SessionConfigSelector'
import type { SessionRuntimeConfig } from '@/types/sessionConfig'
import { OFFICIAL_API_PROFILE } from '@/types/modelProfile'
import { normalizeEngineId, getEngineFullName } from '@/utils/engineDisplay'
import { useToastStore } from '@/stores/toastStore'
import { useRadioBroadcastPrefsStore } from '@/stores/radioBroadcastPrefsStore'

/** 方向 key → 中文标签（与 DIRECTION_PRESETS 对齐） */
const DIRECTION_LABELS: Record<DirectionKind, string> = {
  study: '学习',
  story: '故事',
  tech: '技术',
  news: '新闻',
  custom: '自定义',
}

/** 引擎选择（元数据 store 加载后动态；兜 low 用 claude/simple-ai 两档） */
function useEngineOptions() {
  const metadatas = useEngineMetadataStore((s) => s.metadatas)
  return useMemo(() => {
    if (metadatas.length > 0) {
      return metadatas.map((meta) => ({
        id: normalizeEngineId(meta.id),
        label: meta.name,
        Icon: Bot,
      }))
    }
    return [
      { id: 'claude-code' as const, label: 'Claude', Icon: Bot },
      { id: 'simple-ai' as const, label: 'Simple', Icon: Zap },
    ]
  }, [metadatas])
}

/** 累计时长格式化（mm:ss / h:mm:ss） */
function formatDuration(ms: number): string {
  if (ms <= 0) return '0:00'
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** 倍速档位循环顺序（P0-2） */
const SPEED_STEPS = [1, 1.25, 1.5, 2, 0.75] as const

export function RadioBroadcastPanel() {
  const { t } = useTranslation('common')
  const rb = useRadioBroadcast()
  const prefs = useRadioBroadcastPrefsStore()
  const { setPrefs } = useRadioBroadcastPrefsStore()
  const toast = useToastStore()

  // kind/text/voice 跟随 prefs（持久化）
  const [kind, setKind] = useState<DirectionKind>(prefs.kind)
  const [directionText, setDirectionText] = useState(prefs.directionText)
  const [voice, setVoice] = useState<VoiceId>(prefs.voice)
  const [volume, setVolume] = useState(prefs.volume)
  const [base64Mode, setBase64Mode] = useState(prefs.base64Mode)
  const [voiceStopEnabled, setVoiceStopEnabled] = useState(prefs.voiceStopEnabled)
  const [engineId, setEngineId] = useState<string>(prefs.engineId || normalizeEngineId(useConfigStore.getState().config?.defaultEngine))
  const [providerConfig, setProviderConfig] = useState<SessionRuntimeConfig>(prefs.providerConfig)
  const [maxRounds, setMaxRounds] = useState(prefs.maxRounds)
  const [maxSeconds, setMaxSeconds] = useState(prefs.maxSeconds)

  // 输入校验态（非法轮次/时长 → 红框）
  const [roundsInvalid, setRoundsInvalid] = useState(false)
  const [secondsInvalid, setSecondsInvalid] = useState(false)

  // 播报中是否正在查看配置（双视图可达，播报不中断）
  const [showConfigWhilePlaying, setShowConfigWhilePlaying] = useState(false)

  // 页签（P1）：畅听（现有播放/配置双视图）/ 内容库 / 音色库
  const [tab, setTab] = useState<'listen' | 'library' | 'voices'>('listen')
  /** 音色列表版本号：音色库内增删后 ++，触发上方音色下拉重拉 */
  const [voiceListVersion, setVoiceListVersion] = useState(0)

  // 插话输入（P2-2）：播报视图内
  const [interjectText, setInterjectText] = useState('')
  const commitInterject = () => {
    if (!interjectText.trim()) return
    rb.interject(interjectText)
    setInterjectText('')
  }

  // 「继续上次畅听」（P2-3）：idle 态读取上次快照
  interface LastSession {
    direction: { kind: DirectionKind; text: string }
    voice: VoiceId
    ts: number
  }
  const [lastSession, setLastSession] = useState<LastSession | null>(null)
  const isIdle = rb.status === 'idle'
  useEffect(() => {
    try {
      const raw = localStorage.getItem('polaris.radioLastSession')
      const parsed = raw ? (JSON.parse(raw) as LastSession) : null
      // 旧快照可能存显示名「MiMo-默认」（API 不认，会 400），读入时统一纠正
      if (parsed?.voice) parsed.voice = normalizeVoiceId(parsed.voice)
      if (parsed?.direction?.text) setLastSession(parsed)
    } catch { /* 静默 */ }
  }, [isIdle])
  const resumeLastSession = () => {
    if (!lastSession) return
    const official = providerConfig.profileMode === 'official'
    setKind(lastSession.direction.kind)
    setDirectionText(lastSession.direction.text)
    setVoice(lastSession.voice)
    void rb.start({
      direction: lastSession.direction,
      voice: lastSession.voice,
      volume,
      base64Mode,
      voiceStopEnabled,
      rate: speed,
      engineId: engineId !== defaultEngineId ? engineId : undefined,
      modelProfileId: official ? OFFICIAL_API_PROFILE : providerConfig.modelProfileId || undefined,
      model: providerConfig.model || undefined,
    })
  }

  // 倍速（P0-2）：prefs 持久化，播报中即时生效
  const speed = prefs.speed ?? 1
  const cycleSpeed = () => {
    const idx = SPEED_STEPS.indexOf(speed as (typeof SPEED_STEPS)[number])
    const next = SPEED_STEPS[(idx + 1 + SPEED_STEPS.length) % SPEED_STEPS.length] // idx=-1（存量 prefs 无此字段）时落到 1
    setPrefs({ speed: next })
    rb.setRate(next)
  }

  // 睡眠定时（P0-3）：快捷档
  const sleepActive = rb.sleepUntil > 0 || rb.sleepAfterSegment
  const handleSleep = (opts: { minutes?: number; afterSegment?: boolean } | null) => {
    rb.sleep(opts)
  }

  // 动态音色列表（P1）：预置（voices.presets 插件下发，失败回退静态）+ 自定义（cap.voice 库）；
  // 切到音色库页签时重拉（同步新增/删除结果）
  const [voiceOptions, setVoiceOptions] = useState(MIMO_VOICES)
  useEffect(() => {
    let alive = true
    Promise.all([listPresetVoices(), listCustomVoices()])
      .then(([presets, customs]) => {
        if (!alive) return
        const dyn = presets.ok
          ? presets.voices.map((v) => ({
              id: v.voiceId,
              label: v.name,
              desc: [v.language, v.gender].filter(Boolean).join(' · ') || '云端音色',
            }))
          : []
        const customOps = customs.ok
          ? customs.voices.map((v) => ({
              id: v.id,
              label: `★ ${v.name}`,
              desc: v.type === 'clone' ? '克隆音色' : '设计音色',
            }))
          : []
        const seen = new Set([...dyn, ...customOps].map((v) => v.id))
        const merged = [...customOps, ...dyn, ...MIMO_VOICES.filter((v) => !seen.has(v.id))]
        setVoiceOptions(merged.length > 0 ? merged : MIMO_VOICES)
      })
      .catch(() => { /* 拉取失败：保留静态预置兜底 */ })
    return () => { alive = false }
  }, [tab === 'voices', voiceListVersion])
  // 选中音色不在选项（动态列表加载前/被裁剪）→ 头插保证 select 可显示
  const voiceChoices = useMemo(
    () => (voiceOptions.some((v) => v.id === voice) ? voiceOptions : [{ id: voice, label: voice, desc: '' }, ...voiceOptions]),
    [voiceOptions, voice],
  )

  // 播报结束后复位「查看配置」态：下次开始默认回到播报视图
  useEffect(() => {
    if (rb.status === 'idle') setShowConfigWhilePlaying(false)
  }, [rb.status])

  // 引擎选择内部：默认跟随全局，显式选才覆盖
  const engineOptions = useEngineOptions()
  const defaultEngineId = normalizeEngineId(useConfigStore.getState().config?.defaultEngine)

  // 写回 prefs（debounce 不必要，量小；直接 set）
  useEffect(() => {
    setPrefs({ kind, directionText, voice, volume, base64Mode, voiceStopEnabled })
  }, [kind, directionText, voice, volume, base64Mode, voiceStopEnabled, setPrefs])
  useEffect(() => {
    setPrefs({ engineId: engineId === defaultEngineId ? '' : engineId, providerConfig })
  }, [engineId, providerConfig, defaultEngineId, setPrefs])
  useEffect(() => {
    setPrefs({ maxRounds, maxSeconds })
  }, [maxRounds, maxSeconds, setPrefs])

  // Toast 反馈：自动停止 / 语音口令 / 手动停止 / error
  // 触发依据：status 从非 idle 回到 idle 且 stopReason 非空（首次渲染不回放）。
  const prevStatusRef = useRef(rb.status)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = rb.status
    const reason = rb.stopReason
    const stoppingNow = prev !== 'idle' && rb.status === 'idle' && !!reason
    if (!stoppingNow || !reason) return
    const map: Record<string, { type: 'info' | 'error'; title: string }> = {
      'max-rounds': { type: 'info', title: t('radioBroadcast.toast.maxRounds', { defaultValue: '已播满上限，自动停止播报' }) },
      'max-seconds': { type: 'info', title: t('radioBroadcast.toast.maxSeconds', { defaultValue: '已达时长上限，自动停止播报' }) },
      sleep: { type: 'info', title: t('radioBroadcast.toast.sleep', { defaultValue: '定时到，已停止播报' }) },
      'voice-command': { type: 'info', title: t('radioBroadcast.toast.voiceStopped', { defaultValue: '已通过语音口令停止播报' }) },
      manual: { type: 'info', title: t('radioBroadcast.toast.stopped', { defaultValue: '已停止播报' }) },
      finished: { type: 'info', title: t('radioBroadcast.toast.finished', { defaultValue: '回听结束，已播完全部内容' }) },
      error: { type: 'error', title: t('radioBroadcast.toast.error', { defaultValue: '播报出错' }) },
    }
    const item = map[reason]
    if (!item) return
    if (item.type === 'info') toast.info(item.title)
    else toast.error(item.title)
  }, [rb.status, rb.stopReason, toast, t])

  // start 成功反馈：status 从 idle 进入 playing/generating 提示一次
  const prevStatusForStart = useRef(rb.status)
  useEffect(() => {
    const prev = prevStatusForStart.current
    prevStatusForStart.current = rb.status
    const startedNow = prev === 'idle' && (rb.status === 'playing' || rb.status === 'generating')
    if (startedNow) {
      toast.success(t('radioBroadcast.toast.started', { defaultValue: '播报开始' }))
    }
  }, [rb.status, toast, t])

  // start 失败（预检 mimo-tts）→ error Toast（error 态由状态徽标 + Toast 双重提示）
  const prevError = useRef<string | null>(null)
  useEffect(() => {
    if (rb.status === 'error' && rb.error && prevError.current !== rb.error) {
      prevError.current = rb.error
      toast.error(rb.error)
    }
    if (rb.status !== 'error') prevError.current = null
  }, [rb.status, rb.error, toast])

  const validate = (): boolean => {
    let ok = true
    if (maxRounds.trim()) {
      const v = Number(maxRounds)
      const valid = Number.isInteger(v) && v >= 1
      setRoundsInvalid(!valid)
      if (!valid) ok = false
    } else setRoundsInvalid(false)
    if (maxSeconds.trim()) {
      const v = Number(maxSeconds)
      const valid = Number.isInteger(v) && v >= 1
      setSecondsInvalid(!valid)
      if (!valid) ok = false
    } else setSecondsInvalid(false)
    return ok
  }

  const handleStart = async () => {
    if (!validate()) {
      toast.warning(t('radioBroadcast.toast.invalidLimits', { defaultValue: '轮次/时长需为 ≥1 的整数' }))
      return
    }
    const official = providerConfig.profileMode === 'official'
    const modelProfileId = official ? OFFICIAL_API_PROFILE : providerConfig.modelProfileId || undefined
    const rounds = Number(maxRounds)
    const seconds = Number(maxSeconds)
    await rb.start({
      direction: { kind, text: directionText || DIRECTION_LABELS[kind] },
      voice,
      volume,
      base64Mode,
      voiceStopEnabled,
      rate: speed,
      engineId: engineId !== defaultEngineId ? engineId : undefined,
      modelProfileId,
      model: providerConfig.model || undefined,
      maxRounds: Number.isFinite(rounds) && rounds > 0 ? rounds : undefined,
      maxSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined,
    })
  }

  const handleStop = async () => {
    await rb.stop()
  }

  const handlePauseResume = () => {
    if (rb.isPlaying) rb.pause()
    else rb.resume()
  }

  // 视图决定：idle/error → 配置；播报中 → 默认播报视图，可切配置（不中断）
  const showConfigView =
    rb.status === 'idle' || rb.status === 'error' || (rb.isActive && showConfigWhilePlaying)
  const showPlayingView = rb.isActive && !showConfigWhilePlaying

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto">
      {/* 头部：标题 + 状态徽标（aria-live） */}
      <div className="mb-3 flex shrink-0 items-center justify-between px-1">
        <div className="flex items-center gap-2 text-text-primary">
          <AudioWaveform size={16} />
          <span className="text-[13px] font-medium">
            {t('radioBroadcast.panelTitle', { defaultValue: 'AI 连续播报' })}
          </span>
        </div>
        {rb.status !== 'idle' && (
          <span
            aria-live="polite"
            role="status"
            className={clsx(
              'rounded-full px-2 py-0.5 text-[11px]',
              rb.status === 'error'
                ? 'bg-red-500/15 text-red-400'
                : rb.status === 'generating'
                  ? 'bg-yellow-500/15 text-yellow-500'
                  : 'bg-emerald-500/15 text-emerald-500',
            )}
          >
            {STATUS_TEXT[rb.status]}
          </span>
        )}
      </div>

      {/* 页签栏（P1）：畅听 / 内容库 / 音色库 */}
      <nav
        role="tablist"
        aria-label={t('radioBroadcast.tabs', { defaultValue: '电台页签' })}
        className="mb-3 flex shrink-0 items-center gap-1 rounded-md bg-[rgb(var(--c-bg-elevated)/0.4)] p-0.5"
      >
        {([
          { key: 'listen', label: t('radioBroadcast.tab.listen', { defaultValue: '畅听' }), Icon: Radio },
          { key: 'library', label: t('radioBroadcast.tab.library', { defaultValue: '内容库' }), Icon: Library },
          { key: 'voices', label: t('radioBroadcast.tab.voices', { defaultValue: '音色库' }), Icon: Mic },
        ] as const).map(({ key, label, Icon }) => (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={clsx(
              'flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-[11.5px] transition-colors',
              tab === key
                ? 'bg-[rgb(var(--c-accent)/0.18)] text-[rgb(var(--c-accent))]'
                : 'text-text-secondary hover:text-text-primary',
            )}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </nav>

      {/* ===== 播报中视图 ===== */}
      {tab === 'listen' && showPlayingView && (
        <div className="flex flex-col gap-3">
          {/* 播报中快捷：查看配置（不中断） */}
          {rb.isActive && (
            <button
              type="button"
              onClick={() => setShowConfigWhilePlaying(true)}
              aria-label={t('radioBroadcast.configView', { defaultValue: '查看配置' })}
              className="flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-[11.5px] text-text-secondary transition-colors hover:bg-[rgb(var(--c-bg-elevated)/0.6)] hover:text-text-primary"
            >
              <Settings2 size={13} />
              {t('radioBroadcast.configView', { defaultValue: '查看配置' })}
            </button>
          )}

          <div className="text-[12.5px] leading-relaxed text-text-primary">
            <span className="text-text-secondary">{DIRECTION_LABELS[rb.direction.kind]} · </span>
            {rb.direction.text}
          </div>

          {/* 字幕跟读（P0-1）：全文滚动文稿，当前句高亮 + 自动居中 */}
          {rb.transcript && rb.transcript.lines.length > 0 ? (
            <TranscriptView transcript={rb.transcript} isPlaying={rb.isPlaying} />
          ) : (
            <div
              aria-label={t('radioBroadcast.nowPlaying', { defaultValue: '正在朗读' })}
              className="max-h-28 overflow-y-auto rounded-md bg-[rgb(var(--c-bg-elevated)/0.5)] px-3 py-2 text-[12.5px] leading-relaxed text-text-primary"
            >
              <div className="mb-1 flex items-center gap-1 text-[10.5px] uppercase tracking-wide text-text-tertiary">
                {rb.isPlaying ? (
                  <span className="animate-eq-bars flex items-end gap-[2px]" aria-hidden>
                    <span />
                    <span />
                    <span />
                  </span>
                ) : (
                  <AudioWaveform size={11} />
                )}
                {rb.status === 'generating'
                  ? t('radioBroadcast.generating', { defaultValue: '内容生成中…' })
                  : t('radioBroadcast.nowPlaying', { defaultValue: '正在朗读' })}
              </div>
              {rb.nowPlayingText}
            </div>
          )}

          {/* 进度：累计时长 + 句/段 + 上限剩余 */}
          <ProgressInfo startedAt={rb.startedAt} segmentCount={rb.segmentCount} segmentIndex={rb.segment?.index} maxRounds={rb.maxRounds} maxSeconds={rb.maxSeconds} />

          {/* 插话（P2-2）：半双工——提交后暂停播报，AI 回复到达后自动续播 */}
          <div className="flex items-center gap-1.5">
            <input
              value={interjectText}
              onChange={(e) => setInterjectText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitInterject()
              }}
              placeholder={t('radioBroadcast.interjectPlaceholder', { defaultValue: '插话：说点什么，AI 会回应后继续播报…' })}
              aria-label={t('radioBroadcast.interject', { defaultValue: '插话' })}
              className="min-w-0 flex-1 rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.6)] px-2.5 py-1.5 text-[12px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-[rgb(var(--c-accent)/0.6)]"
            />
            <button
              type="button"
              onClick={commitInterject}
              disabled={!interjectText.trim()}
              aria-label={t('radioBroadcast.interject', { defaultValue: '插话' })}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.6)] px-2.5 py-1.5 text-[11.5px] text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              <MessageCircle size={12} />
              {t('radioBroadcast.interject', { defaultValue: '插话' })}
            </button>
          </div>

          {/* 倍速 + 睡眠定时快捷条（P0-2 / P0-3） */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={cycleSpeed}
              aria-label={t('radioBroadcast.speed', { defaultValue: '倍速' })}
              title={t('radioBroadcast.speedHint', { defaultValue: '点击切换倍速' })}
              className="flex items-center gap-1 rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.6)] px-2 py-1 text-[11.5px] text-text-secondary transition-colors hover:text-text-primary"
            >
              <Gauge size={12} />
              {speed}x
            </button>
            <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
            <button
              type="button"
              onClick={() => handleSleep({ minutes: 15 })}
              aria-label={t('radioBroadcast.sleep15', { defaultValue: '15 分钟后停止' })}
              className={clsx(
                'flex items-center gap-1 rounded-md border px-2 py-1 text-[11.5px] transition-colors',
                sleepActive && rb.sleepUntil > 0
                  ? 'border-[rgb(var(--c-accent)/0.5)] bg-[rgb(var(--c-accent)/0.15)] text-[rgb(var(--c-accent))]'
                  : 'border-border bg-[rgb(var(--c-bg-elevated)/0.6)] text-text-secondary hover:text-text-primary',
              )}
            >
              <Timer size={12} />
              15m
            </button>
            <button
              type="button"
              onClick={() => handleSleep({ minutes: 30 })}
              aria-label={t('radioBroadcast.sleep30', { defaultValue: '30 分钟后停止' })}
              className="flex items-center gap-1 rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.6)] px-2 py-1 text-[11.5px] text-text-secondary transition-colors hover:text-text-primary"
            >
              <Timer size={12} />
              30m
            </button>
            <button
              type="button"
              onClick={() => handleSleep({ afterSegment: true })}
              aria-label={t('radioBroadcast.sleepAfterSegment', { defaultValue: '播完本段停止' })}
              className={clsx(
                'rounded-md border px-2 py-1 text-[11.5px] transition-colors',
                rb.sleepAfterSegment
                  ? 'border-[rgb(var(--c-accent)/0.5)] bg-[rgb(var(--c-accent)/0.15)] text-[rgb(var(--c-accent))]'
                  : 'border-border bg-[rgb(var(--c-bg-elevated)/0.6)] text-text-secondary hover:text-text-primary',
              )}
            >
              {t('radioBroadcast.sleepAfterSegment', { defaultValue: '播完本段' })}
            </button>
            {sleepActive && (
              <button
                type="button"
                onClick={() => handleSleep(null)}
                aria-label={t('radioBroadcast.sleepCancel', { defaultValue: '取消定时' })}
                className="rounded-md px-1.5 py-1 text-[11px] text-text-tertiary underline underline-offset-2 hover:text-text-secondary"
              >
                {t('radioBroadcast.sleepCancel', { defaultValue: '取消定时' })}
                {rb.sleepUntil > 0 && `（${new Date(rb.sleepUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}）`}
              </button>
            )}
          </div>

          {rb.error && (
            <div className="rounded-md bg-red-500/10 px-2.5 py-2 text-[12px] text-red-400">
              {rb.error}
            </div>
          )}

          {/* 播放控制条（暂停/继续 + 停止） */}
          <PlaybackControls
            status={rb.status}
            isPlaying={rb.isPlaying}
            playingText={null}
            onPauseResume={handlePauseResume}
            onStop={handleStop}
          />
        </div>
      )}

      {/* ===== 配置视图 ===== */}
      {tab === 'listen' && showConfigView && (
        <div className="flex flex-col gap-3">
          {/* 播报中查看配置头：返回播放视图 */}
          {rb.isActive && (
            <button
              type="button"
              onClick={() => setShowConfigWhilePlaying(false)}
              aria-label={t('radioBroadcast.backToPlayback', { defaultValue: '返回播报' })}
              className="flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-[11.5px] text-text-secondary transition-colors hover:bg-[rgb(var(--c-bg-elevated)/0.6)] hover:text-text-primary"
            >
              <ArrowLeft size={13} />
              {t('radioBroadcast.backToPlayback', { defaultValue: '返回播报' })}
            </button>
          )}
          {rb.isActive && (
            <div className="rounded-md bg-yellow-500/10 px-2.5 py-1.5 text-[11.5px] text-yellow-500">
              {t('radioBroadcast.playingHint', { defaultValue: '播报进行中，修改将应用于下次播报' })}
            </div>
          )}

          {/* ① 内容 */}
          <div className="rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.4)] px-3 py-2.5">
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-text-secondary">
              <CircleDot size={12} />
              {t('radioBroadcast.section.content', { defaultValue: '内容' })}
            </div>
            <div className="flex flex-wrap gap-1">
              {(['study', 'story', 'tech', 'news', 'custom'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  aria-pressed={kind === k}
                  className={clsx(
                    'rounded-md px-2 py-1 text-[12px] transition-colors',
                    kind === k
                      ? 'bg-[rgb(var(--c-accent)/0.18)] text-[rgb(var(--c-accent))]'
                      : 'bg-[rgb(var(--c-bg-elevated)/0.6)] text-text-secondary hover:text-text-primary',
                  )}
                >
                  {DIRECTION_LABELS[k]}
                </button>
              ))}
            </div>
            <input
              value={directionText}
              onChange={(e) => setDirectionText(e.target.value)}
              placeholder={t('radioBroadcast.directionPlaceholder', { defaultValue: '如：经济学基础、王阳明传、今日要闻…' })}
              aria-label={t('radioBroadcast.directionInput', { defaultValue: '播报内容' })}
              className="mt-2 w-full rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.6)] px-2.5 py-1.5 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-[rgb(var(--c-accent)/0.6)]"
            />
            {/* 换台（P2-1）：播报中显式触发——同会话岔题，不停声 */}
            {rb.isActive && (
              <button
                type="button"
                onClick={() => rb.switchTopic({ kind, text: directionText.trim() || DIRECTION_LABELS[kind] })}
                aria-label={t('radioBroadcast.switchTopic', { defaultValue: '立即换台' })}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-[rgb(var(--c-accent)/0.4)] bg-[rgb(var(--c-accent)/0.12)] px-2.5 py-1.5 text-[12px] text-[rgb(var(--c-accent))] transition-colors hover:bg-[rgb(var(--c-accent)/0.2)]"
              >
                <Radio size={12} />
                {t('radioBroadcast.switchTopic', { defaultValue: '立即换台（不停播）' })}
              </button>
            )}
          </div>

          {/* ② 声音 */}
          <div className="rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.4)] px-3 py-2.5">
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-text-secondary">
              <Volume2 size={12} />
              {t('radioBroadcast.section.voice', { defaultValue: '声音' })}
            </div>
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value as VoiceId)}
              aria-label={t('radioBroadcast.voiceSelect', { defaultValue: '音色' })}
              className="w-full rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.6)] px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-[rgb(var(--c-accent)/0.6)]"
            >
              {voiceChoices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}{v.desc ? ` — ${v.desc}` : ''}
                </option>
              ))}
            </select>
            <div className="mt-2 flex items-center gap-2">
              <Volume2 size={13} className="shrink-0 text-text-tertiary" />
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                aria-label={t('radioBroadcast.volume', { defaultValue: '音量' })}
                className="w-full accent-[rgb(var(--c-accent))]"
              />
              <span className="w-7 shrink-0 text-right text-[11px] text-text-tertiary">
                {Math.round(volume * 100)}%
              </span>
            </div>
          </div>

          {/* ③ 模型 */}
          <div className="rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.4)] px-3 py-2.5">
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-text-secondary">
              <Bot size={12} />
              {t('radioBroadcast.section.model', { defaultValue: '模型' })}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {engineOptions.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setEngineId(id)}
                  title={getEngineFullName(id)}
                  aria-pressed={engineId === id}
                  className={clsx(
                    'flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] transition-colors',
                    engineId === id
                      ? 'bg-[rgb(var(--c-accent)/0.18)] text-[rgb(var(--c-accent))]'
                      : 'bg-[rgb(var(--c-bg-elevated)/0.6)] text-text-secondary hover:text-text-primary',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-text-tertiary">
              {t('radioBroadcast.engineHintPlaying', { defaultValue: '播报中修改将在下次播报生效；默认跟随全局引擎。' })}
            </p>
            <div className="mt-1">
              <SessionConfigSelector
                config={providerConfig}
                onChange={setProviderConfig}
                visibleTypes={['profile', 'model']}
                variant="panel"
                engineOverride={engineId}
                writeThroughToSession={false}
              />
            </div>
          </div>

          {/* ④ 控制 */}
          <div className="rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.4)] px-3 py-2.5">
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-text-secondary">
              <Settings2 size={12} />
              {t('radioBroadcast.section.control', { defaultValue: '控制' })}
            </div>
            {/* 自动停止 */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <input
                  type="number"
                  min={1}
                  value={maxRounds}
                  onChange={(e) => setMaxRounds(e.target.value)}
                  placeholder={t('radioBroadcast.maxRoundsPlaceholder', { defaultValue: '播 N 轮' })}
                  aria-label={t('radioBroadcast.maxRounds', { defaultValue: '播放轮次上限' })}
                  aria-invalid={roundsInvalid}
                  className={clsx(
                    'w-full rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.6)] px-2.5 py-1.5 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-[rgb(var(--c-accent)/0.6)]',
                    roundsInvalid && 'border-red-500/60 focus:border-red-500',
                  )}
                />
                {roundsInvalid && (
                  <p className="mt-1 text-[10.5px] text-red-400">
                    {t('radioBroadcast.invalidRounds', { defaultValue: '请输入 ≥1 的整数' })}
                  </p>
                )}
              </div>
              <div>
                <input
                  type="number"
                  min={1}
                  value={maxSeconds}
                  onChange={(e) => setMaxSeconds(e.target.value)}
                  placeholder={t('radioBroadcast.maxSecondsPlaceholder', { defaultValue: '播 N 分钟' })}
                  aria-label={t('radioBroadcast.maxSeconds', { defaultValue: '播放时长上限' })}
                  aria-invalid={secondsInvalid}
                  className={clsx(
                    'w-full rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.6)] px-2.5 py-1.5 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-[rgb(var(--c-accent)/0.6)]',
                    secondsInvalid && 'border-red-500/60 focus:border-red-500',
                  )}
                />
                {secondsInvalid && (
                  <p className="mt-1 text-[10.5px] text-red-400">
                    {t('radioBroadcast.invalidSeconds', { defaultValue: '请输入 ≥1 的整数' })}
                  </p>
                )}
              </div>
            </div>
            <p className="mt-1 text-[11px] text-text-tertiary">
              {t('radioBroadcast.limitsHint', { defaultValue: '填「播 N 轮」= 播满 N 段后自动停止；填「播 N 分钟」按时长兜底。都不填则无限连续播报。' })}
            </p>
            {/* 开关项 */}
            <div className="mt-2 flex flex-col gap-1.5">
              <label className="flex cursor-pointer items-center justify-between gap-2">
                <span className="text-[12px] text-text-secondary">
                  {t('radioBroadcast.voiceStop', { defaultValue: '语音「停止」口令' })}
                </span>
                <input
                  type="checkbox"
                  checked={voiceStopEnabled}
                  onChange={(e) => setVoiceStopEnabled(e.target.checked)}
                  aria-label={t('radioBroadcast.voiceStop', { defaultValue: '语音「停止」口令' })}
                  className="h-3.5 w-3.5 accent-[rgb(var(--c-accent))]"
                />
              </label>
              <label className="flex cursor-pointer items-center justify-between gap-2">
                <span className="text-[12px] text-text-secondary">
                  {t('radioBroadcast.base64', { defaultValue: '移动端模式（base64 音频）' })}
                </span>
                <input
                  type="checkbox"
                  checked={base64Mode}
                  onChange={(e) => setBase64Mode(e.target.checked)}
                  aria-label={t('radioBroadcast.base64', { defaultValue: '移动端模式' })}
                  className="h-3.5 w-3.5 accent-[rgb(var(--c-accent))]"
                />
              </label>
              <p className="text-[11px] leading-relaxed text-text-tertiary">
                {t('radioBroadcast.voiceStopHint', { defaultValue: '说「停止」结束播报；移动端开启后音频以 base64 传输。' })}
              </p>
            </div>
          </div>

          {/* 播报中：配置视图内嵌迷你控制条（双视图任一时刻均可停止/暂停） */}
          {rb.isActive && (
            <div className="rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.4)] px-3 py-2.5">
              <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-text-secondary">
                <AudioWaveform size={12} />
                {t('radioBroadcast.nowPlaying', { defaultValue: '正在朗读' })}
              </div>
              <PlaybackControls
                status={rb.status}
                isPlaying={rb.isPlaying}
                playingText={rb.nowPlayingText}
                onPauseResume={handlePauseResume}
                onStop={handleStop}
              />
            </div>
          )}

          <button
            type="button"
            onClick={handleStart}
            disabled={rb.isActive}
            aria-label={rb.status === 'error' ? t('radioBroadcast.retry', { defaultValue: '重试' }) : t('radioBroadcast.start', { defaultValue: '开始播报' })}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[rgb(var(--c-accent))] px-3 py-2 text-[13px] font-medium text-[rgb(var(--c-accent-contrast))] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {rb.status === 'error' ? (
              <>
                <RefreshCw size={15} />
                {t('radioBroadcast.retry', { defaultValue: '重试' })}
              </>
            ) : rb.isActive ? (
              <>
                <Loader2 size={15} className="animate-spin" />
                {t('radioBroadcast.playingHintShort', { defaultValue: '播报中' })}
              </>
            ) : (
              <>
                <Play size={15} />
                {t('radioBroadcast.start', { defaultValue: '开始播报' })}
              </>
            )}
          </button>
        </div>
      )}

      {/* 继续上次畅听（P2-3）：idle 且有上次快照时展示快捷恢复 */}
      {tab === 'listen' && rb.status === 'idle' && lastSession && (
        <button
          type="button"
          onClick={resumeLastSession}
          aria-label={t('radioBroadcast.resumeLast', { defaultValue: '继续上次畅听' })}
          className="mb-3 flex w-full items-center gap-2 self-start rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.6)] px-2.5 py-1.5 text-left text-[11.5px] text-text-secondary transition-colors hover:text-text-primary"
        >
          <RotateCcw size={12} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {t('radioBroadcast.resumeLast', { defaultValue: '继续上次畅听' })}
            ：{lastSession.direction.text}
          </span>
        </button>
      )}

      {/* ===== 内容库页签（P1）===== */}
      {tab === 'library' && <LibraryTab onPlay={(item) => { void rb.playLibraryItem(item) }} />}

      {/* ===== 音色库页签（P1）===== */}
      {tab === 'voices' && (
        <VoicesTab
          activeVoice={voice}
          onSelectVoice={(id) => setVoice(id)}
          onVoiceListChange={() => setVoiceListVersion(v => v + 1)}
        />
      )}
    </div>
  )
}

/** 播放控制条（暂停/继续 + 停止）——播报视图与配置视图（播报中）共用，双视图均可停止/暂停 */
function PlaybackControls({
  status,
  isPlaying,
  playingText,
  onPauseResume,
  onStop,
}: {
  status: RadioBroadcastStatus
  isPlaying: boolean
  /** 当前播放句缩略（配置视图迷你条显示） */
  playingText: string | null
  onPauseResume: () => void
  onStop: () => void
}) {
  const { t } = useTranslation('common')

  if (status === 'starting' || status === 'stopping') {
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled
          className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[rgb(var(--c-bg-elevated))] px-3 py-2 text-[13px] text-text-secondary"
        >
          <Loader2 size={15} className="animate-spin" />
          {STATUS_TEXT[status]}
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onPauseResume}
        aria-label={isPlaying ? t('radioBroadcast.pause', { defaultValue: '暂停' }) : t('radioBroadcast.resume', { defaultValue: '继续' })}
        className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[rgb(var(--c-bg-elevated))] px-3 py-2 text-[13px] text-text-primary transition-colors hover:bg-[rgb(var(--c-bg-hover))]"
      >
        {isPlaying ? <Pause size={15} /> : <Play size={15} />}
        {isPlaying ? t('radioBroadcast.pause', { defaultValue: '暂停' }) : t('radioBroadcast.resume', { defaultValue: '继续' })}
      </button>
      <button
        type="button"
        onClick={onStop}
        aria-label={t('radioBroadcast.stop', { defaultValue: '停止' })}
        className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-500/15 px-3 py-2 text-[13px] text-red-400 transition-colors hover:bg-red-500/25"
      >
        <Square size={15} />
        {t('radioBroadcast.stop', { defaultValue: '停止' })}
      </button>
      {playingText && (
        <span className="min-w-0 flex-1 truncate text-[11px] text-text-tertiary" aria-hidden>
          {playingText}
        </span>
      )}
    </div>
  )
}

/** 进度信息条：累计时长 + 句/段 + 上限剩余（1s 刷新） */
function ProgressInfo({ startedAt, segmentCount, segmentIndex, maxRounds, maxSeconds }: {
  startedAt: number
  segmentCount: number
  segmentIndex?: number
  maxRounds?: number
  maxSeconds?: number
}) {
  const { t } = useTranslation('common')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [startedAt])

  const elapsedMs = startedAt > 0 ? Math.max(0, now - startedAt) : 0
  const elapsed = formatDuration(elapsedMs)

  // 上限剩余（大小取配置与已用最小者；显示哪个配置就用哪个）
  const roundsLeft = maxRounds && segmentIndex !== undefined ? Math.max(0, maxRounds - segmentIndex) : undefined
  const secondsLeft = maxSeconds ? Math.max(0, maxSeconds - elapsedMs / 1000) : undefined
  const restText = secondsLeft !== undefined
    ? ` · ${t('radioBroadcast.remaining', { defaultValue: '剩余' })} ${formatDuration(secondsLeft * 1000)}`
    : roundsLeft !== undefined
      ? ` · ${t('radioBroadcast.roundsLeft', { defaultValue: '剩余' })} ${roundsLeft} ${t('radioBroadcast.roundsUnit', { defaultValue: '轮' })}`
      : ''

  return (
    <div className="flex items-center gap-2 text-[11px] text-text-tertiary">
      <span className="inline-flex items-center gap-1">
        {t('radioBroadcast.duration', { defaultValue: '已播' })} {elapsed}
      </span>
      {segmentCount > 0 && (
        <span>· {t('radioBroadcast.segmentCount', { defaultValue: '句' })} {segmentCount}</span>
      )}
      {segmentIndex !== undefined && segmentIndex > 0 && (
        <span>· {t('radioBroadcast.segment', { defaultValue: '段' })} {segmentIndex}</span>
      )}
      {restText && <span className="truncate">{restText}</span>}
    </div>
  )
}

// 状态文案（i18n）
const STATUS_TEXT: Record<string, string> = {
  starting: '正在准备…',
  playing: '播报中',
  generating: '内容生成中…',
  stopping: '正在停止…',
  error: '出错了',
  idle: '',
}

/** 字幕跟读（P0-1）：队列即文稿；当前句高亮并滚动到容器垂直居中（不动外层面板滚动） */
function TranscriptView({ transcript, isPlaying }: {
  transcript: NonNullable<RadioBroadcastTranscript>
  isPlaying: boolean
}) {
  const { t } = useTranslation('common')
  const boxRef = useRef<HTMLDivElement>(null)
  const idx = transcript.currentIndex

  useEffect(() => {
    const box = boxRef.current
    if (!box || idx < 0) return
    const el = box.querySelector<HTMLElement>(`[data-line="${idx}"]`)
    if (!el) return
    // offsetParent = 容器自身（relative）：offsetTop 即相对容器顶
    const target = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2
    // jsdom 无 Element.scrollTo：能力检测 + scrollTop 兜底
    if (typeof box.scrollTo === 'function') {
      box.scrollTo({ top: target, behavior: 'smooth' })
    } else {
      box.scrollTop = target
    }
  }, [idx])

  return (
    <div
      ref={boxRef}
      aria-label={t('radioBroadcast.transcript', { defaultValue: '字幕跟读' })}
      className="relative max-h-48 overflow-y-auto rounded-md bg-[rgb(var(--c-bg-elevated)/0.5)] px-3 py-2"
    >
      <div className="sticky top-0 mb-1 flex items-center gap-1 bg-transparent text-[10.5px] uppercase tracking-wide text-text-tertiary">
        {isPlaying ? (
          <span className="animate-eq-bars flex items-end gap-[2px]" aria-hidden>
            <span />
            <span />
            <span />
          </span>
        ) : (
          <AudioWaveform size={11} />
        )}
        {t('radioBroadcast.transcript', { defaultValue: '字幕跟读' })}
      </div>
      {transcript.lines.map((line, i) => (
        <p
          key={line.id}
          data-line={i}
          aria-current={i === idx ? 'step' : undefined}
          className={clsx(
            'py-0.5 text-[12.5px] leading-relaxed transition-colors',
            i === idx
              ? 'font-medium text-text-primary'
              : line.status === 'done' || line.status === 'playing'
                ? 'text-text-tertiary'
                : line.status === 'failed'
                  ? 'text-text-tertiary line-through opacity-60'
                  : 'text-text-secondary opacity-70',
          )}
        >
          {line.text}
        </p>
      ))}
    </div>
  )
}

// ================================================================
// 内容库 / 音色库（P1 无限畅听电台·资产层页签）
// ================================================================

/** 内容库页签：已入库单集列表（play = 控制器 replay 直插，无 AI 成本） */
function LibraryTab({ onPlay }: { onPlay: (item: LibraryItem) => void }) {
  const { t } = useTranslation('common')
  const toast = useToastStore()
  // null = 首拉中（避免空态闪烁）
  const [items, setItems] = useState<LibraryItem[] | null>(null)

  const loadItems = useCallback(
    (showErrorToast: boolean) => {
      listLibraryItems()
        .then((res) => {
          if (res.ok) setItems(res.items)
          else {
            setItems([])
            if (showErrorToast) toast.error(res.error ?? t('radioBroadcast.library.loadFailed', { defaultValue: '内容库加载失败' }))
          }
        })
        .catch(() => {
          setItems([])
          if (showErrorToast) toast.error(t('radioBroadcast.library.loadFailed', { defaultValue: '内容库加载失败' }))
        })
    },
    [toast, t],
  )

  useEffect(() => {
    loadItems(false)
  }, [loadItems])

  const toggleFavorite = (item: LibraryItem) => {
    void updateLibraryItem(item.id, { favorite: !item.favorite })
      .then((res) => {
        if (res.ok && res.item) {
          setItems((prev) => prev?.map((it) => (it.id === item.id ? (res.item ?? it) : it)) ?? null)
        } else {
          toast.error(t('radioBroadcast.library.updateFailed', { defaultValue: '操作失败' }))
        }
      })
      .catch(() => toast.error(t('radioBroadcast.library.updateFailed', { defaultValue: '操作失败' })))
  }

  const removeItem = (item: LibraryItem) => {
    void deleteLibraryItem(item.id)
      .then((res) => {
        if (res.ok) {
          setItems((prev) => prev?.filter((it) => it.id !== item.id) ?? null)
          toast.info(t('radioBroadcast.library.deleted', { defaultValue: '已删除单集' }))
        } else {
          toast.error(res.error ?? t('radioBroadcast.library.updateFailed', { defaultValue: '操作失败' }))
        }
      })
      .catch(() => toast.error(t('radioBroadcast.library.updateFailed', { defaultValue: '操作失败' })))
  }

  return (
    <div className="flex flex-col gap-2">
      {items === null ? (
        <div className="flex items-center justify-center py-8 text-[12px] text-text-tertiary">
          <Loader2 size={14} className="mr-2 animate-spin" />
          {t('radioBroadcast.library.loading', { defaultValue: '加载中…' })}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-[12px] leading-relaxed text-text-tertiary">
          <Library size={20} className="mx-auto mb-2 opacity-50" />
          {t('radioBroadcast.library.empty', { defaultValue: '暂无内容。畅听播报中的内容会自动存入这里，之后随时回听。' })}
        </div>
      ) : (
        items.map((item) => (
          <div
            key={item.id}
            className="rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.4)] px-3 py-2"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium text-text-primary">{item.title}</div>
                <div className="mt-0.5 truncate text-[10.5px] text-text-tertiary">
                  {[
                    item.topic || undefined,
                    new Date(item.createdAt).toLocaleDateString(),
                    t('radioBroadcast.library.sentences', { defaultValue: '{{count}} 句', count: item.sentences.length }),
                    item.source === 'live' ? t('radioBroadcast.library.fromLive', { defaultValue: '畅听存档' }) : undefined,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => onPlay(item)}
                  aria-label={t('radioBroadcast.library.play', { defaultValue: '回听' })}
                  title={t('radioBroadcast.library.play', { defaultValue: '回听' })}
                  className="flex items-center justify-center rounded-md px-1.5 py-1.5 text-text-secondary transition-colors hover:bg-[rgb(var(--c-bg-hover))] hover:text-[rgb(var(--c-accent))]"
                >
                  <Play size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => toggleFavorite(item)}
                  aria-label={item.favorite ? t('radioBroadcast.library.unfavorite', { defaultValue: '取消收藏' }) : t('radioBroadcast.library.favorite', { defaultValue: '收藏' })}
                  aria-pressed={item.favorite}
                  className={clsx(
                    'flex items-center justify-center rounded-md px-1.5 py-1.5 transition-colors hover:bg-[rgb(var(--c-bg-hover))]',
                    item.favorite ? 'text-amber-400' : 'text-text-tertiary hover:text-text-secondary',
                  )}
                >
                  <Star size={14} className={item.favorite ? 'fill-amber-400' : undefined} />
                </button>
                <button
                  type="button"
                  onClick={() => removeItem(item)}
                  aria-label={t('radioBroadcast.library.delete', { defaultValue: '删除' })}
                  className="flex items-center justify-center rounded-md px-1.5 py-1.5 text-text-tertiary transition-colors hover:bg-red-500/10 hover:text-red-400"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  )
}

/** 音频试听小播放器（probe 返回 dataUrl 内联可播） */
function ProbeAudio({ dataUrl, label }: { dataUrl: string; label: string }) {
  return <audio src={dataUrl} controls aria-label={label} className="mt-2 h-8 w-full" />
}

/** 音色库页签：我的音色（设计/克隆）+ 新增向导 + 预置音色 */
function VoicesTab({ activeVoice, onSelectVoice, onVoiceListChange }: {
  activeVoice: string
  onSelectVoice: (id: string) => void
  /** 音色列表变化（增/删后）→ 通知面板重拉下拉 */
  onVoiceListChange: () => void
}) {
  const { t } = useTranslation('common')
  const toast = useToastStore()

  const [customs, setCustoms] = useState<CustomVoice[] | null>(null)
  const [presets, setPresets] = useState<PresetVoiceInfo[]>([])

  const loadVoices = useCallback(() => {
    listCustomVoices()
      .then((res) => setCustoms(res.ok ? res.voices : []))
      .catch(() => setCustoms([]))
    listPresetVoices()
      .then((res) => setPresets(res.ok ? res.voices : []))
      .catch(() => { /* 失败留空：预置走畅听页静态兜底 */ })
  }, [])

  useEffect(() => {
    loadVoices()
  }, [loadVoices])

  const refresh = () => {
    loadVoices()
    onVoiceListChange()
  }

  const removeVoice = (v: CustomVoice) => {
    void deleteVoice(v.id)
      .then((res) => {
        if (res.ok) {
          toast.info(t('radioBroadcast.voices.deleted', { defaultValue: '已删除音色' }))
          refresh()
        } else {
          toast.error(res.error ?? t('radioBroadcast.library.updateFailed', { defaultValue: '操作失败' }))
        }
      })
      .catch(() => toast.error(t('radioBroadcast.library.updateFailed', { defaultValue: '操作失败' })))
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 我的音色（design/clone，入库可播报） */}
      <section className="rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.4)] px-3 py-2.5">
        <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-text-secondary">
          <Mic size={12} />
          {t('radioBroadcast.voices.mine', { defaultValue: '我的音色' })}
        </div>
        {customs === null ? (
          <div className="flex items-center py-2 text-[12px] text-text-tertiary">
            <Loader2 size={13} className="mr-2 animate-spin" />
            {t('radioBroadcast.library.loading', { defaultValue: '加载中…' })}
          </div>
        ) : customs.length === 0 ? (
          <p className="py-1 text-[11.5px] leading-relaxed text-text-tertiary">
            {t('radioBroadcast.voices.mineEmpty', { defaultValue: '还没有自定义音色。用下面的向导描述一个，或上传录音克隆。' })}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {customs.map((v) => (
              <div
                key={v.id}
                className={clsx(
                  'flex items-center justify-between gap-2 rounded px-2 py-1.5 transition-colors',
                  activeVoice === v.id ? 'bg-[rgb(var(--c-accent)/0.12)]' : 'bg-[rgb(var(--c-bg-elevated)/0.6)]',
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelectVoice(v.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="truncate text-[12.5px] text-text-primary">
                    {v.name}
                    {activeVoice === v.id && (
                      <span className="ml-1.5 rounded-full bg-[rgb(var(--c-accent)/0.2)] px-1.5 py-px text-[9.5px] text-[rgb(var(--c-accent))]">
                        {t('radioBroadcast.voices.current', { defaultValue: '当前' })}
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[10.5px] text-text-tertiary">
                    {v.type === 'clone'
                      ? t('radioBroadcast.voices.cloneTag', { defaultValue: '克隆' })
                      : t('radioBroadcast.voices.designTag', { defaultValue: '设计' })}
                    {v.description ? ` · ${v.description}` : ''}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => removeVoice(v)}
                  aria-label={t('radioBroadcast.library.delete', { defaultValue: '删除' })}
                  className="shrink-0 rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-red-500/10 hover:text-red-400"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 新增：设计音色（description → 试听 → 入库） */}
      <DesignVoiceWizard onSaved={refresh} />
      {/* 新增：克隆音色（上传样本 → 试听 → 入库） */}
      <CloneVoiceWizard onSaved={refresh} />

      {/* 预置音色（插件下发；只读可选） */}
      {presets.length > 0 && (
        <section className="rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.4)] px-3 py-2.5">
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-text-secondary">
            <Sparkles size={12} />
            {t('radioBroadcast.voices.preset', { defaultValue: '预置音色' })}
          </div>
          <div className="flex flex-wrap gap-1">
            {presets.map((p) => (
              <button
                key={p.voiceId}
                type="button"
                onClick={() => onSelectVoice(p.voiceId)}
                aria-pressed={activeVoice === p.voiceId}
                className={clsx(
                  'rounded-md px-2 py-1 text-[11.5px] transition-colors',
                  activeVoice === p.voiceId
                    ? 'bg-[rgb(var(--c-accent)/0.18)] text-[rgb(var(--c-accent))]'
                    : 'bg-[rgb(var(--c-bg-elevated)/0.6)] text-text-secondary hover:text-text-primary',
                )}
              >
                {p.name}
                {p.gender ? ` · ${p.gender}` : ''}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/** 试听 + 保存共用提交逻辑：probe 成功返回 dataUrl；保存不重复试听 */
async function commitVoiceProbe(args: {
  kind: 'design' | 'clone'
  name: string
  description?: string
  sampleBase64?: string
  sampleName?: string
  save: boolean
}): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
  if (args.save) {
    const res = args.kind === 'design'
      ? await addDesignVoice(args.name, args.description ?? '')
      : await addCloneVoice(args.name, args.sampleBase64 ?? '', args.sampleName)
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  }
  return probeVoice({
    kind: args.kind,
    description: args.description,
    sampleBase64: args.sampleBase64,
    sampleName: args.sampleName,
  })
}

/** 设计音色向导：名称 + 外貌描述 → 试听 → 入库 */
function DesignVoiceWizard({ onSaved }: { onSaved: () => void }) {
  const { t } = useTranslation('common')
  const toast = useToastStore()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState<'probe' | 'save' | null>(null)
  const [probeUrl, setProbeUrl] = useState<string | null>(null)

  const validInputs = name.trim().length > 0 && description.trim().length > 0

  const submit = (save: boolean) => {
    if (!validInputs || busy) return
    setBusy(save ? 'save' : 'probe')
    setProbeUrl(null)
    void commitVoiceProbe({
      kind: 'design',
      name: name.trim(),
      description: description.trim(),
      save,
    })
      .then((res) => {
        setBusy(null)
        if (res.ok) {
          if (save) {
            toast.success(t('radioBroadcast.voices.saved', { defaultValue: '音色已保存' }))
            setName('')
            setDescription('')
            onSaved()
          } else if (res.dataUrl) {
            setProbeUrl(res.dataUrl)
          } else {
            toast.error(t('radioBroadcast.voices.probeFailed', { defaultValue: '试听未返回音频' }))
          }
        } else {
          toast.error(res.error ?? t('radioBroadcast.voices.probeFailed', { defaultValue: '试听失败' }))
        }
      })
      .catch((e) => {
        setBusy(null)
        toast.error(String(e))
      })
  }

  return (
    <section className="rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.4)] px-3 py-2.5">
      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-text-secondary">
        <Sparkles size={12} />
        {t('radioBroadcast.voices.designTitle', { defaultValue: '设计一个音色' })}
      </div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('radioBroadcast.voices.namePlaceholder', { defaultValue: '音色名称，如：沉静男声' })}
        aria-label={t('radioBroadcast.voices.name', { defaultValue: '音色名称' })}
        className="w-full rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.6)] px-2.5 py-1.5 text-[12.5px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-[rgb(var(--c-accent)/0.6)]"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        placeholder={t('radioBroadcast.voices.designPlaceholder', { defaultValue: '描述音色：性别、年龄、语气、语速、情感（如：50 岁沉稳男声，语速慢，像深夜电台主持）' })}
        aria-label={t('radioBroadcast.voices.designDesc', { defaultValue: '音色描述' })}
        className="mt-1.5 w-full resize-none rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.6)] px-2.5 py-1.5 text-[12px] leading-relaxed text-text-primary outline-none placeholder:text-text-tertiary focus:border-[rgb(var(--c-accent)/0.6)]"
      />
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          disabled={!validInputs || busy !== null}
          onClick={() => submit(false)}
          className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-[11.5px] text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'probe' ? <Loader2 size={12} className="animate-spin" /> : <Volume2 size={12} />}
          {t('radioBroadcast.voices.probe', { defaultValue: '试听' })}
        </button>
        <button
          type="button"
          disabled={!validInputs || busy !== null}
          onClick={() => submit(true)}
          className="flex items-center gap-1 rounded-md bg-[rgb(var(--c-accent))] px-2.5 py-1.5 text-[11.5px] font-medium text-[rgb(var(--c-accent-contrast))] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'save' ? <Loader2 size={12} className="animate-spin" /> : null}
          {t('radioBroadcast.voices.save', { defaultValue: '保存' })}
        </button>
      </div>
      {probeUrl && <ProbeAudio dataUrl={probeUrl} label={t('radioBroadcast.voices.probe', { defaultValue: '试听' })} />}
    </section>
  )
}

/** 克隆音色向导：名称 + 上传样本（≤10MB）→ 试听 → 入库 */
function CloneVoiceWizard({ onSaved }: { onSaved: () => void }) {
  const { t } = useTranslation('common')
  const toast = useToastStore()
  const [name, setName] = useState('')
  const [sample, setSample] = useState<{ base64: string; fileName: string } | null>(null)
  const [busy, setBusy] = useState<'probe' | 'save' | null>(null)
  const [probeUrl, setProbeUrl] = useState<string | null>(null)

  const validInputs = name.trim().length > 0 && sample !== null

  const onFile = (file: File | null) => {
    if (!file) return
    if (file.size > 10 * 1024 * 1024) {
      toast.error(t('radioBroadcast.voices.sampleTooLarge', { defaultValue: '样本不能超过 10MB' }))
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const raw = typeof reader.result === 'string' ? reader.result : ''
      // 去 data URL 前缀，仅留 base64 载荷（后端两者均可解，统一裸 base64）
      const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw
      setSample({ base64, fileName: file.name })
    }
    reader.onerror = () => toast.error(t('radioBroadcast.voices.sampleReadFailed', { defaultValue: '样本读取失败' }))
    reader.readAsDataURL(file)
  }

  const submit = (save: boolean) => {
    if (!validInputs || !sample || busy) return
    setBusy(save ? 'save' : 'probe')
    setProbeUrl(null)
    void commitVoiceProbe({
      kind: 'clone',
      name: name.trim(),
      sampleBase64: sample.base64,
      sampleName: sample.fileName,
      save,
    })
      .then((res) => {
        setBusy(null)
        if (res.ok) {
          if (save) {
            toast.success(t('radioBroadcast.voices.saved', { defaultValue: '音色已保存' }))
            setName('')
            setSample(null)
            onSaved()
          } else if (res.dataUrl) {
            setProbeUrl(res.dataUrl)
          } else {
            toast.error(t('radioBroadcast.voices.probeFailed', { defaultValue: '试听未返回音频' }))
          }
        } else {
          toast.error(res.error ?? t('radioBroadcast.voices.probeFailed', { defaultValue: '试听失败' }))
        }
      })
      .catch((e) => {
        setBusy(null)
        toast.error(String(e))
      })
  }

  return (
    <section className="rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.4)] px-3 py-2.5">
      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-text-secondary">
        <Upload size={12} />
        {t('radioBroadcast.voices.cloneTitle', { defaultValue: '克隆一个音色' })}
      </div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('radioBroadcast.voices.namePlaceholder', { defaultValue: '音色名称，如：爸爸的声音' })}
        aria-label={t('radioBroadcast.voices.name', { defaultValue: '音色名称' })}
        className="w-full rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.6)] px-2.5 py-1.5 text-[12.5px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-[rgb(var(--c-accent)/0.6)]"
      />
      <label className="mt-1.5 flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-2 text-[11.5px] text-text-secondary transition-colors hover:text-text-primary">
        <Upload size={12} />
        {sample ? sample.fileName : t('radioBroadcast.voices.samplePlaceholder', { defaultValue: '上传干净人声样本（wav/mp3，≤10MB）' })}
        <input type="file" accept="audio/wav,audio/mpeg,audio/flac,audio/mp4,audio/ogg" className="hidden" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
      </label>
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          disabled={!validInputs || busy !== null}
          onClick={() => submit(false)}
          className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-[11.5px] text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'probe' ? <Loader2 size={12} className="animate-spin" /> : <Volume2 size={12} />}
          {t('radioBroadcast.voices.probe', { defaultValue: '试听' })}
        </button>
        <button
          type="button"
          disabled={!validInputs || busy !== null}
          onClick={() => submit(true)}
          className="flex items-center gap-1 rounded-md bg-[rgb(var(--c-accent))] px-2.5 py-1.5 text-[11.5px] font-medium text-[rgb(var(--c-accent-contrast))] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'save' ? <Loader2 size={12} className="animate-spin" /> : null}
          {t('radioBroadcast.voices.save', { defaultValue: '保存' })}
        </button>
      </div>
      {probeUrl && <ProbeAudio dataUrl={probeUrl} label={t('radioBroadcast.voices.probe', { defaultValue: '试听' })} />}
    </section>
  )
}