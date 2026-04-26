/**
 * UUID 生成工具
 *
 * crypto.randomUUID() 要求安全上下文（HTTPS / localhost）。
 * 通过局域网 IP（http://192.168.x.x:9800）访问时不是安全上下文，
 * randomUUID 会 undefined。此函数提供兼容回退。
 */

/** 生成 v4 UUID，兼容非安全上下文（HTTP 局域网访问） */
export function generateUUID(): string {
  // 优先使用原生 API（安全上下文）
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  // 回退：基于 crypto.getRandomValues 的 v4 UUID
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // 设置 version 4 和 variant 位
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join('-');
  }

  // 最终回退：Math.random（极少触发，仅老旧环境）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
