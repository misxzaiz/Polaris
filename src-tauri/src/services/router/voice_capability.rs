//! cap.voice — 语义化语音能力（无限畅听电台资产层）
//!
//! 唯一权威持有三个存储：音色库 / 内容库（音频资产）/ 持久合成缓存。
//! 前端只经 `router_dispatch` 读写，禁止直写文件（AGENTS.md 单写路径纪律）。
//!
//! 合成**委托不持有**（AGENTS.md「唯一权威，禁止多写路径」）：构造时注入
//! `Arc<dyn Capability>`（生产 = cap.mcp 同一实例，经 `RouterBus::register_handle_arc`
//! 共享注册；单测注入 fake）。本能力不持有 McpClient、不拉起插件进程。
//!
//! 契约（plans/radio-broadcast-p1-asset-layer-spec.md §2.2，对总纲 §四的三处细化
//! 以子 spec 为准）：synthesize / voices.* / library.*。jobs 预生成留 P2。
//!
//! 关键技术边界（总纲 §4.3 如实交代）：
//! - MiMo voice design / clone 是无状态 API，不返回可复用 voiceId → 音色库的
//!   本质 = 持久化参数（design 描述文本 / clone 样本文件）并命名，合成时回放。
//! - file 模式音频仍在插件目录（插件零改动），本能力返回 `file` 绝对路径，
//!   前端按端构建播放 URL（Tauri asset 协议 / Web `/api/files/*`，手机可达）。
//! - 缓存是成本护城河（总纲 §6.3）：key = FNV-1a(engine|voiceRef|style|text)，
//!   跨重启稳定；命中零 API 成本。
//!
//! 权限：对齐 cap.mcp（Bootstrap/Plugin 放行；Remote 须带已鉴权 token）。
//! 破坏性动作（library.delete / voices.delete）经 bus dispatch 自动落审计
//! （mod.rs dispatch.ok 通道），本能力不重复建审计路径。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::contracts::{
    Capability, CapabilityId, Context, Source, standard_describe, unsupported_action,
};

/// cap.voice 能力 ID。
pub const VOICE_CAP_ID: &str = "cap.voice";

/// 默认引擎插件（cap.mcp 的 mcpServerId）。v1 单引擎常量，结构预留路由表。
pub const DEFAULT_ENGINE_PLUGIN: &str = "mimo-tts";

/// 缓存目录 GC 配额（字节，500MB）：超限时清空 cache/（items 音频在 library/audio，不受影响）。
const CACHE_GC_QUOTA_BYTES: u64 = 500 * 1024 * 1024;

// ── 数据模型（camelCase 序列化，与前端 types 对齐）─────────────────────────

/// 自定义音色（design / clone）。预置音色不入库（由插件下发，前端兜底）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomVoice {
    pub id: String,
    pub name: String,
    /// "design" | "clone"
    #[serde(rename = "type")]
    pub kind: String,
    /// 引擎插件 id（design/clone 语义不跨引擎迁移，总纲 §6.2）
    pub engine: String,
    /// design：音色描述文本（合成时回放）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// clone：样本文件名（相对 samples/）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_file: Option<String>,
    pub created_at: u64,
}

/// 库单集的一句话引用（audioId = 合成缓存 key；file = 当时的音频绝对路径）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentenceRef {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
}

/// 内容库单集（一段播报 = 一个 item；句级索引天然支持按句 seek/续播）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub topic: String,
    pub engine: String,
    pub voice_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    pub created_at: u64,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    /// "live" | "pregen" | "chat"（v1 播报段自动入库 = live）
    pub source: String,
    pub sentences: Vec<SentenceRef>,
    #[serde(default)]
    pub size_bytes: u64,
}

// ── 存储层（JSON 整读写，tmp+rename 防半写）────────────────────────────────

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// FNV-1a 64bit：跨运行稳定（DefaultHasher 不保证，不能做磁盘缓存 key）。
/// 非安全场景（缓存 key / 音频文件名），key 里附长度进一步降碰撞面。
pub fn fnv1a(input: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in input.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}_{}", input.len())
}

fn load_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Vec<T>, String> {
    match fs::read_to_string(path) {
        Ok(s) if s.trim().is_empty() => Ok(Vec::new()),
        Ok(s) => serde_json::from_str::<Vec<T>>(&s)
            .map_err(|e| format!("{} 解析失败: {e}", path.display())),
        Err(_) => Ok(Vec::new()), // 首次使用：空库
    }
}

fn save_json<T: Serialize>(path: &Path, items: &[T]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("建目录失败: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(items).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&tmp, body).map_err(|e| format!("写临时文件失败: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("原子替换失败: {e}"))?;
    Ok(())
}

// ── 能力实现 ───────────────────────────────────────────────────────────────

/// 可变状态（整库读写持锁；file 级并发由 Mutex 串行化，句级合成吞吐瓶颈
/// 本就在插件 stdio 串行链上，此处锁竞争可忽略）。
struct VoiceState {
    voices: Vec<CustomVoice>,
    items: Vec<LibraryItem>,
}

pub struct VoiceCapability {
    /// 语音数据根 `<dataRoot>/voice/`
    root: PathBuf,
    /// 合成委托能力（生产 = cap.mcp；不持有 client）
    synth: Arc<dyn Capability>,
    /// 引擎插件 id（cap.mcp 的 mcpServerId）
    engine_plugin: String,
    state: Mutex<VoiceState>,
}

impl VoiceCapability {
    /// 装配构造：root = `<dataRoot>/voice/`；synth = cap.mcp 同一实例。
    pub fn new(root: PathBuf, synth: Arc<dyn Capability>) -> Self {
        let voices = load_json(&root.join("voices.json")).unwrap_or_default();
        let items = load_json(&root.join("library.json")).unwrap_or_default();
        Self {
            root,
            synth,
            engine_plugin: DEFAULT_ENGINE_PLUGIN.to_string(),
            state: Mutex::new(VoiceState { voices, items }),
        }
    }

    // ── 路径帮助 ──

    fn cache_dir(&self) -> PathBuf {
        self.root.join("cache")
    }
    fn samples_dir(&self) -> PathBuf {
        self.root.join("samples")
    }
    fn library_audio_dir(&self) -> PathBuf {
        self.root.join("library").join("audio")
    }

    // ── 权限 gate（对齐 cap.mcp）──

