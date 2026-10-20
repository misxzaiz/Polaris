/**
 * RadioBroadcastPanel — AI 连续语音播报面板（左侧边栏）
 *
 * 形态：
 *  - 常驻左侧面板（ActivityBar 图标 + LeftPanel 挂载），配置视图 & 播报中视图同面板切换。
 *  - 信息状态：方向/内容/音色 + AI 引擎/供应商/模型 + 轮次/时长上限 + 开关项。
 *
 * 消费：useRadioBroadcast()（读 store + 触发 action）。状态机唯一写入方是控制器。
 *
 * 视觉：主题 token（--c-bg-* / text-text-primary / border-border），不硬编码色值。
 */
import { useState, useMemo } from 'react'
import { clsx } from 'clsx'
import { Bot, Zap, AudioWaveform, Play, Square, Pause, Loader2, RefreshCw } from 'lucide-react'
import { useRadioBroadcast } from '@/hooks/useRadioBroadcast'
import type { DirectionKind, VoiceId } from '@/services/voiceBroadcast/types'
import { useEngineMetadataStore } from '@/stores/engineMetadataStore'
import { useConfigStore } from '@/stores/configStore'
import { SessionConfigSelector } from '@/components/Chat/session/SessionConfigSelector'
import type { SessionRuntimeConfig } from '@/types/sessionConfig'
import { useSessionConfig } from '@/stores/sessionConfigStore'
import { OFFICIAL_API_PROFILE } from '@/types/modelProfile'
import { normalizeEngineId, getEngineFullName } from '@/utils/engineDisplay'

/** 方向 key → 中文标签（与 DIRECTION_PRESETS 对齐） */
const DIRECTION_LABELS: Record<DirectionKind, string> = {
  study: '学习',
  story: '故事',
  tech: '技术',
  news: '新闻',
  custom: '自定义',
}

