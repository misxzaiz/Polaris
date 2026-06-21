import { useState, useCallback, useMemo } from 'react'

interface ColorFormat {
  hex: string
  rgb: string
  hsl: string
  hsv: string
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : null
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break
    case g: h = ((b - r) / d + 2) / 6; break
    case b: h = ((r - g) / d + 4) / 6; break
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) }
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  const v = max
  const s = max === 0 ? 0 : d / max
  let h = 0
  if (max !== min) {
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break
      case g: h = ((b - r) / d + 2) / 6; break
      case b: h = ((r - g) / d + 4) / 6; break
    }
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), v: Math.round(v * 100) }
}

function generatePalette(baseHex: string): string[] {
  const rgb = hexToRgb(baseHex)
  if (!rgb) return []
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b)
  const colors: string[] = []
  for (let i = 0; i < 10; i++) {
    const l = 10 + i * 8
    const hslStr = `hsl(${hsl.h}, ${hsl.s}%, ${l}%)`
    const div = document.createElement('div')
    div.style.color = hslStr
    document.body.appendChild(div)
    const computed = getComputedStyle(div).color
    document.body.removeChild(div)
    const match = computed.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/)
    if (match) {
      const hex = '#' + [match[1], match[2], match[3]].map((c) => parseInt(c).toString(16).padStart(2, '0')).join('')
      colors.push(hex)
    }
  }
  return colors
}

export default function ColorPickerPanel({ pluginId }: { pluginId: string; onSendToChat?: (msg: string) => void }) {
  const [inputColor, setInputColor] = useState('#3B82F6')
  const [copied, setCopied] = useState<string | null>(null)

  const formats = useMemo<ColorFormat | null>(() => {
    const rgb = hexToRgb(inputColor)
    if (!rgb) return null
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b)
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b)
    return {
      hex: inputColor.toUpperCase(),
      rgb: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
      hsl: `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`,
      hsv: `hsv(${hsv.h}, ${hsv.s}%, ${hsv.v}%)`,
    }
  }, [inputColor])

  const palette = useMemo(() => generatePalette(inputColor), [inputColor])

  const handleCopy = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 1500)
  }, [])

  const handleRandom = useCallback(() => {
    const hex = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')
    setInputColor(hex)
  }, [])

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#E8E8EC' }}>取色工具</h3>
        <span style={{ fontSize: 10, color: '#71717A' }}>Plugin: {pluginId}</span>
      </div>

      {/* Color Preview & Input */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 8,
            background: inputColor,
            border: '2px solid #3F3F46',
            cursor: 'pointer',
            position: 'relative',
            overflow: 'hidden',
          }}
          onClick={() => {
            const input = document.createElement('input')
            input.type = 'color'
            input.value = inputColor
            input.addEventListener('input', (e) => setInputColor((e.target as HTMLInputElement).value))
            input.click()
          }}
        >
          <input
            type="color"
            value={inputColor}
            onChange={(e) => setInputColor(e.target.value)}
            style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }}
          />
        </div>
        <input
          type="text"
          value={inputColor}
          onChange={(e) => {
            const val = e.target.value
            if (/^#[0-9a-fA-F]{6}$/.test(val)) setInputColor(val)
          }}
          placeholder="#3B82F6"
          style={{
            flex: 1,
            padding: '8px 10px',
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: '#18181B',
            color: '#E8E8EC',
            fontFamily: 'Consolas, Monaco, "Courier New", monospace',
            fontSize: 12,
            outline: 'none',
          }}
        />
        <button
          onClick={handleRandom}
          style={{
            padding: '8px 12px',
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: '#27272A',
            color: '#A1A1AA',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          随机
        </button>
      </div>

      {/* Color Formats */}
      {formats && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {Object.entries(formats).map(([key, value]) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 36, fontSize: 10, color: '#71717A', textTransform: 'uppercase' }}>{key}</span>
              <div
                style={{
                  flex: 1,
                  padding: '6px 10px',
                  borderRadius: 4,
                  background: '#18181B',
                  border: '1px solid #3F3F46',
                  fontFamily: 'monospace',
                  fontSize: 11,
                  color: '#E8E8EC',
                }}
              >
                {value}
              </div>
              <button
                onClick={() => handleCopy(value, key)}
                style={{
                  padding: '4px 8px',
                  borderRadius: 4,
                  border: '1px solid #3F3F46',
                  background: copied === key ? '#22C55E' : '#27272A',
                  color: copied === key ? '#fff' : '#A1A1AA',
                  fontSize: 10,
                  cursor: 'pointer',
                }}
              >
                {copied === key ? '✓' : '复制'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Color Palette */}
      {palette.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, color: '#71717A' }}>色阶</span>
          <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #3F3F46' }}>
            {palette.map((color, i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  height: 32,
                  background: color,
                  cursor: 'pointer',
                  position: 'relative',
                }}
                onClick={() => setInputColor(color)}
                onMouseEnter={(e) => {
                  const span = document.createElement('span')
                  span.textContent = color
                  span.style.cssText = 'position:absolute;bottom:100%;left:50%;transform:translateX(-50%);background:#000;color:#fff;padding:2px 4px;border-radius:3px;font-size:9px;white-space:nowrap;pointer-events:none;z-index:10;'
                  ;(e.target as HTMLElement).appendChild(span)
                }}
                onMouseLeave={(e) => {
                  const span = (e.target as HTMLElement).querySelector('span')
                  if (span) span.remove()
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Quick Colors */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11, color: '#71717A' }}>常用颜色</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {['#EF4444', '#F97316', '#EAB308', '#22C55E', '#06B6D4', '#3B82F6', '#8B5CF6', '#EC4899', '#000000', '#FFFFFF', '#6B7280', '#374151'].map((color) => (
            <div
              key={color}
              style={{
                width: 24,
                height: 24,
                borderRadius: 4,
                background: color,
                border: '1px solid #3F3F46',
                cursor: 'pointer',
              }}
              onClick={() => setInputColor(color)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
