//! 历史对话存储 Tauri 命令
//!
//! 把对话从浏览器 OPFS 搬到磁盘 jsonl，统一接管在 `<DataRoot>/dialogs/` 下。
//!
//! 文件命名：`<externalId>.jsonl`（externalId 由前端清洗为 `[a-zA-Z0-9._-]+`）。
//! 写入策略：原子写入（唯一后缀 `*.tmp` → sync → rename），避免崩溃时半截 jsonl；
//! 详见 `dialog_write_inner` 的根因注释。

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use serde_json::Value;

use crate::error::{AppError, Result};
use crate::services::data_root::data_root;

const DIALOG_FILE_EXT: &str = ".jsonl";
const MAX_NAME_LEN: usize = 255;

/// 列表 meta 条目：文件名 + 该文件首行(DialogMeta JSON 字符串)。
/// 仅读首行 → 会话列表无需把整份 jsonl(可能数 MB)读进内存/走 IPC。
#[derive(Serialize)]
pub struct DialogMetaEntry {
    pub name: String,
    #[serde(rename = "metaLine")]
    pub meta_line: String,
}

fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > MAX_NAME_LEN {
        return Err(AppError::ValidationError(format!(
            "对话文件名长度非法: {} 字节",
            name.len()
        )));
    }
    if !name.ends_with(DIALOG_FILE_EXT) {
        return Err(AppError::ValidationError(format!(
            "对话文件名必须以 {} 结尾",
            DIALOG_FILE_EXT
        )));
    }
    let stem = name.trim_end_matches(DIALOG_FILE_EXT);
    if stem.is_empty() {
        return Err(AppError::ValidationError(
            "对话文件名 stem 为空".to_string(),
        ));
    }
    if !stem
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return Err(AppError::ValidationError(
            "对话文件名仅允许 [a-zA-Z0-9._-]".to_string(),
        ));
    }
    // 防 path traversal
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err(AppError::ValidationError(
            "对话文件名禁止路径分隔符".to_string(),
        ));
    }
    Ok(())
}

fn dialogs_dir() -> Result<PathBuf> {
    let dir = data_root().dialogs_dir();
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn dialog_path(name: &str) -> Result<PathBuf> {
    validate_name(name)?;
    Ok(dialogs_dir()?.join(name))
}

// ============================================================================
// inner 实现（共享给 IPC dispatch）
// ============================================================================

pub fn dialog_list_inner() -> Result<Vec<String>> {
    let dir = dialogs_dir()?;
    let mut names: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            if let Some(name) = e.file_name().to_str() {
                if name.ends_with(DIALOG_FILE_EXT) {
                    names.push(name.to_string());
                }
            }
        }
    }
    Ok(names)
}

pub fn dialog_read_inner(name: &str) -> Result<Option<String>> {
    let p = dialog_path(name)?;
    if !p.exists() {
        return Ok(None);
    }
    Ok(Some(fs::read_to_string(&p)?))
}

/// 高效列举:仅读取每个 jsonl 文件的**首行**(DialogMeta),不加载消息体。
/// 会话越大收益越明显(几十 MB 的历史文件只读几百字节)。
pub fn dialog_list_meta_inner() -> Result<Vec<DialogMetaEntry>> {
    let dir = dialogs_dir()?;
    // 顺带回收崩溃遗留的 tmp（列表是历史面板的常规入口，低频且非关键路径）
    sweep_stale_tmp_files(&dir);
    let mut out: Vec<DialogMetaEntry> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            let name = match e.file_name().to_str() {
                Some(n) if n.ends_with(DIALOG_FILE_EXT) => n.to_string(),
                _ => continue,
            };
            let file = match fs::File::open(e.path()) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let mut reader = BufReader::new(file);
            let mut first_line = String::new();
            match reader.read_line(&mut first_line) {
                Ok(0) => continue, // 空文件
                Ok(_) => {
                    let trimmed = first_line.trim_end_matches(['\n', '\r']).to_string();
                    if !trimmed.is_empty() {
                        out.push(DialogMetaEntry {
                            name,
                            meta_line: trimmed,
                        });
                    }
                }
                Err(_) => continue,
            }
        }
    }
    Ok(out)
}

