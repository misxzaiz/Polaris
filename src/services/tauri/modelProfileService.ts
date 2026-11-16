/**
 * 模型 Profile 服务
 *
 * 封装 Profile 相关的 Tauri IPC 命令。
 */

import { invoke } from '@/services/transport'

/** K-R5 批E3：model_profile 命令删除，走 cap.meta 总线 */
async function metaDispatch<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const res = await invoke<{ msgId: string; ok: boolean; result: T; error: string | null }>('router_dispatch', {
    req: { target: 'cap.meta', payload: { action, ...payload } },
  })
  if (!res.ok) throw new Error(res.error || ('cap.meta ' + action + ' 失败'))
  return res.result
}
import type { ModelProfile, ConnectionTestResult } from '@/types/modelProfile'

/**
 * 测试模型 Profile 连接
 *
 * 向 Profile 配置的端点发送最小化请求，验证连通性。
 * @returns 结构化结果：`ok` 表示端点可达；失败时 `status`/`detail`
 *          携带 HTTP 状态码与错误体摘要，供 UI 展示具体原因。
 */
export async function testModelProfileConnection(profile: ModelProfile): Promise<ConnectionTestResult> {
  return metaDispatch<ConnectionTestResult>('model_test_connection', { profile })
}

/**
 * 从 Profile 端点拉取可用模型列表
 *
 * `GET {baseUrl}/v1/models`，按线路格式注入鉴权头，返回模型 ID 列表。
 * @returns 模型 ID 字符串数组；端点不支持或失败时由后端返回错误
 */
export async function fetchModelsForProfile(profile: ModelProfile): Promise<string[]> {
  return metaDispatch<string[]>('model_fetch_models', { profile })
}
