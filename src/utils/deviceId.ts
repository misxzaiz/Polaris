/**
 * 端级设备标识（S4 · 统一仲裁所需）
 *
 * 每个前端进程（桌面 / web / 移动）有一个稳定的 deviceId，用于：
 * - 后端仲裁：send/interrupt 的 owner 校验（startedByDevice == deviceId）
 * - 幂等键：requestId 配合 deviceId 防双写
 *
 * 持久化策略：localStorage（端级稳定，重启不变）。
 * 无 localStorage 环境回退内存变量（同一进程内稳定）。
 *
 * 对齐 spec §6 风险：requestId UUID 不跨请求复用；deviceId 端级全局唯一。
 */

import { generateUUID } from '@/utils/uuid'

const DEVICE_ID_KEY = '__polaris_device_id__'

let memoryDeviceId: string | null = null

/**
 * 获取本端 deviceId（首次调用时生成并持久化，后续返回同一值）。
 *
 * 读取优先级：localStorage（跨会话稳定）> 内存变量（同进程内稳定）。
 * 先读 localStorage 确保：外部重置 localStorage 后下次调用能感知。
 */
export function getDeviceId(): string {
  // 优先读 localStorage（跨会话 / 跨模块重新加载时恢复同一值）
  try {
    const stored = localStorage.getItem(DEVICE_ID_KEY)
    if (stored) {
      memoryDeviceId = stored
      return stored
    }
  } catch {
    // localStorage 不可用（隐私模式等）→ 回退内存
  }

  if (memoryDeviceId) return memoryDeviceId

  // 生成并持久化
  const id = generateUUID()
  memoryDeviceId = id
  try {
    localStorage.setItem(DEVICE_ID_KEY, id)
  } catch {
    // 持久化失败 → 仅内存（同进程内稳定）
  }
  return id
}

/**
 * 生成请求级幂等键（每次调用新 UUID，不跨请求复用）。
 */
export function newRequestId(): string {
  return generateUUID()
}