/// 全局 JSONL 写锁：同一后端进程内的全部写者（前端整写/合并写、后端归档、
/// WAL 追加）在此串行，消除「读-合并-写」交错导致的逻辑丢更新
/// （阶段 1A⑥，plans/jsonl-single-writer-spec.md §1）。
/// 方案 A 拓扑下所有前端写都经本进程（Tauri IPC / Web HTTP 同一入口），
/// 进程内锁即全局锁；写路径低频（轮末），单全局锁足够，不做 per-file 分片。
static DIALOG_WRITE_LOCK: Mutex<()> = Mutex::new(());

fn lock_dialog_write() -> std::sync::MutexGuard<'static, ()> {
    // 投毒只发生在持锁线程 panic 时；写互斥不承载需要毒化保护的不变式
    DIALOG_WRITE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn dialog_write_inner(name: &str, content: &str) -> Result<()> {
    let _guard = lock_dialog_write();
    dialog_write_locked(name, content)
}

/// 无锁原子写（唯一 tmp + sync + rename）。调用方必须已持 `DIALOG_WRITE_LOCK`。
fn dialog_write_locked(name: &str, content: &str) -> Result<()> {
    let target = dialog_path(name)?;
    let parent = target
        .parent()
        .ok_or_else(|| AppError::ConfigError("无法解析对话目录".to_string()))?;
    fs::create_dir_all(parent)?;
    // 根因修复（2026-10-24，审计 2.4/2.5）：
    // 1) tmp 曾固定为 `{name}.tmp`——前端轮末整写与后端 archive_conversation 整写
    //    走同一 `dialog_write_inner`（同进程多线程），共用同一 tmp 名会互相覆写
    //    半截文件。改为唯一后缀（pid + 单调序号），双写者互不干扰；
    // 2) 写后 `sync_data` 刷盘——此前无 fsync，崩溃/断电时 rename 可能落空文件；
    // 3) rename 先试原子覆盖（POSIX 语义；目标不存在时 Windows 也成功），失败
    //    再退回 remove+rename 重试环，把「文件不存在」窗口压到最短。
    //    已知边界：Windows 上 remove→rename 间仍有微小窗口，事务级替换需
    //    ReplaceFileW，留待后续批次。
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!("{}.{}.{}.tmp", name, std::process::id(), seq));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_data()?;
    }
    let rename_result = (|| -> Result<()> {
        if fs::rename(&tmp, &target).is_err() {
            if target.exists() {
                fs::remove_file(&target)?;
            }
            fs::rename(&tmp, &target)?;
        }
        Ok(())
    })();
    if rename_result.is_err() {
        // rename 失败清理自己的 tmp 不留垃圾（崩溃遗留的由 sweep_stale_tmp 兜底）
        let _ = fs::remove_file(&tmp);
        rename_result?;
    }
    // 索引维护（尽力而为，绝不阻塞主写路径）
    crate::services::dialog_index::on_self_write(name, content);
    Ok(())
}

