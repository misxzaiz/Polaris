/**
 * 字段级加密工具（移植自 personal-hub src/utils/crypto.ts）
 *
 * 使用 crypto-js AES 口令模式（CryptoJS 内部用 EVP_BytesToKey 从口令派生密钥+IV，
 * 产出 "U2FsdGVkX1..." 格式密文）。保留该模式以兼容 personal-hub 既有密文。
 */
import CryptoJS from 'crypto-js'

export function encrypt(text: string, key: string): string {
  return CryptoJS.AES.encrypt(text, key).toString()
}

export function decrypt(ciphertext: string, key: string): string {
  const bytes = CryptoJS.AES.decrypt(ciphertext, key)
  return bytes.toString(CryptoJS.enc.Utf8)
}

/** 生成 32 字节随机密钥（口令字符串），用于建议用户使用强密钥 */
export function generateKey(): string {
  return CryptoJS.lib.WordArray.random(256 / 8).toString()
}

/**
 * 业务包装：用配置中的 encryptionKey 加密描述。
 * 无密钥时原样返回（不加密），由调用方决定是否阻止加密保存。
 */
export function encryptDescription(text: string, key: string): string {
  if (!key) return text
  return encrypt(text, key)
}

/**
 * 业务包装：解密描述。
 * - 未加密（无 is_encrypted 标记）直接返回原文
 * - 已加密但无密钥 → 返回占位符，避免把密文当明文显示（修复 personal-hub 源码 UX 缺陷）
 * - 解密失败 → 返回占位符
 */
export const ENCRYPTED_PLACEHOLDER_NO_KEY = '[已加密 — 需配置密钥]'
export const ENCRYPTED_PLACEHOLDER_FAILED = '[解密失败]'

export function decryptDescription(
  text: string | undefined,
  isEncrypted: boolean,
  key: string,
): string {
  if (!text) return ''
  if (!isEncrypted) return text
  if (!key) return ENCRYPTED_PLACEHOLDER_NO_KEY
  try {
    const result = decrypt(text, key)
    return result || ENCRYPTED_PLACEHOLDER_FAILED
  } catch {
    return ENCRYPTED_PLACEHOLDER_FAILED
  }
}