    fn gate(payload: &Value, ctx: &dyn Context) -> Result<(), Value> {
        match ctx.source() {
            Source::Bootstrap | Source::Plugin { .. } => Ok(()),
            Source::Remote { token } => {
                if token.is_empty() {
                    Err(json!({
                        "ok": false,
                        "error": "cap.voice 仅允许本地调用或携带有效 token 的远程调用"
                    }))
                } else {
                    let _ = payload;
                    Ok(())
                }
            }
        }
    }

    // ── synthesize（缓存 + 委托）──

    /// 自定义音色参数回放：库内命中 design/clone 用存档参数；否则按预置名透传 synth 工具。
    /// synthesize 与 voices.probe 共用（probe 无需 style）。
    fn voice_tool_args(&self, voice_ref: &str, text: &str) -> (String, Value) {
        let Ok(state) = self.state.lock() else {
            // 锁中毒兜底：按预置名透传（与未命中同路径，委托层会给出真实错误）
            return (
                "mimo_tts_synthesize".to_string(),
                json!({ "text": text, "voice": voice_ref }),
            );
        };
        match state.voices.iter().find(|v| v.id == voice_ref) {
            Some(v) if v.kind == "design" => (
                "mimo_tts_voice_design".to_string(),
                json!({
                    "text": text,
                    "description": v.description.clone().unwrap_or_default(),
                }),
            ),
            Some(v) if v.kind == "clone" => (
                "mimo_tts_voice_clone".to_string(),
                json!({
                    "text": text,
                    "sample": v.sample_file.as_ref().map(|f| self.samples_dir().join(f).to_string_lossy().to_string()),
                }),
            ),
            _ => (
                "mimo_tts_synthesize".to_string(),
                json!({ "text": text, "voice": voice_ref }),
            ),
        }
    }

    fn invoke_synthesize(&self, payload: &Value, ctx: &dyn Context) -> Result<Value, String> {
        let text = str_field(payload, "text").unwrap_or_default().to_string();
        if text.trim().is_empty() {
            return Ok(json!({ "ok": false, "error": "text 不能为空" }));
        }
        let voice_ref = str_field(payload, "voiceRef")
            .unwrap_or("冰糖")
            .to_string();
        let style = str_field(payload, "style").map(|s| s.to_string());
        let output_mode = str_field(payload, "outputMode").unwrap_or("file").to_string();

        let engine = self.engine_plugin.clone();
        let key = fnv1a(&format!("{engine}|{voice_ref}|{}|{}", style.as_deref().unwrap_or(""), text));

        // L2 磁盘缓存命中：跨重启零 API 成本（base64 模式读文件现编 dataUrl）
        let cache_file = self.cache_dir().join(format!("{key}.wav"));
        let base64_requested = output_mode == "base64";
        if cache_file.exists() {
            let size = fs::metadata(&cache_file).map(|m| m.len()).unwrap_or(0);
            let mut hit = json!({
                "ok": true, "audioId": key, "cached": true,
                "format": "wav", "sizeBytes": size,
                "file": cache_file.to_string_lossy(),
            });
            if base64_requested {
                hit["dataUrl"] = json!(file_to_data_url(&cache_file));
            }
            return Ok(hit);
        }

        // 自定义音色展开（参数回放；语义绑引擎，总纲 §6.2）
        let (tool, mut arguments) = self.voice_tool_args(&voice_ref, &text);
        if let Some(st) = &style {
            arguments["style"] = json!(st);
        }
        if base64_requested {
            arguments["outputMode"] = json!("base64");
        }

        // 委托 cap.mcp（同一 ctx 透传：source 语义保持，cap.mcp gate 自行复核）
        let delegated = self.synth.invoke(
            json!({ "action": "call", "mcpServerId": engine, "tool": tool, "arguments": arguments }),
            ctx,
        );
        let reply = match delegated {
            Ok(r) => r,
            Err(e) => return Ok(json!({ "ok": false, "error": format!("合成委托失败: {e}") })),
        };
        if reply.get("ok").and_then(Value::as_bool) != Some(true) {
            return Ok(json!({
                "ok": false,
                "error": reply.get("error").and_then(Value::as_str).unwrap_or("合成未成功").to_string(),
            }));
        }
        let parsed = parse_plugin_result(&reply);
        let Some(parsed) = parsed else {
            return Ok(json!({ "ok": false, "error": "合成结果解析失败（resultJson 缺失）" }));
        };
        if parsed.get("success").and_then(Value::as_bool) != Some(true) {
            return Ok(json!({
                "ok": false,
                "error": parsed.get("error").and_then(Value::as_str).unwrap_or("TTS 合成未成功（可能是 API Key 未配置）").to_string(),
            }));
        }

        // 音频文件来源：file 模式为插件返回的绝对路径；base64 模式解码 dataUrl
        let audio_bytes: Option<Vec<u8>> = if base64_requested {
            parsed
                .get("audioDataUrl")
                .and_then(Value::as_str)
                .and_then(data_url_decode)
        } else {
            parsed
                .get("file")
                .and_then(Value::as_str)
                .and_then(|f| fs::read(f).ok())
        };
        let Some(bytes) = audio_bytes else {
            return Ok(json!({ "ok": false, "error": "合成成功但未取得音频数据" }));
        };

        // 写缓存（tmp+rename；超配额 GC 扫描）
        if let Err(e) = self.write_cache_file(&cache_file, &bytes) {
            tracing::warn!("[cap.voice] 缓存写入失败（不阻塞播放语义）: {e}");
        }

        let mut out = json!({
            "ok": true, "audioId": key, "cached": false,
            "format": parsed.get("format").and_then(Value::as_str).unwrap_or("wav"),
            "sizeBytes": bytes.len(),
            "file": cache_file.to_string_lossy(),
        });
        if base64_requested {
            // 插件已给 dataUrl 则透传，避免二次编码；否则由缓存文件现编
            let data_url = parsed
                .get("audioDataUrl")
                .and_then(Value::as_str)
                .map(|s| s.to_string())
                .unwrap_or_else(|| file_to_data_url(&cache_file));
            out["dataUrl"] = json!(data_url);
        }
        Ok(out)
    }

