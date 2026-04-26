/**
 * Web 模式服务端地址管理（Token 已移除，仅保留 server URL 管理）
 */

const SERVER_URL_KEY = 'polaris_server_url';

/** 获取服务器地址（localStorage 或当前页面 origin） */
export function getServerUrl(): string {
  return localStorage.getItem(SERVER_URL_KEY) || window.location.origin;
}

/** 保存服务器地址 */
export function storeServerUrl(url: string): void {
  localStorage.setItem(SERVER_URL_KEY, url);
}
