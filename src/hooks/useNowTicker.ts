import { useEffect, useState } from 'react'

/** 倒计时的自然粒度：秒级文案再快一格文字也不会变。 */
export const NOW_TICKER_INTERVAL_MS = 1_000

/**
 * 一个只在 `active` 时走的「现在」。
 *
 * 为什么不靠 store 刷新顺手重算：流式期间 prefill 等待与工具执行间隙没有
 * chunk 到达，store 的 streamRate 不会刷新，靠事件驱动的读数会停在收到那
 * 一刻的秒数。定时器只在有倒计时可显示时存在；`active` 一变先重取一次
 * 「现在」，不带着上一段的偏差起步。
 *
 * 仅供运行时长这类需要墙钟推进的展示使用；速率等跟随 chunk 的事件驱动
 * 读数不应用它。
 */
export function useNowTicker(active: boolean, intervalMs: number = NOW_TICKER_INTERVAL_MS): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [active, intervalMs])
  return now
}
