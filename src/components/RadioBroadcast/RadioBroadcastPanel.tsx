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
import { useEffect, useMemo, useRef, useState } from 'react'
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
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useRadioBroadcast } from '@/hooks/useRadioBroadcast'
import type { DirectionKind, RadioBroadcastStatus, VoiceId } from '@/services/voiceBroadcast/types'
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
      'voice-command': { type: 'info', title: t('radioBroadcast.toast.voiceStopped', { defaultValue: '已通过语音口令停止播报' }) },
      manual: { type: 'info', title: t('radioBroadcast.toast.stopped', { defaultValue: '已停止播报' }) },
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

      {/* ===== 播报中视图 ===== */}
      {showPlayingView && (
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

          {/* 正在朗读（自动滚动区域改为显示当前句 + 下句预告） */}
          {rb.nowPlayingText && (
            <div
              aria-label={t('radioBroadcast.nowPlaying', { defaultValue: '正在朗读' })}
              className="max-h-28 overflow-y-auto rounded-md bg-[rgb(var(--c-bg-elevated)/0.5)] px-3 py-2 text-[12.5px] leading-relaxed text-text-primary"
            >
              <div className="mb-1 flex items-center gap-1 text-[10.5px] uppercase tracking-wide text-text-tertiary">
                <Volume2 size={11} />
                {t('radioBroadcast.nowPlaying', { defaultValue: '正在朗读' })}
              </div>
              {rb.nowPlayingText}
            </div>
          )}

          {/* 进度：累计时长 + 句/段 + 上限剩余 */}
          <ProgressInfo startedAt={rb.startedAt} segmentCount={rb.segmentCount} segmentIndex={rb.segment?.index} maxRounds={rb.maxRounds} maxSeconds={rb.maxSeconds} />

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
      {showConfigView && (
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
              {rb.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} — {v.desc}
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