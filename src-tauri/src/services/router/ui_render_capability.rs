//! cap.ui.render —— 可交互渲染入口（P2）+ UI 模板运行时注册（v2）
//!
//! 对应 `plans/plugin-cap-inject-render-v1.md` §2.1 / `plans/plugin-manage-hook-inject-v1.md`
//! §5 P2：把「可交互渲染」从 MCP 伴生进程专属提升为 **cap 契约的一等公民**。
//! v2 扩展对应 `plans/ui-template-runtime-v1.md`：AI 运行时注册 parametrized 模板，
//! 后续任意回合「模板 ID + params」填参渲染，无需每次重发完整结构。
//!
//! # 动作协议（payload `{ "action": ... }`）
//!
//! - `register`：注册/覆盖模板
//!   ```jsonc
//!   { "action": "register",
//!     "templateId": "deploy-card",            // 必填 ≤64，[A-Za-z0-9\-_./:]
//!     "title": "部署确认", "description": "…",
//!     "dsl": [ { "type": "text", "content": "环境 {{env}} 部署 {{service}}" }, … ],
//!     "buttons": [ { "id": "deploy", "label": "部署", "danger": false } ],
//!     "persist": true }                        // 默认 true 落 Storage(domain=ui.template)；
//!                                              // false 仅内存（本能力单例，重启丢失）
//!   ```
//!   DSL 节点白名单见 `TEMPLATE_NODE_TYPES`；嵌套 ≤8 层、节点 ≤64、序列化 ≤32KB。
//!   同 templateId 重注册 = 覆盖更新（owner 记录 + warn 日志）。
//! - `unregister` `{ templateId }` → `{ unregistered: true }`
//! - `list` `{}` → `{ templates: [{ templateId, title, description, owner, persisted }] }`
//! - `request`：渲染一帧（v1 行为全保留）
//!   ```jsonc
//!   { "action": "request",
//!   "sessionId": "session-uuid",      // 必填（前端 respond_plugin_card 回填依赖）
//!   "pluginId": "polaris.ui",        // 归属（卡片 header 显示）
//!   "cardId": "confirm",             // 前端 chatCardRegistry 匹配 key（custom 帧）
//!   "toolName": "ui.render",         // 兜底渲染的卡片名；模板帧用默认值即可命中 UiFrameCard
//!   "mode": "display"?,              // v2 可选：display = fire-and-forget，不等应答
//!   "title": "确认操作",
//!   "frame": { "type": "confirm", "content": "确定删除？", "danger": true,
//!              /* question: {questions:[...]} / form: {fields:[...]}
//!              /* template: { "templateId": "deploy-card", "params": { "env": "prod" } } */ } }
//!   ```
//!
//!   返回（oneshot 回传，阻塞等待用户应答，超时 180s 按 declined）：
//!   ```jsonc
//!   { "status": "answered" | "declined" | "timeout" | "displayed",
//!     "answer": { /* template: {templateId, action, values}
//!                  question: {answers:[{selected,customInput}]}
//!                  form: {values} / confirm: {confirmed} / custom 原始值 */ },
//!     "interactionId": "uuid" }
//!   ```
//!
//! # 复用链路
//!
//! - 登记 `PendingPluginCard`（state.pending_plugin_cards）+ oneshot
//!   （`register_plugin_card_answer_sender`）—— 与 ask_listener 同款通道。
//! - 广播 `plugin_card` 事件（`emit_plugin_card_event`，已 pub(crate)）——
//!   前端 eventHandler 已有处理；模板帧经内置 UiFrameCard（chatCardRegistry key
//!   `ui.render`）渲染，question/form/confirm 也由它兜住（修复 JSON 兜底缺口）。
//! - 模板帧 payload **内联模板定义**（`frame.template`）——前端无状态渲染，
//!   对话历史重放不依赖注册表现存（「日志即真相」一致性）。
//! - 回填：前端 `respondPluginCard` → `cap.ai.chat respond_plugin_card` →
//!   `ai_chat_core::respond_plugin_card` → oneshot send → 本能力 await 返回。
//!
//! # 安全
//!
//! - frame.type 白名单 {question, form, confirm, custom, template} + 字段校验；
//!   模板 DSL 节点白名单 + 深度/节点数/字节上限，**不做任意 HTML/JS**（v1 取向延续）；
//! - interactionId 防重放（uuid 由后端生成，登记前检查 pending 表已存在则拒绝）；
//! - display 模式不登记 pending / oneshot（无挂起通道，按钮自然禁用）；
//! - 经 RouterBus dispatch 复用权限 gate + 审计（Source::Remote 默认 deny 规则由
//!   policy_permission 控制）；模板写经 Storage 事务 + 域审计。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use tokio::sync::oneshot;