/// 回收崩溃遗留的 tmp 文件（审计 2.5：tmp 残留无任何回收逻辑，dialog_list 只认
/// `.jsonl`，残留文件永远躺在目录里）。只删修改时间早于 1 小时的 `*.tmp`，
/// 避免误删并发写者刚创建的 tmp（唯一后缀后并发 tmp 同样以 .tmp 结尾）。
fn sweep_stale_tmp_files(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(3600))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(n) = file_name.to_str() else { continue };
        if !n.ends_with(".tmp") {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if modified < cutoff {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
}

/// 增量追加消息行（WAL 式崩溃保护）。
///
/// - 文件不存在：用 `meta_line` 建档后写入（原子写）；缺 meta 报错。
/// - 文件已存在：直接 append；若文件末尾无换行（旧版 serialize 不带尾换行），先补 `\n`。
///
/// 追加的行必须是单行 JSON（含 `\n` 会破坏 JSONL 结构，直接拒绝）。
/// meta 行的 messageCount/updatedAt 允许暂时陈旧——轮末的整体覆写（consolidation）会规整。
pub fn dialog_append_inner(name: &str, meta_line: Option<&str>, lines: &[String]) -> Result<()> {
    if lines.is_empty() {
        return Ok(());
    }
    for l in lines {
        if l.contains('\n') {
            return Err(AppError::ValidationError(
                "追加行不允许包含换行符".to_string(),
            ));
        }
    }

    // WAL 追加与整写/合并写同锁串行（spec §1）
    let _guard = lock_dialog_write();
    let target = dialog_path(name)?;
    let parent = target
        .parent()
        .ok_or_else(|| AppError::ConfigError("无法解析对话目录".to_string()))?;
    fs::create_dir_all(parent)?;

    if !target.exists() {
        let meta = meta_line.ok_or_else(|| {
            AppError::ValidationError("首次追加缺少 meta 行".to_string())
        })?;
        let mut content = String::new();
        content.push_str(meta.trim());
        content.push('\n');
        for l in lines {
            content.push_str(l);
            content.push('\n');
        }
        let tmp = parent.join(format!("{}.tmp", name));
        fs::write(&tmp, content)?;
        fs::rename(&tmp, &target)?;
        crate::services::dialog_index::on_self_append(name, meta_line, lines);
        return Ok(());
    }

    use std::io::{Read, Seek, SeekFrom, Write};
    let mut file = fs::OpenOptions::new()
        .read(true)
        .append(true)
        .open(&target)?;
    let len = file.metadata()?.len();
    let mut needs_nl = false;
    if len > 0 {
        let mut buf = [0u8; 1];
        file.seek(SeekFrom::Start(len - 1))?;
        file.read_exact(&mut buf)?;
        needs_nl = buf[0] != b'\n';
    }
    let mut payload = String::new();
    if needs_nl {
        payload.push('\n');
    }
    for l in lines {
        payload.push_str(l);
        payload.push('\n');
    }
    file.write_all(payload.as_bytes())?;
    crate::services::dialog_index::on_self_append(name, meta_line, lines);
    Ok(())
}

/// 分页读取结果：meta 行 + 按 seq 升序的一页消息行（原始 JSON 字符串，前端只 parse 本页）。
#[derive(Serialize)]
pub struct DialogPage {
    #[serde(rename = "metaLine")]
    pub meta_line: String,
    /// 本页消息行（seq 升序）
    pub lines: Vec<String>,
    /// 消息行总数
    pub total: usize,
    /// 本页之前是否还有更早的消息
    #[serde(rename = "hasMore")]
    pub has_more: bool,
}

/// 行探测：只反序列化 type/seq 两个字段，避免构建完整 Value 树。
#[derive(serde::Deserialize)]
struct LineProbe {
    #[serde(rename = "type")]
    kind: String,
    seq: Option<i64>,
}

/// 尾部优先分页读取：返回 seq < `before_seq`（缺省为全部）中最新的 `limit` 条。
///
/// 大会话（数 MB JSONL）恢复时只读尾页，前端无需整份 parse。
/// 行按 seq 排序（与前端 parseDialog 同规则：缺 seq 的按出现顺序兜底），容忍行序错乱。
pub fn dialog_read_page_inner(
    name: &str,
    before_seq: Option<i64>,
    limit: usize,
) -> Result<Option<DialogPage>> {
    let p = dialog_path(name)?;
    if !p.exists() {
        return Ok(None);
    }
    let limit = limit.clamp(1, 1000);

    let file = fs::File::open(&p)?;
    let reader = BufReader::new(file);

    let mut meta_line: Option<String> = None;
    // (seq, 原始行)
    let mut msg_lines: Vec<(i64, String)> = Vec::new();
    let mut fallback_seq: i64 = 0;

    for line in reader.lines().map_while(|r| r.ok()) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let probe: LineProbe = match serde_json::from_str(trimmed) {
            Ok(pr) => pr,
            Err(_) => continue, // 坏行跳过
        };
        match probe.kind.as_str() {
            "meta" => {
                if meta_line.is_none() {
                    meta_line = Some(trimmed.to_string());
                }
            }
            "msg" => {
                let seq = probe.seq.unwrap_or(fallback_seq);
                msg_lines.push((seq, trimmed.to_string()));
                fallback_seq += 1;
            }
            _ => {}
        }
    }

    let meta_line = match meta_line {
        Some(m) => m,
        None => return Ok(None), // 无 meta 视为无效会话
    };

    msg_lines.sort_by_key(|(seq, _)| *seq);
    let total = msg_lines.len();

    let eligible: Vec<(i64, String)> = match before_seq {
        Some(before) => msg_lines.into_iter().filter(|(s, _)| *s < before).collect(),
        None => msg_lines,
    };
    let has_more = eligible.len() > limit;
    let start = eligible.len().saturating_sub(limit);
    let lines: Vec<String> = eligible[start..].iter().map(|(_, l)| l.clone()).collect();

    Ok(Some(DialogPage {
        meta_line,
        lines,
        total,
        has_more,
    }))
}

