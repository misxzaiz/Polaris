/**
 * crypto.subtle.digest(SHA-256) polyfill —— 供非安全上下文的 Web 端使用 edge-tts
 *
 * 背景：
 *   edge-tts-universal 仅依赖 crypto.subtle.digest(SHA-256) 计算签名
 *   （已穷举其 crypto 调用：subtle.digest ×1 + getRandomValues ×2，
 *    后者在非安全上下文可用，无需 polyfill）。
 *   crypto.subtle 仅在安全上下文（HTTPS / localhost）存在；
 *   http://<局域网IP> 等场景下为 undefined，导致 edge-tts 崩溃降级到浏览器 TTS。
 *
 * 本模块：在非安全上下文且 subtle 缺失时，注入一个最小 subtle.digest 实现。
 * 仅注入 digest('SHA-256')，其余 API 不提供（edge-tts 用不到）。
 *
 * 安全边界（不影响 App / 桌面端）：
 *   - 安全上下文（isSecureContext=true，含 App webview、localhost）下不注入，原生 subtle 优先
 *   - 已有原生 subtle 时不覆盖
 *   - 纯计算、无网络、无侧信道（TTS 签名非高安全场景，纯 JS SHA-256 可接受）
 *
 * 参考：auth.ts 的 md5Bytes 自实现模式（同风格，无外部依赖）。
 */

/** 标准 SHA-256（FIPS 180-4），输入字节，输出 32 字节 */
function sha256Bytes(input: Uint8Array): Uint8Array {
  // 常量 K（前 64 个素数的立方根小数部分前 32 位）
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;

  // 初始哈希值
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  // 填充：message + 0x80 + 0... + 64bit 长度（大端）
  const bitLenHi = Math.floor((input.length * 8) / 0x100000000);
  const bitLenLo = (input.length * 8) >>> 0;
  let len = input.length + 1;
  while (len % 64 !== 56) len++;
  const msg = new Uint8Array(len + 8);
  msg.set(input);
  msg[input.length] = 0x80;
  const dv = new DataView(msg.buffer);
  dv.setUint32(len, bitLenHi);
  dv.setUint32(len + 4, bitLenLo);

  const W = new Uint32Array(64);
  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
  return out;
}

/** 标记：是否已注入 polyfill（供诊断） */
let injected = false;

/**
 * 确保 crypto.subtle.digest 可用。仅在必要时注入，幂等。
 * 在模块加载时调用一次即可（ttsService 顶部）。
 */
export function ensureCryptoSubtleDigest(): void {
  if (injected) return;
  if (typeof window === 'undefined' || !window.crypto) return;
  // 已有原生 subtle（安全上下文 / App / localhost）→ 不动
  if (window.crypto.subtle) return;

  const digest = (algorithm: unknown, data: BufferSource): Promise<ArrayBuffer> => {
    const name = typeof algorithm === 'string'
      ? algorithm
      : (algorithm as { name?: string })?.name ?? '';
    if (name.toUpperCase() !== 'SHA-256') {
      return Promise.reject(new Error(`polyfill 仅支持 SHA-256，收到: ${name}`));
    }
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const hash = sha256Bytes(bytes);
    // 返回独立 ArrayBuffer（与原生 digest 行为一致）。typed-array `.buffer` 的静态类型是
    // ArrayBufferLike（含 SharedArrayBuffer 的宽型），而 `slice` 实际只在新 ArrayBuffer 上截取——
    // 显式收窄断言，避免不同环境 lib 型宽差导致的 tsc 抖动。
    return Promise.resolve(hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength) as ArrayBuffer);
  };

  try {
    // crypto.subtle 是缺失（undefined）而非只读，直接 defineProperty 到 crypto 实例
    Object.defineProperty(window.crypto, 'subtle', {
      value: { digest },
      writable: true,
      configurable: true,
      enumerable: true,
    });
    injected = true;
  } catch {
    // 某些引擎 crypto 冻结：整体替换 window.crypto（已验证 configurable）
    try {
      Object.defineProperty(window, 'crypto', {
        value: { ...window.crypto, getRandomValues: window.crypto.getRandomValues.bind(window.crypto), subtle: { digest } },
        writable: true,
        configurable: true,
      });
      injected = true;
    } catch {
      // 注入失败：保持原状，调用方走浏览器 TTS 降级
    }
  }
}

/** 诊断用：当前 subtle.digest 是否可用（原生或 polyfill） */
export function isSubtleDigestAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(window.crypto?.subtle?.digest);
}

// 顶层自执行：本模块即「确保 digest 可用」的副作用模块。
//
// 为何在此自执行而非仅靠 ttsService 顶部调用：
//   生产构建（vite build → Rollup）会把「顶层仅纯函数声明、副作用仅在
//   被调用时发生」的模块判定为可 tree-shake——实测整个 cryptoPolyfill
//   （含 SHA-256 实现）曾被打包器删除，导致非安全上下文 Web 端永远降级到
//   浏览器内置 TTS、丢失 Edge 云端音色。此处顶层自执行 + vite.config 的
//   moduleSideEffects 显式声明双保险，确保模块必入 bundle 且必执行。
//
// 安全性：ensureCryptoSubtleDigest 内部幂等，且仅当「非安全上下文且原生
//   subtle 缺失」时才真正注入；安全上下文 / App / localhost 下直接 return，
//   行为不变。
ensureCryptoSubtleDigest();
