use aes::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use base64::{Engine, prelude::BASE64_STANDARD};
use rand::RngCore;
use crate::error::{AppError, Result};

type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;
type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

const AES_BLOCK: usize = 16;
const AES_KEY: usize = 16;
const AES_IV: usize = 16;
const CIPHER_SALT: usize = 8;
const CIPHER_PREFIX: &[u8] = b"Salted__";

fn pkcs7_pad(data: &[u8]) -> Vec<u8> {
    let pad = AES_BLOCK - (data.len() % AES_BLOCK);
    let mut out = data.to_vec();
    out.extend(vec![pad as u8; pad]);
    out
}

fn pkcs7_unpad(data: &[u8]) -> Result<Vec<u8>> {
    if data.is_empty() { return Err(AppError::ValidationError("密文为空".into())); }
    let pad = data[data.len()-1] as usize;
    if pad == 0 || pad > AES_BLOCK || pad > data.len() {
        return Err(AppError::ValidationError("PKCS7 padding invalid".into()));
    }
    Ok(data[..data.len()-pad].to_vec())
}

fn evp_bytes_to_key(passphrase: &[u8], salt: &[u8]) -> ([u8; AES_KEY], [u8; AES_IV]) {
    let mut prev = Vec::new();
    let mut key_iv = Vec::new();
    while key_iv.len() < AES_KEY + AES_IV {
        let mut hasher = md5::Context::new();
        if !prev.is_empty() { hasher.consume(&prev); }
        hasher.consume(passphrase);
        hasher.consume(salt);
        key_iv.extend_from_slice(&hasher.compute().0);
        prev = key_iv[key_iv.len()-16..].to_vec();
    }
    let mut key = [0u8; AES_KEY];
    let mut iv = [0u8; AES_IV];
    key.copy_from_slice(&key_iv[..AES_KEY]);
    iv.copy_from_slice(&key_iv[AES_KEY..AES_KEY+AES_IV]);
    (key, iv)
}

/// 加密（与 crypto-js AES.encrypt 格式完全兼容）
pub fn encrypt(plaintext: &str, passphrase: &str) -> String {
    let mut salt = [0u8; CIPHER_SALT];
    rand::thread_rng().fill_bytes(&mut salt);
    let (key, iv) = evp_bytes_to_key(passphrase.as_bytes(), &salt);
    let padded = pkcs7_pad(plaintext.as_bytes());
    let mut buf = vec![0u8; padded.len()];
    buf[..padded.len()].copy_from_slice(&padded);
    let ct = Aes128CbcEnc::new(&key.into(), &iv.into())
        .encrypt_padded_mut::<aes::cipher::block_padding::Pkcs7>(&mut buf, padded.len())
        .expect("AES encryption failed");
    let mut out = Vec::with_capacity(CIPHER_PREFIX.len() + CIPHER_SALT + ct.len());
    out.extend_from_slice(CIPHER_PREFIX);
    out.extend_from_slice(&salt);
    out.extend_from_slice(ct);
    BASE64_STANDARD.encode(&out)
}

/// 解密
pub fn decrypt(ciphertext_b64: &str, passphrase: &str) -> Result<String> {
    let data = BASE64_STANDARD.decode(ciphertext_b64.trim())
        .map_err(|e| AppError::ValidationError(format!("Base64 decode failed: {e}")))?;
    if data.len() < CIPHER_PREFIX.len() + CIPHER_SALT + AES_BLOCK {
        return Err(AppError::ValidationError("密文过短".into()));
    }
    if &data[..CIPHER_PREFIX.len()] != CIPHER_PREFIX {
        return Err(AppError::ValidationError("密文格式无效".into()));
    }
    let salt = &data[CIPHER_PREFIX.len()..CIPHER_PREFIX.len()+CIPHER_SALT];
    let ct = &data[CIPHER_PREFIX.len()+CIPHER_SALT..];
    let (key, iv) = evp_bytes_to_key(passphrase.as_bytes(), salt);
    let mut buf = ct.to_vec();
    let pt = Aes128CbcDec::new(&key.into(), &iv.into())
        .decrypt_padded_mut::<aes::cipher::block_padding::Pkcs7>(&mut buf)
        .map_err(|_| AppError::ValidationError("AES 解密失败".into()))?;
    pkcs7_unpad(pt).and_then(|v| String::from_utf8(v).map_err(|e| AppError::ValidationError(format!("UTF-8 decode failed: {e}"))))
}

/// 业务包装：解密 description 字段
pub const ENCRYPTED_PLACEHOLDER_NO_KEY: &str = "[已加密 — 需配置密钥]";
pub const ENCRYPTED_PLACEHOLDER_FAILED: &str = "[解密失败]";

pub fn decrypt_description(text: Option<&str>, is_encrypted: bool, key: &str) -> String {
    let text = match text {
        Some(t) if !t.is_empty() => t,
        _ => return String::new(),
    };
    if !is_encrypted { return text.to_string(); }
    if key.is_empty() { return ENCRYPTED_PLACEHOLDER_NO_KEY.to_string(); }
    decrypt(text, key).unwrap_or_else(|_| ENCRYPTED_PLACEHOLDER_FAILED.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let s = encrypt("hello 世界", "key123");
        assert!(s.starts_with("U2FsdGVkX1"));
        assert_eq!(decrypt(&s, "key123").unwrap(), "hello 世界");
    }

    #[test]
    fn wrong_key() {
        let s = encrypt("secret", "correct");
        assert!(decrypt(&s, "wrong").is_err());
    }

    #[test]
    fn empty_key() {
        let s = encrypt("test", "");
        assert_eq!(decrypt(&s, "").unwrap(), "test");
    }

    #[test]
    fn different_salt_each_call() {
        let s1 = encrypt("hello", "key");
        let s2 = encrypt("hello", "key");
        assert_ne!(s1, s2);
    }

    #[test]
    fn decrypt_placeholder_no_key() {
        let s = encrypt("secret", "key");
        assert_eq!(decrypt_description(Some(&s), true, ""), ENCRYPTED_PLACEHOLDER_NO_KEY);
    }

    #[test]
    fn decrypt_description_not_encrypted() {
        assert_eq!(decrypt_description(Some("plain"), false, ""), "plain");
    }
}
