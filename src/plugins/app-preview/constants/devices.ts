export interface DevicePreset {
  /** 唯一标识 */
  id: string
  /** 设备显示名称 */
  name: string
  /** CSS 媒体查询中的宽度（对应 width 字段） */
  width: number
  /** CSS 媒体查询中的高度（对应 height 字段） */
  height: number
  /** 设备像素比（影响 window.devicePixelRatio） */
  devicePixelRatio: number
  /** 是否带有顶部刘海（Dynamic Island / Notch） */
  hasNotch: boolean
  /** 分组 */
  group: 'iphone' | 'android' | 'standard'
}

export const DEVICE_PRESETS: DevicePreset[] = [
  // iPhone
  { id: 'iphone-15-pro-max', name: 'iPhone 15 Pro Max', width: 430, height: 932, devicePixelRatio: 3, hasNotch: true, group: 'iphone' },
  { id: 'iphone-15-pro',     name: 'iPhone 15 Pro',      width: 393, height: 852, devicePixelRatio: 3, hasNotch: true, group: 'iphone' },
  { id: 'iphone-14-pro',     name: 'iPhone 14 Pro',      width: 390, height: 844, devicePixelRatio: 3, hasNotch: true, group: 'iphone' },
  { id: 'iphone-se',         name: 'iPhone SE',          width: 375, height: 667, devicePixelRatio: 2, hasNotch: false, group: 'iphone' },
  // Android
  { id: 'pixel-8-pro',       name: 'Pixel 8 Pro',        width: 412, height: 915, devicePixelRatio: 2.75, hasNotch: true, group: 'android' },
  { id: 'pixel-7',           name: 'Pixel 7',            width: 412, height: 892, devicePixelRatio: 2.625, hasNotch: true, group: 'android' },
  { id: 'samsung-s24',       name: 'Galaxy S24',         width: 360, height: 780, devicePixelRatio: 3, hasNotch: true, group: 'android' },
  // 自定义
  { id: 'custom',            name: '自定义',             width: 375, height: 812, devicePixelRatio: 3, hasNotch: true, group: 'standard' },
]

export interface DeviceGroup {
  key: string
  label: string
  devices: DevicePreset[]
}

export const DEVICE_GROUPS: DeviceGroup[] = [
  { key: 'iphone', label: 'iPhone',   devices: DEVICE_PRESETS.filter((d) => d.group === 'iphone') },
  { key: 'android', label: 'Android', devices: DEVICE_PRESETS.filter((d) => d.group === 'android') },
  { key: 'standard', label: '其他',  devices: DEVICE_PRESETS.filter((d) => d.group === 'standard') },
]
