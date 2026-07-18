/**
 * 上下文用量水位条
 *
 * 对标 Claude Code 状态行(上下文百分比)+ /cost。
 * 水位分子 = input + cacheCreation + cacheRead(三项之和,非单一 input);
 * 分母 = 会话配置 contextWindow(缺省 200K)。
 * 主行使用紧凑圆圈进度；悬停/聚焦浮出详情卡:token 四分类 + 缓存命中率 + 阈值预警 +
 * 按模型维度用量明细 + 原始报文查看按钮。
 *
 * **用量口径基准：** 当引擎为 Claude Code 时，input/cacheCreation/cacheRead 来自
 * modelUsage 的累计求和（完整本轮），与 `/usage` 命令输出一致。退化路径读顶层 usage
 * （仅最后一次 API 调用，偏小）。
 *
 * **悬浮卡显隐（关键修复）：**
 * `active` 由锚点容器 + 卡片本身两个独立事件宿主共同维持，覆盖 `mb-2` 间隙造成的
 * hover 命中区断开：anchor.onMouseLeave 不再关闭卡片（已移除），card.onMouseLeave 兜底
 * 处理"鼠标从卡片离开到外部"的失活。anchor.onBlur 做 relatedTarget 白检，避免 anchor
 * 与 card 之间的 Tab 流转误关卡片。
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

function fmtCost(n: number | undefined): string {
  if (n == null || n === 0) return '';
  return `$${n.toFixed(4)}`;
}

/**
 * 判断焦点相关目标是否仍在 anchor 或 card 区域内。用于 anchor.onBlur 白检，
 * 避免 Tab 在 anchor↔card 之间流转时误关卡片。
 */
function isFocusStillInside(
  relatedTarget: EventTarget | null,
  anchorRef: React.RefObject<HTMLDivElement | null>,
  cardRef: React.RefObject<HTMLDivElement | null>,
): boolean {
  const anchor = anchorRef.current;
  const card = cardRef.current;
  if (!anchor || !card) return false;
  if (relatedTarget == null) return false;
  if (!(relatedTarget instanceof HTMLElement)) return false;
  return anchor.contains(relatedTarget) || card.contains(relatedTarget);
}

export function ContextMeter({ usage, contextWindow, labelMode = 'full' }: ContextMeterProps) {
  const [active, setActive] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const window = usage.contextWindow ?? contextWindow ?? 200000;
  const used = usage.input + usage.cacheCreation + usage.cacheRead;
  const pct = window > 0 ? used / window : 0;
  const pctClamped = Math.min(Math.max(pct, 0), 1);
  const hitRate = used > 0 ? Math.round((usage.cacheRead / used) * 100) : 0;

  const modelUsage = usage.modelUsage;
  const modelCount = modelUsage ? Object.keys(modelUsage).length : 0;

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
      onFocus={() => setActive(true)}
      onBlur={(e) => {
        if (!isFocusStillInside(e.relatedTarget, anchorRef, cardRef)) {
          setActive(false);
          setShowRaw(false);
        }
      }}
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
        <div
          ref={cardRef}
          className={clsx(
            'absolute bottom-full right-0 mb-2 z-40 rounded-xl border border-border-subtle bg-background-elevated p-3 shadow-xl',
            showRaw ? 'w-[480px]' : 'w-[310px]',
          )}
          onMouseEnter={() => setActive(true)}
          onMouseLeave={() => {
            setActive(false);
            setShowRaw(false);
          }}
        >
          {showRaw && usage.rawPayload ? (
            /* 原始报文查看模式 */
            <div className="max-h-[400px] overflow-auto">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] uppercase tracking-wide text-text-muted">原始 result 报文</span>
                <button
                  className="text-[11px] text-primary hover:underline"
                  onClick={() => setShowRaw(false)}
                >
                  返回
                </button>
              </div>
              <pre className="text-[11px] font-mono text-text-secondary whitespace-pre-wrap break-all leading-relaxed">
                {JSON.stringify(usage.rawPayload, null, 2)}
              </pre>
            </div>
          ) : (
            <>
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

              {/* 按模型维度的用量明细 */}
              {modelCount > 0 && (
                <div className="mt-2.5 pt-2.5 border-t border-border-subtle">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] text-text-muted">模型维度用量</span>
                    <span className="text-[10px] text-text-muted">{modelCount} 模型</span>
                  </div>
                  {modelUsage && Object.entries(modelUsage).map(([model, m]) => (
                    <div key={model} className="mb-2 last:mb-0">
                      <div className="text-[11px] font-medium text-text-secondary mb-1">{model}</div>
                      <div className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-0.5 text-[11px]">
                        <MeterRow color="bg-primary/60" label="输入" value={m.inputTokens} dim />
                        {m.cacheCreationInputTokens != null && m.cacheCreationInputTokens > 0 ? (
                          <MeterRow color="bg-amber-500/60" label="缓存写入" value={m.cacheCreationInputTokens} dim />
                        ) : null}
                        {m.cacheReadInputTokens != null && m.cacheReadInputTokens > 0 ? (
                          <MeterRow color="bg-purple-400/60" label="缓存读取" value={m.cacheReadInputTokens} dim />
                        ) : null}
                        <MeterRow color="bg-text-tertiary/60" label="输出" value={m.outputTokens} dim />
                        {m.costUsd != null && m.costUsd > 0 ? (
                          <>
                            <span className="text-text-muted flex items-center gap-1">
                              <span className="w-2 h-2 rounded-sm shrink-0 bg-transparent" />
                              花费
                            </span>
                            <span className="font-mono text-right tabular-nums text-text-muted">{fmtCost(m.costUsd)}</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* 原始报文查看按钮 */}
              {usage.rawPayload && (
                <div className="mt-2.5 pt-2.5 border-t border-border-subtle">
                  <button
                    className="flex items-center gap-1 text-[11px] text-text-muted hover:text-primary transition-colors"
                    onClick={() => setShowRaw(true)}
                  >
                    <span className="text-xs">📄</span>
                    查看原始报文
                  </button>
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
            </>
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