/**
 * auth — Pocket 桌面端连接认证管理
 *
 * 直接复用主项目 src/services/transport/auth 的实现，
 * 确保 Pocket 与主项目的 localStorage key 一致。
 */
export {
  getServerUrl,
  storeServerUrl,
  clearServerUrl,
  getTokenMd5,
  storeTokenMd5,
  getServerHistory,
  addServerToHistory,
  removeServerFromHistory,
  md5Hex,
} from '@/services/transport/auth';

export type { ServerHistoryEntry } from '@/services/transport/auth';