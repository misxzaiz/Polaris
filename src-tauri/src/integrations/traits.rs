/*! 平台集成 Trait 定义
 *
 * 所有平台适配器必须实现此 Trait。
 */

use async_trait::async_trait;
use std::path::Path;
use tokio::sync::mpsc::Sender;

use super::types::{IntegrationMessage, IntegrationStatus, MediaDownload, MessageContent, Platform, SendTarget};
use crate::error::Result;

/// 平台集成 Trait
///
/// 所有平台适配器必须实现此 Trait，提供统一的连接、发送、状态接口。
#[async_trait]
pub trait PlatformIntegration: Send + Sync {
    /// 获取平台类型
    fn platform(&self) -> Platform;

    /// 连接到平台
    ///
    /// # Arguments
    /// * `message_tx` - 消息发送通道，接收到的消息通过此通道发送给 IntegrationManager
    ///
    /// # Returns
    /// 连接成功返回 Ok(())，失败返回错误
    async fn connect(&mut self, message_tx: Sender<IntegrationMessage>) -> Result<()>;

    /// 断开连接
    async fn disconnect(&mut self) -> Result<()>;

    /// 发送消息
    ///
    /// # Arguments
    /// * `target` - 发送目标
    /// * `content` - 消息内容
    ///
    /// Note: 使用 `&mut self` 以支持发送前的 Token 刷新等操作
    async fn send(&mut self, target: SendTarget, content: MessageContent) -> Result<()>;

    /// 获取当前状态
    fn status(&self) -> IntegrationStatus;

    /// 下载消息中的媒体文件到本地
    ///
    /// # Arguments
    /// * `msg` - 原始消息（含 platform_message_id 和 MessageContent）
    /// * `save_dir` - 保存目录（由 manager 创建，已存在）
    ///
    /// # Returns
    /// 每个媒体项的下载结果列表
    async fn download_media(
        &mut self,
        msg: &IntegrationMessage,
        save_dir: &Path,
    ) -> Vec<MediaDownload> {
        // 默认空实现，子类可 override
        let _ = (msg, save_dir);
        vec![]
    }

    /// 是否已连接
    fn is_connected(&self) -> bool {
        self.status().connected
    }

    /// 平台名称
    fn platform_name(&self) -> &'static str {
        match self.platform() {
            Platform::QQBot => "QQ Bot",
            Platform::Feishu => "Feishu",
        }
    }
}
