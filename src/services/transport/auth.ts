/**
 * Web 模式服务端地址 / Token 管理
 */

const SERVER_URL_KEY = 'polaris_server_url';
const TOKEN_MD5_KEY = 'polaris_web_token_md5';

/**
 * 获取服务器地址
 *
 * 优先级: localStorage > window.location.origin
 * 移动端 Tauri 中，window.location.origin 是 tauri://localhost，
 * 不可用作 API 地址，因此移动端必须通过 localStorage 预设服务器地址。
 */
export function getServerUrl(): string {
  const stored = localStorage.getItem(SERVER_URL_KEY);
  if (stored) return stored;

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
  localStorage.setItem(SERVER_URL_KEY, url);
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
