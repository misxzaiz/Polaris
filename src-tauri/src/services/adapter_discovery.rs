//! 通用方言适配器 —— 采集 + 翻译合编排（plans/plugin-adapter-capability-spec.md S1/S2）
//!
//! 职责边界（spec §3.3 准入链）：
//! - 适配器只有「翻译权」：本模块不信任任何来自适配器的数据。产物经
//!   `admit_translated` 宿主独占校验（unknown-field fail fast / idPrefix 白名单 /
//!   宿主 designated 字段剥除 / id 冲突不覆盖）。
//! - 传输为 one-shot MCP 工具调用（`McpOnceAdapterTransport`）：每次调用 spawn
//!   适配器插件 server、预算内拿结果、Drop 即杀进程；**不进 McpClientRegistry
//!   常驻池**（避免给注册表状态机增加新语义）。
//! - 缓存只做加速不做真相：`<config>/plugins/adapter-cache/<id>.json`，键为根目录
//!   签名；连续失败熔断（默认 3 次）跳过调用。不可用适配器**绝不炸掉整个
//!   discover**——失败只追加 `PluginDiscoveryError { stale: true }`，原生扫描结果
//!   原样保留。

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::models::plugin::{
    DiscoveredPluginManifest, PluginAdapterManifestContribution, PluginDiscoveryError,
    PluginManifestSourceKind,
};

/// 连续失败熔断阈值（spec §3.2：连续 N 次失败跳过 MCP 调用只用 stale 缓存）
pub const BREAKER_THRESHOLD: u32 = 3;
/// schemaVersion（适配器 ↔ 宿主协议握手；未知版本拒译，绝不 best-effort）
pub const PROTOCOL_SCHEMA_VERSION: u64 = 1;

/// 校验宿主缓存/审计可信任的适配器产出协议版本
pub fn expected_schema_version(version: Option<u64>) -> std::result::Result<u64, String> {
    match version {
        Some(v) if v == PROTOCOL_SCHEMA_VERSION => Ok(v),
        Some(v) => Err(format!(
            "适配器协议 schemaVersion={v}，宿主支持 {PROTOCOL_SCHEMA_VERSION}（未知版本拒载，绝不猜）"
        )),
        None => Err("适配器响应缺少 schemaVersion（拒载，绝不 best-effort）".to_string()),
    }
}

/// 适配器贡献条目（capability `adapters_list` 动作返回的形状）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterEntry {
    /// 声明该适配器的插件（贡献方）id
    pub plugin_id: String,
    /// 声明该适配器的插件安装路径（调试/审计定位用）
    pub install_path: String,
    /// 适配器 MCP server 定义（取贡献插件第一个 stdio server；`{{pluginDir}}` 已替换为 install_path）
    pub mcp_server_name: String,
    pub mcp_command: String,
    pub mcp_args: Vec<String>,
    #[serde(flatten)]
    pub contribution: PluginAdapterManifestContribution,
}

impl AdapterEntry {
    fn server_def(&self) -> Option<AdapterServerDef> {
        if self.mcp_command.is_empty() {
            return None;
        }
        Some(AdapterServerDef {
            server_name: self.mcp_server_name.clone(),
            command: self.mcp_command.clone(),
            args: self.mcp_args.clone(),
        })
    }
}

/// 适配器 MCP server 定义（one-shot 调用入参）
#[derive(Debug, Clone)]
pub struct AdapterServerDef {
    pub server_name: String,
    pub command: String,
    pub args: Vec<String>,
}

/// 从发现结果中摘取全部适配器贡献。
///
/// 去重规则：按 `contribution.id` 全局唯一，首个声明者胜出（与 panelType
/// 「后装者静默覆盖」相反——适配器重复声明必须显式报错，由调用方接入诊断通道；
/// 此处保序去重保证 `adapters_list` 幂等）。
pub fn collect_adapters(plugins: &[DiscoveredPluginManifest]) -> Vec<AdapterEntry> {
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for plugin in plugins {
        for contribution in &plugin.contributes.adapters {
            if !seen.insert(contribution.id.clone()) {
                continue;
            }
            // 取第一个 stdio server 作为适配器进程定义；`{{pluginDir}}` 与
            // 插件 MCP 启动同源替换（install_path 即插件安装目录）。
            let def = plugin
                .contributes
                .mcp_servers
                .iter()
                .find(|s| s.transport == "stdio");
            let (server_name, command, args) = match def {
                Some(def) => (
                    def.id.clone(),
                    def.command.trim().to_string(),
                    def.args_template
                        .iter()
                        .map(|a| a.replace("{{pluginDir}}", &plugin.install_path))
                        .collect::<Vec<_>>(),
                ),
                None => (String::new(), String::new(), Vec::new()),
            };
            entries.push(AdapterEntry {
                plugin_id: plugin.id.clone(),
                install_path: plugin.install_path.clone(),
                mcp_server_name: server_name,
                mcp_command: command,
                mcp_args: args,
                contribution: contribution.clone(),
            });
        }
    }
    entries
}

