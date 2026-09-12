//! cap.config —— 系统配置统一入口（第八步：cap.config 上总线试点）
//!
//! 对应 `dev/docs/sky/step8-config.md`：
//! - 设计目标：config.json 仍是**单一真源**，但读写收敛为 dispatch 总线上的
//!   唯一可审计/可鉴权入口，行为与现有 `update_config_patch` 双通道对齐。
//! - 试点片段：`performance` 段（性能开关，无敏感字段、已有热切换管线）。
//!
//! # 白名单 schema（单一真源）
//!
//! 所有可写字段在此声明。`schema` 动作返回纯声明（前端据此渲染控件），
//! `patch` 动作按此校验。未列入的字段/section 一律拒绝，杜绝任意写。
//!
//! # patch 深层合并（本能力的关键价值）
//!
//! `ConfigStore::patch` 只做**顶层字段整体替换**（`merge_json_object` 只并第一层）。
//! 因此直接 `patch({ performance: { fileWatcher: true } })` 会把整个 performance
//! 对象替换掉，其他开关（如 schedulerDaemon）会被重置回默认——每 toggle 一个
//! 开关就丢其他。cap.config 必须在白名单内**先读当前 section 值 → 与 patch
//! 深层合并 → 整体写顶层**，再交给 `ConfigStore::patch` 持久化。
//!
//! # 信号脱敏（读路径）
//!
//! - `web.token` → 掩码
//! - `modelProfiles[].apiKey` / `providerGroups[].apiKey` → 掩码
//!
//! 掩码规则（复用 mask_key 形态）：`${ENV}` → `env:<NAME>`；长度 ≤4 → `****`；
//! 否则保留后 4 字符 → `****<last4>`。
//!
//! # 动作协议（payload `{ "action": ... }`）
//!
//! - `get`     `{ "action": "get", "section": "performance"|"all" }`
//!                      → `{ "section": "performance", "value": {...} }`
//! - `patch`   `{ "action": "patch", "section": "performance", "value": {...} }`
//!                      → 完整 config（与现有 update_config_patch 返回对齐）
//! - `schema`  `{ "action": "schema" }` → 白名单纯声明
//! - `reset_cli`  `{ "action": "reset_cli" }` → `{ "reset": true }`（占位，后续专用动作）

use crate::contracts::{Capability, CapabilityId, Context, Value};
use crate::models::config::Config;
use std::sync::{Arc, Mutex};

/// cap.config —— 系统配置能力（唯一实现）
pub struct ConfigCapability {
    config_store: Arc<Mutex<crate::services::config_store::ConfigStore>>,
    /// 事件回调：patch 成功后通知上层触发副作用链（cascade/refresh/emit）。
    /// 不直接持有 tauri AppHandle，保持本能力纯逻辑可测。
    on_patch: Box<dyn Fn(&Config) + Send + Sync>,
}

impl ConfigCapability {
    pub fn new(
        config_store: Arc<Mutex<crate::services::config_store::ConfigStore>>,
        on_patch: Box<dyn Fn(&Config) + Send + Sync>,
    ) -> Self {
        Self { config_store, on_patch }
    }
}

const CAP_ID: &str = "cap.config";

/// 支持的 action 协议（写死为契约，与前端/规划对齐）
pub const CONFIG_ACTIONS: &[&str] = &["get", "patch", "schema", "reset_cli"];

/// section 类型分类
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SectionKind {
    /// 布尔开关组（可写，patch 按字段合并 + 缺失补默认）
    BoolSet,
    /// 对象配置（可写，patch 按字段合并）
    Object,
    /// 只读（读可、写拒绝）
    ReadOnly,
    /// 锁定（读已脱敏、写走独立动作）
    Locked,
}

/// 白名单 schema 条目
struct SectionSchema {
    name: &'static str,
    kind: SectionKind,
    /// 可写子字段（BoolSet/Object 时）
    fields: &'static [&'static str],
}

