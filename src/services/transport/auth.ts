/**
 * Web 模式 Token 管理
 *
 * 支持两种 token 获取方式：
 * 1. URL query param: ?token=xxx（首次接入，桌面端 QR 码扫码场景）
 * 2. localStorage: polaris_token（后续访问）
 */

const STORAGE_KEY = 'polaris_token';
const SERVER_URL_KEY = 'polaris_server_url';

/** 从 URL query param 提取 token */
export function getTokenFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('token');
}

/** 从 localStorage 读取已保存的 token */
export function getStoredToken(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

/** 保存 token 到 localStorage */
export function storeToken(token: string): void {
  localStorage.setItem(STORAGE_KEY, token);
}

/** 清除已保存的 token */
export function clearStoredToken(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** 获取服务器地址（localStorage 或当前页面 origin） */
export function getServerUrl(): string {
  return localStorage.getItem(SERVER_URL_KEY) || window.location.origin;
}

/** 保存服务器地址 */
export function storeServerUrl(url: string): void {
  localStorage.setItem(SERVER_URL_KEY, url);
}

/**
 * 初始化 Web 认证
 *
 * 1. 从 URL 提取 token（如有）并保存到 localStorage
 * 2. 清理 URL 中的 token 参数，避免泄露
 * 3. 返回最终可用的 token
 */
export function initWebAuth(): string | null {
  const urlToken = getTokenFromUrl();
  if (urlToken) {
    storeToken(urlToken);
    // 清理 URL，防止 token 泄露到地址栏
    window.history.replaceState({}, '', window.location.pathname);
  }
  return getStoredToken();
}
