import { DevicePreset } from '@/plugins/app-preview/constants/devices'

/** 获取当前设备预设的 CSS `width` 变量值 */
export function getDeviceWidth(device: DevicePreset): string {
  return `${device.width}px`
}

/** 获取当前设备预设的 CSS `height` 变量值 */
export function getDeviceHeight(device: DevicePreset): string {
  return `${device.height}px`
}

/** 判断设备是否有顶部刘海 */
export function deviceHasNotch(device: DevicePreset): boolean {
  return device.hasNotch
}

/** 计算预览区应显示的 `transform: scale` 值 */
export function computeScale(
  device: DevicePreset,
  previewContentWidth: number | null,
  previewContentHeight: number | null,
): number {
  if (!previewContentWidth || !previewContentHeight || device.width === 0 || device.height === 0) {
    return 1
  }

  const scaleX = previewContentWidth / device.width
  const scaleY = previewContentHeight / device.height
  const scale = Math.min(scaleX, scaleY)

  // 限制缩放范围：最小 0.25（设备很大时缩小），最大 2（设备很小时放大）
  return Math.max(0.25, Math.min(2, scale))
}