pub fn dialog_delete_inner(name: &str) -> Result<()> {
    let p = dialog_path(name)?;
    if p.exists() {
        fs::remove_file(&p)?;
    }
    crate::services::dialog_index::on_self_delete(name);
    Ok(())
}

// ============================================================================
// JSONL 行级编解码 helper（自 turn_persist 迁入：前端合并写与后端归档共用
// 同一套解析/合并/去重契约，单一真源。turn_persist 经 pub(crate) 引用。）
// ============================================================================

/// ISO 8601 → epoch ms（解析失败返回 None）
pub(crate) fn parse_iso(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

/// 取消息 JSON 的时间戳（epoch ms）；无 timestamp 返回 None
pub(crate) fn message_ts(msg: &Value) -> Option<i64> {
    msg.get("timestamp").and_then(Value::as_str).and_then(parse_iso)
}

/// 解析既有 JSONL：返回 (meta 行, 消息列表)。消息按 id 收敛（首位置 + 末内容）。
pub(crate) fn parse_existing_dialog(raw: Option<&str>) -> (Option<Value>, Vec<Value>) {
    let mut meta = None;
    let mut messages: Vec<Value> = Vec::new();
    let Some(text) = raw else {
        return (meta, messages);
    };
    for (i, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if i == 0 || v.get("type").and_then(Value::as_str) == Some("meta") {
            meta = Some(v);
            continue;
        }
        if v.get("type").and_then(Value::as_str) == Some("msg") {
            if let Some(msg) = v.get("message") {
                upsert_by_id(&mut messages, msg.clone());
            }
        }
    }
    (meta, messages)
}

/// 按 id 插入/覆盖：保留首次出现的位置，内容取最新（与 `parseDialogLines`+前端去重同规则）
pub(crate) fn upsert_by_id(messages: &mut Vec<Value>, msg: Value) {
    let id = msg.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    if id.is_empty() {
        messages.push(msg);
        return;
    }
    if let Some(slot) = messages
        .iter_mut()
        .find(|m| m.get("id").and_then(Value::as_str) == Some(id.as_str()))
    {
        *slot = msg;
    } else {
        messages.push(msg);
    }
}

/// 按消息时间升序稳定排序；缺失/不可解析的时间沿用前一条（保持相对顺序）
pub(crate) fn sort_messages_by_time(messages: &mut [Value]) {
    let mut prev = 0i64;
    let mut keyed: Vec<(i64, usize)> = Vec::with_capacity(messages.len());
    for (i, m) in messages.iter().enumerate() {
        let ts = m
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_iso)
            .unwrap_or(prev);
        prev = ts;
        keyed.push((ts, i));
    }
    keyed.sort_by_key(|(ts, i)| (*ts, *i));
    let order: Vec<usize> = keyed.into_iter().map(|(_, i)| i).collect();
    let snapshot: Vec<Value> = messages.to_vec();
    for (dst, src) in order.into_iter().enumerate() {
        messages[dst] = snapshot[src].clone();
    }
}