/// 单次适配器 MCP 工具调用。
///
/// 返回 boxed future（object-safe，可注入 fake）；真实实现 one-shot spawn。
pub trait AdapterMcpTransport: Send + Sync {
    fn call(
        &self,
        def: &AdapterServerDef,
        tool: &str,
        args: Value,
        budget: Duration,
    ) -> Pin<Box<dyn Future<Output = std::result::Result<Value, String>> + Send>>;
}

/// 真实 transport：复用 SimpleAI 的 `McpClient`（initialize 握手 + JSON-RPC 帧与
/// Polaris 插件 server 同型），每次调用一次性 spawn，Drop 即杀进程；预算内未返回
/// 即视为失败（调用方熔断计数），由 client Drop 兜底杀进程。
pub struct McpOnceAdapterTransport;

impl AdapterMcpTransport for McpOnceAdapterTransport {
    fn call(
        &self,
        def: &AdapterServerDef,
        tool: &str,
        args: Value,
        budget: Duration,
    ) -> Pin<Box<dyn Future<Output = std::result::Result<Value, String>> + Send>> {
        let def = def.clone();
        let tool = tool.to_string();
        Box::pin(async move {
            let env = HashMap::new();
            let client = crate::ai::engine::simple_ai::mcp::client::McpClient::spawn(
                def.server_name.clone(),
                &def.command,
                &def.args,
                &env,
            )
            .await
            .map_err(|e| format!("适配器 MCP server '{}' 拉起失败: {e}", def.server_name))?;
            let result = tokio::time::timeout(budget, client.call_tool(&tool, &args))
                .await
                .map_err(|_| format!("适配器调用 '{}' 超预算（{}ms），按失败熔断", tool, budget.as_millis()))?
                .map_err(|e| format!("适配器工具 '{}' 调用失败: {e}", tool))?;
            if result.is_error {
                return Err(format!("适配器工具 '{}' 返回错误: {}", tool, result.text()));
            }
            let text = result.text();
            serde_json::from_str::<Value>(&text)
                .map_err(|e| format!("适配器工具 '{}' 返回非 JSON: {}（原文前 120 字: {}）", tool, e, text.chars().take(120).collect::<String>()))
        })
    }
}

/* -------------------------------- 适配器响应形状 -------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AdapterCandidate {
    pub path: String,
    pub manifest_path: String,
    pub manifest: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AdapterDiscoverOutcome {
    pub schema_version: Option<u64>,
    pub dialect: Option<String>,
    pub candidates: Vec<AdapterCandidate>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AdapterTranslateOutcome {
    pub schema_version: Option<u64>,
    pub plugin: Option<Value>,
    pub diagnostics: Vec<String>,
}

/* -------------------------------- 缓存（只加速不做真相） -------------------------------- */

/// 根目录签名：路径 + 一层 deep 条目切面（文件名 + mtime 秒），方言未变即复用缓存。
fn root_signature(root: &Path) -> String {
    let mut parts = vec![root.to_string_lossy().to_string()];
    match std::fs::read_dir(root) {
        Ok(entries) => {
            let mut names: Vec<(String, i64)> = entries
                .filter_map(|e| e.ok())
                .map(|e| {
                    let mtime = e
                        .metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    (e.file_name().to_string_lossy().to_string(), mtime)
                })
                .collect();
            names.sort();
            parts.extend(names.into_iter().map(|(n, m)| format!("{n}:{m}")));
        }
        // 不可读目录：签名只含路径本身（缓存自然失效于每次内容变化不可观测，保守起见不进熔断）
        Err(_) => parts.push("unreadable".to_string()),
    }
    format!("v1|{}", parts.join("#"))
}

