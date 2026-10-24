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
//! # Handler 类型
//!
//! - `forward`：别名转发（原始能力）；
//! - `plugin-rpc`（P2-b）：经 cap.mcp 调插件进程 MCP 工具——「插件提供 cap」
//!   的最低成本路径，插件用任意语言实现 handler，宿主保留统一权限/审计；
//! - `wasm`：P4 占位（注册即拒绝）。
//!
//! # 安全
//!
//! - 拒绝注册既有内置 cap（cap.kv 等）与已注册的动态 cap（cap.registry 内校验）；
//! - 转发仍过 RouterBus.dispatch 统一权限 gate + 审计，且**保留原始调用方
//!   Source**（转发不得提权：Remote 调用方经别名转发后，目标 cap 仍按 Remote
//!   判权——修复点见 2026-10-24 审计 X1，曾改写为 Plugin 身份导致 Remote deny
//!   基线可被别名洗白）。

use std::sync::Arc;

use serde_json::json;

use crate::contracts::*;
use crate::services::router::RouterBus;

/// 动态能力的 handler 类型（P2-b，2026-10-24 审计：此前仅 Forward 别名——
/// 插件无法承载真正的业务逻辑）
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

    /// 插件进程 RPC（P2-b）：经 cap.mcp 常驻 client 池调用插件 MCP 工具。
    /// 业务逻辑由插件进程承载（任意语言），宿主仍过统一 dispatch gate + 审计；
    /// cap.mcp 内部复核 source（未鉴权 Remote 拒绝）与 per-tool gates。
    #[serde(alias = "plugin-rpc")]
    PluginRpc {
        /// 目标插件 id（描述性；归属校验由 cap.mcp 的 server 定义归属保证）
        plugin_id: String,
        /// 插件贡献的 MCP server id（contributes.mcpServers[].id）
        server_id: String,
        /// 插件进程内的工具名（tools/list 可见）
        tool: String,
        /// 超时（毫秒）。v1 由 cap.mcp 底层 McpClient 的 tools/call 超时兜底
        /// （180s）；per-handler 超时随覆盖链方案落地。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
    },

    /// WASM 沙箱 handler（P4 预留占位）：注册时显式拒绝，占位保证契约前向兼容。
    #[serde(alias = "wasm")]
    Wasm {
        module_id: String,
        function: String,
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
        let (handler_type, detail) = match &self.config.handler {
            DynamicHandler::Forward { target, .. } => (
                "forward",
                json!({ "target": target }),
            ),
            DynamicHandler::PluginRpc { plugin_id, server_id, tool, timeout_ms } => (
                "plugin-rpc",
                json!({ "pluginId": plugin_id, "serverId": server_id, "tool": tool, "timeoutMs": timeout_ms }),
            ),
            DynamicHandler::Wasm { module_id, function } => (
                "wasm",
                json!({ "moduleId": module_id, "function": function }),
            ),
        };
        let protocol = match &self.config.handler {
            DynamicHandler::Forward { .. } => {
                json!("直接传给底层能力：`{ ...底层能力动作参数 }`；缺省时回退 handler.defaults")
            }
            DynamicHandler::PluginRpc { .. } => {
                json!("payload 原样作为插件 MCP 工具的 arguments（JSON 对象）")
            }
            DynamicHandler::Wasm { .. } => json!("P4 未实现"),
        };
        // json! 宏不支持 struct update，handler 对象手工合并 type + 变体字段
        let mut handler_obj = detail;
        if let Value::Object(ref mut m) = handler_obj {
            m.insert("type".into(), Value::String(handler_type.into()));
        }
        json!({
            "summary": self.config.summary,
            "dynamic": true,
            "handler": handler_obj,
            "description": self.config.description,
            "protocol": { "payload": protocol },
        })
    }

    fn invoke(&self, params: Value, ctx: &dyn Context) -> Result<Value, String> {
        let (target, payload) = match &self.config.handler {
            DynamicHandler::Forward { ref defaults, .. } => {
                // 调用方给了有效 payload（非 null）则覆盖默认
                let payload = if params.is_object() && !params.as_object().unwrap().is_empty() {
                    params
                } else {
                    defaults.clone().unwrap_or(Value::Null)
                };
                (self.handler_target(), payload)
            }
            DynamicHandler::PluginRpc { ref server_id, ref tool, .. } => {
                // P2-b：经 cap.mcp 通道调插件工具（统一 gate/审计/归属校验/工具门）
                (
                    "cap.mcp".to_string(),
                    json!({
                        "action": "call",
                        "mcpServerId": server_id,
                        "tool": tool,
                        "arguments": params,
                    }),
                )
            }
            DynamicHandler::Wasm { .. } => {
                return Err("wasm handler 尚未实现（P4 预留）".into());
            }
        };

        // 构造 Envelope 走 RouterBus.dispatch —— 权限 + 审计与其它调用统一。
        // Source 保留原始调用方（转发不得提权）：目标 cap 的权限 gate 按真实
        // 来源裁决，Remote 调用方无法借别名洗白为 Plugin 身份（审计 X1）。
        let env = Envelope {
            id: MsgId(format!("dynamic-{}", uuid::Uuid::new_v4())),
            source: ctx.source().clone(),
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
            DynamicHandler::PluginRpc { .. } => "cap.mcp".to_string(),
            DynamicHandler::Wasm { .. } => String::new(),
        }
    }
}