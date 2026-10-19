//! DynamicCapability —— 配置驱动的运行时动态能力（AI/插件运行时注册）
//!
//! 这是「AI 自拓展能力」的核心：注册一个 `cap.<dynamic>` 时，不新增任何编译期代码，
//! 只声明一段 JSON 配置（描述 + 转发目标 + 默认 payload）。dispatch 到该 cap 时，
//! `DynamicCapability` 把调用转发到注册时声明的 `handler.target` 底层能力。
//!
//! 典型配置（由 cap.registry 的 register 动作构造）：
//! ```json
//! {
//!   "id": "cap.user.todo-report",
//!   "summary": "生成待办周报",
//!   "handler": {
//!     "type": "forward",
//!     "target": "cap.todo",
//!     "defaults": { "action": "list", "scope": "all" }
//!   }
//! }
//! ```
//!
//! # 转发语义
//!
//! - 调用 payload 含 `handler.payload` 时优先用调用方 payload（允许覆盖 defaults）；
//! - 否则用 handler.defaults（注册时声明的默认动作）；
//! - 不存在的底层 target → dispatch 返回「能力未注册」，自然报错给调用方。
//!
//! # 安全
//!
//! - 拒绝注册既有内置 cap（cap.kv 等）与已注册的动态 cap（cap.registry 内校验）；
//! - 转发仍过 RouterBus.dispatch 统一权限 gate + 审计（Source::Plugin 身份）。

use std::sync::Arc;

use serde_json::json;

use crate::contracts::*;
use crate::services::router::RouterBus;

/// 动态能力的 handler 类型
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DynamicHandler {
    /// 转发到既有 cap（如 cap.todo / cap.http / cap.kv / cap.bash）
    #[serde(alias = "forward")]
    Forward {
        /// 底层转发目标（必须 `cap.*` 且已注册）
        target: String,
        /// 默认 payload（调用方未给 payload 时使用）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        defaults: Option<Value>,
    },
}

/// 动态能力配置（cap.registry.register 的入参与持久化结构）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicCapabilityConfig {
    /// 能力 id（必须 `cap.*`，不得与既有 cap 冲突）
    pub id: String,
    /// 人类可读描述（cap_list / cap.help 可见）
    pub summary: String,
    /// 动作协议说明（自由文本，供 AI 构造 payload 时参考）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 处理器（当前仅 forward）
    pub handler: DynamicHandler,
    /// 是否持久化（重启后自动重新装配）
    #[serde(default = "default_true")]
    pub persist: bool,
}

fn default_true() -> bool {
    true
}

/// 运行时动态能力（注册进 RouterBus 的 Handles 表，内部以 Arc 持有）
pub struct DynamicCapability {
    config: DynamicCapabilityConfig,
    /// 转发用 RouterBus 引用（注册时由 cap.registry 注入）
    router: Arc<RouterBus>,
}

impl DynamicCapability {
    pub fn new(config: DynamicCapabilityConfig, router: Arc<RouterBus>) -> Self {
        Self { config, router }
    }
}

impl Capability for DynamicCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(self.config.id.clone())
    }

    fn describe(&self) -> Value {
        json!({
            "summary": self.config.summary,
            "dynamic": true,
            "handler": {
                "type": "forward",
                "target": self.handler_target(),
            },
            "description": self.config.description,
            "protocol": {
                "payload": "直接传给底层能力：`{ ...底层能力动作参数 }`；缺省时回退 handler.defaults",
            }
        })
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        let target = self.handler_target();
        let payload = match self.config.handler {
            DynamicHandler::Forward { ref defaults, .. } => {
                // 调用方给了有效 payload（非 null）则覆盖默认
                if params.is_object() && !params.as_object().unwrap().is_empty() {
                    params
                } else {
                    defaults.clone().unwrap_or(Value::Null)
                }
            }
        };

        // 构造 Envelope 走 RouterBus.dispatch —— 权限 + 审计与其它调用统一
        let env = Envelope {
            id: MsgId(format!("dynamic-{}", uuid::Uuid::new_v4())),
            source: Source::Plugin {
                caller: PluginId(format!("dynamic:{}", self.config.id)),
            },
            target: CapabilityId(target.clone()),
            payload,
            trace: TraceId(format!("dynamic-{}", uuid::Uuid::new_v4())),
        };
        match self.router.dispatch(env) {
            Ok(reply) => reply.result,
            Err(e) => Err(format!("[{}] 转发 {} 失败: {}", self.config.id, target, e)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

impl DynamicCapability {
    fn handler_target(&self) -> String {
        match &self.config.handler {
            DynamicHandler::Forward { target, .. } => target.clone(),
        }
    }
}