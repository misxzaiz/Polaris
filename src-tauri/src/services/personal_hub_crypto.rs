//! Personal Hub 加密工具（与前端 crypto-js 双向兼容）
//!
//! 前端 `src/services/personalHub/crypto.ts` 使用 crypto-js 的 AES 口令模式
//! (`CryptoJS.AES.encrypt(text, passphrase)`):
//! - 密钥派生: MD5-based EVP_BytesToKey, salt 8 字节随机
//! - 加密算法: AES-128-CBC, PKCS7 填充
//! - 输出格式: "U2FsdGVkX1" (base64 "Salted__") + base64(salt + ciphertext)
//!
//! 本模块实现完全相同的格式，保证 Rust 端加解密与前端已加密字段兼容。

use crate::error::{AppError, Result};
use aes::Aes128;
use aes::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use base64::{Engine, prelude::BASE64_STANDARD};
use md5::{Md5, Digest};
use rand::RngCore;

type Aes128CbcEncryptor = cbc::Encryptor<Aes128>;
type Aes128CbcDecryptor = cbc::Decryptor<Aes128>;

/// Salt 大小（与 crypto-js 一致）
const SALT_SIZE: usize = 8;
/// Salt 前缀 "Salted__"
const SALT_PREFIX: &[u8] = b"Salted__";
/// AES 密钥大小
const KEY_SIZE: usize = 16;
/// AES IV 大小
const IV_SIZE: usize = 16;

/// 用 MD5-based EVP_BytesToKey 从口令派生 AES-128-CBC 密钥 + IV。
/// 与 crypto-js 的 EVP_BytesToKey 实现完全一致。
fn evp_bytes_to_key(passphrase: &[u8], salt: &[u8]) -> ([u8; KEY_SIZE], [u8; IV_SIZE]) {
    // 需要派生 KEY_SIZE + IV_SIZE = 32 字节，每次 MD5 产出 16 字节，需要 2 次
    let total = KEY_SIZE + IV_SIZE;

    let mut concatenated = Vec::with_capacity(total);
    let mut prev_hash = Vec::new();

    while concatenated.len() < total {
        // digest = MD5(prev || password || salt)
        let mut hasher = Md5::new();
        if !prev_hash.is_empty() {
            hasher.update(&prev_hash);
        }
        hasher.update(passphrase);
        hasher.update(salt);
        let hash = hasher.finalize();

        concatenated.extend_from_slice(&hash);
        prev_hash = hash.to_vec();
    }

    let mut key = [0u8; KEY_SIZE];
    let mut iv = [0u8; IV_SIZE];
    key.copy_from_slice(&concatenated[0..KEY_SIZE]);
    iv.copy_from_slice(&concatenated[KEY_SIZE..KEY_SIZE + IV_SIZE]);

    (key, iv)
}

/// PKCS7 padding
fn pkcs7_pad(data: &[u8]) -> Vec<u8> {
    let block_size = KEY_SIZE;
    let pad_len = block_size - (data.len() % block_size);
    let mut result = data.to_vec();
    result.extend(std::iter::repeat(pad_len as u8).take(pad_len));
    result
}

/// PKCS7 unpadding
fn pkcs7_unpad(data: &[u8]) -> Result<Vec<u8>> {
    if data.is_empty() {
        return Err(AppError::ValidationError("密文为空".into()));
    }
    let pad_len = data[data.len() - 1] as usize;
    if pad_len == 0 || pad_len > KEY_SIZE {
        return Err(AppError::ValidationError("PKCS7 填充校验失败".into()));
    }
    if data.len() < pad_len {
        return Err(AppError::ValidationError("密文长度小于填充长度".into()));
    }
    let plaintext = &data[..data.len() - pad_len];
    // 验证填充字节一致性
    if !plaintext.is_empty() && plaintext[plaintext.len() - pad_len..].iter().any(|&b| b != pad_len as u8) {
        return Err(AppError::ValidationError("PKCS7 填充字节不一致".into()));
    }
    Ok(plaintext.to_vec())
}

/// 加密：plaintext + passphrase → "U2FsdGVkX1..." 格式的 base64 字符串
pub fn encrypt(plaintext: &str, passphrase: &str) -> String {
    let mut salt = [0u8; SALT_SIZE];
    let _ = rand::thread_rng().try_fill_bytes(&mut salt);

    let (key, iv) = evp_bytes_to_key(passphrase.as_bytes(), &salt);

    let padded = pkcs7_pad(plaintext.as_bytes());
    let mut ciphertext = vec![0u8; padded.len()];
    Aes128CbcEncryptor::encrypt(&key.into(), &iv.into(), &padded, &mut ciphertext);

    // 组合: prefix + salt + ciphertext
    let mut combined = Vec::with_capacity(SALT_PREFIX.len() + SALT_SIZE + ciphertext.len());
    combined.extend_from_slice(SALT_PREFIX);
    combined.extend_from_slice(&salt);
    combined.extend_from_slice(&ciphertext);

    BASE64_STANDARD.encode(&combined)
}

