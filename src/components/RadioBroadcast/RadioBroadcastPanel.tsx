/**
 * RadioBroadcastPanel — AI 连续语音播报面板（全局浮层）
 *
 * 形态：
 *  - 未播报：右下角悬浮小按钮（带音波图标），点击展开配置。
 *  - 播报中：展开为迷你播放器卡片（方向/音色/状态/当前句/停止/暂停）。
 *
 * 消费：useRadioBroadcast()（读 store + 触发 action）。状态机唯一写入方是控制器。
 *
 * 视觉：主题 token（--c-bg-* / text-text-primary / border-border），不硬编码色值。
 */
import { useState } from 'react'
import { clsx } from 'clsx'
import { AudioWaveform, Play, Square, Pause, Loader2, RefreshCw, X } from 'lucide-react'
import { useRadioBroadcast } from '@/hooks/useRadioBroadcast'
import type { DirectionKind, VoiceId } from '@/services/voiceBroadcast/types'

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

export function RadioBroadcastPanel() {
  const rb = useRadioBroadcast()
  const [expanded, setExpanded] = useState(false)
  const [kind, setKind] = useState<DirectionKind>('study')
  const [directionText, setDirectionText] = useState('经济学基础')
  const [voice, setVoice] = useState<VoiceId>('冰糖')
  const [base64Mode, setBase64Mode] = useState(false)
  const [voiceStopEnabled, setVoiceStopEnabled] = useState(true)

  // 未播报且未展开：仅悬浮按钮
  const idleAndCollapsed = rb.status === 'idle' && !expanded

  const handleStart = async () => {
    await rb.start({
      direction: { kind, text: directionText || DIRECTION_LABELS[kind] },
      voice,
      base64Mode,
      voiceStopEnabled,
    })
  }

  const handleStop = async () => {
    await rb.stop()
    setExpanded(false)
  }

  return (
    <div className="fixed bottom-5 right-5 z-[500] flex flex-col items-end gap-2">
      {idleAndCollapsed ? (
        // 悬浮小按钮：未播报入口
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className={clsx(
            'flex h-11 w-11 items-center justify-center rounded-full border border-border',
            'bg-[rgb(var(--c-bg-elevated)/0.9)] text-text-primary shadow-lg backdrop-blur',
            'transition-all hover:scale-105 hover:bg-[rgb(var(--c-bg-elevated))]',
          )}
          title="AI 连续语音播报"
          aria-label="打开 AI 连续语音播报"
        >
          <AudioWaveform size={20} />
        </button>
      ) : (
        // 展开卡片（配置 / 播报中）
        <div
          className={clsx(
            'w-[320px] rounded-2xl border border-border p-4 shadow-xl backdrop-blur-xl',
            'bg-[rgb(var(--c-bg-surface)/0.95)]',
          )}
        >
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-text-primary">
              <AudioWaveform size={16} />
              <span className="text-[13px] font-medium">AI 连续播报</span>
            </div>
            <div className="flex items-center gap-1">
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
              <button
                type="button"
                onClick={() => {
                  setExpanded(false)
                  if (rb.status !== 'idle') void rb.stop()
                }}
                className="rounded-md p-1 text-text-secondary hover:bg-[rgb(var(--c-bg-hover))] hover:text-text-primary"
                aria-label="关闭播报面板"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {rb.status === 'idle' ? (
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
                <Play size={15} />
                开始播报
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

              {rb.status === 'error' && (
                <button
                  type="button"
                  onClick={handleStart}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-[rgb(var(--c-accent))] px-3 py-2 text-[13px] font-medium text-[rgb(var(--c-accent-contrast))]"
                >
                  <RefreshCw size={15} />
                  重试
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