/// 全量白名单 schema（单一真源；写动作据此校验）
///
/// 注意：字段名一律用 **camelCase JSON 名**（与前端 `update_config_patch` 的
/// patch 键一致），而非 Rust snake_case。schema 返回给前端的就是这些 JSON 名。
fn config_schema() -> Vec<SectionSchema> {
    vec![
        SectionSchema {
            name: "core",
            kind: SectionKind::Object,
            fields: &["defaultEngine", "workDir", "sessionDir"],
        },
        // 试点段落：性能开关（真实模型 PerformanceFeatures 的 8 字段）
        SectionSchema {
            name: "performance",
            kind: SectionKind::BoolSet,
            fields: &[
                "fileWatcher",
                "lspIndex",
                "schedulerDaemon",
                "syntaxHighlighting",
                "mermaidDiagrams",
                "katexMath",
                "codeEditorLanguages",
                "pluginAutoStart",
            ],
        },
        SectionSchema {
            name: "web",
            kind: SectionKind::Object,
            fields: &["enabled", "host", "port"],
            // token 属敏感（Locked 语义），写走独立动作（后续 apply_web）
        },
        SectionSchema {
            name: "modelProfiles",
            kind: SectionKind::ReadOnly,
            fields: &[],
        },
        SectionSchema {
            name: "providerGroups",
            kind: SectionKind::ReadOnly,
            fields: &[],
        },
        SectionSchema {
            name: "permissions",
            kind: SectionKind::Locked,
            fields: &[],
        },
    ]
}

fn schema_named(name: &str) -> Option<SectionSchema> {
    config_schema().into_iter().find(|s| s.name == name)
}

/// performance 段完整补默认（缺失字段按真实模型默认值补全，保证整体写回不丢字段）
fn default_performance_json() -> Value {
    serde_json::json!({
        "fileWatcher": false,
        "lspIndex": false,
        "schedulerDaemon": true,
        "syntaxHighlighting": false,
        "mermaidDiagrams": false,
        "katexMath": false,
        "codeEditorLanguages": false,
        "pluginAutoStart": false,
    })
}

/// 是否为敏感子字段（读路脱敏）
fn is_sensitive_field(section: &str, field: &str) -> bool {
    match section {
        "web" => matches!(field, "token"),
        "modelProfiles" | "providerGroups" => matches!(field, "apiKey"),
        _ => false,
    }
}

/// 脱敏量化（对齐 mask_key / 验证 crate）
fn mask_value(v: &str) -> String {
    let trimmed = v.trim();
    if let Some(rest) = trimmed.strip_prefix("${") {
        if let Some(name_end) = rest.find('}') {
            return format!("env:{}", &rest[..name_end]);
        }
    }
    let count = trimmed.chars().count();
    if count <= 4 {
        return "****".to_string();
    }
    let chars: Vec<char> = trimmed.chars().collect();
    let tail: String = chars[count - 4..].iter().collect();
    format!("****{}", tail)
}

