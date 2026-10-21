/**
 * voiceBroadcast — 句合成结果内存缓存（P0-5，LRU）
 *
 * 动机（父 spec §6.3）：MiMo 免费额度未知，重听/重复收听/重开同方向/探测等
 * 场景存在大量同参数重复合成。key = hash(text+voice+style+outputMode)，
 * 命中即零 API 成本。
 *
 * 边界（P0 子 spec 如实交代）：
 * - 仅内存（App 运行期有效），跨 stop 保留（stop 清队列不清缓存——缓存价值
 *   恰在「重开同方向」）；持久化磁盘缓存归 P1 cap.voice。
 * - file 模式 url 指向插件托管文件，插件侧无 GC（本次会话内稳定），url 可安全复用；
 *   base64 data URL 自包含，同样可复用。
 */
import { createLogger } from '@/utils/logger'

const log = createLogger('VoiceBroadcastSynthCache')

/** 缓存条目数上限（句级合成，单条 url/data URL；200 条约覆盖数小时连续播报） */
const MAX_ENTRIES = 200

/** 字节估算上限（50MB）：data URL 可精确算，file url 无长度信息按均值 100KB 估 */
const MAX_BYTES = 50 * 1024 * 1024
const FILE_URL_ESTIMATE_BYTES = 100 * 1024

export interface SynthCacheEntry {
  /** 可播放地址（file url 或 data URL） */
  url: string
  format?: string
}

/** 简单字符串 hash（djb2 变体，足够区分合成参数组合；非安全场景） */
function hashKey(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36) + '_' + input.length.toString(36)
}

export function synthCacheKey(args: {
  text: string
  voice?: string
  style?: string
  outputMode?: 'file' | 'base64'
}): string {
  return hashKey(`${args.outputMode ?? 'file'}\u0000${args.voice ?? ''}\u0000${args.style ?? ''}\u0000${args.text}`)
}

export class SynthCache {
  /** key → entry；Map 保序 = 访问序（get 时重插尾部，淘汰取队头） */
  private map = new Map<string, SynthCacheEntry>()
  private bytes = 0

  get(key: string): SynthCacheEntry | null {
    const hit = this.map.get(key)
    if (!hit) return null
    // 访问序刷新：删后重插到尾部（最近使用）
    this.map.delete(key)
    this.map.set(key, hit)
    return hit
  }

  put(key: string, entry: SynthCacheEntry): void {
    // 同 key 覆盖：先扣减旧字节
    const old = this.map.get(key)
    if (old) {
      this.bytes -= this.estimate(old.url)
      this.map.delete(key)
    }
    this.map.set(key, entry)
    this.bytes += this.estimate(entry.url)
    this.evict()
  }

  private estimate(url: string): number {
    // data URL：base64 部分 ≈ 原始字节 ×4/3；file url 按均值估算
    if (url.startsWith('data:')) {
      const base64 = url.split(',')[1] ?? ''
      return Math.round((base64.length * 3) / 4)
    }
    return FILE_URL_ESTIMATE_BYTES
  }

  /** 超限淘汰：从最旧（队头）开始，直到条目数与字节量双双达标 */
  private evict(): void {
    while (this.map.size > MAX_ENTRIES || this.bytes > MAX_BYTES) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      const key = oldest.value
      const entry = this.map.get(key)
      this.map.delete(key)
      if (entry) this.bytes -= this.estimate(entry.url)
    }
    if (this.map.size > 0) {
      log.debug('缓存状态', { entries: this.map.size, estBytes: this.bytes })
    }
  }

  clear(): void {
    this.map.clear()
    this.bytes = 0
  }

  get size(): number {
    return this.map.size
  }
}