use crate::contracts::{AuditEntry, Capability, CapabilityId, Context, Id, Item, Query};
use crate::services::ask_listener::{PluginCardOutcome, emit_plugin_card_event};
use crate::state::{AppState, PendingPluginCard, PluginCardStatus};

const CAP_ID: &str = "cap.ui.render";

/// 支持的动作协议（v2：+ register / unregister / list）
pub const UI_RENDER_ACTIONS: &[&str] = &["request", "register", "unregister", "list"];

/// frame.type 白名单（v2 + template；渐进内容安全，不做任意 HTML）
const ALLOWED_FRAME_TYPES: &[&str] = &["question", "form", "confirm", "custom", "template"];

/// 模板持久化域（与 cap.kv / cap.registry 隔离）
const TEMPLATE_DOMAIN: &str = "ui.template";

/// DSL 白名单节点类型（与前端 uiTemplateNodes 渲染器必须同步）
const TEMPLATE_NODE_TYPES: &[&str] = &[
    "vstack",
    "hstack",
    "text",
    "metric",
    "badge",
    "table",
    "progress",
    "divider",
    "input",
    "select",
];

/// 模板结构上限（防滥用；与前端渲染容错上限一致）
const TEMPLATE_MAX_NODES: usize = 64;
const TEMPLATE_MAX_DEPTH: usize = 8;
const TEMPLATE_MAX_BYTES: usize = 32 * 1024;
const TEMPLATE_ID_MAX_BYTES: usize = 64;

/// 等待用户应答超时（与 ask_listener PLUGIN_CARD_TIMEOUT 同值）
const UI_RENDER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// cap.ui.render —— 通用可交互渲染入口 + 模板注册表。
///
/// 依赖注入 `Arc<AppState>`（state.rs 装配提供）：复用 pending_plugin_cards /
/// plugin_card_answer_senders / event_broadcast。persist=false 的模板存本地
/// `ephemeral_templates`（能力单例持有，不进 state.rs，避免新增全局通道）。
pub struct UiRenderCapability {
    state: Arc<AppState>,
    /// persist=false 模板：templateId → 定义。仅本能力实例内存态。
    ephemeral_templates: Mutex<HashMap<String, Value>>,
}

impl UiRenderCapability {
    pub fn with_state(state: Arc<AppState>) -> Self {
        Self {
            state,
            ephemeral_templates: Mutex::new(HashMap::new()),
        }
    }

