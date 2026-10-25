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
//! - `web.token` → 掩码（get full / get all / 命名 section 读均脱敏）
//! - `modelProfiles[].apiKey` / `providerGroups[].members[].keys` →
//!   **Bootstrap/Plugin 来源仅经 section=full 可读且不脱敏**（这两 section 不在
//!   白名单 schema：get all 只返回白名单 section、命名 section 读对非白名单直接
//!   报"未知 section"，均触达不了它们；full 不脱敏是前端编辑表单需原始 apiKey，
//!   回写透传整体替换不污染密钥）；**Remote 来源掩码为哨兵 `__POLARIS_MASKED__`**
//!   （P0 安全部署闸：远程 token 泄漏时凭据不外流，spec §3），回写时按
//!   id/位置还原，无法还原则拒绝整个 patch。
//!
//! 掩码规则（复用 mask_key 形态）：`${ENV}` → `env:<NAME>`；长度 ≤4 → `****`；
//! 否则保留后 4 字符 → `****<last4>`。
//!
//! # 动作协议（payload `{ "action": ... }`）
//!
//! - `get`     `{ "action": "get", "section": "<白名单名>"|"all"|"full" }`
//!                      → 命名 section 为 `{ "section", "value" }` 包装；
//!                        all 为白名单 section 裸对象；full 为完整 config
//! - `patch`   `{ "action": "patch", "section": "<key>", "value": {...} }`
//!                      或顶层形态 `{ "action": "patch", "patch": { 顶层key: {...} } }`
//!                      → 完整 config（与现有 update_config_patch 返回对齐）
//! - `schema`  `{ "action": "schema" }` → 白名单纯声明
//! - `reset_cli`  `{ "action": "reset_cli" }` → `{ "reset": true }`（占位，后续专用动作）
//!
//! # 写权限（全源放行）
//!
//! `cap.config` 不在 `PolicyPermission` 内置 deny 里（远程**读**是 Web/移动端
//! 连接与驱动刚需），**写动作**（`patch` / `reset_cli`）也对全部来源放行：
//! - `Source::Bootstrap`（桌面主窗口 IPC）
//! - `Source::Plugin`（MCP 桥 `polaris-dispatch` 等，`ask_listener` 注入）
//! - `Source::Remote`（Web/移动端 HTTP，token 已由传输层鉴权 + 脱敏）
//!
//! 安全说明：远程写不再按来源拒绝，鉴权完全依赖传输层 token；配置白名单
//! schema 校验（未列入字段/section 拒绝）与敏感字段脱敏仍然生效。

