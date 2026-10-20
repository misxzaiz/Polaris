/**
 * 流式生成速率徽章
 *
 * 展示当前一轮 AI 回复的生成速率（TPS）与首 token 延迟（TTFT）。
 * 对标 opencode / Claude Code 状态行的 TPS 指示；数据来自 StreamRateSnapshot。
 *
 * 语义：
 * - 流式进行中：显示即时速率（滚窗加权），无稳定读数时显示等待态。
 * - 本轮结束后：显示全程平均速率（已用 provider 精确 token 校正）+ 生成耗时。
 * - TTFT 只在 >=100ms 时展示（更短无体感意义，且多为测量噪声）。
 */
import { Gauge, Hourglass } from 'lucide-react';
import { clsx } from 'clsx';
import type { StreamRateSnapshot } from '@/services/streamRateTracker';

export interface StreamRateBadgeProps {
  snapshot: StreamRateSnapshot;
  /** 是否流式进行中（决定显示即时值还是终值） */
  streaming: boolean;
  /** 是否显示 TTFT */
  showTtft?: boolean;
  className?: string;
}

const TTFT_MIN_MS = 100;

/** 速率阈值与配色（参考 opencode-tps-meter 的 slow=10 / fast=50 口径） */
const SLOW_TPS = 10;
const FAST_TPS = 50;

function rateColor(tps: number): string {
  if (tps < SLOW_TPS) return 'text-amber-400';
  if (tps > FAST_TPS) return 'text-emerald-400';
  return 'text-primary';
}

function fmtSeconds(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function StreamRateBadge({
  snapshot,
  streaming,
  showTtft = true,
  className,
}: StreamRateBadgeProps) {
  const tps = snapshot.avgTps ?? snapshot.tps;
  const tpsLabel = tps != null && tps > 0 ? `${tps.toFixed(1)}` : null;

  // 无任何可用读数（未开始或仍在等待首 token）→ 不渲染
  if (tpsLabel == null && (snapshot.ttftMs == null || snapshot.ttftMs < TTFT_MIN_MS)) {
    return null;
  }

  const color = tpsLabel ? rateColor(Number(tpsLabel)) : 'text-text-muted';
  const ttftVisible = showTtft && snapshot.ttftMs != null && snapshot.ttftMs >= TTFT_MIN_MS;

  const title = [
    '生成速率',
    tpsLabel ? (streaming ? `即时 ${tpsLabel} tok/s` : `平均 ${tpsLabel} tok/s`) : '尚未稳定',
    ttftVisible && snapshot.ttftMs != null ? `首 token ${fmtSeconds(snapshot.ttftMs)}` : '',
    snapshot.generationMs != null ? `生成耗时 ${fmtSeconds(snapshot.generationMs)}` : '',
    snapshot.providerTokens != null ? `输出 ${snapshot.providerTokens.toLocaleString()} token` : '',
  ]
    .filter(Boolean)
    .join('　·　');

  return (
    <span
      className={clsx(
        'flex items-center gap-1 px-1.5 py-0.5 rounded-full cursor-default font-mono text-[11px] tabular-nums shrink-0',
        color,
        className,
      )}
      title={title}
    >
      {tpsLabel == null ? (
        <Hourglass size={12} className="animate-pulse" />
      ) : (
        <Gauge size={12} />
      )}
      {tpsLabel && <span>{tpsLabel}</span>}
      {ttftVisible && snapshot.ttftMs != null && (
        <span className="text-text-muted">·{fmtSeconds(snapshot.ttftMs)}</span>
      )}
      {tpsLabel != null && (
        <span className="text-text-tertiary">tok/s</span>
      )}
    </span>
  );
}