    fn require_str<'a>(args: &'a Value, key: &str) -> std::result::Result<&'a str, String> {
        args.get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("cap.ui.render 缺少参数: {}", key))
    }

    /// 从节点对象取字符串字段并限长（模板字段统一出口）
    fn bounded_str<'a>(
        obj: &'a Map<String, Value>,
        key: &str,
        max: usize,
    ) -> std::result::Result<&'a str, String> {
        let s = obj
            .get(key)
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("模板 {} 节点缺少字符串字段 {}", obj.get("type").and_then(|t| t.as_str()).unwrap_or("?"), key))?;
        if s.chars().count() > max {
            return Err(format!(
                "模板 {} 节点字段 {} 超长（>{}/{max} 字符）",
                obj.get("type").and_then(|t| t.as_str()).unwrap_or("?"),
                key,
                s.chars().count()
            ));
        }
        Ok(s)
    }

    /// 校验 frame 白名单与必填字段
    fn validate_frame(frame: &Value) -> std::result::Result<(), String> {
        let ftype = frame
            .get("type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "cap.ui.render frame 缺少 type".to_string())?;
        if !ALLOWED_FRAME_TYPES.contains(&ftype) {
            return Err(format!(
                "cap.ui.render frame.type 不在白名单（{:?}）: {}",
                ALLOWED_FRAME_TYPES, ftype
            ));
        }
        match ftype {
            "question" => {
                if frame.get("questions").is_none() {
                    return Err("cap.ui.render question 帧缺少 questions".to_string());
                }
            }
            "form" => {
                if frame.get("fields").is_none() {
                    return Err("cap.ui.render form 帧缺少 fields".to_string());
                }
            }
            "confirm" => {
                if frame.get("content").is_none() {
                    return Err("cap.ui.render confirm 帧缺少 content".to_string());
                }
            }
            "template" => {
                Self::require_str(frame, "templateId").map_err(|_| {
                    "cap.ui.render template 帧缺少 templateId".to_string()
                })?;
                if let Some(params) = frame.get("params") {
                    if !params.is_object() {
                        return Err("cap.ui.render template 帧的 params 必须是对象".to_string());
                    }
                }
            }
            _ => {} // custom：透传，由前端 chatCardRegistry 匹配组件
        }
        Ok(())
    }

    /// 校验模板定义（dsl + buttons）并限字节。注册时 fail fast。
    fn validate_template_def(def: &Value) -> std::result::Result<(), String> {
        let dsl = match def.get("dsl").and_then(|v| v.as_array()) {
            Some(arr) if !arr.is_empty() => arr,
            Some(_) => return Err("cap.ui.render.register dsl 不能为空数组".to_string()),
            None => return Err("cap.ui.render.register 缺少 dsl 数组".to_string()),
        };
        let mut count = 0usize;
        for node in dsl {
            Self::validate_template_node(node, 1, &mut count)?;
        }
        if let Some(buttons) = def.get("buttons") {
            if !buttons.is_null() {
                let arr = buttons
                    .as_array()
                    .ok_or_else(|| "cap.ui.render.register buttons 必须是数组".to_string())?;
                if arr.len() > 8 {
                    return Err(format!(
                        "cap.ui.render.register buttons 超上限 8（当前 {}）",
                        arr.len()
                    ));
                }
                for b in arr {
                    let obj = b
                        .as_object()
                        .ok_or_else(|| "cap.ui.render.register 每个 button 必须是对象".to_string())?;
                    Self::bounded_str(obj, "id", 32)?;
                    Self::bounded_str(obj, "label", 48)?;
                    if let Some(d) = obj.get("danger") {
                        if !d.is_boolean() {
                            return Err("cap.ui.render.register button.danger 必须是布尔".to_string());
                        }
                    }
                }
            }
        }
        if let Some(title) = def.get("title").and_then(|v| v.as_str()) {
            if title.chars().count() > 120 {
                return Err("cap.ui.render.register title 超长（>120 字符）".to_string());
            }
        }
        if let Some(desc) = def.get("description").and_then(|v| v.as_str()) {
            if desc.chars().count() > 500 {
                return Err("cap.ui.render.register description 超长（>500 字符）".to_string());
            }
        }
        let bytes = serde_json::to_string(def)
            .map_err(|e| format!("cap.ui.render.register 序列化失败: {}", e))?
            .len();
        if bytes > TEMPLATE_MAX_BYTES {
            return Err(format!(
                "cap.ui.render.register 模板超限（{bytes} > {TEMPLATE_MAX_BYTES} 字节）"
            ));
        }
        Ok(())
    }

    /// 递归校验单个 DSL 节点（白名单 + 字段限长/限规模）
    fn validate_template_node(
        node: &Value,
        depth: usize,
        count: &mut usize,
    ) -> std::result::Result<(), String> {
        if depth > TEMPLATE_MAX_DEPTH {
            return Err(format!("cap.ui.render.register 模板嵌套超过 {TEMPLATE_MAX_DEPTH} 层"));
        }
        let obj = node
            .as_object()
            .ok_or_else(|| "cap.ui.render.register 每个模板节点必须是对象".to_string())?;
        let node_type = obj
            .get("type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "cap.ui.render.register 模板节点缺少 type".to_string())?;
        if !TEMPLATE_NODE_TYPES.contains(&node_type) {
            return Err(format!(
                "cap.ui.render.register 模板节点类型不在白名单: {}（允许 {TEMPLATE_NODE_TYPES:?}）",
                node_type
            ));
        }
        *count += 1;
        if *count > TEMPLATE_MAX_NODES {
            return Err(format!("cap.ui.render.register 模板节点超上限 {TEMPLATE_MAX_NODES}"));
        }
        match node_type {
            "vstack" | "hstack" => {
                let children = obj
                    .get("children")
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| format!("cap.ui.render.register {} 节点缺少 children", node_type))?;
                if children.len() > 16 {
                    return Err(format!(
                        "cap.ui.render.register {} 节点 children 超上限 16（当前 {}）",
                        node_type,
                        children.len()
                    ));
                }
                for child in children {
                    Self::validate_template_node(child, depth + 1, count)?;
                }
            }
            "text" => {
                Self::bounded_str(obj, "content", 2000)?;
                if let Some(tone) = obj.get("tone") {
                    if !tone.is_string() {
                        return Err("cap.ui.render.register text.tone 必须是字符串".to_string());
                    }
                }
            }
            "metric" => {
                Self::bounded_str(obj, "value", 200)?;
                if let Some(label) = obj.get("label") {
                    label.as_str().ok_or_else(|| {
                        "cap.ui.render.register metric.label 必须是字符串".to_string()
                    })?;
                }
            }
            "badge" => {
                Self::bounded_str(obj, "label", 120)?;
            }
            "table" => {
                let columns = obj
                    .get("columns")
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| "cap.ui.render.register table 缺少 columns".to_string())?;
                if columns.is_empty() || columns.len() > 8 {
                    return Err(format!(
                        "cap.ui.render.register table columns 数量越界（1-8，当前 {}）",
                        columns.len()
                    ));
                }
                for col in columns {
                    col.as_str().ok_or_else(|| {
                        "cap.ui.render.register table 列名必须是字符串".to_string()
                    })?;
                }
                let rows = obj
                    .get("rows")
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| "cap.ui.render.register table 缺少 rows".to_string())?;
                if rows.len() > 50 {
                    return Err(format!(
                        "cap.ui.render.register table rows 超上限 50（当前 {}）",
                        rows.len()
                    ));
                }
                for row in rows {
                    let cells = row.as_array().ok_or_else(|| {
                        "cap.ui.render.register table 行必须是数组".to_string()
                    })?;
                    if cells.len() != columns.len() {
                        return Err(format!(
                            "cap.ui.render.register 表格行/列数不一致（{} 列声明，行有 {} 格）",
                            columns.len(),
                            cells.len()
                        ));
                    }
                    for cell in cells {
                        cell.as_str().ok_or_else(|| {
                            "cap.ui.render.register 表格单元格必须是字符串".to_string()
                        })?;
                    }
                }
            }
            "progress" => {
                if !matches!(obj.get("value").and_then(|v| v.as_f64()), Some(v) if (0.0..=100.0).contains(&v)) {
                    return Err("cap.ui.render.register progress.value 必须是 0-100 数字".to_string());
                }
            }
            "divider" => {}
            "input" => {
                Self::bounded_str(obj, "field", 32)?;
            }
            "select" => {
                Self::bounded_str(obj, "field", 32)?;
                let options = obj
                    .get("options")
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| "cap.ui.render.register select 缺少 options".to_string())?;
                if options.is_empty() || options.len() > 32 {
                    return Err(format!(
                        "cap.ui.render.register select options 数量越界（1-32，当前 {}）",
                        options.len()
                    ));
                }
                for opt in options {
                    let s = opt.as_str().ok_or_else(|| {
                        "cap.ui.render.register select option 必须是字符串".to_string()
                    })?;
                    if s.chars().count() > 64 {
                        return Err("cap.ui.render.register select option 超长（>64 字符）".to_string());
                    }
                }
            }
            _ => {} // 白名单已兜住，不可达
        }
        Ok(())
    }

    /// 读取模板（内存优先，其次 Storage）。未注册 → 明确错误给调用方。
    fn load_template(&self, ctx: &dyn Context, template_id: &str) -> Result<Value, String> {
        if let Ok(ephem) = self.ephemeral_templates.lock() {
            if let Some(v) = ephem.get(template_id) {
                return Ok(v.clone());
            }
        }
        let storage = ctx
            .storage()
            .map_err(|e| format!("cap.ui.render 无存储: {}", e))?;
        match storage.load(TEMPLATE_DOMAIN, &Id(template_id.to_string())) {
            Ok(item) => Ok(item.data),
            Err(e) if e.contains("不存在") => {
                Err(format!("cap.ui.render 模板未注册，请先 register: {}", template_id))
            }
            Err(e) => Err(format!("cap.ui.render 模板读取失败: {}", e)),
        }
    }

    /// 模板摘要（list 用；不回传 dsl 全量，避免响应膨胀）
    fn template_summary(data: &Value) -> Value {
        json!({
            "templateId": data.get("templateId").cloned().unwrap_or(Value::Null),
            "title": data.get("title").cloned().unwrap_or(Value::Null),
            "description": data.get("description").cloned().unwrap_or(Value::Null),
            "owner": data.get("owner").cloned().unwrap_or(Value::Null),
        })
    }

    // ==================== 动作：register / unregister / list ====================

    fn do_register(&self, params: &Value, ctx: &dyn Context) -> Result<Value, String> {
        let template_id = Self::require_str(params, "templateId")?.to_string();
        if template_id.len() > TEMPLATE_ID_MAX_BYTES
            || !template_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_./:".contains(c))
        {
            return Err(format!(
                "cap.ui.render.register templateId 只允许字母数字与 -_./:，长度 ≤{TEMPLATE_ID_MAX_BYTES}: {}",
                template_id
            ));
        }
        let data = json!({
            "templateId": template_id,
            "title": params.get("title").and_then(|v| v.as_str()).unwrap_or(""),
            "description": params.get("description").and_then(|v| v.as_str()).unwrap_or(""),
            "dsl": params.get("dsl").cloned().ok_or_else(|| "cap.ui.render.register 缺少 dsl".to_string())?,
            "buttons": params.get("buttons").cloned().unwrap_or(Value::Null),
            "owner": ctx.caller_id().0,
            "createdAtMs": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        });
        Self::validate_template_def(&data)?;

        let persist = params.get("persist").and_then(|v| v.as_bool()).unwrap_or(true);
        if persist {
            let storage = ctx
                .storage()
                .map_err(|e| format!("cap.ui.render 无存储: {}", e))?;
            let mut txn = storage
                .begin()
                .map_err(|e| format!("cap.ui.render 开启事务失败: {}", e))?;
            if let Err(e) =
                txn.store(TEMPLATE_DOMAIN, &Item { id: Id(template_id.clone()), data: data.clone() })
            {
                return Err(format!("cap.ui.render 模板写入失败: {}", e));
            }
            // 域审计与业务写同库同事务（kv_capability 同款纪律）
            if let Err(e) = txn.append_audit(
                TEMPLATE_DOMAIN,
                &AuditEntry {
                    timestamp_ms: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0),
                    capability: CapabilityId(CAP_ID.into()),
                    source: ctx.source().clone(),
                    action: "ui_template.register".into(),
                    prev_hash: String::new(),
                    detail: None,
                    duration_ms: None,
                },
            ) {
                return Err(format!("cap.ui.render 模板审计写入失败: {}", e));
            }
            txn.commit()
                .map_err(|e| format!("cap.ui.render 事务提交失败: {}", e))?;
            // 持久化覆盖同名内存模板（单一真相：有持久化就不留内存旧值）
            if let Ok(mut ephem) = self.ephemeral_templates.lock() {
                ephem.remove(&template_id);
            }
        } else {
            // 仅内存：写本地表（能力单例持有，重启丢失）
            self.ephemeral_templates
                .lock()
                .map_err(|e| format!("cap.ui.render 模板内存表锁: {}", e))?
                .insert(template_id.clone(), data.clone());
        }
        tracing::info!("[cap.ui.render] 模板注册: id={} persist={}", template_id, persist);
        Ok(json!({ "registered": true, "templateId": template_id, "persisted": persist }))
    }

    fn do_unregister(&self, template_id: &str, ctx: &dyn Context) -> Result<Value, String> {
        if let Ok(storage) = ctx.storage() {
            let mut txn = storage
                .begin()
                .map_err(|e| format!("cap.ui.render 开启事务失败: {}", e))?;
            let _ = txn.delete(TEMPLATE_DOMAIN, &Id(template_id.to_string()));
            if let Err(e) = txn.append_audit(
                TEMPLATE_DOMAIN,
                &AuditEntry {
                    timestamp_ms: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0),
                    capability: CapabilityId(CAP_ID.into()),
                    source: ctx.source().clone(),
                    action: "ui_template.unregister".into(),
                    prev_hash: String::new(),
                    detail: None,
                    duration_ms: None,
                },
            ) {
                return Err(format!("cap.ui.render 模板审计写入失败: {}", e));
            }
            let _ = txn.commit();
        }
        if let Ok(mut ephem) = self.ephemeral_templates.lock() {
            ephem.remove(template_id);
        }
        tracing::info!("[cap.ui.render] 模板注销: id={}", template_id);
        Ok(json!({ "unregistered": true, "templateId": template_id }))
    }

    fn do_list(&self, ctx: &dyn Context) -> Result<Value, String> {
        let mut templates: Vec<Value> = Vec::new();
        if let Ok(ephem) = self.ephemeral_templates.lock() {
            for data in ephem.values() {
                let mut s = Self::template_summary(data);
                if let Some(obj) = s.as_object_mut() {
                    obj.insert("persisted".into(), json!(false));
                }
                templates.push(s);
            }
        }
        if let Ok(storage) = ctx.storage() {
            if let Ok(items) = storage.query(TEMPLATE_DOMAIN, &Query { filter: Value::Null, limit: None }) {
                for item in items {
                    let mut s = Self::template_summary(&item.data);
                    if let Some(obj) = s.as_object_mut() {
                        obj.insert("persisted".into(), json!(true));
                    }
                    templates.push(s);
                }
            }
        }
        Ok(json!({ "templates": templates }))
    }

    // ==================== 动作：request（渲染一帧） ====================

    fn do_request(&self, params: &Value, ctx: &dyn Context) -> Result<Value, String> {
        let session_id = Self::require_str(params, "sessionId")?.to_string();
        let plugin_id = Self::require_str(params, "pluginId")?.to_string();
        let card_id = Self::require_str(params, "cardId")?.to_string();
        let tool_name = params
            .get("toolName")
            .and_then(|v| v.as_str())
            .unwrap_or("ui.render")
            .to_string();
        let frame = params
            .get("frame")
            .ok_or_else(|| "cap.ui.render 缺少 frame".to_string())?;
        Self::validate_frame(frame)?;

        // display 模式：request 级或 frame 级声明皆可；不登记 pending，不等应答
        let display = params.get("mode").and_then(|v| v.as_str()) == Some("display")
            || frame.get("mode").and_then(|v| v.as_str()) == Some("display");

        // 组装前端渲染 payload：title + frame（frame 内嵌 questions/fields/content/自定义）
        let mut frame_out = frame.clone();

        // 模板帧：定义内联下发（前端无状态渲染，历史重放不依赖注册表）
        let mut title = params
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if let Some(obj) = frame_out.as_object_mut() {
            if obj.get("type").and_then(|v| v.as_str()) == Some("template") {
                let template_id = Self::require_str(frame, "templateId")?;
                let def = self.load_template(ctx, template_id)?;
                if title.is_empty() {
                    title = def
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                }
                // 后端注册的定义是唯一权威：无条件覆盖调用方可能自带的同名键
                obj.insert("template".into(), def);
                obj.insert(
                    "mode".into(),
                    json!(if display { "display" } else { "interaction" }),
                );
            }
        }

        let payload = json!({
            "title": title,
            "frame": frame_out,
        });

        if display {
            let interaction_id = uuid::Uuid::new_v4().to_string();
            emit_plugin_card_event(
                &self.state,
                &session_id,
                &interaction_id,
                &plugin_id,
                &card_id,
                &tool_name,
                payload,
            );
            return Ok(json!({ "status": "displayed", "interactionId": interaction_id }));
        }

        let state = self.state.clone();
        // 同步 invoke 驱动 async oneshot 等待（与 ai_chat_capability 同款：
        // block_in_place + Handle::block_on，调用方在 tokio 多线程运行时内）
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| "cap.ui.render 需在 tokio 运行时内调用".to_string())?;

        tokio::task::block_in_place(move || {
            handle.block_on(async move {
                let interaction_id = uuid::Uuid::new_v4().to_string();
                let (tx, rx) = oneshot::channel::<PluginCardOutcome>();

                // 1. 登记 pending + oneshot sender（复用 ask_listener 通道）
                {
                    let mut pending = state.pending_plugin_cards.lock().map_err(|e| {
                        format!("cap.ui.render pending_plugin_cards 锁: {}", e)
                    })?;
                    if pending.contains_key(&interaction_id) {
                        return Err(format!(
                            "cap.ui.render interactionId 冲突（防重放）: {}",
                            interaction_id
                        ));
                    }
                    pending.insert(
                        interaction_id.clone(),
                        PendingPluginCard {
                            interaction_id: interaction_id.clone(),
                            session_id: session_id.clone(),
                            call_id: None,
                            plugin_id: plugin_id.clone(),
                            card_id: card_id.clone(),
                            tool_name: tool_name.clone(),
                            payload: payload.clone(),
                            status: PluginCardStatus::Pending,
                            source: Some("ui.render".to_string()),
                        },
                    );
                }
                state.register_plugin_card_answer_sender(&interaction_id, tx);

                // 2. 广播 plugin_card 事件 → 前端渲染（零改动复用 eventHandler）
                emit_plugin_card_event(
                    &state,
                    &session_id,
                    &interaction_id,
                    &plugin_id,
                    &card_id,
                    &tool_name,
                    payload,
                );

                // 3. 等待用户应答（前端 respondPluginCard → respond_plugin_card → oneshot）
                match tokio::time::timeout(UI_RENDER_TIMEOUT, rx).await {
                    Ok(Ok(outcome)) => {
                        // 清理 pending（应答已回）
                        if let Ok(mut pending) = state.pending_plugin_cards.lock() {
                            pending.remove(&interaction_id);
                        }
                        if outcome.declined {
                            Ok(json!({
                                "status": "declined",
                                "answer": Value::Null,
                                "interactionId": interaction_id,
                            }))
                        } else {
                            Ok(json!({
                                "status": "answered",
                                "answer": outcome.result,
                                "interactionId": interaction_id,
                            }))
                        }
                    }
                    Ok(Err(_recv_err)) => {
                        // oneshot 被丢弃，按 declined 处理
                        tracing::info!(
                            "[cap.ui.render] interaction_id={} oneshot 被丢弃，按 declined 处理",
                            interaction_id
                        );
                        if let Ok(mut pending) = state.pending_plugin_cards.lock() {
                            pending.remove(&interaction_id);
                        }
                        Ok(json!({
                            "status": "declined",
                            "answer": Value::Null,
                            "interactionId": interaction_id,
                        }))
                    }
                    Err(_elapsed) => {
                        tracing::info!(
                            "[cap.ui.render] interaction_id={} 超时，按 declined 处理",
                            interaction_id
                        );
                        if let Ok(mut pending) = state.pending_plugin_cards.lock() {
                            pending.remove(&interaction_id);
                        }
                        Ok(json!({
                            "status": "timeout",
                            "answer": Value::Null,
                            "interactionId": interaction_id,
                        }))
                    }
                }
            })
        })
    }
}