    fn write_cache_file(&self, cache_file: &Path, bytes: &[u8]) -> Result<(), String> {
        let dir = self.cache_dir();
        fs::create_dir_all(&dir).map_err(|e| format!("建缓存目录失败: {e}"))?;
        let tmp = cache_file.with_extension("wav.tmp");
        fs::write(&tmp, bytes).map_err(|e| format!("写缓存失败: {e}"))?;
        fs::rename(&tmp, cache_file).map_err(|e| format!("缓存落位失败: {e}"))?;
        // 超配额 → 全清 cache（v1 从简，items 音频在 library/audio 不受影响）
        if dir_stats_bytes(&dir) > CACHE_GC_QUOTA_BYTES {
            tracing::info!("[cap.voice] 缓存超配额，全清 cache/ 目录");
            let _ = fs::remove_dir_all(&dir);
            let _ = fs::create_dir_all(&dir);
        }
        Ok(())
    }

    // ── voices.* ──

    fn invoke_voices(&self, action: &str, payload: &Value) -> Result<Value, String> {
        match action {
            "voices.list" => {
                let state = self.lock_state()?;
                Ok(json!({ "ok": true, "voices": state.voices }))
            }
            "voices.presets" => {
                // 委托插件 list_voices（前端显式拉取 + 静态兜底，不随 list 高频调用）
                let reply = self
                    .synth
                    .invoke(
                        json!({
                            "action": "call",
                            "mcpServerId": self.engine_plugin,
                            "tool": "mimo_tts_list_voices",
                            "arguments": {},
                        }),
                        &BootstrapCtx,
                    )
                    .unwrap_or_else(|e| json!({ "ok": false, "error": e }));
                if reply.get("ok").and_then(Value::as_bool) == Some(true) {
                    if let Some(parsed) = parse_plugin_result(&reply) {
                        return Ok(json!({ "ok": true, "voices": parsed.get("voices").cloned().unwrap_or(json!([])) }));
                    }
                }
                Ok(json!({ "ok": false, "voices": [], "error": reply.get("error").and_then(Value::as_str).unwrap_or("预置音色拉取失败") }))
            }
            "voices.add" => {
                let kind = str_field(payload, "type").unwrap_or("design").to_string();
                let name = str_field(payload, "name").unwrap_or_default().trim().to_string();
                if name.is_empty() {
                    return Ok(json!({ "ok": false, "error": "name 不能为空" }));
                }
                let description = str_field(payload, "description").map(|s| s.trim().to_string());
                let kind = kind.to_string();
                if !(kind == "design" || kind == "clone") {
                    return Ok(json!({ "ok": false, "error": format!("不支持的音色类型: {kind}") }));
                }
                let voice = if kind == "clone" {
                    // 样本 base64 落盘 samples/<id>.<ext>（≤10MB 由前端/Echo 侧约束，此处防御截断）
                    let sample = str_field(payload, "sampleBase64").unwrap_or_default();
                    if sample.is_empty() {
                        return Ok(json!({ "ok": false, "error": "clone 音色缺 sampleBase64" }));
                    }
                    let ext = str_field(payload, "sampleName")
                        .and_then(|n| n.rsplit('.').next().map(|e| e.to_lowercase()))
                        .filter(|e| matches!(e.as_str(), "wav" | "mp3" | "flac" | "m4a" | "ogg"))
                        .unwrap_or_else(|| "wav".to_string());
                    let id = format!("cl-{}", now_ms());
                    let dir = self.samples_dir();
                    fs::create_dir_all(&dir).map_err(|e| format!("建样本目录失败: {e}"))?;
                    let file = format!("{id}.{ext}");
                    let bytes = data_url_decode(&sample).or_else(|| {
                        // 裸 base64（无 data: 前缀）兜底
                        use base64::Engine as _;
                        base64::engine::general_purpose::STANDARD.decode(sample.as_bytes()).ok()
                    });
                    let Some(bytes) = bytes else {
                        return Ok(json!({ "ok": false, "error": "样本 base64 解码失败" }));
                    };
                    if bytes.len() > 10 * 1024 * 1024 {
                        return Ok(json!({ "ok": false, "error": "样本超过 10MB 上限" }));
                    }
                    fs::write(dir.join(&file), bytes).map_err(|e| format!("样本写盘失败: {e}"))?;
                    CustomVoice {
                        id,
                        name,
                        kind,
                        engine: self.engine_plugin.clone(),
                        description: None,
                        sample_file: Some(file),
                        created_at: now_ms(),
                    }
                } else {
                    let Some(description) = description.filter(|d| !d.is_empty()) else {
                        return Ok(json!({ "ok": false, "error": "design 音色缺 description" }));
                    };
                    CustomVoice {
                        id: format!("dv-{}", now_ms()),
                        name,
                        kind,
                        engine: self.engine_plugin.clone(),
                        description: Some(description),
                        sample_file: None,
                        created_at: now_ms(),
                    }
                };
                let mut state = self.lock_state()?;
                state.voices.push(voice.clone());
                save_json(&self.root.join("voices.json"), &state.voices)?;
                Ok(json!({ "ok": true, "voice": voice }))
            }
            "voices.update" => {
                let voice_id = str_field(payload, "voiceId").unwrap_or_default().to_string();
                let mut state = self.lock_state()?;
                let Some(v) = state.voices.iter_mut().find(|v| v.id == voice_id) else {
                    return Ok(json!({ "ok": false, "error": format!("音色不存在: {voice_id}") }));
                };
                if let Some(n) = str_field(payload, "name").filter(|s| !s.trim().is_empty()) {
                    v.name = n.trim().to_string();
                }
                if let Some(d) = str_field(payload, "description") {
                    v.description = Some(d.trim().to_string());
                }
                let voice = v.clone();
                save_json(&self.root.join("voices.json"), &state.voices)?;
                Ok(json!({ "ok": true, "voice": voice }))
            }
            "voices.delete" => {
                let voice_id = str_field(payload, "voiceId").unwrap_or_default().to_string();
                let mut state = self.lock_state()?;
                let before = state.voices.len();
                let removed = state.voices.iter().find(|v| v.id == voice_id).cloned();
                state.voices.retain(|v| v.id != voice_id);
                if state.voices.len() == before {
                    return Ok(json!({ "ok": false, "error": format!("音色不存在: {voice_id}") }));
                }
                save_json(&self.root.join("voices.json"), &state.voices)?;
                // 级联删样本文件（索引已删，文件不删会成孤儿）
                if let Some(v) = removed {
                    if let Some(f) = v.sample_file {
                        let _ = fs::remove_file(self.samples_dir().join(f));
                    }
                }
                Ok(json!({ "ok": true }))
            }
            "voices.probe" => {
                // 试听：固定欢迎语合成。kind 决定委托工具（design/clone 现场参数，不入库）
                let kind = str_field(payload, "kind").unwrap_or("preset").to_string();
                let text = str_field(payload, "text").unwrap_or("你好，欢迎收听 Polaris 电台。").to_string();
                let (tool, arguments, tmp_sample) = match kind.as_str() {
                    "design" => {
                        let Some(description) = str_field(payload, "description").map(|s| s.to_string()).filter(|s| !s.is_empty()) else {
                            return Ok(json!({ "ok": false, "error": "试听缺少 description" }));
                        };
                        ("mimo_tts_voice_design".to_string(), json!({ "text": text, "description": description, "outputMode": "base64" }), None)
                    }
                    "clone" => {
                        let Some(sample_b64) = str_field(payload, "sampleBase64").map(|s| s.to_string()).filter(|s| !s.is_empty()) else {
                            return Ok(json!({ "ok": false, "error": "试听缺少 sampleBase64" }));
                        };
                        // clone 工具收路径/URL；现场样本走临时文件（试听不入库，用后即删）
                        let dir = self.samples_dir();
                        fs::create_dir_all(&dir).map_err(|e| format!("建样本目录失败: {e}"))?;
                        let ext = str_field(payload, "sampleName")
                            .and_then(|n| n.rsplit('.').next().map(|e| e.to_lowercase()))
                            .filter(|e| matches!(e.as_str(), "wav" | "mp3" | "flac" | "m4a" | "ogg"))
                            .unwrap_or_else(|| "wav".to_string());
                        let tmp_name = format!("probe-{}.{}", now_ms(), ext);
                        let bytes = data_url_decode(&sample_b64).or_else(|| {
                            use base64::Engine as _;
                            base64::engine::general_purpose::STANDARD.decode(sample_b64.as_bytes()).ok()
                        });
                        let Some(bytes) = bytes else {
                            return Ok(json!({ "ok": false, "error": "样本 base64 解码失败" }));
                        };
                        fs::write(dir.join(&tmp_name), bytes).map_err(|e| format!("临时样本写盘失败: {e}"))?;
                        let tmp_path = dir.join(&tmp_name);
                        (
                            "mimo_tts_voice_clone".to_string(),
                            json!({ "text": text, "sample": tmp_path.to_string_lossy(), "outputMode": "base64" }),
                            Some(tmp_path),
                        )
                    }
                    _ => {
                        let voice = str_field(payload, "voice").unwrap_or("冰糖").to_string();
                        // 自定义音色（id 命中库）按其存档 design/clone 参数现场试听；否则预置名透传
                        let (tool, mut arguments) = self.voice_tool_args(&voice, &text);
                        arguments["outputMode"] = json!("base64");
                        (tool, arguments, None)
                    }
                };
                let delegated = self.synth.invoke(
                    json!({ "action": "call", "mcpServerId": self.engine_plugin, "tool": tool, "arguments": arguments }),
                    &BootstrapCtx,
                );
                // 试听临时样本用后即删（无论委托成败）
                if let Some(tmp) = &tmp_sample {
                    let _ = fs::remove_file(tmp);
                }
                let reply = match delegated {
                    Ok(r) => r,
                    Err(e) => return Ok(json!({ "ok": false, "error": format!("试听委托失败: {e}") })),
                };
                if reply.get("ok").and_then(Value::as_bool) != Some(true) {
                    return Ok(json!({
                        "ok": false,
                        "error": reply.get("error").and_then(Value::as_str).unwrap_or("试听失败").to_string(),
                    }));
                }
                let Some(parsed) = parse_plugin_result(&reply) else {
                    return Ok(json!({ "ok": false, "error": "试听结果解析失败" }));
                };
                if parsed.get("success").and_then(Value::as_bool) != Some(true) {
                    return Ok(json!({
                        "ok": false,
                        "error": parsed.get("error").and_then(Value::as_str).unwrap_or("试听未成功").to_string(),
                    }));
                }
                let data_url = parsed.get("audioDataUrl").and_then(Value::as_str).unwrap_or("").to_string();
                if data_url.is_empty() {
                    return Ok(json!({ "ok": false, "error": "试听未返回音频" }));
                }
                Ok(json!({ "ok": true, "dataUrl": data_url }))
            }
            _ => Ok(json!({
                "ok": false,
                // 错误即文档：列出 voices 族合法动作 + cap.help 自查入口（contracts::unsupported_action）
                "error": unsupported_action(
                    VOICE_CAP_ID,
                    action,
                    &[
                        "voices.list",
                        "voices.presets",
                        "voices.add",
                        "voices.update",
                        "voices.delete",
                        "voices.probe",
                    ],
                ),
            })),
        }
    }

