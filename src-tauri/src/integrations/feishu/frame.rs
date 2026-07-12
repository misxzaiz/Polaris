/*! 飞书 pbbp2 协议帧解析
 *
 * 参考飞书官方 Go SDK: larksuite/oapi-sdk-go/ws/pbbp2.pb.go
 * Frame / Header 使用 protobuf 编码，无需 prost 编译期依赖，手动实现编解码。
 */

/// protobuf 帧头
#[derive(Debug, Clone, Default)]
pub struct Header {
    pub key: String,
    pub value: String,
}

/// protobuf 帧
#[derive(Debug, Clone, Default)]
pub struct Frame {
    pub seq_id: u64,
    pub log_id: u64,
    pub service: i32,
    pub method: i32,
    pub headers: Vec<Header>,
    pub payload_encoding: String,
    pub payload_type: String,
    pub payload: Vec<u8>,
    pub log_id_new: String,
}

/// 帧方法类型
pub enum FrameMethod {
    Control = 0,
    Data = 1,
}

/// 消息类型常量
pub const MESSAGE_TYPE_EVENT: &str = "event";
#[allow(dead_code)]
pub const MESSAGE_TYPE_CARD: &str = "card"; // 保留供卡片消息使用
pub const MESSAGE_TYPE_PING: &str = "ping";
#[allow(dead_code)]
pub const MESSAGE_TYPE_PONG: &str = "pong";

/// 客户端配置（Pong 帧的 Payload）
#[derive(Debug, Clone, serde::Deserialize)]
#[allow(non_snake_case)]
pub struct ClientConfig {
    #[serde(default)]
    #[allow(dead_code)]
    pub ReconnectCount: i32,
    #[serde(default)]
    pub ReconnectInterval: u64,
    #[serde(default)]
    #[allow(dead_code)]
    pub ReconnectNonce: u32,
    #[serde(default)]
    pub PingInterval: u64,
}

/// ACK 响应体
#[derive(Debug, serde::Serialize)]
struct AckResponse {
    code: u16,
    headers: serde_json::Value,
    data: Option<()>,
}

// ---- protobuf varint 编解码 ----

fn encode_varint(value: u64) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut v = value;
    loop {
        let b = (v & 0x7F) as u8;
        v >>= 7;
        if v == 0 {
            buf.push(b);
            break;
        }
        buf.push(b | 0x80);
    }
    buf
}

fn decode_varint(data: &[u8], offset: &mut usize) -> Option<u64> {
    let mut result: u64 = 0;
    let mut shift: u32 = 0;
    while *offset < data.len() {
        let b = data[*offset];
        *offset += 1;
        result |= ((b & 0x7F) as u64) << shift;
        if b < 0x80 {
            return Some(result);
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
    None
}

/// 解码有符号 varint (zigzag)
#[allow(dead_code)]
fn decode_varint_i32(data: &[u8], offset: &mut usize) -> Option<i32> {
    let raw = decode_varint(data, offset)?;
    // protobuf zigzag 编码: (n >> 1) ^ -(n & 1)
    // 但 service/method 用的是普通 varint
    Some(raw as i32)
}

fn encode_field_varint(buf: &mut Vec<u8>, field_num: u32, value: u64) {
    buf.push((field_num << 3) as u8); // wire type 0
    buf.extend(encode_varint(value));
}

fn encode_field_bytes(buf: &mut Vec<u8>, field_num: u32, value: &[u8]) {
    buf.push(((field_num << 3) | 2) as u8); // wire type 2
    buf.extend(encode_varint(value.len() as u64));
    buf.extend_from_slice(value);
}

// ---- Frame 编解码 ----

impl Frame {
    /// 从 protobuf 二进制数据解码帧
    pub fn decode(data: &[u8]) -> Option<Self> {
        let mut frame = Frame::default();
        let mut offset = 0;

        while offset < data.len() {
            let tag = decode_varint(data, &mut offset)?;
            let field_num = (tag >> 3) as u32;
            let wire_type = (tag & 0x7) as u8;

            match wire_type {
                0 => {
                    // varint
                    let value = decode_varint(data, &mut offset)?;
                    match field_num {
                        1 => frame.seq_id = value,
                        2 => frame.log_id = value,
                        3 => frame.service = value as i32,
                        4 => frame.method = value as i32,
                        _ => {}
                    }
                }
                2 => {
                    // length-delimited
                    let len = decode_varint(data, &mut offset)? as usize;
                    if offset + len > data.len() {
                        return None;
                    }
                    let value = &data[offset..offset + len];
                    offset += len;

                    match field_num {
                        5 => {
                            // headers (repeated)
                            if let Some(header) = Header::decode(value) {
                                frame.headers.push(header);
                            }
                        }
                        6 => frame.payload_encoding = String::from_utf8_lossy(value).into_owned(),
                        7 => frame.payload_type = String::from_utf8_lossy(value).into_owned(),
                        8 => frame.payload = value.to_vec(),
                        9 => frame.log_id_new = String::from_utf8_lossy(value).into_owned(),
                        _ => {}
                    }
                }
                _ => {
                    // 跳过未知 wire type
                    break;
                }
            }
        }

        Some(frame)
    }

    /// 编码帧为 protobuf 二进制数据
    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(64);

        encode_field_varint(&mut buf, 1, self.seq_id);
        encode_field_varint(&mut buf, 2, self.log_id);
        encode_field_varint(&mut buf, 3, self.service as u64);
        encode_field_varint(&mut buf, 4, self.method as u64);

        for header in &self.headers {
            let header_bytes = header.encode();
            encode_field_bytes(&mut buf, 5, &header_bytes);
        }

        if !self.payload_encoding.is_empty() {
            encode_field_bytes(&mut buf, 6, self.payload_encoding.as_bytes());
        }
        if !self.payload_type.is_empty() {
            encode_field_bytes(&mut buf, 7, self.payload_type.as_bytes());
        }
        if !self.payload.is_empty() {
            encode_field_bytes(&mut buf, 8, &self.payload);
        }
        if !self.log_id_new.is_empty() {
            encode_field_bytes(&mut buf, 9, self.log_id_new.as_bytes());
        }

        buf
    }

    /// 构建 Ping 帧
    pub fn new_ping(service_id: i32) -> Self {
        Frame {
            seq_id: 0,
            log_id: 0,
            service: service_id,
            method: FrameMethod::Control as i32,
            headers: vec![Header {
                key: "type".into(),
                value: MESSAGE_TYPE_PING.into(),
            }],
            payload_encoding: String::new(),
            payload_type: String::new(),
            payload: Vec::new(),
            log_id_new: String::new(),
        }
    }

    /// 构建 ACK 响应帧（基于收到的数据帧）
    pub fn new_ack(original: &Frame) -> Self {
        let ack = AckResponse {
            code: 200,
            headers: serde_json::Value::Object(serde_json::Map::new()),
            data: None,
        };
        let payload = serde_json::to_vec(&ack).unwrap_or_default();

        Frame {
            seq_id: original.seq_id,
            log_id: original.log_id,
            service: original.service,
            method: FrameMethod::Data as i32,
            headers: original.headers.clone(),
            payload_encoding: String::new(),
            payload_type: String::new(),
            payload,
            log_id_new: String::new(),
        }
    }

    /// 获取 headers 中指定 key 的值
    pub fn get_header(&self, key: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|h| h.key == key)
            .map(|h| h.value.as_str())
    }

    /// 从 WS 端点 URL 中提取 service_id
    pub fn extract_service_id(ws_url: &str) -> i32 {
        ws_url
            .split("service_id=")
            .nth(1)
            .and_then(|s| s.split('&').next())
            .and_then(|s| s.parse::<i32>().ok())
            .unwrap_or(0)
    }
}

