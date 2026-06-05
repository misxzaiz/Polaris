/**
 * 模型 Profile 服务
 *
 * 封装 Profile 相关的 Tauri IPC 命令。
 */

import { invoke } from '@/services/transport'
import type { ModelProfile } from '@/types/modelProfile'

/**
 * 测试模型 Profile 连接
 *
 * 向 Profile 配置的端点发送最小化请求，验证连通性。
 * @returns true 表示端点可达，false 表示不可达
 */
export async function testModelProfileConnection(profile: ModelProfile): Promise<boolean> {
  return invoke<boolean>('test_model_profile_connection', { profile })
}