    // ── library.* ──

    fn invoke_library(&self, action: &str, payload: &Value) -> Result<Value, String> {
        match action {
            "library.list" => {
                let state = self.lock_state()?;
                let favorite_only = payload
                    .get("filter")
                    .and_then(|f| f.get("favorite"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let mut items: Vec<&LibraryItem> = state
                    .items
                    .iter()
                    .filter(|it| !favorite_only || it.favorite)
                    .collect();
                items.reverse(); // 新的在前
                Ok(json!({ "ok": true, "items": items }))
            }
            "library.add" => {
                let title = str_field(payload, "title").unwrap_or_default().trim().to_string();
                if title.is_empty() {
                    return Ok(json!({ "ok": false, "error": "title 不能为空" }));
                }
                let sentences: Vec<SentenceRef> = payload
                    .get("sentences")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|s| {
                                let text = s.get("text").and_then(Value::as_str)?.to_string();
                                Some(SentenceRef {
                                    text,
                                    audio_id: s.get("audioId").and_then(Value::as_str).map(|x| x.to_string()),
                                    file: s.get("file").and_then(Value::as_str).map(|x| x.to_string()),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                if sentences.is_empty() {
                    return Ok(json!({ "ok": false, "error": "sentences 不能为空" }));
                }
                // 音频资产自持：把句子 file 复制入 library/audio/<itemId>/<i>.wav
                let item_id = format!("it-{}", now_ms());
                let dest_dir = self.library_audio_dir().join(&item_id);
                let mut saved: Vec<SentenceRef> = Vec::with_capacity(sentences.len());
                let mut total = 0u64;
                for (i, s) in sentences.iter().enumerate() {
                    let mut out = SentenceRef {
                        text: s.text.clone(),
                        audio_id: s.audio_id.clone(),
                        file: None,
                    };
                    if let Some(f) = &s.file {
                        match fs::read(f) {
                            Ok(bytes) => {
                                if fs::create_dir_all(&dest_dir).is_ok() {
                                    let dest = dest_dir.join(format!("{i}.wav"));
                                    if fs::write(&dest, &bytes).is_ok() {
                                        out.file = Some(dest.to_string_lossy().to_string());
                                        total += bytes.len() as u64;
                                    }
                                }
                            }
                            Err(_) => tracing::warn!("[cap.voice] library.add 句 {i} 源音频缺失，仅记文本"),
                        }
                    }
                    saved.push(out);
                }
                let item = LibraryItem {
                    id: item_id,
                    title,
                    topic: str_field(payload, "topic").unwrap_or_default().to_string(),
                    engine: str_field(payload, "engine").unwrap_or(&self.engine_plugin).to_string(),
                    voice_ref: str_field(payload, "voiceRef").unwrap_or_default().to_string(),
                    style: str_field(payload, "style").map(|s| s.to_string()),
                    created_at: now_ms(),
                    favorite: false,
                    tags: payload
                        .get("tags")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter_map(Value::as_str).map(|x| x.to_string()).collect())
                        .unwrap_or_default(),
                    source: str_field(payload, "source").unwrap_or("live").to_string(),
                    sentences: saved,
                    size_bytes: total,
                };
                let mut state = self.lock_state()?;
                state.items.push(item.clone());
                save_json(&self.root.join("library.json"), &state.items)?;
                Ok(json!({ "ok": true, "item": item }))
            }
            "library.get" => {
                let item_id = str_field(payload, "itemId").unwrap_or_default().to_string();
                let state = self.lock_state()?;
                match state.items.iter().find(|it| it.id == item_id) {
                    Some(it) => Ok(json!({ "ok": true, "item": it })),
                    None => Ok(json!({ "ok": false, "error": format!("单集不存在: {item_id}") })),
                }
            }
            "library.update" => {
                let item_id = str_field(payload, "itemId").unwrap_or_default().to_string();
                let mut state = self.lock_state()?;
                let Some(it) = state.items.iter_mut().find(|it| it.id == item_id) else {
                    return Ok(json!({ "ok": false, "error": format!("单集不存在: {item_id}") }));
                };
                if let Some(t) = str_field(payload, "title").filter(|s| !s.trim().is_empty()) {
                    it.title = t.trim().to_string();
                }
                if let Some(f) = payload.get("favorite").and_then(Value::as_bool) {
                    it.favorite = f;
                }
                if let Some(tags) = payload.get("tags").and_then(Value::as_array) {
                    it.tags = tags.iter().filter_map(Value::as_str).map(|x| x.to_string()).collect();
                }
                let item = it.clone();
                save_json(&self.root.join("library.json"), &state.items)?;
                Ok(json!({ "ok": true, "item": item }))
            }
            "library.delete" => {
                let item_id = str_field(payload, "itemId").unwrap_or_default().to_string();
                let mut state = self.lock_state()?;
                let before = state.items.len();
                state.items.retain(|it| it.id != item_id);
                if state.items.len() == before {
                    return Ok(json!({ "ok": false, "error": format!("单集不存在: {item_id}") }));
                }
                save_json(&self.root.join("library.json"), &state.items)?;
                // 删音频目录（索引已删，资产不删会积垃圾）
                let _ = fs::remove_dir_all(self.library_audio_dir().join(&item_id));
                Ok(json!({ "ok": true }))
            }
            "library.stats" => {
                let state = self.lock_state()?;
                let total_bytes: u64 = state.items.iter().map(|it| it.size_bytes).sum();
                let cache_bytes = dir_stats_bytes(&self.cache_dir());
                Ok(json!({
                    "ok": true,
                    "count": state.items.len(),
                    "totalBytes": total_bytes,
                    "cacheBytes": cache_bytes,
                }))
            }
            _ => Ok(json!({
                "ok": false,
                // 错误即文档：列出 library 族合法动作 + cap.help 自查入口（contracts::unsupported_action）
                "error": unsupported_action(
                    VOICE_CAP_ID,
                    action,
                    &[
                        "library.list",
                        "library.add",
                        "library.get",
                        "library.update",
                        "library.delete",
                        "library.stats",
                    ],
                ),
            })),
        }
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, VoiceState>, String> {
        self.state.lock().map_err(|_| "cap.voice 内部锁中毒".to_string())
    }
}

/// Bootstrap 上下文占位：voices.presets / voices.probe 的内部委托走 synthGate 复核
/// （SynthCapability invoke 只用 source + 插件 gate），此空 ctx 仅作参数形状。
struct BootstrapCtx;

impl Context for BootstrapCtx {
    fn resolve_cap(&self, _id: &CapabilityId) -> Result<Value, String> {
        Err("not implemented".into())
    }
    fn storage(&self) -> Result<&dyn crate::contracts::Storage, String> {
        Err("not implemented".into())
    }
    fn check_permission(
        &self,
        _req: &crate::contracts::PermissionRequest,
    ) -> Result<crate::contracts::PermissionVerdict, String> {
        Ok(crate::contracts::PermissionVerdict::Allow)
    }
    fn source(&self) -> &Source {
        static BOOT: Source = Source::Bootstrap;
        &BOOT
    }
    fn caller_id(&self) -> &crate::contracts::PluginId {
        static PID: &str = "core";
        static PLUGIN_ID: std::sync::OnceLock<crate::contracts::PluginId> = std::sync::OnceLock::new();
        PLUGIN_ID.get_or_init(|| crate::contracts::PluginId(PID.into()))
    }
    fn plugin_config(&self) -> Result<Value, String> {
        Ok(Value::Null)
    }
}

// ── 小工具 ──

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// 解析 cap.mcp 回复中的 resultJson（插件 JSON.stringify 的字符串）。
fn parse_plugin_result(reply: &Value) -> Option<Value> {
    reply
        .get("resultJson")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
}

/// `data:audio/wav;base64,xxx` → 字节；裸 base64 也接受。
fn data_url_decode(s: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    let payload = s.split_once(',').map(|(_, p)| p).unwrap_or(s);
    base64::engine::general_purpose::STANDARD.decode(payload.trim()).ok()
}

fn file_to_data_url(path: &Path) -> String {
    match fs::read(path) {
        Ok(bytes) => {
            use base64::Engine as _;
            format!(
                "data:audio/wav;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )
        }
        Err(_) => String::new(),
    }
}

/// 目录字节总量（一层).cache GC / stats 用。
fn dir_stats_bytes(dir: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(rd) = fs::read_dir(dir) {
        for entry in rd.flatten() {
            if let Ok(md) = entry.metadata() {
                if md.is_file() {
                    total += md.len();
                }
            }
        }
    }
    total
}

impl Capability for VoiceCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(VOICE_CAP_ID.into())
    }

    /// 依赖镜像：合成委托 cap.mcp（装配层同一实例注入，非运行期总线解析）。
    fn dependencies(&self) -> Vec<CapabilityId> {
        vec![CapabilityId("cap.mcp".into())]
    }

    /// 能力自描述（cap.help 索引）。
    ///
    /// describe 一律经 standard_describe 构造（2026-10-25 审计：旧手写顶层
    /// "id"/"description" 键与其余能力 "summary" 键两套口径）。逐条对齐实现：
    /// - synthesize 的 voiceRef 实际可省（缺省"冰糖"）。
    /// - voices.add 的 type 实际可省（缺省 design）。
    /// - voices.probe 的 kind 实际可省（缺省 preset）。
    /// - library.add 实现接受可选 tags: string[]。
    fn describe(&self) -> Value {
        standard_describe(
            VOICE_CAP_ID,
            "语音电台",
            "语义化语音能力：合成（带持久缓存）/ 音色库（design/clone 参数持久化）/ 内容库（播报资产与续播）",
            Some("权限对齐 cap.mcp（仅本地或携带有效 token 的 Remote）。合成结果落持久缓存（key=FNV-1a(engine|voiceRef|style|text)，跨重启命中零 API 成本）；library.add 复制句子音频入内容库自持，voices.delete / library.delete 级联删样本/音频资产"),
            json!({
                "synthesize": { "params": { "text": "string（必填）", "voiceRef?": "string（预置名或自定义音色id，缺省 \"冰糖\"）", "style?": "string", "outputMode?": "'file'|'base64'（缺省 file）" }, "returns": "{ ok, audioId, cached, format, sizeBytes, file?, dataUrl? }（base64 模式才有 dataUrl）" },
                "voices.presets": { "params": {}, "returns": "{ ok, voices } 或 { ok: false, voices: [], error }" },
                "voices.list": { "params": {}, "returns": "{ ok, voices: CustomVoice[] }（仅自定义音色，预置音色经 voices.presets 拉取）" },
                "voices.add": { "params": { "type?": "'design'|'clone'（缺省 design）", "name": "string（必填）", "description?": "design 必填：音色描述文本", "sampleBase64?": "clone 必填：样本 base64（≤10MB）", "sampleName?": "string（推断样本扩展名）" }, "returns": "{ ok, voice: CustomVoice }" },
                "voices.update": { "params": { "voiceId": "string（必填）", "name?": "string", "description?": "string" }, "returns": "{ ok, voice: CustomVoice }" },
                "voices.delete": { "params": { "voiceId": "string（必填）" }, "returns": "{ ok }（级联删样本文件）" },
                "voices.probe": { "params": { "kind?": "'preset'|'design'|'clone'（缺省 preset）", "voice?": "string（kind=preset 时，预置名或自定义音色id，缺省 \"冰糖\"）", "description?": "string（kind=design 必填）", "sampleBase64?": "string（kind=clone 必填）", "sampleName?": "string", "text?": "string（缺省固定欢迎语）" }, "returns": "{ ok, dataUrl }（试听不入库，临时样本用后即删）" },
                "library.list": { "params": { "filter?": "{ favorite?: bool }" }, "returns": "{ ok, items: LibraryItem[] }（新的在前）" },
                "library.add": { "params": { "title": "string（必填）", "topic?": "string", "engine?": "string（缺省 mimo-tts）", "voiceRef?": "string", "style?": "string", "source?": "string（缺省 live）", "tags?": "string[]", "sentences": "[{ text, audioId?, file? }]（必填，至少一句）" }, "returns": "{ ok, item: LibraryItem }（句子 file 已复制入内容库）" },
                "library.get": { "params": { "itemId": "string（必填）" }, "returns": "{ ok, item: LibraryItem } 或 { ok: false, error }" },
                "library.update": { "params": { "itemId": "string（必填）", "title?": "string", "favorite?": "bool", "tags?": "string[]" }, "returns": "{ ok, item: LibraryItem }" },
                "library.delete": { "params": { "itemId": "string（必填）" }, "returns": "{ ok }（级联删音频目录）" },
                "library.stats": { "params": {}, "returns": "{ ok, count, totalBytes, cacheBytes }" },
            }),
        )
    }

    fn invoke(&self, payload: Value, ctx: &dyn Context) -> Result<Value, String> {
        if let Err(deny) = Self::gate(&payload, ctx) {
            return Ok(deny);
        }
        let action = payload.get("action").and_then(Value::as_str).unwrap_or("").to_string();
        match action.as_str() {
            "synthesize" => self.invoke_synthesize(&payload, ctx),
            a if a.starts_with("voices.") => self.invoke_voices(&action, &payload),
            a if a.starts_with("library.") => self.invoke_library(&action, &payload),
            // 缺 action 单独点名（缺省空串落未知分支会出现「不支持动作: 」空动作名）
            "" => Ok(json!({
                "ok": false,
                "error": "cap.voice 需要 action 参数（synthesize / voices.* / library.*，协议见 cap.help show target=cap.voice）",
            })),
            _ => Ok(json!({
                "ok": false,
                // 错误即文档：顶层未知动作给动作族提示（voices.* / library.* 再细分），
                // 2026-10-25 审计：13 个动作不列族只能再查 cap_list 恢复
                "error": unsupported_action(
                    VOICE_CAP_ID,
                    &action,
                    &[
                        "synthesize",
                        "voices.*（list/presets/add/update/delete/probe）",
                        "library.*（list/add/get/update/delete/stats）",
                    ],
                ),
            })),
        }
    }
}

// ── 测试（本机 cargo test --lib 受 Tauri DLL 限制不跑，CI 执行；cargo check 保编译）──

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 测试 Context（可编程 source），对齐 mcp_capability tests。
    struct TestCtx {
        source: Source,
    }
    impl Context for TestCtx {
        fn resolve_cap(&self, _id: &CapabilityId) -> Result<Value, String> {
            Err("not implemented".into())
        }
        fn storage(&self) -> Result<&dyn crate::contracts::Storage, String> {
            Err("not implemented".into())
        }
        fn check_permission(
            &self,
            _req: &crate::contracts::PermissionRequest,
        ) -> Result<crate::contracts::PermissionVerdict, String> {
            Ok(crate::contracts::PermissionVerdict::Allow)
        }
        fn source(&self) -> &Source {
            &self.source
        }
        fn caller_id(&self) -> &crate::contracts::PluginId {
            static PID: &str = "test";
            static PLUGIN_ID: std::sync::OnceLock<crate::contracts::PluginId> = std::sync::OnceLock::new();
            PLUGIN_ID.get_or_init(|| crate::contracts::PluginId(PID.into()))
        }
        fn plugin_config(&self) -> Result<Value, String> {
            Ok(Value::Null)
        }
    }

    /// fake 合成能力：固定返回插件形态 resultJson（file 模式写临时文件）。
    struct FakeSynth {
        calls: Mutex<usize>,
        fail: Mutex<bool>,
    }
    impl FakeSynth {
        fn new() -> Arc<Self> {
            Arc::new(Self { calls: Mutex::new(0), fail: Mutex::new(false) })
        }
        fn call_count(&self) -> usize {
            *self.calls.lock().unwrap()
        }
        fn set_fail(&self, v: bool) {
            *self.fail.lock().unwrap() = v;
        }
    }
    impl Capability for FakeSynth {
        fn id(&self) -> CapabilityId {
            CapabilityId("cap.mcp".into())
        }
        fn dependencies(&self) -> Vec<CapabilityId> {
            Vec::new()
        }
        fn describe(&self) -> Value {
            json!({})
        }
        fn invoke(&self, _payload: Value, _ctx: &dyn Context) -> Result<Value, String> {
            *self.calls.lock().unwrap() += 1;
            if *self.fail.lock().unwrap() {
                return Ok(json!({ "ok": false, "error": "synth down" }));
            }
            // 就近写一个假 wav（合成产物）
            let dir = std::env::temp_dir().join(format!("polaris-voice-fake-{}", now_ms()));
            let _ = fs::create_dir_all(&dir);
            let file = dir.join("fake.wav");
            let _ = fs::write(&file, b"RIFF-fake-audio-bytes");
            Ok(json!({
                "ok": true,
                "resultJson": json!({
                    "success": true,
                    "format": "wav",
                    "file": file.to_string_lossy(),
                    "sizeBytes": 20,
                }).to_string(),
            }))
        }
    }

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("polaris-voice-cap-test-{tag}-{}", now_ms()));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    fn boot_ctx() -> TestCtx {
        TestCtx { source: Source::Bootstrap }
    }

    #[test]
    fn remote_empty_token_denied() {
        let cap = VoiceCapability::new(temp_root("gate"), FakeSynth::new());
        let ctx = TestCtx { source: Source::Remote { token: String::new() } };
        let reply = cap
            .invoke(json!({ "action": "synthesize", "text": "hi" }), &ctx)
            .unwrap();
        assert_eq!(reply["ok"], false);
        assert!(reply["error"].as_str().unwrap().contains("token"));
    }

    #[test]
    fn remote_with_token_passes_gate() {
        let cap = VoiceCapability::new(temp_root("gate2"), FakeSynth::new());
        let ctx = TestCtx { source: Source::Remote { token: "t".into() } };
        let reply = cap
            .invoke(json!({ "action": "library.stats" }), &ctx)
            .unwrap();
        assert_eq!(reply["ok"], true, "带 token 的 Remote 应放行: {reply}");
    }

    #[test]
    fn synthesize_caches_across_calls() {
        let synth = FakeSynth::new();
        let root = temp_root("cache");
        let cap = VoiceCapability::new(root, synth.clone());
        let ctx = boot_ctx();
        let first = cap
            .invoke(json!({ "action": "synthesize", "text": "第一句", "voiceRef": "冰糖" }), &ctx)
            .unwrap();
        assert_eq!(first["ok"], true);
        assert_eq!(first["cached"], false);
        assert!(first["file"].as_str().unwrap().contains("cache"));
        // 缓存文件落盘（可靠证缓存内容存在）
        assert!(Path::new(first["file"].as_str().unwrap()).exists());
        let second = cap
            .invoke(json!({ "action": "synthesize", "text": "第一句", "voiceRef": "冰糖" }), &ctx)
            .unwrap();
        assert_eq!(second["cached"], true, "第二次应命中缓存: {second}");
        assert_eq!(synth.call_count(), 1, "缓存命中不应再委托合成");
        // 不同参数 → 不同 key → 再合成一次
        let _ = cap
            .invoke(json!({ "action": "synthesize", "text": "第一句", "voiceRef": "茉莉" }), &ctx)
            .unwrap();
        assert_eq!(synth.call_count(), 2);
    }

    #[test]
    fn synthesize_delegation_failure_forwarded() {
        let synth = FakeSynth::new();
        synth.set_fail(true);
        let cap = VoiceCapability::new(temp_root("fail"), synth);
        let reply = cap
            .invoke(json!({ "action": "synthesize", "text": "hi" }), &boot_ctx())
            .unwrap();
        assert_eq!(reply["ok"], false);
        assert!(reply["error"].as_str().unwrap().contains("synth down"));
    }

    #[test]
    fn voices_crud_roundtrip_persists() {
        let root = temp_root("voices");
        let cap = VoiceCapability::new(root.clone(), FakeSynth::new());
        let ctx = boot_ctx();
        // add design
        let add = cap
            .invoke(
                json!({ "action": "voices.add", "type": "design", "name": "说书人", "description": "低沉的说书人嗓音" }),
                &ctx,
            )
            .unwrap();
        assert_eq!(add["ok"], true, "{add}");
        let vid = add["voice"]["id"].as_str().unwrap().to_string();
        // list
        let list = cap.invoke(json!({ "action": "voices.list" }), &ctx).unwrap();
        assert_eq!(list["voices"].as_array().unwrap().len(), 1);
        // update
        let up = cap
            .invoke(json!({ "action": "voices.update", "voiceId": vid, "name": "说书先生" }), &ctx)
            .unwrap();
        assert_eq!(up["voice"]["name"], "说书先生");
        // 新实例从磁盘恢复（持久化验证）
        let cap2 = VoiceCapability::new(root.clone(), FakeSynth::new());
        let list2 = cap2.invoke(json!({ "action": "voices.list" }), &ctx).unwrap();
        assert_eq!(list2["voices"].as_array().unwrap().len(), 1);
        // delete 级联
        let del = cap2
            .invoke(json!({ "action": "voices.delete", "voiceId": vid }), &ctx)
            .unwrap();
        assert_eq!(del["ok"], true);
        let list3 = cap2.invoke(json!({ "action": "voices.list" }), &ctx).unwrap();
        assert_eq!(list3["voices"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn voices_clone_saves_sample_and_deletes_file() {
        let root = temp_root("clone");
        let cap = VoiceCapability::new(root.clone(), FakeSynth::new());
        let ctx = boot_ctx();
        // "RIFF" 的 base64 = UklGRg==
        let add = cap
            .invoke(
                json!({ "action": "voices.add", "type": "clone", "name": "我的声音", "sampleBase64": "data:audio/wav;base64,UklGRg==" }),
                &ctx,
            )
            .unwrap();
        assert_eq!(add["ok"], true, "{add}");
        let sample = add["voice"]["sampleFile"].as_str().unwrap().to_string();
        assert!(root.join("samples").join(&sample).exists(), "样本应落盘");
        let vid = add["voice"]["id"].as_str().unwrap().to_string();
        let _ = cap.invoke(json!({ "action": "voices.delete", "voiceId": vid }), &ctx);
        assert!(!root.join("samples").join(&sample).exists(), "删除应级联删样本");
    }

    #[test]
    fn library_crud_and_stats() {
        let root = temp_root("lib");
        let synth = FakeSynth::new();
        let cap = VoiceCapability::new(root.clone(), synth.clone());
        let ctx = boot_ctx();
        // 先合成两句拿 file
        let s1 = cap
            .invoke(json!({ "action": "synthesize", "text": "句一" }), &ctx)
            .unwrap();
        let f1 = s1["file"].as_str().unwrap().to_string();
        let s2 = cap
            .invoke(json!({ "action": "synthesize", "text": "句二" }), &ctx)
            .unwrap();
        let f2 = s2["file"].as_str().unwrap().to_string();
        // 入库
        let add = cap
            .invoke(
                json!({
                    "action": "library.add",
                    "title": "经济学基础 · 第 1 段",
                    "topic": "经济学基础",
                    "voiceRef": "冰糖",
                    "source": "live",
                    "sentences": [
                        { "text": "句一", "file": f1 },
                        { "text": "句二", "file": f2 },
                    ],
                }),
                &ctx,
            )
            .unwrap();
        assert_eq!(add["ok"], true, "{add}");
        let item_id = add["item"]["id"].as_str().unwrap().to_string();
        // 音频资产自持（复制进 library/audio）
        let saved_file = add["item"]["sentences"][0]["file"].as_str().unwrap();
        assert!(saved_file.contains("library"), "应复制进 library/audio: {saved_file}");
        assert!(Path::new(saved_file).exists());
        // get / list
        let got = cap.invoke(json!({ "action": "library.get", "itemId": item_id }), &ctx).unwrap();
        assert_eq!(got["item"]["title"], "经济学基础 · 第 1 段");
        // update favorite
        let up = cap
            .invoke(json!({ "action": "library.update", "itemId": item_id, "favorite": true }), &ctx)
            .unwrap();
        assert_eq!(up["item"]["favorite"], true);
        // list + favorite filter
        let list = cap.invoke(json!({ "action": "library.list" }), &ctx).unwrap();
        assert_eq!(list["items"].as_array().unwrap().len(), 1);
        let list_fav = cap
            .invoke(json!({ "action": "library.list", "filter": { "favorite": true } }), &ctx)
            .unwrap();
        assert_eq!(list_fav["items"].as_array().unwrap().len(), 1);
        // stats
        let stats = cap.invoke(json!({ "action": "library.stats" }), &ctx).unwrap();
        assert_eq!(stats["count"], 1);
        assert!(stats["cacheBytes"].as_u64().unwrap() > 0);
        // delete 级联删目录
        let del = cap
            .invoke(json!({ "action": "library.delete", "itemId": item_id }), &ctx)
            .unwrap();
        assert_eq!(del["ok"], true);
        assert!(!root.join("library").join("audio").join(&item_id).exists());
        let list2 = cap.invoke(json!({ "action": "library.list" }), &ctx).unwrap();
        assert_eq!(list2["items"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn fnv1a_stable_across_instances() {
        // 同参数跨调用稳定（磁盘缓存 key 的前提）
        let a = fnv1a("mimo-tts|冰糖||第一句");
        let b = fnv1a("mimo-tts|冰糖||第一句");
        assert_eq!(a, b);
        assert_ne!(a, fnv1a("mimo-tts|茉莉||第一句"));
        assert!(a.contains('_'), "应带长度后缀: {a}");
    }

    #[test]
    fn unknown_action_lists_action_families() {
        let cap = VoiceCapability::new(temp_root("unknown"), FakeSynth::new());
        let ctx = boot_ctx();
        // 顶层未知动作：动作族提示 + cap.help 自查入口（contracts::unsupported_action）
        let reply = cap.invoke(json!({ "action": "sing" }), &ctx).unwrap();
        let err = reply["error"].as_str().unwrap();
        assert!(err.contains("synthesize"), "应列动作族: {err}");
        assert!(err.contains("cap.help show target=cap.voice"), "应附自查入口: {err}");
        // 缺 action 单独点名
        let reply = cap.invoke(json!({}), &ctx).unwrap();
        assert!(
            reply["error"].as_str().unwrap().contains("需要 action 参数"),
            "缺 action 应单独点名: {reply}"
        );
    }

    #[test]
    fn describe_contract() {
        // describe 契约校验（contracts::validate_describe）：顶层键白名单 + 每动作 params/returns 齐全
        let cap = VoiceCapability::new(temp_root("describe"), FakeSynth::new());
        let problems = crate::contracts::validate_describe(VOICE_CAP_ID, &cap.describe());
        assert!(problems.is_empty(), "cap.voice describe 契约违例: {problems:?}");
        // 审计修正回归：顶层口径为 summary，13 个动作全量在册
        let d = cap.describe();
        assert_eq!(d["id"], VOICE_CAP_ID);
        assert_eq!(d["name"], "语音电台");
        assert!(d.get("description").is_none(), "不得残留旧 description 键");
        let actions = d["actions"].as_object().unwrap();
        assert_eq!(actions.len(), 13, "动作清单: {actions:?}");
        assert!(actions.contains_key("library.add"));
        assert!(
            actions["library.add"]["params"].get("tags?").is_some(),
            "library.add 应补 tags 参数: {actions:?}"
        );
    }
}
