/**
 * 上下文用量水位条
 *
 * 对标 Claude Code 状态行(上下文百分比)+ /cost。
 * 水位分子 = input + cacheCreation + cacheRead(三项之和,非单一 input);
 * 分母 = 会话配置 contextWindow(缺省 200K)。
 * 主行使用紧凑圆圈进度；悬停/聚焦浮出详情卡:token 四分类 + 缓存命中率 + 阈值预警。
 */

import { useState, useRef } from 'react';
import { clsx } from 'clsx';
import type { UsageStats } from '@/stores/conversationStore/types';

interface ContextMeterProps {
  usage: UsageStats;
  /** 会话配置里的上下文窗口;usage.contextWindow 优先,其次此值,再兜底 200K */
  contextWindow?: number;
  /** 主行标签密度：full=used/window, percent=百分比, icon=仅圆圈 */
  labelMode?: 'full' | 'percent' | 'icon';
}

/** 压缩阈值(与 SimpleAI compact.rs 默认对齐) */
const COMPACT_THRESHOLD = 0.8;
const CRITICAL_THRESHOLD = 0.95;
const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function fmt(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k';
  return String(n);
}

export function ContextMeter({ usage, contextWindow, labelMode = 'full' }: ContextMeterProps) {
  const [active, setActive] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  const window = usage.contextWindow ?? contextWindow ?? 200000;
  const used = usage.input + usage.cacheCreation + usage.cacheRead;
  const pct = window > 0 ? used / window : 0;
  const pctClamped = Math.min(Math.max(pct, 0), 1);
  const hitRate = used > 0 ? Math.round((usage.cacheRead / used) * 100) : 0;

  const level =
    pct >= CRITICAL_THRESHOLD ? 'crit' : pct >= COMPACT_THRESHOLD ? 'warn' : 'ok';
  const accentColor =
    level === 'crit'
      ? 'text-red-400'
      : level === 'warn'
        ? 'text-amber-400'
        : 'text-primary';
  const labelColor =
    level === 'crit'
      ? 'text-red-400'
      : level === 'warn'
        ? 'text-amber-400'
        : 'text-text-secondary';

  // 三段宽度(相对窗口)，主行圆圈只表达总量与风险等级，详情卡保留构成信息。
  const wi = Math.min((usage.input / window) * 100, 100);
  const wc = Math.min((usage.cacheCreation / window) * 100, 100);
  const wr = Math.min((usage.cacheRead / window) * 100, 100);

  const winLabel = window >= 1e6 ? `${window / 1e6}m` : `${Math.round(window / 1000)}k`;
  const percentLabel = `${Math.round(pct * 100)}%`;
  const mainLabel = labelMode === 'full'
    ? `${fmt(used)}/${winLabel}`
    : labelMode === 'percent'
      ? percentLabel
      : null;
  const ariaLabel = `上下文用量 ${percentLabel}，${fmt(used)}/${winLabel}`;
  const ringOffset = RING_CIRCUMFERENCE * (1 - pctClamped);

  return (
    <div
      ref={anchorRef}
      tabIndex={0}
      role="status"
      aria-label={ariaLabel}
      title={ariaLabel}
      className="relative flex items-center gap-1 px-1.5 py-0.5 rounded-full cursor-default hover:bg-background-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors shrink-0"
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        className={clsx('shrink-0 -rotate-90', accentColor)}
        aria-hidden="true"
      >
        <circle
          cx="12"
          cy="12"
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.8"
          className="opacity-20"
        />
        <circle
          cx="12"
          cy="12"
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={ringOffset}
          className="transition-[stroke-dashoffset] duration-300"
        />
      </svg>
      {mainLabel && (
        <span className={clsx('font-mono text-[11px] tabular-nums whitespace-nowrap', labelColor)}>
          {mainLabel}
        </span>
      )}

      {/* 悬浮详情卡 */}
      {active && (
        <div className="absolute bottom-full right-0 mb-2 z-40 w-[280px] rounded-xl border border-border-subtle bg-background-elevated p-3 shadow-xl">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] uppercase tracking-wide text-text-muted">上下文用量</span>
            <span className={clsx('font-mono text-[11px]', labelColor)}>{percentLabel} · {winLabel}</span>
          </div>
          <div className="h-2 rounded bg-background-tertiary overflow-hidden flex mb-2.5 relative">
            <div className="h-full bg-primary" style={{ width: `${wi}%` }} />
            <div className="h-full bg-amber-500" style={{ width: `${wc}%` }} />
            <div className="h-full bg-purple-400" style={{ width: `${wr}%` }} />
            <div
              className="absolute top-[-1px] h-[10px] w-px bg-text-tertiary"
              style={{ left: `${COMPACT_THRESHOLD * 100}%` }}
            />
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-y-1.5 gap-x-3 text-[12px]">
            <MeterRow color="bg-primary" label="输入 input" value={usage.input} />
            {usage.cacheCreation > 0 && (
              <MeterRow color="bg-amber-500" label="缓存写入" value={usage.cacheCreation} />
            )}
            {usage.cacheRead > 0 && (
              <MeterRow color="bg-purple-400" label="缓存读取" value={usage.cacheRead} />
            )}
            <MeterRow color="bg-text-tertiary" label="输出 output" value={usage.output} dim />
          </div>
          {usage.cacheRead > 0 && (
            <div className="mt-2.5 pt-2.5 border-t border-border-subtle flex items-center justify-between">
              <span className="text-[11px] text-text-muted">缓存命中率</span>
              <span className="font-mono text-[12px] text-purple-400">{hitRate}%</span>
            </div>
          )}
          {level !== 'ok' && (
            <div
              className={clsx(
                'mt-2.5 rounded-md px-2 py-1.5 text-[11px]',
                level === 'crit'
                  ? 'bg-red-500/10 text-red-400 border border-red-500/30'
                  : 'bg-amber-500/10 text-amber-400 border border-amber-500/30',
              )}
            >
              {level === 'crit'
                ? `逼近上下文窗口(${percentLabel})· 建议压缩交接或开启新会话`
                : `接近压缩阈值(${percentLabel})· 即将自动压缩上下文`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MeterRow({
  color,
  label,
  value,
  dim,
}: {
  color: string;
  label: string;
  value: number;
  dim?: boolean;
}) {
  return (
    <>
      <span className={clsx('flex items-center gap-2', dim ? 'text-text-muted' : 'text-text-secondary')}>
        <span className={clsx('w-2 h-2 rounded-sm shrink-0', color)} />
        {label}
      </span>
      <span className={clsx('font-mono text-right tabular-nums', dim ? 'text-text-muted' : 'text-text-primary')}>
        {value.toLocaleString()}
      </span>
    </>
  );
}
