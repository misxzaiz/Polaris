/**
 * 多开槽位解析（拆分自 OverlayApp.tsx 初始化段）。
 * 纯函数：从当前窗口 label 解析 slot 号 + 对应 posKey。
 * 规格：plans/pet-overlay-r2-spec.md §2.5 / §4.1
 *
 * 纪律：仅 pos 按 slot 分（key 后缀 `.${slot}`）；功能开关/会话 id 全局共享。
 * 非 Tauri 环境返回 slot=0 + 默认 key。
 */
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { KV_POS_KEY } from './constants'

export interface SlotInfo {
  slot: number      // 0 = 主位（label pet-overlay）；2..8 = 副位
  posKey: string    // slot=0 → KV_POS_KEY；slot≥2 → KV_POS_KEY.${slot}
}

/** 从当前窗口 label 解析槽位号与 posKey。非 Tauri 环境返回默认。 */
export async function resolveSlot(): Promise<SlotInfo> {
  if (!('__TAURI_INTERNALS__' in window)) return { slot: 0, posKey: KV_POS_KEY }
  try {
    const lbl = getCurrentWebviewWindow().label
    if (lbl.startsWith('pet-overlay-')) {
      const slot = Number(lbl.split('-').pop()) || 0
      return { slot, posKey: slot ? `${KV_POS_KEY}.${slot}` : KV_POS_KEY }
    }
  } catch { /* 单开形态 */ }
  return { slot: 0, posKey: KV_POS_KEY }
}