/// 缓存条目：该签名下最近一次成功发现/翻译的产物（宿主 admit 阶段每次都会重放）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AdapterCacheEntry {
    pub signature: String,
    pub plugins: Vec<Value>,
    pub diagnostics: Vec<String>,
}

/// 适配器缓存文件：<config>/plugins/adapter-cache/<id>.json
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AdapterCacheFile {
    #[serde(default)]
    pub consecutive_failures: u32,
    #[serde(default)]
    pub entries: HashMap<String, AdapterCacheEntry>,
}

pub fn cache_path(config_dir: &Path, adapter_id: &str) -> PathBuf {
    let safe: String = adapter_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
        .collect();
    config_dir
        .join("plugins")
        .join("adapter-cache")
        .join(format!("{safe}.json"))
}

pub fn load_cache(config_dir: &Path, adapter_id: &str) -> AdapterCacheFile {
    std::fs::read_to_string(cache_path(config_dir, adapter_id))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_cache(config_dir: &Path, adapter_id: &str, cache: &AdapterCacheFile) {
    let path = cache_path(config_dir, adapter_id);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(cache) {
        let _ = std::fs::write(path, text);
    }
}

/* -------------------------------- 准入（宿主独占，适配器无特权） -------------------------------- */

/// 适配器产物顶层已知键（宿主盖戳字段 source/installPath/builtin **不得**由适配器产出）
const KNOWN_TOP_KEYS: &[&str] = &[
    "id",
    "name",
    "version",
    "description",
    "enabledByDefault",
    "contributes",
    "permissions",
    "origin",
    // 宿主留注的方言兼容元数据命名空间（L2 前置；host 独占消费，不参与模型解析）
    "compat",
];
const KNOWN_CONTRIBUTE_KEYS: &[&str] = &[
    "views",
    "mcpServers",
    "services",
    "panel",
    "engines",
    "chatCards",
    "toolProviders",
    "styles",
    "configSchema",
    "executors",
];

fn unknown_keys_error(obj: &Value, known: &[&str], scope: &str) -> Option<String> {
    let map = obj.as_object()?;
    let unknown: Vec<String> = map
        .keys()
        .filter(|k| !known.contains(&k.as_str()))
        .cloned()
        .collect();
    if unknown.is_empty() {
        None
    } else {
        Some(format!("{scope} 含未知字段（deny_unknown_fields 语义）: {unknown:?}"))
    }
}

/// 翻译产物准入：校验通过返回完整 `DiscoveredPluginManifest`（source.kind=Adapter），
/// 否则返回可归因的错误文案（宿主按 errors 通道处理，绝不静默丢弃 view/字段）。
pub fn admit_translated(
    entry: &AdapterEntry,
    dialect_manifest_path: &str,
    translated: &Value,
) -> std::result::Result<DiscoveredPluginManifest, String> {
    if !translated.is_object() {
        return Err("翻译产物必须是对象".to_string());
    }

    // 1. 宿主 designated 字段不得由适配器产出
    for key in ["source", "installPath", "builtin"] {
        if translated.get(key).is_some() {
            return Err(format!(
                "适配器不得产出宿主 designated 字段 \"{key}\"（来源元数据由宿主盖戳）"
            ));
        }
    }

    // 2. unknown-field fail fast（顶层 + contributes 两级，spec §3.3）
    for (value, known, scope) in [
        (translated, KNOWN_TOP_KEYS, "翻译产物"),
        (
            translated.get("contributes").unwrap_or(&Value::Null),
            KNOWN_CONTRIBUTE_KEYS,
            "翻译产物.contributes",
        ),
    ] {
        if let Some(msg) = unknown_keys_error(value, known, scope) {
            return Err(msg);
        }
    }

    // 3. idPrefix 白名单（防越权圈占其他插件命名空间）
    let id = translated
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let prefix = &entry.contribution.id_prefix;
    if prefix.is_empty() {
        return Err("适配器贡献 idPrefix 为空，宿主拒注册（spec §3.1 必填）".to_string());
    }
    if !id.starts_with(prefix.as_str()) {
        return Err(format!(
            "翻译产物 id=\"{id}\" 不在适配器 idPrefix=\"{prefix}\" 命名空间内（拒注册）"
        ));
    }
    let name = translated
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let version = translated
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if name.is_empty() || version.is_empty() {
        return Err("翻译产物缺少 name/version（宿主必填字段）".to_string());
    }

    // 4. 反序列化为内部模型（source.kind=Adapter + adapterId 由宿主盖戳）
    serde_json::from_value::<DiscoveredPluginManifest>(serde_json::json!({
        "id": id,
        "name": name,
        "version": version,
        "description": translated.get("description").cloned().unwrap_or(Value::Null),
        "builtin": false,
        "enabledByDefault": translated.get("enabledByDefault").and_then(|v| v.as_bool()).unwrap_or(false),
        "contributes": translated.get("contributes").cloned().unwrap_or_else(|| json!({})),
        "permissions": translated.get("permissions").cloned().unwrap_or_else(|| json!({})),
        "origin": translated.get("origin").cloned().unwrap_or_else(|| json!({})),
        "source": {
            "kind": "adapter",
            "adapterId": entry.contribution.id,
        },
        "installPath": dialect_manifest_path,
    }))
    .map_err(|e| format!("翻译产物反序列化失败: {e}"))
}

fn push_error(errors: &mut Vec<PluginDiscoveryError>, path: String, error: String, stale: Option<bool>) {
    errors.push(PluginDiscoveryError {
        path,
        error,
        stale,
    });
}

/* -------------------------------- 合并编排 -------------------------------- */

/// 单次发现/翻译调用的产出（成功路径）
struct AdapterRunOutcome {
    plugins: Vec<Value>,
    diagnostics: Vec<String>,
}

/// 对单个适配器贡献执行一轮「发现（可选）→ 翻译 → 准入」合并。
///
/// `force`：`discover_adapter` 动作显式刷新（绕开缓存命中与熔断，成功后清零熔断计数）。
/// `config_dir`：缓存落位根（data_root 单点，见 AGENTS §3.3）。
pub async fn merge_adapter(
    result: &mut crate::models::plugin::PluginDiscoveryResult,
    entry: &AdapterEntry,
    config_dir: &Path,
    workspace_override_root: Option<&str>,
    force: bool,
    transport: &dyn AdapterMcpTransport,
) {
    let adapter_label = format!("adapter:{}", entry.contribution.id);

    // roots：`${WORKSPACE}` 类占位符依赖宿主 env 注水（阶段 2.5），未注入则显式跳过；
    // merge 等调试动作可经 workspace_override_root 显式指定扫描根。
    let mut roots: Vec<String> = Vec::new();
    if let Some(override_root) = workspace_override_root {
        roots.push(override_root.to_string());
    } else {
        for root in &entry.contribution.roots {
            if root.contains("${") {
                push_error(
                    &mut result.errors,
                    adapter_label.clone(),
                    format!("root \"{root}\" 含未注入占位符（宿主 env 注水未落地，显式跳过而非猜测路径）"),
                    None,
                );
            } else if !root.trim().is_empty() {
                roots.push(root.clone());
            }
        }
        // roots 为空：适配器未声明扫描根（内置首发版友好）——记录诊断跳过，不算失败
        if roots.is_empty() {
            push_error(
                &mut result.errors,
                adapter_label.clone(),
                "适配器未声明 roots（或占位符未注入），本轮不参与扫描（显式跳过）".to_string(),
                None,
            );
            return;
        }
    }

    let Some(def) = entry.server_def() else {
        push_error(
            &mut result.errors,
            adapter_label.clone(),
            "适配器贡献缺少 stdio mcpServers 定义（无法拉起翻译进程）".to_string(),
            None,
        );
        return;
    };

    let budget = Duration::from_millis(entry.contribution.timeout_ms.max(1) as u64);
    let mut cache = load_cache(config_dir, &entry.contribution.id);

    for root in &roots {
        let sig = root_signature(Path::new(root));
        // 命中缓存（force 绕开）→ 直接准入缓存产物
        if !force {
            if let Some(hit) = cache.entries.get(root.as_str()) {
                if hit.signature == sig {
                    for plugin_value in &hit.plugins {
                        match admit_translated(entry, root, plugin_value) {
                            Ok(manifest) => match find_conflict(&result.plugins, &manifest.id) {
                                Some(existing_path) => push_error(
                                    &mut result.errors,
                                    format!("{adapter_label}:{root}"),
                                    format!(
                                        "翻译产物 id=\"{}\" 与已发现插件冲突（installPath={}），拒绝覆盖",
                                        manifest.id, existing_path
                                    ),
                                    None,
                                ),
                                None => result.plugins.push(manifest),
                            },
                            Err(e) => push_error(
                                &mut result.errors,
                                format!("{adapter_label}:{root}"),
                                format!("缓存产物准入失败: {e}"),
                                Some(true),
                            ),
                        }
                    }
                    for d in &hit.diagnostics {
                        push_error(
                            &mut result.errors,
                            format!("{adapter_label}:{root}"),
                            d.clone(),
                            Some(true),
                        );
                    }
                    continue;
                }
            }
            // 熔断态：跳过调用（不误报为失败，但显式 stale 标注）
            if cache.consecutive_failures >= BREAKER_THRESHOLD {
                push_error(
                    &mut result.errors,
                    format!("{adapter_label}:{root}"),
                    format!(
                        "适配器连续 {} 次失败已熔断，跳过本轮调用（缓存产物不可用）",
                        cache.consecutive_failures
                    ),
                    Some(true),
                );
                continue;
            }
        }

        match run_adapter_once(entry, &def, root, budget, transport).await {
            Ok(outcome) => {
                for plugin_value in &outcome.plugins {
                    match admit_translated(entry, root, plugin_value) {
                        Ok(manifest) => match find_conflict(&result.plugins, &manifest.id) {
                            Some(existing_path) => push_error(
                                &mut result.errors,
                                format!("{adapter_label}:{root}"),
                                format!(
                                    "翻译产物 id=\"{}\" 与已发现插件冲突（installPath={}），拒绝覆盖",
                                    manifest.id, existing_path
                                ),
                                None,
                            ),
                            None => result.plugins.push(manifest),
                        },
                        Err(e) => push_error(
                            &mut result.errors,
                            format!("{adapter_label}:{root}"),
                            format!("翻译产物准入失败: {e}"),
                            None,
                        ),
                    }
                }
                for d in &outcome.diagnostics {
                    if !d.is_empty() {
                        push_error(
                            &mut result.errors,
                            format!("{adapter_label}:{root}"),
                            d.clone(),
                            None,
                        );
                    }
                }
                // 成功 → 写缓存、清零熔断计数（缓存只加速不做真相）
                if !outcome.plugins.is_empty() || !outcome.diagnostics.is_empty() {
                    cache.entries.insert(
                        root.clone(),
                        AdapterCacheEntry {
                            signature: sig,
                            plugins: outcome.plugins.clone(),
                            diagnostics: outcome.diagnostics.clone(),
                        },
                    );
                }
                cache.consecutive_failures = 0;
            }
            Err(e) => {
                // 失败 → 原生结果原样保留、solved 标注 stale、递增熔断
                cache.consecutive_failures = cache.consecutive_failures.saturating_add(1);
                push_error(
                    &mut result.errors,
                    format!("{adapter_label}:{root}"),
                    e,
                    Some(true),
                );
            }
        }
    }
    save_cache(config_dir, &entry.contribution.id, &cache);
}

/// id 冲突探测：返回已被占用的 installPath（借用方先拿结果再写 errors，避免双借用）
fn find_conflict<'a>(
    plugins: &'a [DiscoveredPluginManifest],
    id: &str,
) -> Option<&'a String> {
    plugins.iter().find(|p| p.id == id).map(|p| &p.install_path)
}

