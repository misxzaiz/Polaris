import { useEffect, useState } from 'react'

const FAVICON_CACHE = new Map<string, string | null>()
const FAVICON_TIMEOUT = 5_000

export function useFavicon(url: string): string | null {
  const [favicon, setFavicon] = useState<string | null>(null)

  useEffect(() => {
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      setFavicon(null)
      return
    }

    // 缓存命中
    if (FAVICON_CACHE.has(host)) {
      setFavicon(FAVICON_CACHE.get(host) ?? null)
      return
    }

    // 尝试原生 favicon.ico
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), FAVICON_TIMEOUT)

    fetch(`https://${host}/favicon.ico`, { signal: abort.signal, mode: 'no-cors' })
      .then(() => {
        const iconUrl = `https://${host}/favicon.ico`
        FAVICON_CACHE.set(host, iconUrl)
        setFavicon(iconUrl)
      })
      .catch(() => {
        // 回退到 Google favicon 服务
        const fallback = `https://t2.gstatic.com/faviconV2?url=${host}`
        FAVICON_CACHE.set(host, fallback)
        setFavicon(fallback)
      })
      .finally(() => clearTimeout(timer))

    return () => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [url])

  return favicon
}