use crate::contracts::{
    standard_describe, unsupported_action, Capability, CapabilityId, Context, Value,
};
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

    /// 写动作（patch/reset_cli）的源校验——全源放行（含 Remote）。
    ///
    /// 曾按 source 拒绝远程写（仅 Bootstrap/Plugin 可写），产品决策放开：
    /// 移动端/Web 需要远程写入配置。鉴权完全依赖传输层 token 注入。
    fn ensure_writable_source(&self, _source: &crate::contracts::Source) -> Result<(), String> {
        Ok(())
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
        // modelProfiles / providerGroups 不列入白名单：patch 走透传整体替换
        //（do_patch 第 0 步，与摘旧前 update_config_patch 行为对齐）。
        // 原因：这两 section 含 apiKey 敏感字段，若列入白名单走深层合并，
        // 前端从 get full 拿到的是脱敏掩码，回写会污染密钥；透传整体替换
        // 则由前端始终提交完整列表（含原始 apiKey），不触发部分合并。
        // get full 对这两 section 的 apiKey 仍脱敏（只读展示场景），
        // 但 ModelProviderTab 编辑表单需原始 apiKey —— 见 get full 例外。
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
///
/// 仅 web.token 需要打掩码：调用点只有 do_get 的 full 分支（仅对 `k == "web"`
/// 调用）与白名单 section 读（core/performance/web，modelProfiles/providerGroups
/// 在命名 section 路径先被"未知 section"拒绝）。曾有 modelProfiles/providerGroups
/// 掩码分支，实际不可达（2026-10-25 审计：与模块文档"仅 get all 脱敏"的误导同根），
/// 已删除——这两 section 仅经 section=full 读；Remote 来源的脱敏改走
/// `mask_remote_secrets`（P0 安全部署闸，plans/p0-web-security-gate-spec.md §3）。
fn apply_masks(section: &str, obj: &mut Value) {
    if section == "web" {
        if let Some(token) = obj.get_mut("token") {
            if let Some(s) = token.as_str() {
                *token = Value::String(mask_value(s));
            }
        }
    }
}

/// Remote 来源 `get full` 的密钥哨兵：patch 回写时按 id/位置还原为现值。
const REMOTE_MASK_SENTINEL: &str = "__POLARIS_MASKED__";

/// 对 Remote 来源的 full 响应掩码密钥字段（P0 安全部署闸 spec §3）。
///
/// 覆盖 `modelProfiles[].apiKey` 与 `providerGroups[].members[].keys`（多 Key 池，
/// 同为凭据泄漏面）。Bootstrap/Plugin 来源不经过此函数——桌面编辑表单需要原文。
/// `web.token` 的掩码（mask_value 形态）与此无关，对所有来源生效。
fn mask_remote_secrets(full: &mut Value) {
    let Some(obj) = full.as_object_mut() else {
        return;
    };
    if let Some(mp) = obj.get_mut("modelProfiles") {
        mask_secrets_recursive(mp, &["apiKey"]);
    }
    if let Some(pg) = obj.get_mut("providerGroups") {
        mask_secrets_recursive(pg, &["apiKey", "keys"]);
    }
}

/// 递归掩码指定字段名。字符串 → 哨兵；字符串数组（keys 池）→ 等长哨兵数组。
fn mask_secrets_recursive(v: &mut Value, fields: &[&str]) {
    match v {
        Value::Array(items) => {
            for item in items {
                mask_secrets_recursive(item, fields);
            }
        }
        Value::Object(map) => {
            for (k, val) in map.iter_mut() {
                if fields.contains(&k.as_str()) {
                    match val {
                        Value::String(s) if !s.is_empty() => {
                            *val = Value::String(REMOTE_MASK_SENTINEL.to_string());
                        }
                        Value::Array(arr) if !arr.is_empty() => {
                            *val = Value::Array(vec![
                                Value::String(REMOTE_MASK_SENTINEL.to_string());
                                arr.len()
                            ]);
                        }
                        _ => {}
                    }
                } else {
                    mask_secrets_recursive(val, fields);
                }
            }
        }
        _ => {}
    }
}

fn sentinel_reject(context: &str) -> String {
    format!(
        "patch 含脱敏哨兵 {REMOTE_MASK_SENTINEL} 但无法还原（{}）——远程读取返回的是掩码。\
         新建条目请填写真实密钥；修改既有条目请只改非密钥字段，或从桌面端编辑密钥",
        context
    )
}

/// patch 透传落盘前，把 Remote 读到的哨兵按身份还原为现值（spec §3）。
///
/// - modelProfiles：按 `id` 匹配还原 `apiKey`；
/// - providerGroups：按组 `id` + 成员索引还原 `keys`（成员无独立 id），
///   索引错位（profileId 不一致）视为结构变化 → 拒绝，防密钥串组；
/// - `id` 匹配不到 / 现值缺位 → 拒绝整个 patch：宁可失败也不把哨兵写进
///   config 烧掉密钥。
fn restore_remote_sentinels(
    section: &str,
    patch_val: &mut Value,
    current_full: &Value,
) -> Result<(), String> {
    let Some(cur_obj) = current_full.as_object() else {
        return Ok(());
    };
    match section {
        "modelProfiles" => {
            let Some(new_items) = patch_val.as_array_mut() else {
                return Ok(());
            };
            let cur_items = cur_obj.get("modelProfiles").and_then(Value::as_array);
            for item in new_items {
                let Some(obj) = item.as_object_mut() else {
                    continue;
                };
                if obj.get("apiKey").and_then(Value::as_str) != Some(REMOTE_MASK_SENTINEL) {
                    continue;
                }
                let id = obj
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| sentinel_reject("modelProfiles 条目缺 id"))?;
                let cur = cur_items
                    .and_then(|items| {
                        items
                            .iter()
                            .find(|c| c.get("id").and_then(Value::as_str) == Some(id))
                            .and_then(|c| c.get("apiKey").cloned())
                    })
                    .ok_or_else(|| sentinel_reject(&format!("modelProfiles id={id} 无既有条目")))?;
                obj.insert("apiKey".to_string(), cur);
            }
            Ok(())
        }
        "providerGroups" => {
            let Some(new_groups) = patch_val.as_array_mut() else {
                return Ok(());
            };
            let cur_groups = cur_obj.get("providerGroups").and_then(Value::as_array);
            for group in new_groups {
                let Some(gobj) = group.as_object_mut() else {
                    continue;
                };
                // 身份数据（gid）与哨兵探测都在可变借用前完成，避免与
                // members 的 &mut 重叠（E0502）。
                let gid_owned = gobj.get("id").and_then(Value::as_str).map(str::to_string);
                let has_sentinel = gobj
                    .get("members")
                    .and_then(Value::as_array)
                    .is_some_and(|members| {
                        members.iter().any(|m| {
                            m.get("keys").and_then(Value::as_array).is_some_and(|keys| {
                                keys.iter().any(|k| k.as_str() == Some(REMOTE_MASK_SENTINEL))
                            })
                        })
                    });
                if !has_sentinel {
                    continue;
                }
                let gid = gid_owned.ok_or_else(|| sentinel_reject("providerGroups 分组缺 id"))?;
                let cur_group = cur_groups
                    .and_then(|gs| {
                        gs.iter()
                            .find(|c| c.get("id").and_then(Value::as_str) == Some(gid.as_str()))
                    })
                    .ok_or_else(|| {
                        sentinel_reject(&format!("providerGroups id={gid} 无既有分组"))
                    })?;
                let cur_members = cur_group
                    .get("members")
                    .and_then(Value::as_array)
                    .ok_or_else(|| sentinel_reject(&format!("providerGroups id={gid} 无 members")))?;
                let Some(members) = gobj.get_mut("members").and_then(Value::as_array_mut) else {
                    continue;
                };
                for (idx, member) in members.iter_mut().enumerate() {
                    let Some(mobj) = member.as_object_mut() else {
                        continue;
                    };
                    // profileId 在 keys 可变借用前取出
                    let profile_id = mobj.get("profileId").and_then(Value::as_str).map(str::to_string);
                    let Some(new_keys) = mobj.get_mut("keys").and_then(Value::as_array_mut) else {
                        continue;
                    };
                    if !new_keys
                        .iter()
                        .any(|k| k.as_str() == Some(REMOTE_MASK_SENTINEL))
                    {
                        continue;
                    }
                    let cur_member = cur_members.get(idx).ok_or_else(|| {
                        sentinel_reject(&format!("providerGroups id={gid} 成员索引 {idx} 超出既有数量"))
                    })?;
                    if profile_id.as_deref()
                        != cur_member.get("profileId").and_then(Value::as_str)
                    {
                        return Err(sentinel_reject(
                            &format!("providerGroups id={gid} 成员顺序与既有配置不一致（profileId 错位），为防密钥串组已拒绝"),
                        ));
                    }
                    let cur_keys = cur_member
                        .get("keys")
                        .and_then(Value::as_array)
                        .ok_or_else(|| {
                            sentinel_reject(&format!("providerGroups id={gid} 成员 {idx} 既有配置无 keys，哨兵无法还原"))
                        })?;
                    for (ki, k) in new_keys.iter_mut().enumerate() {
                        if k.as_str() == Some(REMOTE_MASK_SENTINEL) {
                            let cur = cur_keys.get(ki).cloned().ok_or_else(|| {
                                sentinel_reject(&format!(
                                    "providerGroups id={gid} 成员 {idx} keys[{ki}] 无既有值"
                                ))
                            })?;
                            *k = cur;
                        }
                    }
                }
            }
            Ok(())
        }
        _ => Ok(()),
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

/// 未知 section 的自纠文案（错误即文档：附白名单与 all/full 特殊值，
/// AI 无需先想到调 action=schema 才能发现可选值）
fn unknown_section_error(section: &str) -> String {
    let names: Vec<&str> = config_schema().iter().map(|s| s.name).collect();
    format!(
        "未知 section: {}（可用: {}、all（白名单 section 汇总）、full（完整 config）；可调 action=schema 查看声明）",
        section,
        names.join(" / ")
    )
}

/// `get`：读指定 section（缺省=白名单全部）；只暴露白名单字段，敏感字段脱敏。
///
/// D 阶段扩展：`section=full` 返回**完整 config**（含非白名单顶层 key）。
/// 脱敏策略：`web.token` 脱敏；`modelProfiles`/`providerGroups` 的 apiKey
/// **不脱敏**（前端编辑表单需原始值，回写透传整体替换不污染密钥，
/// 与摘旧前 get_config 行为对齐）。
fn do_get(config: &Config, section: &str, remote: bool) -> Result<Value, String> {
    let full = serde_json::to_value(config).map_err(|e| e.to_string())?;
    let full_obj = full.as_object().unwrap();

    // full：返回完整 config（web.token 各来源均脱敏；modelProfiles/providerGroups
    // 的密钥对 Bootstrap/Plugin 保持原文——前端编辑表单需原始 apiKey，透传整体
    // 替换回写才不污染密钥；对 Remote 来源掩码为哨兵（P0 安全部署闸 spec §3：
    // token 泄漏 = 凭据外流），回写时经 restore_remote_sentinels 按 id 还原）。
    if section == "full" {
        let mut out = serde_json::Map::new();
        for (k, v) in full_obj {
            let mut v = v.clone();
            if k == "web" {
                apply_masks(k, &mut v);
            }
            out.insert(k.clone(), v);
        }
        let mut out_val = Value::Object(out);
        if remote {
            mask_remote_secrets(&mut out_val);
        }
        return Ok(out_val);
    }

    if section != "all" {
        let schema = schema_named(section).ok_or_else(|| unknown_section_error(section))?;
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
    remote: bool,
) -> Result<Value, String> {
    // 0. 未知顶层自由 key → 透传整体替换（兼容旧 update_config_patch 语义）
    if schema_named(section).is_none() {
        let mut store = config_store
            .lock()
            .map_err(|e| format!("config 锁获取失败: {}", e))?;
        // Remote 来源：落盘前把读到的脱敏哨兵还原为现值（spec §3），
        // 哨兵无法还原时拒绝整个 patch——宁可失败也不把哨兵写进 config。
        let mut patch_val = patch_val.clone();
        if remote {
            let current_full = serde_json::to_value(store.get().clone())
                .map_err(|e| format!("config 序列化失败: {}", e))?;
            restore_remote_sentinels(section, &mut patch_val, &current_full)?;
        }
        let mut top_patch = serde_json::Map::new();
        top_patch.insert(section.to_string(), patch_val);
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

impl ConfigCapability {
    /// describe 文档体（状态无关；独立成关联函数便于 describe_contract 测试
    /// 直接调用，无需构造 ConfigStore——其 new() 会触碰真实数据根）。
    ///
    /// 2026-10-25 审计修正（与 do_get/do_patch 实现逐条对齐）：
    /// - get 的 section 取值写全三形态（白名单名 / all / full），原先只写
    ///   "section 名或 all"，照文档构造的 modelProfiles/providerGroups 读取必失败；
    /// - get 的 returns 写明按 section 取值分三种包装形态（命名 section 是
    ///   { section, value } 包装，all/full 才是裸对象）；
    /// - patch 写明双路径差别：白名单 section 严格校验字段并深层合并，
    ///   其余顶层 key 透传整体替换（不校验字段）——原先"必填，白名单 section"
    ///   低估了可写面；
    /// - note 修正：modelProfiles/providerGroups 仅 section=full 可读（此时
    ///   apiKey 不脱敏）；写动作无审批门槛、直接生效（cap_dispatch 审批清单
    ///   不含 cap.config，policy_permission.rs 无本能力 Prompt 规则）。
    ///   2026-10-25 P0 更新：Remote 来源 full 读掩码为哨兵（spec §3），
    ///   上述"不脱敏"自此仅指 Bootstrap/Plugin。
    fn describe_doc() -> Value {
        standard_describe(
            CAP_ID,
            "系统配置",
            "系统配置统一入口：读 section / 白名单 patch / schema / reset_cli",
            Some(
                "写动作（patch/reset_cli）全源放行、直接生效（无审批门槛），鉴权靠传输层 \
                 token；改动全局配置需谨慎（先确认用户意图）；modelProfiles/providerGroups \
                 不在白名单，仅 section=full 可读——Bootstrap/Plugin 明文，Remote 掩码为 \
                 哨兵（回写按 id 还原，无法还原则拒绝）",
            ),
            serde_json::json!({
                "get": { "params": { "section": "string?（白名单 section 名 core/performance/web（permissions 锁定不可读）| all（默认，白名单 section 汇总）| full（完整 config，含非白名单顶层 key，modelProfiles/providerGroups 仅此可读））" }, "returns": "按 section 取值分三形态：命名白名单 section → { section, value } 包装对象；all → { core:…, performance:…, web:… }（仅白名单 section 的裸对象）；full → 完整 config 裸对象。web.token 各形态均脱敏；Remote 来源 full 的 modelProfiles[].apiKey / providerGroups[].members[].keys 掩码为哨兵" },
                "patch": { "params": { "section": "string（与 value 搭配；白名单 section 严格校验字段并深层合并，其余顶层 key 透传整体替换——不校验字段，整个对象直接落盘）", "value": "object（与 section 搭配必填）", "patch": "object（顶层形态二选一：{ patch: { 顶层key: value } } 一次写多个顶层 key，与 section/value 互斥）" }, "returns": "保存后的完整 config 对象" },
                "schema": { "params": {}, "returns": "{ schemaVersion: 1, sections: [{ name, fields, write }] }" },
                "reset_cli": { "params": {}, "returns": "{ reset: true }" }
            }),
        )
    }
}

impl Capability for ConfigCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn describe(&self) -> Value {
        Self::describe_doc()
    }

    fn invoke(&self, params: Value, ctx: &dyn Context) -> Result<Value, String> {
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
                // full 完整读：任何已认证源可用。脱敏分两层：web.token 各来源
                // 均脱敏；modelProfiles/providerGroups 的密钥对 Bootstrap/Plugin
                // 保持原文（前端编辑表单需要），对 Remote 掩码为哨兵（spec §3：
                // 远程 token 泄漏时凭据不外流），回写按 id/位置还原。
                let remote = matches!(ctx.source(), crate::contracts::Source::Remote { .. });
                let config = self
                    .config_store
                    .lock()
                    .map_err(|e| e.to_string())?;
                do_get(config.get(), section, remote)
            }
            "patch" => {
                // 全源放行（含远程 Web/移动端）：写保护已移除，鉴权靠传输层 token。
                // 白名单 schema 校验 + 敏感脱敏仍在 do_patch / do_get 内生效。
                // Remote 来源：哨兵还原（do_patch 内）+ 响应掩码（下方统一处理，
                // 堵"写回响应带出原文"的旁路）。
                let remote = matches!(ctx.source(), crate::contracts::Source::Remote { .. });
                // 顶层对象形态：{ "patch": { key: value, ... } } —— 前端
                // updateConfigPatch 切换后走此协议（一次 patch 多个顶层 key，
                // 白名单 section 严格深层合并 / 自由 key 透传 store.patch）。
                if let Some(top_patch) = params.get("patch") {
                    let top_obj = top_patch.as_object().ok_or_else(|| {
                        "cap.config patch 的 patch 参数必须是对象".to_string()
                    })?;
                    let mut saved = Value::Null;
                    for (k, v) in top_obj {
                        saved = do_patch(&self.config_store, k, v, remote)?;
                        // 副作用链回调（每个顶层 key 落盘后都触发；on_patch 幂等）
                        if let Ok(config) = serde_json::from_value::<Config>(saved.clone()) {
                            (self.on_patch)(&config);
                        }
                    }
                    if remote {
                        mask_remote_secrets(&mut saved);
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
                let mut saved = do_patch(&self.config_store, section, value, remote)?;
                // 副作用链回调（上层注入：cascade / refresh / emit）
                if let Ok(config) = serde_json::from_value::<Config>(saved.clone()) {
                    (self.on_patch)(&config);
                }
                if remote {
                    mask_remote_secrets(&mut saved);
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
            "reset_cli" => {
                // 与 patch 同：全源放行（占位动作）
                self.ensure_writable_source(ctx.source())?;
                Ok(serde_json::json!({ "reset": true }))
            }
            // 未知动作文案统一走 contracts::unsupported_action（列出合法动作与
            // cap.help 指路，AI 可自纠）
            other => Err(unsupported_action(CAP_ID, other, CONFIG_ACTIONS)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::validate_describe;

    #[test]
    fn describe_contract() {
        // describe 契约巡逻：顶层键白名单 + actions 非空 + 每动作含 params/returns
        let d = ConfigCapability::describe_doc();
        let problems = validate_describe(CAP_ID, &d);
        assert!(problems.is_empty(), "describe 契约违例: {problems:?}");
        // 动作清单与 invoke 分支同源（CONFIG_ACTIONS）
        let actions = d["actions"].as_object().unwrap();
        assert_eq!(actions.len(), CONFIG_ACTIONS.len());
        for name in CONFIG_ACTIONS {
            assert!(actions.contains_key(*name), "describe 缺动作 {name}");
        }
    }

    #[test]
    fn unknown_section_error_lists_sections() {
        // 错误即文档：未知 section 文案必须附上可用清单，AI 可自纠
        let err = unknown_section_error("no_such_section");
        assert!(err.contains("core"), "文案应列出白名单 section，实际: {err}");
        assert!(err.contains("full"), "文案应列出 full 特殊值，实际: {err}");
        assert!(
            err.contains("action=schema"),
            "文案应指路 schema 动作，实际: {err}"
        );
    }

    // ===================================================================
    // P0 安全部署闸 spec §3：Remote 密钥掩码 + 哨兵还原（纯 Value 级测试）
    // ===================================================================

    fn sample_full_config() -> Value {
        serde_json::json!({
            "modelProfiles": [
                { "id": "p1", "name": "DeepSeek V4 Pro", "baseUrl": "https://api.example.com", "apiKey": "sk-real-key-1" },
                { "id": "p2", "name": "Empty", "baseUrl": "https://api.example.com", "apiKey": "" }
            ],
            "providerGroups": [
                { "id": "g1", "name": "main", "members": [
                    { "profileId": "p1", "priority": 0, "weight": 1, "keys": ["sk-pool-a", "sk-pool-b"] }
                ] }
            ],
            "performance": { "fileWatcher": false }
        })
    }

    #[test]
    fn remote_mask_covers_profiles_and_key_pools() {
        let mut full = sample_full_config();
        mask_remote_secrets(&mut full);
        let mp = full["modelProfiles"].as_array().unwrap();
        assert_eq!(mp[0]["apiKey"], REMOTE_MASK_SENTINEL, "非空 apiKey 应掩码");
        assert_eq!(mp[1]["apiKey"], "", "空 apiKey 无需掩码");
        let keys = full["providerGroups"][0]["members"][0]["keys"].as_array().unwrap();
        assert_eq!(keys.len(), 2, "keys 池应保持等长哨兵");
        assert!(keys.iter().all(|k| k.as_str() == Some(REMOTE_MASK_SENTINEL)));
        // 非密钥字段不动
        assert_eq!(full["modelProfiles"][0]["name"], "DeepSeek V4 Pro");
    }

    #[test]
    fn remote_restore_round_trips_by_id() {
        let current = sample_full_config();
        // 模拟远程客户端：读到掩码 → 改名称 → 回写
        let mut patch_val = {
            let mut full = sample_full_config();
            mask_remote_secrets(&mut full);
            full["modelProfiles"].clone()
        };
        patch_val[0]["name"] = "renamed";
        restore_remote_sentinels("modelProfiles", &mut patch_val, &current).expect("合法哨兵应还原");
        assert_eq!(patch_val[0]["apiKey"], "sk-real-key-1", "按 id 还原现值");
        assert_eq!(patch_val[0]["name"], "renamed", "非密钥修改保留");
    }

    #[test]
    fn remote_restore_rejects_unknown_id() {
        let current = sample_full_config();
        let mut patch_val = serde_json::json!([
            { "id": "ghost", "apiKey": REMOTE_MASK_SENTINEL }
        ]);
        let err = restore_remote_sentinels("modelProfiles", &mut patch_val, &current)
            .expect_err("未知 id 的哨兵必须拒绝");
        assert!(err.contains("无既有条目"), "错误应指明原因: {err}");
    }

    #[test]
    fn remote_restore_keeps_new_plaintext_key() {
        let current = sample_full_config();
        // 新建条目自带真实密钥，无哨兵 → 原样透传
        let mut patch_val = serde_json::json!([
            { "id": "p3", "name": "new", "apiKey": "sk-brand-new" }
        ]);
        restore_remote_sentinels("modelProfiles", &mut patch_val, &current).expect("明文新建应放行");
        assert_eq!(patch_val[0]["apiKey"], "sk-brand-new");
    }

    #[test]
    fn remote_restore_rejects_member_reorder_with_sentinel() {
        let current = sample_full_config();
        let mut full = sample_full_config();
        mask_remote_secrets(&mut full);
        let mut groups = full["providerGroups"].clone();
        // 模拟成员被换序：profileId 与既有索引错位
        if let Some(member) = groups[0]["members"].as_array_mut() {
            member[0]["profileId"] = Value::String("p2".into());
        }
        let err = restore_remote_sentinels("providerGroups", &mut groups, &current)
            .expect_err("成员错位带哨兵必须拒绝");
        assert!(err.contains("profileId 错位"), "错误应指明原因: {err}");
    }

    #[test]
    fn remote_restore_round_trips_key_pool() {
        let current = sample_full_config();
        let mut full = sample_full_config();
        mask_remote_secrets(&mut full);
        let mut groups = full["providerGroups"].clone();
        // 远程用户在池尾追加一个新 key
        if let Some(keys) = groups[0]["members"][0]["keys"].as_array_mut() {
            keys.push(Value::String("sk-added-remote".into()));
        }
        restore_remote_sentinels("providerGroups", &mut groups, &current).expect("池追加应还原");
        let keys = groups[0]["members"][0]["keys"].as_array().unwrap();
        assert_eq!(keys[0], "sk-pool-a");
        assert_eq!(keys[1], "sk-pool-b");
        assert_eq!(keys[2], "sk-added-remote");
    }
}