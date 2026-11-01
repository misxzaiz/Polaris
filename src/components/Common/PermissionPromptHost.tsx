/**
 * 全局权限审批卡（P1-g，2026-10-24 审计）
 *
 * 消费后端 `permission.prompt` 事件（dispatch Prompt 裁决 → PermissionPromptRegistry
 * 发起），右下角浮层确认：批准 / 拒绝 → `respond_permission_request` 回填。
 * 批准后 AI 重试原调用即放行（10 分钟 TTL，同一 capability+action 粒度）。
 *
 * 设计：非模态浮层（不打断当前工作），队列逐条展示；组件自持队列与订阅，
 * 无全局 store（审批是瞬时交互，无需跨组件状态）。
 * 卡片展示 capability/action/caller/resource 全量元信息（超长可点击展开）；
 * 拒绝回执与审批失败走 toastStore 轻提示，不留「点了没反应」的静默态。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldAlert, Check, X } from 'lucide-react';
import { listen, invoke } from '@/services/transport';
import { createLogger } from '@/utils/logger';
import { cn } from '@/utils/cn';
import { useToastStore } from '@/stores/toastStore';

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
  /** capability/resource 元信息超长截断的展开态（点击切换），长路径/长 caller 也能看全 */
  expanded: boolean
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
          : [...q, { ...payload, resolving: false, expanded: false }],
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
      // 根因：拒绝后卡片随即消失，用户无从确认裁决是否生效；用 toast 轻提示回执
      if (!approved) {
        useToastStore.getState().info('已拒绝', 'AI 将收到拒绝结果')
      }
      setQueue((q) => q.filter((p) => p.requestId !== requestId))
    } catch (error) {
      // 根因：此前失败只写日志且卡片直接消失，用户不知道拒绝是否生效也无法重试；
      // 改为错误 toast + 保留卡片（解除 resolving 锁）允许再次裁决
      const detail = error instanceof Error ? error.message : String(error)
      useToastStore.getState().error('权限审批操作失败', detail)
      setQueue((q) => q.map((p) => (p.requestId === requestId ? { ...p, resolving: false } : p)))
      log.warn('respond_permission_request 失败', { requestId, error: detail })
    }
  }, [])

  const toggleExpanded = useCallback((requestId: string) => {
    setQueue((q) => q.map((p) => (p.requestId === requestId ? { ...p, expanded: !p.expanded } : p)))
  }, [])

  if (queue.length === 0) return null

  return (
    <div
      className="fixed bottom-4 right-4 z-[9999] flex w-[340px] flex-col gap-2"
      data-testid="permission-prompt-host"
    >
      {queue.map((p) => {
        // 未知动作兜底带 capability 名，不再含糊的「执行受控操作」
        const actionLabel =
          (p.action && ACTION_LABELS[p.action]) || p.action || `受控操作（${p.capability}）`
        const metaText = `${p.capability}${p.action ? ` · ${p.action}` : ''}${p.caller ? ` · 来自 ${p.caller}` : ''}`
        // truncate 的展开途径：点击元信息区切换换行展示，截断态辅以 hover title
        const metaLineClass = p.expanded ? 'whitespace-normal break-all' : 'truncate'
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
                <button
                  type="button"
                  onClick={() => toggleExpanded(p.requestId)}
                  className="mt-1 block w-full text-left text-[11px] text-text-secondary"
                  title={p.expanded ? undefined : `${metaText} · ${p.resource}`}
                >
                  <span className={cn('block', metaLineClass)}>{metaText}</span>
                  {/* resource 是本次权限的作用对象（如文件路径），单列一行小字 */}
                  <span className={cn('block', metaLineClass)}>{p.resource}</span>
                </button>
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
