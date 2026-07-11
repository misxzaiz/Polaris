/**
 * MobileSessionTabs — 顶部多会话 Tab 条
 *
 * 对应桌面端 MultiSessionGrid 的"多窗口并行"语义，适配手机屏：
 * - 横向滚动 Tab 条，每个 Tab 显示会话标题 + 状态圆点
 * - 当前激活 Tab 高亮
 * - 长按 Tab 触发关闭确认
 * - 右侧 + 按钮回到会话列表（添加新会话）
 */

import { useState, useRef, useEffect } from 'react';
import { X, Plus } from 'lucide-react';
import { clsx } from 'clsx';
import {
  useMobileSessionRuntime,
  selectTabSessions,
} from '../runtime/mobileSessionRuntime';
import type { MobileSessionStatus } from '../runtime/types';

interface MobileSessionTabsProps {
  /** 点击 + 按钮回到会话列表 */
  onAddNew: () => void;
}

function statusDotClass(status: MobileSessionStatus): string {
  switch (status) {
    case 'running':
      return 'bg-primary animate-pulse';
    case 'waiting':
      return 'bg-warning';
    case 'error':
      return 'bg-danger';
    default:
      return 'bg-text-tertiary/40';
  }
}

export function MobileSessionTabs({ onAddNew }: MobileSessionTabsProps) {
  // selectTabSessions 内部有引用缓存；仍只读 tab 列表渲染所需字段
  const sessions = useMobileSessionRuntime(selectTabSessions);
  const activeSessionId = useMobileSessionRuntime((s) => s.activeSessionId);
  const setActiveSession = useMobileSessionRuntime((s) => s.setActiveSession);
  const closeSession = useMobileSessionRuntime((s) => s.closeSession);

  const [longPressTarget, setLongPressTarget] = useState<string | null>(null);

  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPressTimer = () => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  };

  useEffect(() => clearPressTimer, []);

  const handlePressStart = (sessionId: string) => {
    clearPressTimer();
    pressTimerRef.current = setTimeout(() => {
      setLongPressTarget(sessionId);
    }, 500);
  };

  const handlePressEnd = () => {
    clearPressTimer();
  };

  if (sessions.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto border-b border-border px-2 py-2 scrollbar-none">
      {sessions.map((session) => {
        const active = session.id === activeSessionId;
        return (
          <div
            key={session.id}
            className={clsx(
              'group relative flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition-colors',
              active
                ? 'bg-primary text-white'
                : 'border border-border bg-background-surface text-text-secondary',
            )}
            onClick={() => setActiveSession(session.id)}
            onPointerDown={() => handlePressStart(session.id)}
            onPointerUp={handlePressEnd}
            onPointerLeave={handlePressEnd}
            role="button"
            tabIndex={0}
          >
            <span
              className={clsx(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                active && session.status === 'idle'
                  ? 'bg-white/70'
                  : statusDotClass(session.status),
              )}
              title={session.status}
            />
            <span className="max-w-[100px] truncate">{session.title || '无标题会话'}</span>
            <span className="text-[9px] opacity-70">{session.engineId}</span>

            {(active || longPressTarget === session.id) && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  closeSession(session.id);
                  setLongPressTarget(null);
                }}
                className="ml-0.5 rounded-full p-0.5 hover:bg-white/20"
                aria-label="关闭会话"
              >
                <X size={12} />
              </button>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={onAddNew}
        className="flex shrink-0 items-center justify-center rounded-full border border-dashed border-border p-1.5 text-text-tertiary hover:text-text-primary"
        aria-label="添加会话"
      >
        <Plus size={14} />
      </button>

      {longPressTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setLongPressTarget(null)}
        >
          <div
            className="w-64 rounded-2xl border border-border bg-background-elevated p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium text-text-primary">关闭该会话 Tab？</div>
            <div className="mt-1 text-xs text-text-tertiary">
              关闭后该会话的本地草稿与流状态将被清除；后台事件也不再接收。
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  closeSession(longPressTarget);
                  setLongPressTarget(null);
                }}
                className="flex-1 rounded-xl bg-danger px-3 py-2 text-sm text-white"
              >
                关闭
              </button>
              <button
                type="button"
                onClick={() => setLongPressTarget(null)}
                className="flex-1 rounded-xl border border-border bg-background-surface px-3 py-2 text-sm text-text-secondary"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