/// 按 assistant 内容指纹去重（与前端 `dedupeAssistantMessages` 对齐）。
///
/// 同一轮回复在流式/落定/恢复过程中可能被赋予不同 id（id 漂移），按 id 去重
/// 无法收敛。指纹 = blocks 中 text 块 content 拼接并 trim；同指纹只保留最后一条，
/// 放置在首次出现的位置。仅对有 text 内容的 assistant 生效。
pub(crate) fn dedupe_assistant_by_content(messages: &mut Vec<Value>) {
    if messages.len() <= 1 {
        return;
    }
    // 第一遍：收集每个指纹的首次下标 + 最后一条消息
    let mut first_idx: HashMap<String, usize> = HashMap::new();
    let mut last_msg: HashMap<String, Value> = HashMap::new();
    for (i, m) in messages.iter().enumerate() {
        if m.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let fp = match assistant_text_fp(m) {
            Some(f) if !f.is_empty() => f,
            _ => continue,
        };
        first_idx.entry(fp.clone()).or_insert(i);
        last_msg.insert(fp, m.clone());
    }
    if first_idx.is_empty() {
        return;
    }
    // 第二遍：同指纹只保留首次出现位置（放最后内容），后续跳过
    let mut used: HashMap<String, ()> = HashMap::new();
    let mut out: Vec<Value> = Vec::with_capacity(messages.len());
    for m in messages.iter() {
        if m.get("type").and_then(Value::as_str) == Some("assistant") {
            if let Some(fp) = assistant_text_fp(m) {
                if !fp.is_empty() {
                    if used.contains_key(&fp) {
                        continue;
                    }
                    used.insert(fp.clone(), ());
                    if let Some(last) = last_msg.get(&fp) {
                        out.push(last.clone());
                    }
                    continue;
                }
            }
        }
        out.push(m.clone());
    }
    *messages = out;
}

/// 提取 assistant 消息的文本指纹：blocks 中 text 块 content 拼接并 trim。
fn assistant_text_fp(msg: &Value) -> Option<String> {
    let blocks = msg.get("blocks").and_then(Value::as_array)?;
    let mut s = String::new();
    for b in blocks {
        if b.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(c) = b.get("content").and_then(Value::as_str) {
                s.push_str(c);
            }
        }
    }
    let trimmed = s.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

// ============================================================================
// dialog_consolidate —— 前端整写的原子合并写入口（阶段 1A⑥，spec §2）
// ============================================================================

#[derive(Debug, Serialize)]
pub struct ConsolidateResult {
    /// 合并后的消息总数
    pub total: usize,
}

/// 前端「读盘→合并→整写」的落盘末端改造：锁内 读盘 → 按 id 合并上抛前端快照 →
/// 去重 → 原子写。前端读盘与落盘之间其他写者（后端归档、另一端前端）的新增
/// 以盘面独有行的形式保留，不再被陈旧快照覆掉。
///
/// 语义：整写从「覆盖」变为「按 id 合并」——单条消息删除不经此路径传播
/// （现状无消息级删除流；会话删除走 dialog_delete 不受影响）。
pub fn dialog_consolidate_inner(
    name: &str,
    meta_json: &str,
    messages_json: &str,
) -> Result<ConsolidateResult> {
    let _guard = lock_dialog_write();
    let target = dialog_path(name)?;
    let existing = if target.exists() {
        Some(fs::read_to_string(&target)?)
    } else {
        None
    };
    let (content, total) = consolidate_compute(existing.as_deref(), meta_json, messages_json)?;
    if total == 0 {
        // 防御：空快照不落盘（避免异常客户端清空归档）；既有文件原样保留
        return Ok(ConsolidateResult { total });
    }
    dialog_write_locked(name, &content)?;
    Ok(ConsolidateResult { total })
}