const STATUS_TEXT: Record<string, string> = {
  starting: '正在准备…',
  playing: '播报中',
  generating: '内容生成中…',
  stopping: '正在停止…',
  error: '出错了',
  idle: '',
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

export function RadioBroadcastPanel() {
  const rb = useRadioBroadcast()
  const [kind, setKind] = useState<DirectionKind>('study')
  const [directionText, setDirectionText] = useState('经济学基础')
  const [voice, setVoice] = useState<VoiceId>('冰糖')
  const [base64Mode, setBase64Mode] = useState(false)
  const [voiceStopEnabled, setVoiceStopEnabled] = useState(true)

  // ==== AI 引擎 / 供应商 / 模型（默认跟随全局，显式选才覆盖 ====
  const engineOptions = useEngineOptions()
  const { config } = useConfigStore()
  const defaultEngineId = normalizeEngineId(config?.defaultEngine)
  const globalSessionConfig = useSessionConfig((s) => s.config)
  const [engineId, setEngineId] = useState<string>(defaultEngineId)
  // 供应商/模型面板态：默认跟随全局激活 Profile + 全局模型配置
  const [providerConfig, setProviderConfig] = useState<SessionRuntimeConfig>(() => ({
    profileMode: globalSessionConfig.profileMode ?? 'profile',
    modelProfileId: globalSessionConfig.modelProfileId || config?.activeModelProfileId || '',
    model: globalSessionConfig.model,
  }))
  // 轮次/时长上限（输入字符串，start 时解析）
  const [maxRounds, setMaxRounds] = useState('')
  const [maxSeconds, setMaxSeconds] = useState('')

  const handleStart = async () => {
    // 供应商 → 会话级覆盖映射（official 用哨兵，与 CreateSessionModal 一致）
    const official = providerConfig.profileMode === 'official'
    const modelProfileId = official
      ? OFFICIAL_API_PROFILE
      : providerConfig.modelProfileId || undefined
    const rounds = maxRounds.trim() ? parseInt(maxRounds.trim(), 10) : 0
    const seconds = maxSeconds.trim() ? parseInt(maxSeconds.trim(), 10) : 0
    await rb.start({
      direction: { kind, text: directionText || DIRECTION_LABELS[kind] },
      voice,
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

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto">
      {/* 头部：标题 + 状态徽标 */}
      <div className="mb-3 flex shrink-0 items-center justify-between px-1">
        <div className="flex items-center gap-2 text-text-primary">
          <AudioWaveform size={16} />
          <span className="text-[13px] font-medium">AI 连续播报</span>
        </div>
        {rb.status !== 'idle' && (
          <span
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

      {rb.status === 'idle' || rb.status === 'error' ? (
        // ===== 配置视图 =====
        <div className="flex flex-col gap-3">
          <div>
            <label className="mb-1 block text-[12px] text-text-secondary">方向</label>
            <div className="flex flex-wrap gap-1">
              {(['study', 'story', 'tech', 'news', 'custom'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
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
          </div>

          <div>
            <label className="mb-1 block text-[12px] text-text-secondary">播报内容</label>
            <input
              value={directionText}
              onChange={(e) => setDirectionText(e.target.value)}
              placeholder="如：经济学基础、王阳明传、今日要闻…"
              className="w-full rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.6)] px-2.5 py-1.5 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-[rgb(var(--c-accent)/0.6)]"
            />
          </div>

          <div>
            <label className="mb-1 block text-[12px] text-text-secondary">音色</label>
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value as VoiceId)}
              className="w-full rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.6)] px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-[rgb(var(--c-accent)/0.6)]"
            >
              {rb.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} — {v.desc}
                </option>
              ))}
            </select>
          </div>

          {/* AI 引擎选择（默认跟随全局，显式选才覆盖） */}
          <div>
            <label className="mb-1 block text-[12px] text-text-secondary">AI 引擎</label>
            <div className="grid grid-cols-2 gap-1.5">
              {engineOptions.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setEngineId(id)}
                  disabled={rb.status === 'starting' || rb.status === 'stopping'}
                  title={getEngineFullName(id)}
                  className={clsx(
                    'flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[12px] transition-colors',
                    engineId === id
                      ? 'bg-[rgb(var(--c-accent)/0.18)] text-[rgb(var(--c-accent))]'
                      : 'bg-[rgb(var(--c-bg-elevated)/0.6)] text-text-secondary hover:text-text-primary',
                  )}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-text-tertiary">
              默认跟随全局引擎；播报进行中不可切换。
            </p>
          </div>

          {/* 模型供应商 / 模型（按当前待选引擎过滤 Profile；面板内选择，不写回当前会话） */}
          <div>
            <label className="mb-1 block text-[12px] text-text-secondary">模型供应商 / 模型</label>
            <SessionConfigSelector
              config={providerConfig}
              onChange={setProviderConfig}
              visibleTypes={['profile', 'model']}
              variant="panel"
              engineOverride={engineId}
              writeThroughToSession={false}
            />
          </div>

          {/* 自动停止：轮次 + 时长（可留空 → 无限连续） */}
          <div>
            <label className="mb-1 block text-[12px] text-text-secondary">自动停止（可留空）</label>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <input
                  type="number"
                  min={1}
                  value={maxRounds}
                  onChange={(e) => setMaxRounds(e.target.value)}
                  placeholder="播 N 轮"
                  className="w-full rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.6)] px-2.5 py-1.5 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-[rgb(var(--c-accent)/0.6)]"
                />
              </div>
              <div>
                <input
                  type="number"
                  min={1}
                  value={maxSeconds}
                  onChange={(e) => setMaxSeconds(e.target.value)}
                  placeholder="播 N 分钟"
                  className="w-full rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.6)] px-2.5 py-1.5 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-[rgb(var(--c-accent)/0.6)]"
                />
              </div>
            </div>
            <p className="mt-1 text-[11px] text-text-tertiary">
              填「播 N 轮」= 播满 N 段后自动停止；填「播 N 分钟」按时间上限兜底。都不填则无限连续播报。
            </p>
          </div>

          <div className="flex flex-col gap-1.5 rounded-md border border-border bg-[rgb(var(--c-bg-elevated)/0.4)] px-2.5 py-2">
            <label className="flex cursor-pointer items-center justify-between gap-2">
              <span className="text-[12px] text-text-secondary">语音「停止」口令</span>
              <input
                type="checkbox"
                checked={voiceStopEnabled}
                onChange={(e) => setVoiceStopEnabled(e.target.checked)}
                className="h-3.5 w-3.5 accent-[rgb(var(--c-accent))]"
              />
            </label>
            <label className="flex cursor-pointer items-center justify-between gap-2">
              <span className="text-[12px] text-text-secondary">移动端模式（base64 音频）</span>
              <input
                type="checkbox"
                checked={base64Mode}
                onChange={(e) => setBase64Mode(e.target.checked)}
                className="h-3.5 w-3.5 accent-[rgb(var(--c-accent))]"
              />
            </label>
            <p className="text-[11px] leading-relaxed text-text-tertiary">
              说「停止」结束播报；移动端开启后音频以 base64 传输，适合手机浏览器播放。
            </p>
          </div>

          <button
            type="button"
            onClick={handleStart}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[rgb(var(--c-accent))] px-3 py-2 text-[13px] font-medium text-[rgb(var(--c-accent-contrast))] transition-opacity hover:opacity-90"
          >
            {rb.status === 'error' ? (
              <>
                <RefreshCw size={15} />
                重试
              </>
            ) : (
              <>
                <Play size={15} />
                开始播报
              </>
            )}
          </button>
        </div>
      ) : (
        // ===== 播报中视图 =====
        <div className="flex flex-col gap-3">
          <div className="text-[12.5px] leading-relaxed text-text-primary">
            <span className="text-text-secondary">{DIRECTION_LABELS[rb.direction.kind]} · </span>
            {rb.direction.text}
          </div>

          {rb.nowPlayingText && (
            <div className="max-h-24 overflow-y-auto rounded-md bg-[rgb(var(--c-bg-elevated)/0.5)] px-2.5 py-2 text-[12.5px] leading-relaxed text-text-primary">
              {rb.nowPlayingText}
            </div>
          )}

          {rb.segment && (
            <div className="text-[11px] text-text-tertiary">
              已播 {rb.segmentCount} 句 · 段 {rb.segment.index}
            </div>
          )}

          {rb.error && (
            <div className="rounded-md bg-red-500/10 px-2.5 py-2 text-[12px] text-red-400">
              {rb.error}
            </div>
          )}

          <div className="flex items-center gap-2">
            {rb.status === 'starting' || rb.status === 'stopping' ? (
              <button
                type="button"
                disabled
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[rgb(var(--c-bg-elevated))] px-3 py-2 text-[13px] text-text-secondary"
              >
                <Loader2 size={15} className="animate-spin" />
                {STATUS_TEXT[rb.status]}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => (rb.isPlaying ? rb.pause() : rb.resume())}
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[rgb(var(--c-bg-elevated))] px-3 py-2 text-[13px] text-text-primary transition-colors hover:bg-[rgb(var(--c-bg-hover))]"
                >
                  {rb.isPlaying ? <Pause size={15} /> : <Play size={15} />}
                  {rb.isPlaying ? '暂停' : '继续'}
                </button>
                <button
                  type="button"
                  onClick={handleStop}
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-500/15 px-3 py-2 text-[13px] text-red-400 transition-colors hover:bg-red-500/25"
                >
                  <Square size={15} />
                  停止
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}