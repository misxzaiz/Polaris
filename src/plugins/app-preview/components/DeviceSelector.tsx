import { clsx } from 'clsx'
import { Smartphone } from 'lucide-react'
import { DEVICE_GROUPS, DevicePreset } from '@/plugins/app-preview/constants/devices'
import { useDeviceStore } from '@/plugins/app-preview/stores/deviceStore'

interface DeviceSelectorProps {
  /** 当前选中的设备 */
  current: DevicePreset
  /** 选择回调 */
  onSelect: (device: DevicePreset) => void
  /** 显示组切换 tabs（true=显示 group tabs；false=所有设备平铺） */
  showGroupTabs?: boolean
}

/** 设备选择器：列出所有设备预设，支持按分组折叠 */
export function DeviceSelector({
  current,
  onSelect,
  showGroupTabs = true,
}: DeviceSelectorProps) {
  const { activeGroup, setActiveGroup } = useDeviceStore()

  const filteredDevices = activeGroup === 'all'
    ? DEVICE_GROUPS.flatMap((g) => g.devices)
    : DEVICE_GROUPS.find((g) => g.key === activeGroup)?.devices || []

  return (
    <div className="device-selector">
      {/* 分组 tabs */}
      {showGroupTabs && (
        <div className="device-selector__tabs">
          <button
            className={clsx('device-selector__tab', activeGroup === 'all' && 'active')}
            onClick={() => setActiveGroup('all')}
          >
            全部
          </button>
          {DEVICE_GROUPS.map((g) => (
            <button
              key={g.key}
              className={clsx('device-selector__tab', activeGroup === g.key && 'active')}
              onClick={() => setActiveGroup(g.key)}
            >
              {g.label}
            </button>
          ))}
        </div>
      )}

      {/* 设备网格 */}
      <div className="device-selector__grid">
        {filteredDevices.map((device) => (
          <button
            key={device.id}
            className={clsx(
              'device-selector__item',
              current.id === device.id && 'selected'
            )}
            onClick={() => onSelect(device)}
            title={`${device.name} (${device.width}×${device.height})`}
          >
            {/* 设备图标（SVG 轮廓） */}
            <span className="device-selector__icon">
              <Smartphone
                size={20}
                strokeWidth={1.5}
                className={clsx(current.id === device.id && 'text-primary')}
              />
            </span>
            <span className="device-selector__name">{device.name}</span>
            <span className="device-selector__size">{device.width}×{device.height}</span>
          </button>
        ))}
      </div>

      <style>{DeviceSelectorStyles}</style>
    </div>
  )
}

const DeviceSelectorStyles = `
  .device-selector {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .device-selector__tabs {
    display: flex;
    gap: 4px;
    background: rgba(255, 255, 255, 0.05);
    padding: 3px;
    border-radius: 8px;
  }

  .device-selector__tab {
    flex: 1;
    padding: 6px 12px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: rgba(255, 255, 255, 0.6);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .device-selector__tab:hover {
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.9);
  }

  .device-selector__tab.active {
    background: rgba(255, 255, 255, 0.15);
    color: #fff;
  }

  .device-selector__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: 8px;
  }

  .device-selector__item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 12px 8px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.03);
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: center;
    min-height: 72px;
  }

  .device-selector__item:hover {
    border-color: rgba(255, 255, 255, 0.2);
    background: rgba(255, 255, 255, 0.06);
  }

  .device-selector__item.selected {
    border-color: var(--c-primary, #60A5FA);
    background: rgba(96, 165, 250, 0.08);
    color: #fff;
  }

  .device-selector__icon {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    color: rgba(255, 255, 255, 0.4);
  }

  .device-selector__name {
    font-size: 11px;
    font-weight: 500;
    line-height: 1.2;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .device-selector__size {
    font-size: 9px;
    color: rgba(255, 255, 255, 0.35);
    font-family: 'JetBrains Mono', monospace;
  }
`