impl Header {
    /// 从 protobuf 二进制数据解码
    pub fn decode(data: &[u8]) -> Option<Self> {
        let mut header = Header::default();
        let mut offset = 0;

        while offset < data.len() {
            let tag = decode_varint(data, &mut offset)?;
            let field_num = (tag >> 3) as u32;
            let wire_type = (tag & 0x7) as u8;

            if wire_type == 2 {
                let len = decode_varint(data, &mut offset)? as usize;
                if offset + len > data.len() {
                    return None;
                }
                let value = &data[offset..offset + len];
                offset += len;

                match field_num {
                    1 => header.key = String::from_utf8_lossy(value).into_owned(),
                    2 => header.value = String::from_utf8_lossy(value).into_owned(),
                    _ => {}
                }
            } else {
                break;
            }
        }

        Some(header)
    }

    /// 编码为 protobuf 二进制
    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(32);
        encode_field_bytes(&mut buf, 1, self.key.as_bytes());
        encode_field_bytes(&mut buf, 2, self.value.as_bytes());
        buf
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ping_frame_roundtrip() {
        let ping = Frame::new_ping(33554678);
        let encoded = ping.encode();
        let decoded = Frame::decode(&encoded).unwrap();

        assert_eq!(decoded.service, 33554678);
        assert_eq!(decoded.method, 0);
        assert_eq!(decoded.headers.len(), 1);
        assert_eq!(decoded.headers[0].key, "type");
        assert_eq!(decoded.headers[0].value, "ping");
    }

    #[test]
    fn test_ack_frame_roundtrip() {
        let original = Frame {
            seq_id: 12345,
            log_id: 67890,
            service: 33554678,
            method: 1,
            headers: vec![
                Header { key: "type".into(), value: "event".into() },
                Header { key: "message_id".into(), value: "abc-123".into() },
            ],
            payload: br#"{"schema":"2.0"}"#.to_vec(),
            ..Default::default()
        };

        let ack = Frame::new_ack(&original);
        let encoded = ack.encode();
        let decoded = Frame::decode(&encoded).unwrap();

        assert_eq!(decoded.seq_id, 12345);
        assert_eq!(decoded.service, 33554678);
        assert_eq!(decoded.method, 1);
        assert_eq!(decoded.headers.len(), 2);

        let payload: serde_json::Value = serde_json::from_slice(&decoded.payload).unwrap();
        assert_eq!(payload["code"], 200);
    }

    #[test]
    fn test_extract_service_id() {
        let url = "wss://msg-frontier.feishu.cn/ws/v2?fpid=493&aid=552564&device_id=7627546355398364345&access_key=39f21fe2b77c15689b55d91dcdcee8aa&service_id=33554678&ticket=abc";
        assert_eq!(Frame::extract_service_id(url), 33554678);
    }
}
