//! SSE (Server-Sent Events) 工具函数
//!
//! 提供 SSE block 解析、字段提取和 UTF-8 安全分块功能。

use bytes::Bytes;

/// 从 buffer 中提取一个完整的 SSE block（以 `\n\n` 或 `\r\n\r\n` 分隔）。
///
/// 返回 `Some(block)` 如果找到完整 block，否则返回 `None`（数据不足）。
/// 提取的 block 不包含尾部的空行分隔符。
pub fn take_sse_block(buffer: &mut String) -> Option<String> {
    // 尝试 \n\n
    if let Some(pos) = buffer.find("\n\n") {
        let block = buffer[..pos].to_string();
        buffer.drain(..pos + 2);
        return Some(block);
    }
    // 尝试 \r\n\r\n
    if let Some(pos) = buffer.find("\r\n\r\n") {
        let block = buffer[..pos].to_string();
        buffer.drain(..pos + 4);
        return Some(block);
    }
    None
}

/// 从 SSE 行中提取指定字段的值。
///
/// 支持格式：`field: value`（冒号后可有可选空格）。
/// 返回 `Some(value)` 如果行以指定字段开头。
pub fn strip_sse_field<'a>(line: &'a str, field: &str) -> Option<&'a str> {
    let prefix = format!("{}:", field);
    if line.starts_with(&prefix) {
        let value = &line[prefix.len()..];
        // 跳过前导空格（SSE 规范允许 `data: value` 和 `data:value`）
        Some(value.strip_prefix(' ').unwrap_or(value))
    } else {
        None
    }
}

/// 将字节数据安全地追加到 String buffer，正确处理 UTF-8 多字节字符跨 chunk 边界的情况。
///
/// 当字节流在多字节 UTF-8 字符中间截断时，不完整的字节暂存在 `remainder` 中，
/// 等待下一个 chunk 补全。
pub fn append_utf8_safe(buffer: &mut String, remainder: &mut Vec<u8>, bytes: &Bytes) {
    if bytes.is_empty() {
        return;
    }

    // 将新数据追加到 remainder
    remainder.extend_from_slice(bytes);

    // 尝试将 remainder 解码为 UTF-8
    match std::str::from_utf8(remainder) {
        Ok(valid) => {
            buffer.push_str(valid);
            remainder.clear();
        }
        Err(e) => {
            // 找到最后一个有效的 UTF-8 边界
            let valid_up_to = e.valid_up_to();
            if valid_up_to > 0 {
                // 安全：valid_up_to 保证在 UTF-8 边界上
                let valid = unsafe { std::str::from_utf8_unchecked(&remainder[..valid_up_to]) };
                buffer.push_str(valid);
                remainder.drain(..valid_up_to);
            }
            // 剩余的不完整字节留在 remainder 中等待下一个 chunk
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn take_sse_block_double_newline() {
        let mut buf =
            "event: message_start\ndata: {\"type\":\"start\"}\n\nevent: next\n".to_string();
        let block = take_sse_block(&mut buf);
        assert_eq!(
            block,
            Some("event: message_start\ndata: {\"type\":\"start\"}".to_string())
        );
        assert_eq!(buf, "event: next\n");
    }

    #[test]
    fn take_sse_block_crlf() {
        let mut buf = "data: hello\r\n\r\ndata: world\r\n\r\n".to_string();
        let block = take_sse_block(&mut buf);
        assert_eq!(block, Some("data: hello".to_string()));
        assert_eq!(buf, "data: world\r\n\r\n");
    }

    #[test]
    fn take_sse_block_incomplete() {
        let mut buf = "data: partial".to_string();
        assert_eq!(take_sse_block(&mut buf), None);
    }

    #[test]
    fn strip_sse_field_with_space() {
        assert_eq!(
            strip_sse_field("data: hello world", "data"),
            Some("hello world")
        );
    }

    #[test]
    fn strip_sse_field_no_space() {
        assert_eq!(strip_sse_field("data:hello", "data"), Some("hello"));
    }

    #[test]
    fn strip_sse_field_wrong_field() {
        assert_eq!(strip_sse_field("event: start", "data"), None);
    }

    #[test]
    fn append_utf8_safe_ascii() {
        let mut buf = String::new();
        let mut remainder = Vec::new();
        append_utf8_safe(&mut buf, &mut remainder, &Bytes::from("hello "));
        append_utf8_safe(&mut buf, &mut remainder, &Bytes::from("world"));
        assert_eq!(buf, "hello world");
        assert!(remainder.is_empty());
    }

    #[test]
    fn append_utf8_safe_split_multibyte() {
        let mut buf = String::new();
        let mut remainder = Vec::new();
        // "中" 的 UTF-8 编码是 E4 B8 AD（3 bytes），"文" 是 E6 96 87（3 bytes）
        let full = "中文".as_bytes(); // E4 B8 AD E6 96 87
                                      // 发送前 5 个字节：完整的 "中" + "文" 的前 2 个字节
        append_utf8_safe(&mut buf, &mut remainder, &Bytes::from(&full[..5]));
        assert_eq!(buf, "中");
        assert_eq!(remainder, vec![0xE6, 0x96]); // "文" 的前 2 个字节
                                                 // 发送剩余字节
        append_utf8_safe(&mut buf, &mut remainder, &Bytes::from(&full[5..]));
        assert_eq!(buf, "中文");
        assert!(remainder.is_empty());
    }
}
