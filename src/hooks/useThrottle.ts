/**
 * 节流 Hook - 限制函数执行频率
 * 
 * 与防抖的区别：
 * - 防抖：延迟执行，只执行最后一次
 * - 节流：立即执行，但限制执行频率
 * 
 * 适用场景：流式数据渲染、滚动事件等需要实时响应但需限制频率的场景
 */
import { useCallback, useRef, useState, useEffect } from 'react';

/**
 * 节流值 Hook
 * 
 * 返回一个节流后的值，确保在指定时间间隔内最多更新一次
 * 与 useDebounce 不同，它会在时间间隔开始时立即更新
 * 
 * 实现说明：
 * - 使用 useState 存储节流后的值，确保能触发重渲染
 * - 使用 useRef 存储上次更新时间，避免闭包问题
 * - 当 interval 为 0 时，直接返回原值（无节流）
 */
export function useThrottle<T>(value: T, interval: number): T {
  // 节流后的值（使用状态触发重渲染）
  const [throttledValue, setThrottledValue] = useState<T>(value);
  
  // 上次更新时间
  const lastUpdateTimeRef = useRef<number>(Date.now());
  
  // 待更新的值（用于在间隔结束后更新）
  const pendingValueRef = useRef<T | null>(null);
  
  // 定时器 ID
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // interval 为 0 时，不节流，直接更新
    if (interval <= 0) {
      setThrottledValue(value);
      return;
    }

    const now = Date.now();
    const timeSinceLastUpdate = now - lastUpdateTimeRef.current;

    // 如果距离上次更新已超过间隔时间，立即更新
    if (timeSinceLastUpdate >= interval) {
      lastUpdateTimeRef.current = now;
      setThrottledValue(value);
      pendingValueRef.current = null;
    } else {
      // 否则，记录待更新的值，并在剩余时间后更新
      pendingValueRef.current = value;

      // 如果没有已存在的定时器，创建一个
      if (timeoutRef.current === null) {
        timeoutRef.current = setTimeout(() => {
          if (pendingValueRef.current !== null) {
            lastUpdateTimeRef.current = Date.now();
            setThrottledValue(pendingValueRef.current);
            pendingValueRef.current = null;
          }
          timeoutRef.current = null;
        }, interval - timeSinceLastUpdate);
      }
    }

    // 清理函数
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [value, interval]);

  return throttledValue;
}

/**
 * 节流回调函数 Hook
 * 
 * 返回一个节流后的函数，确保在指定时间间隔内最多执行一次
 */
export function useThrottledCallback<T extends (...args: any[]) => any>(
  callback: T,
  interval: number
): T {
  const lastExecTimeRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastArgsRef = useRef<Parameters<T> | null>(null);

  const throttledCallback = useCallback(
    (...args: Parameters<T>) => {
      const now = Date.now();
      const timeSinceLastExec = now - lastExecTimeRef.current;

      // 保存最新的参数
      lastArgsRef.current = args;

      // 如果距离上次执行超过间隔时间，立即执行
      if (timeSinceLastExec >= interval) {
        lastExecTimeRef.current = now;
        callback(...args);
      } else {
        // 否则，设置定时器在剩余时间后执行
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        
        timeoutRef.current = setTimeout(() => {
          if (lastArgsRef.current) {
            lastExecTimeRef.current = Date.now();
            callback(...lastArgsRef.current);
          }
        }, interval - timeSinceLastExec);
      }
    },
    [callback, interval]
  ) as T;

  return throttledCallback;
}
