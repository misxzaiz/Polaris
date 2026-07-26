import { create } from 'zustand'
import type { DevicePreset } from '@/plugins/app-preview/constants/devices'
import { DEVICE_PRESETS } from '@/plugins/app-preview/constants/devices'

interface DeviceState {
  /** 当前选中的设备 ID */
  deviceId: string
  /** 当前选中的设备（派生） */
  device: DevicePreset | null
  /** 当前选中的设备分组 */
  activeGroup: string
  /** 缩放值（0.25 ~ 2，1=原始大小） */
  scale: number
  /** 是否按预览区自适应缩放（true=自动缩放填满预览区，false=使用固定 scale） */
  autoScale: boolean
}

interface DeviceActions {
  /** 选择设备 */
  selectDevice: (deviceId: string) => void
  /** 设置缩放值 */
  setScale: (scale: number) => void
  /** 重置缩放 */
  resetScale: () => void
  /** 切换自适应缩放 */
  toggleAutoScale: () => void
  /** 切换设备分组 */
  setActiveGroup: (group: string) => void
}

export type { DevicePreset }

const DEFAULT_DEVICE = DEVICE_PRESETS.find((d) => d.id === 'iphone-14-pro') || DEVICE_PRESETS[0]

function createDeviceStore() {
  return create<DeviceState & DeviceActions>((set, get) => ({
    deviceId: DEFAULT_DEVICE.id,
    device: DEFAULT_DEVICE,
    activeGroup: 'all',
    scale: 1,
    autoScale: true,

    selectDevice: (deviceId) => {
      const preset = DEVICE_PRESETS.find((d) => d.id === deviceId)
      if (!preset) return

      set({
        deviceId,
        device: preset,
        // 切换设备时重置 scale 到 1（autoScale 模式下实际由父组件计算）
        scale: 1,
      })

      // 切换分组：根据新设备所属分组自动切换
      const group = preset.group
      const currentGroup = get().activeGroup
      if (currentGroup !== 'all' && currentGroup !== group) {
        set({ activeGroup: group })
      }
    },

    setScale: (scale) => {
      const clamped = Math.max(0.25, Math.min(2, scale))
      set({ scale: clamped })
    },

    resetScale: () => {
      set({ scale: 1 })
    },

    toggleAutoScale: () => {
      set((s) => ({ autoScale: !s.autoScale }))
    },

    setActiveGroup: (group) => {
      set({ activeGroup: group })
    },
  }))
}

export const useDeviceStore = createDeviceStore()