/// 纯计算核（可单测）：输入既有文件原文 + 前端 meta/快照，输出落盘内容与消息总数。
fn consolidate_compute(
    existing_raw: Option<&str>,
    meta_json: &str,
    messages_json: &str,
) -> Result<(String, usize)> {
    let (existing_meta, mut messages) = parse_existing_dialog(existing_raw);
    let incoming: Vec<Value> = serde_json::from_str(messages_json)
        .map_err(|e| AppError::ValidationError(format!("messages_json 非法: {}", e)))?;
    for m in incoming {
        upsert_by_id(&mut messages, m);
    }
    sort_messages_by_time(&mut messages);
    dedupe_assistant_by_content(&mut messages);
    let total = messages.len();
    if total == 0 {
        return Ok((String::new(), 0));
    }

    let mut meta: Value = serde_json::from_str(meta_json)
        .map_err(|e| AppError::ValidationError(format!("meta_json 非法: {}", e)))?;
    // createdAt 以盘面既有值为准（前端本就透传，双保险防会话创建时间漂移）
    if let Some(created) = existing_meta
        .as_ref()
        .and_then(|m| m.get("createdAt"))
        .cloned()
    {
        meta["createdAt"] = created;
    }

    let mut content = String::new();
    content.push_str(&meta.to_string());
    content.push('\n');
    for (i, m) in messages.iter().enumerate() {
        content.push_str(&serde_json::json!({ "type": "msg", "seq": i, "message": m }).to_string());
        content.push('\n');
    }
    Ok((content, total))
}