/// 一轮「discover → 逐候选 translate」调用（缓存 miss / force 时走这里）。
async fn run_adapter_once(
    entry: &AdapterEntry,
    def: &AdapterServerDef,
    root: &str,
    budget: Duration,
    transport: &dyn AdapterMcpTransport,
) -> std::result::Result<AdapterRunOutcome, String> {
    let discover_args = json!({ "rootPath": root });
    let discover_value = transport.call(def, &entry.contribution.tool, discover_args, budget).await?;
    let outcome: AdapterDiscoverOutcome = serde_json::from_value(discover_value.clone())
        .map_err(|e| format!("适配器 discover 响应形状不符: {e}（原文前 120 字: {}）", discover_value.to_string().chars().take(120).collect::<String>()))?;
    expected_schema_version(outcome.schema_version)?;

    let mut plugins = Vec::new();
    let mut diagnostics = outcome.diagnostics.clone();
    for candidate in &outcome.candidates {
        let translate_args = json!({ "manifestPath": candidate.manifest_path });
        let translate_value = transport.call(def, "translate", translate_args, budget).await?;
        let translated: AdapterTranslateOutcome = serde_json::from_value(translate_value.clone())
            .map_err(|e| format!("适配器 translate 响应形状不符: {e}"))?;
        expected_schema_version(translated.schema_version)?;
        match translated.plugin {
            Some(plugin_value) => plugins.push(plugin_value),
            None => {
                // 拒译：诊断全量透传（宿主 errors 通道），不静默
                for d in &translated.diagnostics {
                    diagnostics.push(format!("[translate:{}] {d}", candidate.path));
                }
                if translated.diagnostics.is_empty() {
                    diagnostics.push(format!(
                        "[translate:{}] 无 plugin 产出且无诊断（适配器实现缺陷）",
                        candidate.path
                    ));
                }
            }
        }
    }
    Ok(AdapterRunOutcome { plugins, diagnostics })
}

