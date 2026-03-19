/*! 平台集成模块
 *
 * 提供统一的外部平台集成框架，支持 QQ Bot、钉钉等。
 * 采用抽象 Trait 设计，便于扩展新平台。
 */

pub mod types;
pub mod traits;
pub mod common;
pub mod qqbot;
pub mod manager;
pub mod commands;
pub mod instance_registry;

pub use manager::IntegrationManager;