// ============================================================================
// Tauri 命令
// ============================================================================

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn dialog_list() -> Result<Vec<String>> {
    dialog_list_inner()
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn dialog_list_meta() -> Result<Vec<DialogMetaEntry>> {
    dialog_list_meta_inner()
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn dialog_read(name: String) -> Result<Option<String>> {
    dialog_read_inner(&name)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn dialog_write(name: String, content: String) -> Result<()> {
    dialog_write_inner(&name, &content)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn dialog_consolidate(
    name: String,
    meta_json: String,
    messages_json: String,
) -> Result<ConsolidateResult> {
    dialog_consolidate_inner(&name, &meta_json, &messages_json)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn dialog_append(name: String, meta_line: Option<String>, lines: Vec<String>) -> Result<()> {
    dialog_append_inner(&name, meta_line.as_deref(), &lines)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn dialog_read_page(
    name: String,
    before_seq: Option<i64>,
    limit: usize,
) -> Result<Option<DialogPage>> {
    dialog_read_page_inner(&name, before_seq, limit)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn dialog_delete(name: String) -> Result<()> {
    dialog_delete_inner(&name)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_name_ok() {
        assert!(validate_name("abc-123_def.jsonl").is_ok());
        assert!(validate_name("session.uuid.jsonl").is_ok());
    }

    #[test]
    fn test_validate_name_rejects_traversal() {
        assert!(validate_name("../etc/passwd.jsonl").is_err());
        assert!(validate_name("a/b.jsonl").is_err());
        assert!(validate_name("a\\b.jsonl").is_err());
    }

    #[test]
    fn test_validate_name_rejects_bad_ext() {
        assert!(validate_name("abc.txt").is_err());
        assert!(validate_name("abc").is_err());
        assert!(validate_name(".jsonl").is_err());
    }

    #[test]
    fn test_validate_name_rejects_special_chars() {
        assert!(validate_name("abc!.jsonl").is_err());
        assert!(validate_name("中文.jsonl").is_err());
        assert!(validate_name("ab cd.jsonl").is_err());
    }

    #[test]
    fn test_dialog_path_includes_dialogs_dir() {
        // 仅检查不 panic 与扩展名
        let p = dialog_path("test-session-1.jsonl").unwrap();
        assert!(p.to_string_lossy().contains("dialogs"));
        assert!(p.to_string_lossy().ends_with("test-session-1.jsonl"));
    }

    #[test]
    fn test_atomic_write_helper_validates_path() {
        // 非法名字应在 path 阶段就拒绝
        assert!(dialog_path("bad/../name.jsonl").is_err());
    }

    // ===================================================================
    // dialog_consolidate 合并语义（spec §2，纯计算核测试）
    // ===================================================================

    fn line(seq: usize, msg: Value) -> String {
        serde_json::json!({ "type": "msg", "seq": seq, "message": msg }).to_string()
    }

    fn meta_line(created: &str) -> String {
        serde_json::json!({
            "type": "meta",
            "externalId": "s1",
            "title": "旧标题",
            "engineId": "simple-ai",
            "createdAt": created,
            "updatedAt": "2026-10-25T10:00:00.000Z",
            "messageCount": 2,
        })
        .to_string()
    }

    #[test]
    fn consolidate_merges_snapshot_and_preserves_disk_only() {
        // 盘面:meta + 两条消息(其中 msg-b 是并发写者新增,前端快照里没有)
        let existing = format!(
            "{}\n{}\n{}\n",
            meta_line("2026-10-24T08:00:00.000Z"),
            line(0, serde_json::json!({"id":"a","type":"user","content":"hi","timestamp":"2026-10-25T09:00:00.000Z"})),
            line(1, serde_json::json!({"id":"b","type":"assistant","blocks":[{"type":"text","content":"并发新增"}],"timestamp":"2026-10-25T09:00:05.000Z"})),
        );
        // 前端快照:只有 a 的更新版(内容更富)
        let incoming = serde_json::json!([
            {"id":"a","type":"user","content":"hi","timestamp":"2026-10-25T09:00:00.000Z","attachments":[{"name":"x.png"}]},
        ])
        .to_string();
        let new_meta = serde_json::json!({
            "type": "meta",
            "externalId": "s1",
            "title": "新标题",
            "createdAt": "2026-10-24T08:00:00.000Z",
        })
        .to_string();

        let (content, total) =
            consolidate_compute(Some(&existing), &new_meta, &incoming).expect("合并成功");
        assert_eq!(total, 2, "盘面独有的并发新增必须保留");
        assert!(content.contains("并发新增"), "盘面独有行不丢");
        assert!(content.contains("attachments"), "快照富内容上抛");
        assert!(content.contains("新标题"), "前端 meta 为准");
        // createdAt 以盘面为准
        let meta_json: Value =
            serde_json::from_str(content.lines().next().unwrap()).unwrap();
        assert_eq!(meta_json["createdAt"], "2026-10-24T08:00:00.000Z");
    }

    #[test]
    fn consolidate_sorts_and_dedupes_assistant_by_content() {
        let existing = format!(
            "{}\n{}\n",
            meta_line("2026-10-24T08:00:00.000Z"),
            line(0, serde_json::json!({"id":"a","type":"user","content":"q","timestamp":"2026-10-25T09:00:00.000Z"})),
        );
        // 快照:同一回复两个 id(id 漂移)同内容 → 指纹去重只留一条
        let incoming = serde_json::json!([
            {"id":"a","type":"user","content":"q","timestamp":"2026-10-25T09:00:00.000Z"},
            {"id":"x1","type":"assistant","blocks":[{"type":"text","content":"same"}],"timestamp":"2026-10-25T09:00:05.000Z"},
            {"id":"x2","type":"assistant","blocks":[{"type":"text","content":"same"}],"timestamp":"2026-10-25T09:00:06.000Z"},
        ])
        .to_string();
        let (content, total) =
            consolidate_compute(Some(&existing), &meta_line("2026-10-24T08:00:00.000Z"), &incoming)
                .expect("合并成功");
        assert_eq!(total, 2, "同内容 assistant 去重后: user + 1 条 assistant");
        assert!(content.contains("\"id\":\"x2\""), "保留最后完成版");
        assert!(!content.contains("\"id\":\"x1\""), "丢弃漂移 id");
    }

    #[test]
    fn consolidate_empty_snapshot_is_noop() {
        let existing = format!(
            "{}\n{}\n",
            meta_line("2026-10-24T08:00:00.000Z"),
            line(0, serde_json::json!({"id":"a","type":"user","content":"hi","timestamp":"2026-10-25T09:00:00.000Z"})),
        );
        let (content, total) =
            consolidate_compute(Some(&existing), &meta_line("x"), "[]").expect("空快照");
        assert_eq!(total, 0, "空快照标记 no-op");
        assert!(content.is_empty(), "不产生落盘内容");
    }

    #[test]
    fn consolidate_rejects_bad_payload() {
        let err = consolidate_compute(None, "not-json", "[]");
        assert!(err.is_err(), "非法 meta 必须拒绝");
        let err = consolidate_compute(None, "{}", "not-json");
        assert!(err.is_err(), "非法 messages 必须拒绝");
    }
}