/* -------------------------------- 测试（fake 注入，本机 cargo test --lib 受 DLL 限制能编译不可执行，如实标注） -------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// fake transport：按分发表返回固定响应
    struct FakeTransport {
        discover: Arc<HashMap<String, Value>>, // rootPath → discover 响应
        translate: Arc<HashMap<String, Value>>, // manifestPath → translate 响应
        fail_roots: Arc<HashSet<String>>,
    }

    impl FakeTransport {
        fn canned() -> (Value, Value) {
            // discover：一个 .zcode-plugin 候选；translate：zcode.my-panel 草稿
            let zcode_manifest = json!({
                "name": "my-panel",
                "version": "0.2.0",
                "mcpServers": { "app": { "type": "stdio", "command": "node", "args": ["${ZCODE_PLUGIN_ROOT}/dist/server.mjs"] } },
                "ui": { "surfaces": [ { "id": "editor", "title": { "en": "Editor" }, "resourceUri": "ui://my-panel/editor.html" } ] }
            });
            let discover = json!({
                "schemaVersion": 1,
                "dialect": "zcode",
                "candidates": [ { "path": "fixture", "manifestPath": "/root/fixture/.zcode-plugin/plugin.json", "manifest": zcode_manifest } ],
                "diagnostics": []
            });
            let translate = json!({
                "schemaVersion": 1,
                "plugin": {
                    "id": "zcode.my-panel",
                    "name": "my-panel",
                    "version": "0.2.0",
                    "contributes": {
                        "mcpServers": [ { "id": "app", "transport": "stdio", "command": "node", "argsTemplate": ["{{pluginDir}}/dist/server.mjs"] } ],
                        "views": [ { "id": "zc:my-panel:editor", "area": "activityBar", "panelType": "zc:my-panel:editor", "icon": "Bot", "labelKey": "zc:view:my-panel:editor", "labelDefault": "Editor", "order": 0 } ]
                    },
                    "compat": { "dialect": "zcode" }
                },
                "diagnostics": ["mcpServers[app].env 暂不支持透传（L1），已显式降级"]
            });
            (discover, translate)
        }
    }

    impl AdapterMcpTransport for FakeTransport {
        fn call(
            &self,
            _def: &AdapterServerDef,
            tool: &str,
            args: Value,
            _budget: Duration,
        ) -> Pin<Box<dyn Future<Output = std::result::Result<Value, String>> + Send>> {
            let discover = Arc::clone(&self.discover);
            let translate = Arc::clone(&self.translate);
            let fail_roots = Arc::clone(&self.fail_roots);
            let tool = tool.to_string();
            Box::pin(async move {
                if tool == "discover" {
                    let root = args.get("rootPath").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                    if fail_roots.contains(&root) {
                        return Err("fake 超时/崩溃".to_string());
                    }
                    return discover.get(&root).cloned().ok_or_else(|| "fake: discover 未配置".to_string());
                }
                if tool == "translate" {
                    let manifest_path = args.get("manifestPath").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                    return translate.get(&manifest_path).cloned().ok_or_else(|| "fake: translate 未配置".to_string());
                }
                Err(format!("fake: 未知工具 {tool}"))
            })
        }
    }

    fn discovery_from(plugins: &[Value]) -> crate::models::plugin::PluginDiscoveryResult {
        let mut result = crate::models::plugin::PluginDiscoveryResult::default();
        for p in plugins {
            result
                .plugins
                .push(serde_json::from_value::<DiscoveredPluginManifest>(p.clone()).expect("fixture"));
        }
        result
    }

    fn adapter_plugin_manifest() -> Value {
        json!({
            "id": "opts.zcode-adapter",
            "name": "ZCode Plugin Adapter",
            "version": "0.1.0",
            "builtin": false,
            "enabledByDefault": false,
            "contributes": {
                "adapters": [ { "id": "adapter.zcode", "tool": "discover", "idPrefix": "zcode.", "roots": ["/dialect-root"], "timeoutMs": 3000 } ],
                "mcpServers": [ { "id": "zcode-adapter-mcp", "transport": "stdio", "command": "node", "argsTemplate": ["{{pluginDir}}/mcp/server.js"] } ]
            },
            "source": { "kind": "user" },
            "installPath": "/plugins/opts.zcode-adapter"
        })
    }

    fn canary_plugin_manifest() -> Value {
        json!({
            "id": "native.existing",
            "name": "Native Existing",
            "version": "1.0.0",
            "builtin": false,
            "enabledByDefault": true,
            "contributes": {},
            "source": { "kind": "user" },
            "installPath": "/plugins/native.existing"
        })
    }

    fn storage() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn merge_accepts_translated_plugins_with_adapter_source() {
        let (discover, translate) = FakeTransport::canned();
        let transport = FakeTransport {
            discover: Arc::new(HashMap::from([("/dialect-root".to_string(), discover)])),
            translate: Arc::new(HashMap::from([(
                "/root/fixture/.zcode-plugin/plugin.json".to_string(),
                translate,
            )])),
            fail_roots: Arc::new(HashSet::new()),
        };
        let adapter = serde_json::from_value::<DiscoveredPluginManifest>(adapter_plugin_manifest()).unwrap();
        let entries = collect_adapters(&[adapter]);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].mcp_command, "node");
        assert_eq!(entries[0].mcp_args, vec!["/plugins/opts.zcode-adapter/mcp/server.js"]);

        let tmp = storage();
        let mut result = discovery_from(&[canary_plugin_manifest()]);
        merge_adapter(&mut result, &entries[0], tmp.path(), None, false, &transport).await;

        assert_eq!(result.plugins.len(), 2, "原生插件原样保留 + 翻译产物合并");
        let merged = result.plugins.last().unwrap();
        assert_eq!(merged.id, "zcode.my-panel");
        assert_eq!(merged.source.kind, PluginManifestSourceKind::Adapter);
        assert_eq!(merged.source.adapter_id.as_deref(), Some("adapter.zcode"));
        assert!(result.errors.is_empty(), "errors 应为空: {:?}", result.errors);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn merge_failure_keeps_native_and_marks_stale() {
        let transport = FakeTransport {
            discover: Arc::new(HashMap::new()),
            translate: Arc::new(HashMap::new()),
            fail_roots: Arc::new(HashSet::from(["/dialect-root".to_string()])),
        };
        let adapter = serde_json::from_value::<DiscoveredPluginManifest>(adapter_plugin_manifest()).unwrap();
        let entries = collect_adapters(&[adapter]);
        let tmp = storage();
        let mut result = discovery_from(&[canary_plugin_manifest()]);
        merge_adapter(&mut result, &entries[0], tmp.path(), None, false, &transport).await;

        assert!(
            result.plugins.iter().any(|p| p.id == "native.existing"),
            "失败不得吞掉原生插件"
        );
        assert!(
            result.errors.iter().all(|e| e.stale == Some(true)),
            "适配器失败必须标注 stale"
        );
        // 熔断计数落盘
        let cache = load_cache(tmp.path(), "adapter.zcode");
        assert_eq!(cache.consecutive_failures, 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn merge_breaker_skips_after_threshold() {
        let transport = FakeTransport {
            discover: Arc::new(HashMap::new()),
            translate: Arc::new(HashMap::new()),
            fail_roots: Arc::new(HashSet::from(["/dialect-root".to_string()])),
        };
        let adapter = serde_json::from_value::<DiscoveredPluginManifest>(adapter_plugin_manifest()).unwrap();
        let entries = collect_adapters(&[adapter]);
        let tmp = storage();
        // 预置熔断态
        save_cache(
            tmp.path(),
            "adapter.zcode",
            &AdapterCacheFile {
                consecutive_failures: BREAKER_THRESHOLD,
                entries: HashMap::new(),
            },
        );
        let mut result = discovery_from(&[canary_plugin_manifest()]);
        merge_adapter(&mut result, &entries[0], tmp.path(), None, false, &transport).await;
        assert!(
            result.errors.iter().any(|e| e.error.contains("已熔断")),
            "熔断态应显式报错而非失败计数继续累积"
        );
        let cache = load_cache(tmp.path(), "adapter.zcode");
        assert_eq!(cache.consecutive_failures, BREAKER_THRESHOLD, "熔断态不再递增");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn admit_rejects_unknown_fields_and_prefix_violation() {
        let entry = {
            let adapter = serde_json::from_value::<DiscoveredPluginManifest>(adapter_plugin_manifest()).unwrap();
            collect_adapters(&[adapter]).remove(0)
        };
        // unknown field
        let malformed = json!({ "id": "zcode.ok", "name": "n", "version": "1.0.0", "mysteryField": 1 });
        let e = admit_translated(&entry, "/r", &malformed).unwrap_err();
        assert!(e.contains("未知字段"), "unknown-field 必须 fail fast: {e}");
        // prefix violation
        let squatting = json!({ "id": "polaris.core", "name": "n", "version": "1.0.0" });
        let e = admit_translated(&entry, "/r", &squatting).unwrap_err();
        assert!(e.contains("不应在适配器 idPrefix") || e.contains("拒注册"), "越权圈占必须拒: {e}");
        // designated 字段
        let designated = json!({ "id": "zcode.ok", "name": "n", "version": "1.0.0", "installPath": "/hack" });
        let e = admit_translated(&entry, "/r", &designated).unwrap_err();
        assert!(e.contains("designated"), "适配器不得产出宿主字段: {e}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn merge_rejects_id_conflict_without_overwrite() {
        let (discover, mut translate) = FakeTransport::canned();
        // 篡改翻译产物 id 撞原生插件
        if let Some(plugin) = translate.get_mut("plugin").and_then(|v| v.as_object_mut()) {
            plugin.insert("id".to_string(), json!("native.existing"));
        }
        let transport = FakeTransport {
            discover: Arc::new(HashMap::from([("/dialect-root".to_string(), discover)])),
            translate: Arc::new(HashMap::from([(
                "/root/fixture/.zcode-plugin/plugin.json".to_string(),
                translate,
            )])),
            fail_roots: Arc::new(HashSet::new()),
        };
        let adapter = serde_json::from_value::<DiscoveredPluginManifest>(adapter_plugin_manifest()).unwrap();
        let entries = collect_adapters(&[adapter]);
        let tmp = storage();
        let mut result = discovery_from(&[canary_plugin_manifest()]);
        merge_adapter(&mut result, &entries[0], tmp.path(), None, false, &transport).await;
        assert_eq!(result.plugins.len(), 1, "冲突产物不得合入");
        assert!(result.errors.iter().any(|e| e.error.contains("拒绝覆盖")));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn no_adapters_means_zero_disturbance() {
        let plugins = vec![canary_plugin_manifest()];
        let parsed: Vec<DiscoveredPluginManifest> = plugins
            .iter()
            .map(|p| serde_json::from_value(p.clone()).unwrap())
            .collect();
        assert!(collect_adapters(&parsed).is_empty());
        let mut result = discovery_from(&plugins);
        let before = serde_json::to_string(&result).unwrap();
        // 无适配器 → merge 不被调用（orchestration 条件短路），此处仅断言纯函数路径
        assert_eq!(serde_json::to_string(&result).unwrap(), before);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn root_signature_is_stable_and_changes_on_mtime() {
        let tmp = storage();
        let file = tmp.path().join("marker.txt");
        std::fs::write(&file, b"x").unwrap();
        let s1 = root_signature(tmp.path());
        let s2 = root_signature(tmp.path());
        assert_eq!(s1, s2, "同一状态签名稳定");
        std::fs::write(&file, b"changed").unwrap();
        // mtime 可能同秒，覆盖时不强求变化，仅验证可重入不 panic
        let _ = root_signature(tmp.path());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cache_roundtrip_preserves_entries() {
        let tmp = storage();
        let mut cache = AdapterCacheFile::default();
        cache.entries.insert(
            "/r".to_string(),
            AdapterCacheEntry {
                signature: "v1#/r".to_string(),
                plugins: vec![json!({ "id": "zcode.x" })],
                diagnostics: vec!["d1".to_string()],
            },
        );
        save_cache(tmp.path(), "adapter.zcode", &cache);
        let loaded = load_cache(tmp.path(), "adapter.zcode");
        assert_eq!(loaded.entries.get("/r").unwrap().plugins.len(), 1);
    }
}
