/*! 平台集成模块
 *
 * 提供统一的外部平台集成框架，支持 QQ Bot、钉钉等。
 * 采用抽象 Trait 设计，便于扩展新平台。
 */

pub mod commands;
pub mod common;
pub mod feishu;
pub mod instance_registry;
pub mod manager;
pub mod qqbot;
pub mod traits;
pub mod types;

pub use manager::IntegrationManager;