/// 对 section 值递归打掩码（白名单读路径）
fn apply_masks(section: &str, obj: &mut Value) {
    match section {
        "web" => {
            if let Some(token) = obj.get_mut("token") {
                if let Some(s) = token.as_str() {
                    *token = Value::String(mask_value(s));
                }
            }
        }
        "modelProfiles" | "providerGroups" => {
            if let Some(arr) = obj.as_array_mut() {
                for item in arr {
                    if let Some(k) = item.get_mut("apiKey") {
                        if let Some(s) = k.as_str() {
                            *k = Value::String(mask_value(s));
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

/// 合并「当前 config 的 section 值」与「patch 的 section 值」。
///
/// 关键：规避 `ConfigStore::patch` 顶层整体替换陷阱。分层语义见模块文档。
fn merge_section_value(config: &Config, section: &str, patch_val: &Value) -> Result<Value, String> {
    let section_schema =
        schema_named(section).ok_or_else(|| format!("未知 section: {}", section))?;

    // 当前 config 序列化出该 section 现值
    let current_full =
        serde_json::to_value(config).map_err(|e| format!("config 序列化失败: {}", e))?;
    let current_section = current_full
        .as_object()
        .and_then(|m| m.get(section))
        .cloned()
        .unwrap_or(Value::Object(serde_json::Map::new()));

    match section_schema.kind {
        SectionKind::BoolSet | SectionKind::Object => {
            // 白名单字段校验
            let patch_obj = patch_val
                .as_object()
                .ok_or_else(|| format!("section {} 的值必须是对象", section))?;
            for (k, _) in patch_obj {
                if !section_schema.fields.contains(&k.as_str()) {
                    return Err(format!(
                        "section {} 不允许字段: {}（白名单: {:?}）",
                        section, k, section_schema.fields
                    ));
                }
            }
            // 深层合并：当前值为基底，patch 覆盖
            let mut merged = current_section;
            if merged.is_object() && patch_val.is_object() {
                for (k, v) in patch_obj {
                    merged
                        .as_object_mut()
                        .unwrap()
                        .insert(k.clone(), v.clone());
                }
            }
            // BoolSet 补默认值（缺失字段补全，保证完整对象写回）
            if section_schema.kind == SectionKind::BoolSet && section == "performance" {
                let defaults = default_performance_json();
                let defaults_obj = defaults.as_object().unwrap();
                let merged_obj = merged.as_object_mut().unwrap();
                for (k, dv) in defaults_obj {
                    merged_obj.entry(k.clone()).or_insert_with(|| dv.clone());
                }
            }
            Ok(merged)
        }
        SectionKind::ReadOnly | SectionKind::Locked => {
            Err(format!("section {} 只读/锁定，不可写", section))
        }
    }
}

/// `get`：读指定 section（缺省=白名单全部）；只暴露白名单字段，敏感字段脱敏。
///
/// D 阶段扩展：`section=full` 返回**完整 config**（含非白名单顶层 key），
/// 敏感字段仍脱敏。仅 Bootstrap 本地源可用（`invoke` 中按 ctx.source() 限制，
/// 远程源拒绝）——前端 configStore 需要完整 config 驱动 UI，完整读是本地可信行为。
fn do_get(config: &Config, section: &str) -> Result<Value, String> {
    let full = serde_json::to_value(config).map_err(|e| e.to_string())?;
    let full_obj = full.as_object().unwrap();

    // full：返回完整 config（所有顶层 key，敏感字段脱敏）
    if section == "full" {
        let mut out = serde_json::Map::new();
        for (k, v) in full_obj {
            let mut v = v.clone();
            if k == "web" || k == "modelProfiles" || k == "providerGroups" {
                apply_masks(k, &mut v);
            }
            out.insert(k.clone(), v);
        }
        return Ok(Value::Object(out));
    }

    if section != "all" {
        let schema = schema_named(section).ok_or_else(|| format!("未知 section: {}", section))?;
        if schema.kind == SectionKind::Locked {
            return Err(format!("section {} 已锁定，不对外读", section));
        }
        let mut v = full_obj
            .get(section)
            .cloned()
            .unwrap_or(Value::Object(serde_json::Map::new()));
        apply_masks(section, &mut v);
        return Ok(serde_json::json!({ "section": section, "value": v }));
    }

    // all：只返回白名单 section（不泄露未列出的字段）
    let mut out = serde_json::Map::new();
    for schema in config_schema() {
        if schema.kind == SectionKind::Locked {
            continue;
        }
        let mut v = full_obj
            .get(schema.name)
            .cloned()
            .unwrap_or(Value::Object(serde_json::Map::new()));
        apply_masks(schema.name, &mut v);
        out.insert(schema.name.to_string(), v);
    }
    Ok(Value::Object(out))
}

/// `patch`：白名单 section 深层合并 → 经 ConfigStore.patch 持久化。
///
/// D 阶段扩展：section 若**不在白名单 schema**（即「顶层自由 key」，如
/// `workspaces`/`chatDisplay`），走**透传**路径 —— `store.patch` 对该顶层
/// key 整体替换（`merge_json_object` 只并第一层，等价旧 `update_config_patch`
/// 行为）。这样前端旧 `updateConfigPatch({...顶层对象...})` 的所有字段都能被
/// cap.config 统一承载，同时白名单 section 仍保持严格校验（越权/字段拒绝）。
fn do_patch(
    config_store: &Arc<Mutex<crate::services::config_store::ConfigStore>>,
    section: &str,
    patch_val: &Value,
) -> Result<Value, String> {
    // 0. 未知顶层自由 key → 透传整体替换（兼容旧 update_config_patch 语义）
    if schema_named(section).is_none() {
        let mut store = config_store
            .lock()
            .map_err(|e| format!("config 锁获取失败: {}", e))?;
        let mut top_patch = serde_json::Map::new();
        top_patch.insert(section.to_string(), patch_val.clone());
        let saved = store
            .patch(Value::Object(top_patch))
            .map_err(|e| format!("config patch 失败: {}", e))?;
        return Ok(serde_json::to_value(saved).map_err(|e| e.to_string())?);
    }

    // 1. 白名单 section 校验（ReadOnly/Locked 拒绝）
    let schema = schema_named(section).ok_or_else(|| format!("未知 section: {}", section))?;
    if matches!(schema.kind, SectionKind::ReadOnly | SectionKind::Locked) {
        return Err(format!("section {} 只读/锁定，不可写", section));
    }

    // 2. 持锁：读当前 → 嵌套合并 → 顶层整体写
    let mut store = config_store
        .lock()
        .map_err(|e| format!("config 锁获取失败: {}", e))?;
    let current = store.get().clone();
    let merged = merge_section_value(&current, section, patch_val)?;

    // 3. 只把合并后的完整 section 对象交给顶层 patch（此时顶层替换安全，
    //    因为对象已是全量字段）。其他顶层字段一律不动。
    let mut top_patch = serde_json::Map::new();
    top_patch.insert(section.to_string(), merged);
    let saved = store
        .patch(Value::Object(top_patch))
        .map_err(|e| format!("config patch 失败: {}", e))?;
    Ok(serde_json::to_value(saved).map_err(|e| e.to_string())?)
}

impl Capability for ConfigCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| format!("cap.config 需要 action 参数（{:?}）", CONFIG_ACTIONS))?;

        match action {
            "get" => {
                let section = params
                    .get("section")
                    .and_then(|s| s.as_str())
                    .unwrap_or("all");
                // full 完整读：任何已认证源可用（token/apiKey 已脱敏，读取本身安全，
                // 前端 configStore 驱动 UI 必需完整 config；Web/远程源也依赖此读）。
                let config = self
                    .config_store
                    .lock()
                    .map_err(|e| e.to_string())?;
                do_get(config.get(), section)
            }
            "patch" => {
                // 顶层对象形态：{ "patch": { key: value, ... } } —— 前端
                // updateConfigPatch 切换后走此协议（一次 patch 多个顶层 key，
                // 白名单 section 严格深层合并 / 自由 key 透传 store.patch）。
                if let Some(top_patch) = params.get("patch") {
                    let top_obj = top_patch.as_object().ok_or_else(|| {
                        "cap.config patch 的 patch 参数必须是对象".to_string()
                    })?;
                    let mut saved = Value::Null;
                    for (k, v) in top_obj {
                        saved = do_patch(&self.config_store, k, v)?;
                        // 副作用链回调（每个顶层 key 落盘后都触发；on_patch 幂等）
                        if let Ok(config) = serde_json::from_value::<Config>(saved.clone()) {
                            (self.on_patch)(&config);
                        }
                    }
                    return Ok(saved);
                }
                let section = params
                    .get("section")
                    .and_then(|s| s.as_str())
                    .ok_or_else(|| "patch 需要 section 或 patch 参数".to_string())?;
                let value = params
                    .get("value")
                    .ok_or_else(|| "patch 需要 value 参数".to_string())?;
                let saved = do_patch(&self.config_store, section, value)?;
                // 副作用链回调（上层注入：cascade / refresh / emit）
                if let Ok(config) = serde_json::from_value::<Config>(saved.clone()) {
                    (self.on_patch)(&config);
                }
                Ok(saved)
            }
            "schema" => {
                let sections: Vec<Value> = config_schema()
                    .iter()
                    .map(|s| {
                        serde_json::json!({
                            "name": s.name,
                            "fields": s.fields,
                            "write": match s.kind {
                                SectionKind::ReadOnly => "read",
                                SectionKind::Locked => "locked",
                                _ => "write",
                            },
                        })
                    })
                    .collect();
                Ok(serde_json::json!({
                    "schemaVersion": 1,
                    "sections": sections,
                }))
            }
            "reset_cli" => Ok(serde_json::json!({ "reset": true })),
            other => Err(format!("cap.config 不支持动作: {}", other)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}