impl Capability for UiRenderCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn describe(&self) -> Value {
        serde_json::json!({
            "summary": "可交互渲染 + UI 模板运行时注册：register 注册 DSL 模板 → request 填参渲染对话卡片，用户操作 answer 同回合回传",
            "note": "frame.type 白名单 question/form/confirm/custom/template；模板不落地 dsl 以外的执行面，无任意 HTML",
            "actions": {
                "register": { "params": {
                    "templateId": "string 必填 ≤64 [A-Za-z0-9\\-_./:]",
                    "title": "string?",
                    "description": "string?",
                    "dsl": "Node[] 必填（vstack/hstack/text/metric/badge/table/progress/divider/input/select，text 支持 {{param}} 插值）",
                    "buttons": "[{id,label,danger?}]?（≤8）",
                    "persist": "boolean? 默认 true（仅内存传 false）"
                }, "returns": "{ registered, templateId, persisted }" },
                "unregister": { "params": { "templateId": "string" }, "returns": "{ unregistered, templateId }" },
                "list": { "params": {}, "returns": "{ templates: [{templateId,title,description,owner,persisted}] }" },
                "request": { "params": {
                    "sessionId": "string（必填）",
                    "pluginId": "string（必填）",
                    "cardId": "string（必填）",
                    "toolName": "string?（默认 ui.render）",
                    "mode": "string? display = 不等应答 fire-and-forget",
                    "title": "string?",
                    "frame": "object（type: question|form|confirm|custom|template；template 帧带 templateId+params）"
                }, "returns": "{ status: answered|declined|timeout|displayed, answer?, interactionId }" }
            }
        })
    }

    fn invoke(&self, params: Value, ctx: &dyn Context) -> std::result::Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .unwrap_or("")
            .to_string();
        match action.as_str() {
            "register" => self.do_register(&params, ctx),
            "unregister" => {
                let template_id = Self::require_str(&params, "templateId")?.to_string();
                self.do_unregister(&template_id, ctx)
            }
            "list" => self.do_list(ctx),
            "request" => self.do_request(&params, ctx),
            _ => Err(format!("cap.ui.render 仅支持动作 {:?}", UI_RENDER_ACTIONS)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}
