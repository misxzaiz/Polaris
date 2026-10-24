/**
 * 长按手势（批 6，审计 5.8）：触屏设备长按消息弹出操作菜单——
 * 消息级操作此前全部依赖 hover（opacity-0 group-hover）与右键，
 * 触屏上均不可达。复用 MessageContextMenu 的 (x, y) 触发接口，
 * 桌面右键路径不变。
 */

import { useCallback, useRef, useState } from 'react';

const LONG_PRESS_MS = 500;
/** 超过该移动距离视为滚动而非长按 */
const MOVE_TOLERANCE_PX = 10;

export function useLongPress(onLongPress: (x: number, y: number) => void) {
  const [pressing, setPressing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPosRef.current = null;
    setPressing(false);
  }, []);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    startPosRef.current = { x: touch.clientX, y: touch.clientY };
    const { clientX: x, clientY: y } = touch;
    setPressing(true);
    timerRef.current = setTimeout(() => {
      clear();
      onLongPress(x, y);
    }, LONG_PRESS_MS);
  }, [onLongPress, clear]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!startPosRef.current) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dx = Math.abs(touch.clientX - startPosRef.current.x);
    const dy = Math.abs(touch.clientY - startPosRef.current.y);
    // 移动超容差 = 用户在滚动，取消长按
    if (dx > MOVE_TOLERANCE_PX || dy > MOVE_TOLERANCE_PX) clear();
  }, [clear]);

  const onTouchEnd = useCallback(() => clear(), [clear]);

  return { pressing, touchHandlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd } };
}
