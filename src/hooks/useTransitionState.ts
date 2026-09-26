/**
 * 挂载过渡状态机 Hook
 *
 * 实现 DynamicIsland 同款「enter → open ⇄ exiting → 卸载」三态语义：
 * - 组件挂载即进入 entering（触发入场过渡），过渡结束后进入 open
 * - 调用 exit() 进入 exiting（触发退场过渡），过渡结束后 mounted=false
 *   （调用方据此返回 null 卸载），并触发 onExited（用于父组件清理自身状态）
 * - 复用 setTimeout 而非 transitionend，避免多属性/嵌套过渡监听错乱，
 *   与 DynamicIsland（collapsedExiting + setTimeout）一致
 *
 * 用法：
 *   const { mounted, phase, exit } = useTransitionState({ duration: 260, onExited: ... })
 *   if (!mounted) return null
 *   return <div data-phase={phase} className="...">…</div>
 *   // 关闭时：exit()
 */
import { useState, useEffect, useRef, useCallback } from 'react';

export type TransitionPhase = 'entering' | 'open' | 'exiting';

export interface UseTransitionStateOptions {
  /** 过渡时长（ms），进入与退出共用；默认 260 */
  duration?: number;
  /** 退出过渡结束时调用（此时组件即将卸载，父组件可借此清理打开状态） */
  onExited?: () => void;
  /** 是否启用动画；false（reduced-motion）时直接 open、exit 立即卸载 */
  enabled?: boolean;
}

export interface UseTransitionStateResult {
  /** 是否仍挂载；false 时应停止渲染该组件 */
  mounted: boolean;
  /** 当前阶段：entering / open / exiting */
  phase: TransitionPhase;
  /** 触发退出过渡；结束后 mounted=false 并调用 onExited */
  exit: () => void;
}

export function useTransitionState({
  duration = 260,
  onExited,
  enabled = true,
}: UseTransitionStateOptions): UseTransitionStateResult {
  const [mounted, setMounted] = useState(true);
  const [phase, setPhase] = useState<TransitionPhase>('entering');
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  const exit = useCallback(() => {
    setPhase((prev) => (prev === 'exiting' ? prev : 'exiting'));
  }, []);

  // 进入过渡：entering → open
  useEffect(() => {
    if (!enabled) {
      setPhase('open');
      return;
    }
    const t = setTimeout(() => setPhase('open'), duration);
    return () => clearTimeout(t);
  }, [enabled, duration]);

  // 退出过渡：exiting → 卸载
  useEffect(() => {
    if (phase !== 'exiting') return;
    if (!enabled) {
      setMounted(false);
      onExitedRef.current?.();
      return;
    }
    const t = setTimeout(() => {
      setMounted(false);
      onExitedRef.current?.();
    }, duration);
    return () => clearTimeout(t);
  }, [phase, enabled, duration]);

  return { mounted, phase, exit };
}