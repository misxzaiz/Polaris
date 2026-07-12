/**
 * 网站图标抓取（移植自 personal-hub src/utils/favicon.ts）
 *
 * 纯前端探测站点静态资源 + DuckDuckGo 兜底，localStorage 7 天缓存。
 * 不请求任何后端端点。
 */

interface IconCacheEntry {
  url: string
  timestamp: number
}

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000 // 7 天

export async function fetchFavicon(url: string): Promise<string | null> {
  try {
    const domain = new URL(url).origin

    const cached = getIconFromCache(domain)
    if (cached) return cached

    const sources = [
      `${domain}/favicon.ico`,
      `${domain}/favicon.png`,
      `${domain}/apple-touch-icon.png`,
      `${domain}/icon.png`,
      `${domain}/assets/favicon.ico`,
      `${domain}/static/favicon.ico`,
      `${domain}/images/favicon.ico`,
      `https://icons.duckduckgo.com/ip3/${new URL(url).host}.ico`,
    ]

    for (const iconUrl of sources) {
      try {
        if (await testImageUrl(iconUrl)) {
          setIconCache(domain, iconUrl)
          return iconUrl
        }
      } catch {
        continue
      }
    }
    return null
  } catch {
    return null
  }
}

/** 测试图片是否可加载（8 秒超时） */
export function testImageUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image()
    const timeout = setTimeout(() => {
      img.src = ''
      resolve(false)
    }, 8000)
    img.onload = () => {
      clearTimeout(timeout)
      resolve(true)
    }
    img.onerror = () => {
      clearTimeout(timeout)
      resolve(false)
    }
    img.src = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`
  })
}

export function getIconFromCache(domain: string): string | null {
  try {
    const cached = localStorage.getItem(`favicon_${domain}`)
    if (cached) {
      const { url, timestamp } = JSON.parse(cached) as IconCacheEntry
      if (Date.now() - timestamp < CACHE_TTL) return url
      localStorage.removeItem(`favicon_${domain}`)
    }
  } catch {
    // ignore
  }
  return null
}

export function setIconCache(domain: string, url: string): void {
  try {
    const entry: IconCacheEntry = { url, timestamp: Date.now() }
    localStorage.setItem(`favicon_${domain}`, JSON.stringify(entry))
  } catch {
    // ignore
  }
}
