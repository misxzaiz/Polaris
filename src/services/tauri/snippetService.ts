/**
 * Prompt Snippet 快捷片段 service（第四步迁移：cap.prompt_snippet 统一走 dispatch）
 *
 * 2026-11 Scheduler 域出仓：本模块原寄居 schedulerService.ts，snippet 是独立的
 * 快捷片段功能（宿主 ChatInput / Settings 消费），单独成文件随宿主保留。
 */
import { invoke } from '@/services/transport'
import type {
  PromptSnippet,
  CreateSnippetParams,
  UpdateSnippetParams,
} from '@/types/promptSnippet'

/** router_dispatch 返回形态（与 commands/router.rs RouterDispatchResponse 对应） */
interface DispatchResponse {
  msgId: string
  ok: boolean
  result: Record<string, unknown> | null
  error: string | null
  trace: string
}

/** 经统一总线调用 cap.prompt_snippet */
async function snippetDispatch(action: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await invoke<DispatchResponse>('router_dispatch', {
    req: {
      target: 'cap.prompt_snippet',
      payload: { action, ...payload },
    },
  })
  if (!res.ok) {
    throw new Error(res.error || `cap.prompt_snippet ${action} 失败`)
  }
  return res.result || {}
}

/** 列出所有快捷片段 */
export async function snippetList(): Promise<PromptSnippet[]> {
  const result = await snippetDispatch('list')
  return (result.items as PromptSnippet[]) || []
}

/** 获取单个快捷片段 */
export async function snippetGet(id: string): Promise<PromptSnippet | null> {
  const result = await snippetDispatch('get', { id })
  return (result.item as PromptSnippet | null) ?? null
}

/** 创建快捷片段 */
export async function snippetCreate(params: CreateSnippetParams): Promise<PromptSnippet> {
  const result = await snippetDispatch('create', { ...params })
  return result.item as PromptSnippet
}

/** 更新快捷片段 */
export async function snippetUpdate(id: string, params: UpdateSnippetParams): Promise<PromptSnippet | null> {
  const result = await snippetDispatch('update', { id, ...params })
  return (result.item as PromptSnippet | null) ?? null
}

/** 删除快捷片段 */
export async function snippetDelete(id: string): Promise<boolean> {
  const result = await snippetDispatch('delete', { id })
  return Boolean(result.deleted)
}
