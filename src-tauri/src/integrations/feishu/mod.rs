/*! Feishu (飞书) 集成模块
 *
 * 基于飞书开放平台 API 的 Rust 原生实现。
 * 使用 WebSocket 长连接接收事件，HTTP API 发送消息。
 * WS 协议遵循飞书 pbbp2 二进制帧格式（protobuf 编码）。
 */

mod adapter;
mod frame;

pub use adapter::FeishuAdapter;
