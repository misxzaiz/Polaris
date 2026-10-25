/**
 * Polaris Web Service Worker（PWA 基建，阶段 1B）
 *
 * 设计原则（保守）：
 * - 协议数据绝不缓存：/api/* 与 /ws 直接放行（会话/令牌/流式数据无缓存意义，
 *   缓存它们只会制造陈旧数据与鉴权混乱）。
 * - SPA 导航（HTML 壳）network-first：在线永远拿最新构建，离线回退缓存壳，
 *   保证"弱网/断网时 App 至少能打开"。
 * - 带内容哈希的构建产物（/assets/*）stale-while-revalidate：命中缓存即时返回，
 *   后台刷新；哈希文件名天然版本化，无陈旧风险。
 * - 新版本 SW 安装即 skipWaiting + clients.claim（导航 network-first 已保证
 *   壳是新的，无需用户确认的版本提示；推送/更新 UX 属后续批次）。
 *
 * 仅在生产构建注册（main.tsx 以 import.meta.env.PROD 门控），dev HMR 零影响。
 */

const CACHE = 'polaris-static-v1'
// 启动壳（导航回退目标）；manifest 独立缓存以便离线安装判断
const SHELL_URLS = ['/', '/manifest.webmanifest', '/icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  // 协议数据（REST 命令 / WS 升级 / 文件预览）一律直连，不进 SW
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return

  // SPA 导航：network-first，离线回退启动壳
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((cache) => cache.put('/', copy))
          return res
        })
        .catch(() => caches.match('/'))
    )
    return
  }

  // 哈希构建产物：stale-while-revalidate
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const refresh = fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone()
              caches.open(CACHE).then((cache) => cache.put(req, copy))
            }
            return res
          })
          .catch(() => cached)
        return cached || refresh
      })
    )
  }
})
