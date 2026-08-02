/**
 * Web 模式服务端地址 / Token 管理
 */

const SERVER_URL_KEY = 'polaris_server_url';
const TOKEN_MD5_KEY = 'polaris_web_token_md5';
/** 已连接过的服务地址历史（JSON 数组），最近使用排在前面 */
const SERVER_HISTORY_KEY = 'polaris_server_history';
/** 用户主动断开后，阻止 getServerUrl 回退到页面 origin */
const DISCONNECT_REQUESTED_KEY = 'polaris_disconnect_requested';
/** 历史记录上限，超出后丢弃最旧条目 */
const MAX_HISTORY_ENTRIES = 10;

/**
 * 获取服务器地址
 *
 * 优先级: localStorage > window.location.origin
 * 移动端 Tauri 中，window.location.origin 是 tauri://localhost，
 * 不可用作 API 地址，因此移动端必须通过 localStorage 预设服务器地址。
 *
 * 如果用户主动断开（clearServerUrl），则不再回退到页面 origin，
 * 返回空字符串以确保重新进入设置页。
 */
export function getServerUrl(): string {
  const stored = localStorage.getItem(SERVER_URL_KEY);
  if (stored) return stored;

  // 用户主动断开后不从页面 origin 回退
  if (localStorage.getItem(DISCONNECT_REQUESTED_KEY) === '1') {
    return '';
  }

  // 移动端 Tauri WebView 的 origin 是 tauri.localhost，不可用
  const origin = window.location.origin;
  if (origin.includes('tauri.localhost') || origin === 'tauri://localhost') {
    return '';
  }

  return origin;
}

function isMobileTauri(): boolean {
  return typeof navigator !== 'undefined' &&
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) &&
    ('__TAURI_INTERNALS__' in window);
}

/** 保存服务器地址 */
export function storeServerUrl(url: string): void {
  const trimmed = url.trim();
  if (!trimmed) return;
  localStorage.setItem(SERVER_URL_KEY, trimmed);
  // 重新连接后清除断开标记，恢复正常的 origin 回退行为
  localStorage.removeItem(DISCONNECT_REQUESTED_KEY);
  // 移动端同步保存到 Rust 后端（持久化到文件）
  saveToMobileBackend(url);
}

/**
 * 将服务器配置同步保存到移动端 Rust 后端
 * 静默失败，不影响主流程
 */
async function saveToMobileBackend(url: string): Promise<void> {
  try {
    if (!isMobileTauri()) return;
    const { invoke } = await import('@tauri-apps/api/core');
    const token = localStorage.getItem(TOKEN_MD5_KEY) || '';
    await invoke('set_server_config', { serverUrl: url, token });
  } catch {
    // 移动端后端不可用时静默忽略
  }
}

/** 读取 token 的 md5（为空表示不启用鉴权） */
export function getTokenMd5(): string {
  return localStorage.getItem(TOKEN_MD5_KEY) || '';
}

/** 保存 token 的 md5（传入空字符串表示清空/关闭鉴权） */
export function storeTokenMd5(tokenMd5: string): void {
  localStorage.setItem(TOKEN_MD5_KEY, tokenMd5);
  saveToMobileBackend(localStorage.getItem(SERVER_URL_KEY) || '');
}

// ─── 连接历史 ──────────────────────────────────────────────

export interface ServerHistoryEntry {
  /** 服务地址 */
  url: string;
  /** Token MD5（可选，为空表示该地址未配 Token） */
  tokenMd5?: string;
  /** 最近使用时间戳（ms） */
  lastUsed: number;
}

