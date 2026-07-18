/**
 * 上下文用量水位条
 *
 * 对标 Claude Code 状态行(上下文百分比)+ /cost。
 * 水位分子 = input + cacheCreation + cacheRead(三项之和,非单一 input);
 * 分母 = 会话配置 contextWindow(缺省 200K)。
 * 悬停浮出详情卡:token 四分类 + 缓存命中率 + 阈值预警。
 */

import { useState, useRef } from 'react';
import { clsx } from 'clsx';
import type { UsageStats } from '@/stores/conversationStore/types';

interface ContextMeterProps {
  usage: UsageStats;
  /** 会话配置里的上下文窗口;usage.contextWindow 优先,其次此值,再兜底 200K */
  contextWindow?: number;
}

/** 压缩阈值(与 SimpleAI compact.rs 默认对齐) */
const COMPACT_THRESHOLD = 0.8;
const CRITICAL_THRESHOLD = 0.95;

function fmt(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k';
  return String(n);
}

export function ContextMeter({ usage, contextWindow }: ContextMeterProps) {
  const [hover, setHover] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  const window = usage.contextWindow ?? contextWindow ?? 200000;
  const used = usage.input + usage.cacheCreation + usage.cacheRead;
  const pct = window > 0 ? used / window : 0;
  const hitRate = used > 0 ? Math.round((usage.cacheRead / used) * 100) : 0;

  const level =
    pct >= CRITICAL_THRESHOLD ? 'crit' : pct >= COMPACT_THRESHOLD ? 'warn' : 'ok';
  const labelColor =
    level === 'crit'
      ? 'text-red-400'
      : level === 'warn'
        ? 'text-amber-400'
        : 'text-text-secondary';

  // 三段宽度(相对窗口)
  const wi = Math.min((usage.input / window) * 100, 100);
  const wc = Math.min((usage.cacheCreation / window) * 100, 100);
  const wr = Math.min((usage.cacheRead / window) * 100, 100);

  const winLabel = window >= 1e6 ? `${window / 1e6}m` : `${Math.round(window / 1000)}k`;

  return (
    <div
      ref={anchorRef}
      className="relative flex items-center gap-1.5 px-1.5 py-0.5 rounded-md cursor-default hover:bg-background-hover transition-colors shrink-0"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* 三段水位轨道 */}
      <div className="w-[72px] h-1.5 rounded-full bg-background-tertiary overflow-hidden flex relative">
        <div className="h-full bg-primary transition-all duration-300" style={{ width: `${wi}%` }} />
        <div className="h-full bg-amber-500 transition-all duration-300" style={{ width: `${wc}%` }} />
        <div className="h-full bg-purple-400 transition-all duration-300" style={{ width: `${wr}%` }} />
        {/* 压缩阈值刻度 */}
        <div
          className="absolute top-[-1px] h-[8px] w-px bg-text-tertiary"
          style={{ left: `${COMPACT_THRESHOLD * 100}%` }}
        />
      </div>
      <span className={clsx('font-mono text-[11px] tabular-nums whitespace-nowrap', labelColor)}>
        {fmt(used)}/{winLabel}
      </span>

      {/* 悬浮详情卡 */}
      {hover && (
        <div className="absolute bottom-full right-0 mb-2 z-30 w-[260px] rounded-xl border border-border-subtle bg-background-elevated p-3 shadow-xl">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] uppercase tracking-wide text-text-muted">上下文用量</span>
            <span className="font-mono text-[11px] text-primary">{Math.round(pct * 100)}% · {winLabel}</span>
          </div>
          <div className="h-2 rounded bg-background-tertiary overflow-hidden flex mb-2.5">
            <div className="h-full bg-primary" style={{ width: `${wi}%` }} />
            <div className="h-full bg-amber-500" style={{ width: `${wc}%` }} />
            <div className="h-full bg-purple-400" style={{ width: `${wr}%` }} />
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
                ? `逼近上下文窗口(${Math.round(pct * 100)}%)· 建议压缩交接或开启新会话`
                : `接近压缩阈值(${Math.round(pct * 100)}%)· 即将自动压缩上下文`}
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