/// 解密："U2FsdGVkX1..." 格式的 base64 字符串 → plaintext
pub fn decrypt(ciphertext_b64: &str, passphrase: &str) -> Result<String> {
    let combined = BASE64_STANDARD
        .decode(ciphertext_b64.trim())
        .map_err(|e| AppError::ValidationError(format!("Base64 解码失败: {e}")))?;

    let min_len = SALT_PREFIX.len() + SALT_SIZE + KEY_SIZE;
    if combined.len() < min_len {
        return Err(AppError::ValidationError(
            "密文格式无效：长度不足".into(),
        ));
    }

    // 验证 "Salted__" 前缀
    if combined[0..SALT_PREFIX.len()] != SALT_PREFIX {
        return Err(AppError::ValidationError(
            "密文格式无效：缺少 Salted__ 前缀".into(),
        ));
    }

    let salt = &combined[SALT_PREFIX.len()..SALT_PREFIX.len() + SALT_SIZE];
    let ciphertext = &combined[SALT_PREFIX.len() + SALT_SIZE..];

    let (key, iv) = evp_bytes_to_key(passphrase.as_bytes(), salt);

    let mut decrypted = ciphertext.to_vec();
    Aes128CbcDecryptor::decrypt(&key.into(), &iv.into(), &mut decrypted);

    let unpadded = pkcs7_unpad(&decrypted)?;
    String::from_utf8(unpadded)
        .map_err(|e| AppError::ValidationError(format!("UTF-8 解码失败: {e}")))
}

/// 业务包装：加密 description 字段。
/// 无密钥时原样返回（不加密），与前端 encryptDescription 行为一致。
pub fn encrypt_description(text: &str, key: &str) -> String {
    if key.is_empty() {
        return text.to_string();
    }
    encrypt(text, key)
}

/// 业务包装：解密 description 字段。
/// 与前端 decryptDescription 行为一致：
/// - 未加密（is_encrypted=false）直接返回
/// - 已加密但无密钥 → 返回占位符
/// - 解密失败 → 返回占位符
pub const ENCRYPTED_PLACEHOLDER_NO_KEY: &str = "[已加密 — 需配置密钥]";
pub const ENCRYPTED_PLACEHOLDER_FAILED: &str = "[解密失败]";

pub fn decrypt_description(
    text: Option<&str>,
    is_encrypted: bool,
    key: &str,
) -> String {
    let text = match text {
        Some(t) if !t.is_empty() => t,
        _ => return String::new(),
    };

    if !is_encrypted {
        return text.to_string();
    }

    if key.is_empty() {
        return ENCRYPTED_PLACEHOLDER_NO_KEY.to_string();
    }

    decrypt(text, key).unwrap_or_else(|_| ENCRYPTED_PLACEHOLDER_FAILED.to_string())
}

/// 检查字符串是否为已加密格式（以 "U2FsdGVkX1" 开头）
pub fn is_encrypted_format(text: &str) -> bool {
    text.starts_with("U2FsdGVkX1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_encrypt_decrypt() {
        let passphrase = "test-passphrase";
        let plaintext = "这是一条测试描述";

        let encrypted = encrypt(plaintext, passphrase);
        assert!(encrypted.starts_with("U2FsdGVkX1"));

        let decrypted = decrypt(&encrypted, passphrase).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn encrypt_different_output_each_call() {
        // 每次调用使用随机 salt，输出应该不同
        let passphrase = "key123";
        let plaintext = "hello";

        let enc1 = encrypt(plaintext, passphrase);
        let enc2 = encrypt(plaintext, passphrase);
        assert_ne!(enc1, enc2);

        // 但两个都能正确解密
        assert_eq!(decrypt(&enc1, passphrase).unwrap(), plaintext);
        assert_eq!(decrypt(&enc2, passphrase).unwrap(), plaintext);
    }

    #[test]
    fn decrypt_wrong_key_fails() {
        let passphrase = "correct-key";
        let encrypted = encrypt("secret", passphrase);

        // 用错误密钥解密应该失败
        let result = decrypt(&encrypted, "wrong-key");
        assert!(result.is_err());
    }

    #[test]
    fn decrypt_empty_key_placeholders() {
        let encrypted = encrypt("secret", "passphrase");
        let result = decrypt_description(Some(&encrypted), true, "");
        assert_eq!(result, ENCRYPTED_PLACEHOLDER_NO_KEY);
    }

    #[test]
    fn decrypt_non_encrypted_returns_as_is() {
        let result = decrypt_description(Some("plain text"), false, "");
        assert_eq!(result, "plain text");
    }

    #[test]
    fn encrypt_empty_passphrase() {
        // crypto-js 支持空口令，MD5 派生密钥时口令部分为空
        let encrypted = encrypt("hello", "");
        assert!(encrypted.starts_with("U2FsdGVkX1"));
        assert_eq!(decrypt(&encrypted, "").unwrap(), "hello");
    }

    #[test]
    fn pkcs7_padding_various_lengths() {
        // 精确对齐 block_size 时也应添加完整 padding
        let padded = pkcs7_pad(&[0u8; KEY_SIZE]);
        assert_eq!(padded.len(), KEY_SIZE * 2);
        assert_eq!(padded[KEY_SIZE..], std::iter::repeat(KEY_SIZE as u8).take(KEY_SIZE).collect::<Vec<_>>());

        let unpadded = pkcs7_unpad(&padded).unwrap();
        assert_eq!(unpadded, [0u8; KEY_SIZE]);
    }

    fn is_valid_salt(s: &str) -> bool {
        s.starts_with("U2FsdGVkX1")
    }

    #[test]
    fn encrypt_produces_valid_salt_prefix() {
        let enc = encrypt("test", "key");
        assert!(is_valid_salt(&enc));
    }
}