/** 读取历史记录（按最近使用倒序，最多 MAX_HISTORY_ENTRIES 条） */
export function getServerHistory(): ServerHistoryEntry[] {
  try {
    const raw = localStorage.getItem(SERVER_HISTORY_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as ServerHistoryEntry[];
  } catch {
    return [];
  }
}

/**
 * 添加或更新历史记录。
 * - 同 url 的已有条目会被移到首位并更新 tokenMd5 / lastUsed
 * - 去重并截断至 MAX_HISTORY_ENTRIES 条
 * - 不写 Token 明文，只存 MD5
 */
export function addServerToHistory(url: string, tokenMd5?: string): void {
  const existing = getServerHistory().filter((e) => e.url !== url);
  const entry: ServerHistoryEntry = {
    url,
    tokenMd5: tokenMd5 ? tokenMd5 : undefined,
    lastUsed: Date.now(),
  };
  const next = [entry, ...existing].slice(0, MAX_HISTORY_ENTRIES);
  localStorage.setItem(SERVER_HISTORY_KEY, JSON.stringify(next));
}

/** 从历史记录中移除指定地址 */
export function removeServerFromHistory(url: string): void {
  const filtered = getServerHistory().filter((e) => e.url !== url);
  localStorage.setItem(SERVER_HISTORY_KEY, JSON.stringify(filtered));
}

/** 清空全部历史记录 */
export function clearServerHistory(): void {
  localStorage.removeItem(SERVER_HISTORY_KEY);
}

/**
 * 断开当前连接（清除当前地址 + Token，保留历史记录）。
 * 设置断开标记，阻止 getServerUrl 回退到页面 origin。
 * 移动端会等待后端清空完成后再返回，避免与后续 storeServerUrl 的
 * saveToMobileBackend 发生写写竞态（两个 set_server_config 并发时
 * 后到达的空值会覆盖有效值）。
 */
export async function clearServerUrl(): Promise<void> {
  localStorage.removeItem(SERVER_URL_KEY);
  localStorage.removeItem(TOKEN_MD5_KEY);
  // 标记主动断开，防止 getServerUrl 回退到页面 origin
  localStorage.setItem(DISCONNECT_REQUESTED_KEY, '1');
  // 移动端等待后端清空完成，消除与后续写入的竞态
  if (isMobileTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_server_config', { serverUrl: '', token: '' });
    } catch {
      // 静默失败，不影响前端断开体验
    }
  }
}

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function add32(a: number, b: number): number {
  return (a + b) >>> 0;
}

function md5Bytes(input: Uint8Array): Uint8Array {
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  }

  const S = new Uint8Array([
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ]);

  // Padding
  const origLen = input.length;
  const bitLen = origLen * 8;

  let paddedLen = origLen + 1;
  while ((paddedLen % 64) !== 56) paddedLen++;
  const buf = new Uint8Array(paddedLen + 8);
  buf.set(input, 0);
  buf[origLen] = 0x80;

  const bitLenLo = (bitLen >>> 0);
  const bitLenHi = Math.floor(bitLen / 2 ** 32) >>> 0;
  // append length in bits, little-endian 64-bit
  buf[paddedLen + 0] = bitLenLo & 0xff;
  buf[paddedLen + 1] = (bitLenLo >>> 8) & 0xff;
  buf[paddedLen + 2] = (bitLenLo >>> 16) & 0xff;
  buf[paddedLen + 3] = (bitLenLo >>> 24) & 0xff;
  buf[paddedLen + 4] = bitLenHi & 0xff;
  buf[paddedLen + 5] = (bitLenHi >>> 8) & 0xff;
  buf[paddedLen + 6] = (bitLenHi >>> 16) & 0xff;
  buf[paddedLen + 7] = (bitLenHi >>> 24) & 0xff;

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Uint32Array(16);

  for (let offset = 0; offset < buf.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      M[i] = (buf[j] | (buf[j + 1] << 8) | (buf[j + 2] << 16) | (buf[j + 3] << 24)) >>> 0;
    }

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;

      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }

      const tmp = D;
      D = C;
      C = B;
      const sum = add32(add32(add32(A, F >>> 0), K[i]), M[g]);
      B = add32(B, rotl(sum, S[i]));
      A = tmp;
    }

    a0 = add32(a0, A);
    b0 = add32(b0, B);
    c0 = add32(c0, C);
    d0 = add32(d0, D);
  }

  const out = new Uint8Array(16);
  const words = [a0, b0, c0, d0];
  for (let i = 0; i < 4; i++) {
    const w = words[i];
    out[i * 4 + 0] = w & 0xff;
    out[i * 4 + 1] = (w >>> 8) & 0xff;
    out[i * 4 + 2] = (w >>> 16) & 0xff;
    out[i * 4 + 3] = (w >>> 24) & 0xff;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

/** 计算 MD5 (hex, lowercase) */
export async function md5Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  return bytesToHex(md5Bytes(bytes));
}

/**
 * 从二维码扫描结果中解析服务地址和 Token。
 *
 * 格式: `http://ip:port?token=xxx`
 * 降级: 纯 URL 或纯文本
 */
export function parseQrContent(qrContent: string): {
  serverUrl: string;
  token: string;
} {
  try {
    const url = new URL(qrContent);
    const serverUrl = `${url.protocol}//${url.host}`;
    const token = url.searchParams.get('token') || '';
    return { serverUrl, token };
  } catch {
    // 不是合法 URL，作为纯文本返回
    return { serverUrl: qrContent, token: '' };
  }
}
