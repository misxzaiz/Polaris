/**
 * 全局权限审批卡（P1-g，2026-10-24 审计）
 *
 * 消费后端 `permission.prompt` 事件（dispatch Prompt 裁决 → PermissionPromptRegistry
 * 发起），右下角浮层确认：批准 / 拒绝 → `respond_permission_request` 回填。
 * 批准后 AI 重试原调用即放行（10 分钟 TTL，同一 capability+action 粒度）。
 *
 * 设计：非模态浮层（不打断当前工作），队列逐条展示；组件自持队列与订阅，
 * 无全局 store（审批是瞬时交互，无需跨组件状态）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldAlert, Check, X } from 'lucide-react';
import { listen, invoke } from '@/services/transport';
import { createLogger } from '@/utils/logger';

const log = createLogger('PermissionPromptHost');

/** 后端 permission.prompt 事件载荷（camelCase，对齐 PermissionPromptRegistry） */
interface PermissionPromptEvent {
  requestId: string
  capability: string
  action?: string
  sourceKind: string
  caller?: string
  resource: string
}

interface PendingPrompt extends PermissionPromptEvent {
  resolving: boolean
}

/** 动作的人类可读名（覆盖已知高危动作；未知动作原样展示） */
const ACTION_LABELS: Record<string, string> = {
  stop_for_plugin: '停止插件的全部后台服务',
  autostart: '批量启动插件服务',
  uninstall_local: '卸载插件',
  uninstall_with_cleanup: '卸载插件并清理进程',
  force_uninstall: '强制卸载插件',
}

export function PermissionPromptHost() {
  const [queue, setQueue] = useState<PendingPrompt[]>([])
  const disposed = useRef(false)

  useEffect(() => {
    let unlisten: (() => void) | null = null
    listen<PermissionPromptEvent>('permission.prompt', (payload) => {
      if (disposed.current || !payload?.requestId) return
      setQueue((q) =>
        q.some((p) => p.requestId === payload.requestId)
          ? q
          : [...q, { ...payload, resolving: false }],
      )
    }).then((fn) => {
      if (disposed.current) {
        fn()
        return
      }
      unlisten = fn
    })
    return () => {
      disposed.current = true
      unlisten?.()
    }
  }, [])

  const resolve = useCallback(async (requestId: string, approved: boolean) => {
    setQueue((q) => q.map((p) => (p.requestId === requestId ? { ...p, resolving: true } : p)))
    try {
      await invoke('respond_permission_request', { requestId, approved })
    } catch (error) {
      log.warn('respond_permission_request 失败', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setQueue((q) => q.filter((p) => p.requestId !== requestId))
    }
  }, [])

  if (queue.length === 0) return null

  return (
    <div
      className="fixed bottom-4 right-4 z-[9999] flex w-[340px] flex-col gap-2"
      data-testid="permission-prompt-host"
    >
      {queue.map((p) => {
        const actionLabel =
          (p.action && ACTION_LABELS[p.action]) || p.action || '执行受控操作'
        return (
          <div
            key={p.requestId}
            className="rounded-lg border border-border bg-surface p-3 shadow-lg"
          >
            <div className="flex items-start gap-2">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-text-primary">
                  AI 请求执行：{actionLabel}
                </div>
                <div className="mt-1 truncate text-[11px] text-text-secondary">
                  {p.capability}
                  {p.action ? ` · ${p.action}` : ''}
                  {p.caller ? ` · 来自 ${p.caller}` : ''}
                </div>
              </div>
            </div>
            <div className="mt-2.5 flex justify-end gap-2">
              <button
                type="button"
                disabled={p.resolving}
                onClick={() => resolve(p.requestId, false)}
                className="flex items-center gap-1 rounded-[var(--radius-sm,6px)] px-2.5 py-1 text-[12px] text-text-secondary hover:bg-hover disabled:opacity-50"
              >
                <X className="h-3 w-3" />
                拒绝
              </button>
              <button
                type="button"
                disabled={p.resolving}
                onClick={() => resolve(p.requestId, true)}
                className="flex items-center gap-1 rounded-[var(--radius-sm,6px)] bg-primary px-2.5 py-1 text-[12px] text-white hover:opacity-90 disabled:opacity-50"
              >
                <Check className="h-3 w-3" />
                允许本次（10 分钟）
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
