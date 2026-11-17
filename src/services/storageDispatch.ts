/**
 * cap.storage 统一调用助手（S3 存储插件化：plans/s3-storage-plugin-spec.md）
 *
 * 存储 action 面收口到单一总线能力；storage-sqlite 插件接管后前端零改动。
 */
import { invoke } from '@/services/transport'

export interface StorageDispatchResponse {
  msgId: string
  ok: boolean
  result: unknown
  error: string | null
  trace: string
}

export async function storageDispatch<T = unknown>(payload: Record<string, unknown>): Promise<T> {
  const res = await invoke<StorageDispatchResponse>('router_dispatch', {
    req: { target: 'cap.storage', payload },
  })
  if (!res.ok) {
    throw new Error(res.error || ('cap.storage ' + String(payload.action ?? '') + ' 失败'))
  }
  return res.result as T
}
