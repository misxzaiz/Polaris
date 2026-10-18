/**
 * Prompt 历史持久化服务（cap.kv）
 *
 * 范式同 configDispatchService / dataRootService：经 RouterBus dispatch
 * 调用既有 cap.kv 能力（数据根 <DataRoot>/stores/kv.db），零后端改动，
 * 不引入 localStorage（遵守数据根单点原则，桌面与 Web 运行态共用一份事实）。
 *
 * 归属 key 按 workspace 隔离（对齐 ZCode promptHistoryStorage 的 per-workspace
 * 语义，但存储通道走总线）：不同工作区提示词历史互不串味。
 */

import { invoke } from '@/services/transport'
import { createLogger } from '@/utils/logger'
import { normalizePromptHistoryEntries } from '@/components/Chat/input/promptHistory'

const log = createLogger('PromptHistoryService')

/** router_dispatch 返回形态（与 commands/router.rs RouterDispatchResponse 对应） */
interface DispatchResponse {
  msgId: string
  ok: boolean
  result: Record<string, unknown> | null
  error: string | null
  trace: string
}

/** 无工作区会话（自由会话）共享的历史桶 */
const NO_WORKSPACE_KEY_PART = 'no-workspace'

/** cap.kv 内的域键（domain 固定为 kv，键名自带前缀避免与其它 kv 使用方冲突） */
export function promptHistoryKey(workspacePath: string | null | undefined): string {
  return `prompt-history:${workspacePath || NO_WORKSPACE_KEY_PART}`
}

/** 经 RouterBus dispatch 调用 cap.kv */
async function dispatchKv(
  action: 'get' | 'set',
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await invoke<DispatchResponse>('router_dispatch', {
    req: {
      target: 'cap.kv',
      payload: {
        action,
        ...payload,
      },
    },
  })

  if (!res.ok) {
    throw new Error(res.error || `cap.kv ${action} 失败`)
  }
  return res.result || {}
}

/**
 * 读取指定工作区的 prompt 历史。读失败/解析失败一律返回 []，
 * 不阻塞输入框可用性（历史召回是增强功能，失败只降级不报错）。
 */
export async function readPromptHistoryEntries(
  workspacePath: string | null | undefined,
): Promise<string[]> {
  try {
    const result = await dispatchKv('get', { key: promptHistoryKey(workspacePath) })
    const value = result.value
    if (!Array.isArray(value)) {
      return []
    }
    // 读侧规范化：过滤非字符串/空串、trim、上限截断（老数据或手改数据兜底）
    return normalizePromptHistoryEntries(value)
  } catch (e) {
    log.warn('读取 prompt 历史失败，按空历史降级', { error: String(e) })
    return []
  }
}

/**
 * 写入指定工作区的 prompt 历史。写失败仅 warn，不重试：
 * 调用方（发送提交路径）已把内存 ref 作为浏览态事实源，落库失败只影响下次启动召回。
 */
export async function persistPromptHistoryEntries(
  workspacePath: string | null | undefined,
  entries: readonly string[],
): Promise<void> {
  try {
    const normalized = normalizePromptHistoryEntries(entries)
    await dispatchKv('set', {
      key: promptHistoryKey(workspacePath),
      value: normalized,
    })
  } catch (e) {
    log.warn('写入 prompt 历史失败', { error: String(e) })
  }
}
