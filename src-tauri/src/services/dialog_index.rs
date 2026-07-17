/*! 会话历史 SQLite 索引
 *
 * `<DataRoot>/dialogs/index.db`——历史面板的统一查询层：
 * - **JSONL / 引擎原生文件是事实源**，本索引是可丢弃、可重建的派生数据；
 * - sessions 表：自有(self) + 引擎原生(claude/codex) 会话统一成行，含用户标注
 *   （星标/置顶/归档/标签/备注——原生文件不可写，标注只存在索引里）；
 * - sessions_fts（FTS5, trigram）：全文搜索标题 + 消息正文，CJK 友好；
 * - 写路径挂钩 dialog_write/append/delete 增量维护；native 目录按 (mtime,size)
 *   失效增量扫描（30s 节流），彻底消除"每次开面板全量解析引擎文件"的卡顿。
 */

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::services::data_root::data_root;

/// schema 版本。修改 schema 必须递增，打开时不一致 → 删库重建（索引可再生）。
const SCHEMA_VERSION: i64 = 1;

/// native 扫描节流间隔（秒）
const NATIVE_SCAN_INTERVAL_SECS: u64 = 30;

/// 单会话 FTS 正文上限（字符）：防超大会话拖慢写入/膨胀索引
const FTS_CONTENT_CAP: usize = 200_000;

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  source         TEXT NOT NULL,            -- 'self' | 'claude-native' | 'codex-native'
  engine_id      TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  workspace_path TEXT,
  created_at     INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL DEFAULT 0,
  message_count  INTEGER NOT NULL DEFAULT 0,
  file_size      INTEGER,
  preview        TEXT,
  first_user_text TEXT,
  git_branch     TEXT,
  -- 用户标注（self 与 native 会话统一，永不写回引擎原生文件）
  starred        INTEGER NOT NULL DEFAULT 0,
  pinned         INTEGER NOT NULL DEFAULT 0,
  archived       INTEGER NOT NULL DEFAULT 0,
  color          TEXT,
  user_tags      TEXT,                     -- JSON array
  note           TEXT,
  -- native 缓存失效键
  src_mtime      INTEGER,
  src_size       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(archived, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source);
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  session_id UNINDEXED,
  title,
  content,
  tokenize = 'trigram'
);
"#;

// ============================================================================
// 连接单例
// ============================================================================

struct IndexState {
    conn: Connection,
}

static INDEX: OnceLock<Mutex<Option<IndexState>>> = OnceLock::new();
static LAST_NATIVE_SCAN: AtomicU64 = AtomicU64::new(0);

fn index_cell() -> &'static Mutex<Option<IndexState>> {
    INDEX.get_or_init(|| Mutex::new(None))
}

fn db_path() -> PathBuf {
    data_root().dialogs_dir().join("index.db")
}

fn open_connection() -> Result<Connection> {
    let path = db_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::StateError(format!("创建 dialogs 目录失败: {}", e)))?;
    }

    let mut conn = Connection::open(&path)
        .map_err(|e| AppError::StateError(format!("打开会话索引 DB 失败: {}", e)))?;
    tune_pragmas(&conn);

    let need_rebuild = match read_schema_version(&conn) {
        Ok(v) if v == SCHEMA_VERSION => false,
        Ok(0) => {
            // 全新 DB：建 schema 即可
            conn.execute_batch(SCHEMA_SQL)
                .map_err(|e| AppError::StateError(format!("初始化会话索引 schema 失败: {}", e)))?;
            write_schema_version(&conn, SCHEMA_VERSION);
            // 全新索引 → 从磁盘 JSONL 重建自有会话
            if let Err(e) = rebuild_self_index(&conn) {
                tracing::warn!("[DialogIndex] 自有会话索引重建失败: {}", e);
            }
            false
        }
        _ => true, // 版本不符或损坏 → 删库重建
    };

    if need_rebuild {
        drop(conn);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
        conn = Connection::open(&path)
            .map_err(|e| AppError::StateError(format!("重建会话索引 DB 失败: {}", e)))?;
        tune_pragmas(&conn);
        conn.execute_batch(SCHEMA_SQL)
            .map_err(|e| AppError::StateError(format!("初始化会话索引 schema 失败: {}", e)))?;
        write_schema_version(&conn, SCHEMA_VERSION);
        if let Err(e) = rebuild_self_index(&conn) {
            tracing::warn!("[DialogIndex] 自有会话索引重建失败: {}", e);
        }
        // 重建后 native 扫描节流复位，下次查询立即补扫
        LAST_NATIVE_SCAN.store(0, Ordering::Relaxed);
    }

    Ok(conn)
}

fn tune_pragmas(conn: &Connection) {
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
}

fn read_schema_version(conn: &Connection) -> Result<i64> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| AppError::StateError(format!("读取 schema 版本失败: {}", e)))
}

fn write_schema_version(conn: &Connection, v: i64) {
    let _ = conn.pragma_update(None, "user_version", v);
}

/// 在索引连接上执行操作。索引损坏时自动删库重建一次后重试。
fn with_conn<T>(f: impl Fn(&Connection) -> Result<T>) -> Result<T> {
    let cell = index_cell();
    let mut guard = cell
        .lock()
        .map_err(|_| AppError::StateError("会话索引锁中毒".to_string()))?;

    if guard.is_none() {
        *guard = Some(IndexState {
            conn: open_connection()?,
        });
    }

    let state = guard.as_ref().expect("索引连接已初始化");
    match f(&state.conn) {
        Ok(v) => Ok(v),
        Err(first_err) => {
            // 可能是索引损坏：删库重建后重试一次
            tracing::warn!("[DialogIndex] 操作失败，尝试重建索引: {}", first_err);
            *guard = None;
            let _ = std::fs::remove_file(db_path());
            let _ = std::fs::remove_file(db_path().with_extension("db-wal"));
            let _ = std::fs::remove_file(db_path().with_extension("db-shm"));
            *guard = Some(IndexState {
                conn: open_connection()?,
            });
            let state = guard.as_ref().expect("索引连接已初始化");
            f(&state.conn)
        }
    }
}

// ============================================================================
// 时间工具
// ============================================================================

fn iso_to_epoch_ms(iso: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

fn epoch_ms_to_iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_default()
}

fn systemtime_to_epoch_ms(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ============================================================================
// 自有会话（self）：meta 解析 + FTS 正文抽取
// ============================================================================

struct SelfMeta {
    external_id: String,
    engine_id: String,
    title: String,
    workspace_path: Option<String>,
    created_at: i64,
    updated_at: i64,
    message_count: i64,
    first_user_text: Option<String>,
    preview: Option<String>,
}

fn parse_self_meta(meta_line: &str) -> Option<SelfMeta> {
    let v: serde_json::Value = serde_json::from_str(meta_line.trim()).ok()?;
    if v.get("type")?.as_str()? != "meta" {
        return None;
    }
    let external_id = v.get("externalId")?.as_str()?.to_string();
    if external_id.is_empty() {
        return None;
    }
    Some(SelfMeta {
        external_id,
        engine_id: v
            .get("engineId")
            .and_then(|x| x.as_str())
            .unwrap_or("claude-code")
            .to_string(),
        title: v
            .get("title")
            .and_then(|x| x.as_str())
            .unwrap_or("未命名会话")
            .to_string(),
        workspace_path: v
            .get("workspacePath")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        created_at: v
            .get("createdAt")
            .and_then(|x| x.as_str())
            .map(iso_to_epoch_ms)
            .unwrap_or(0),
        updated_at: v
            .get("updatedAt")
            .and_then(|x| x.as_str())
            .map(iso_to_epoch_ms)
            .unwrap_or(0),
        message_count: v
            .get("messageCount")
            .and_then(|x| x.as_i64())
            .unwrap_or(0),
        first_user_text: v
            .get("firstUserText")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        preview: v
            .get("preview")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
    })
}

/// 从一条消息行（{type:'msg',seq,message}）提取可搜索文本
fn extract_line_text(line: &str, out: &mut String) {
    if out.len() >= FTS_CONTENT_CAP {
        return;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return;
    };
    if v.get("type").and_then(|t| t.as_str()) != Some("msg") {
        return;
    }
    let Some(msg) = v.get("message") else { return };
    match msg.get("type").and_then(|t| t.as_str()) {
        Some("user") => {
            if let Some(c) = msg.get("content").and_then(|c| c.as_str()) {
                push_text(out, c);
            }
        }
        Some("assistant") => {
            if let Some(blocks) = msg.get("blocks").and_then(|b| b.as_array()) {
                for b in blocks {
                    if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(c) = b.get("content").and_then(|c| c.as_str()) {
                            push_text(out, c);
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

fn push_text(out: &mut String, text: &str) {
    if out.len() >= FTS_CONTENT_CAP || text.trim().is_empty() {
        return;
    }
    if !out.is_empty() {
        out.push('\n');
    }
    let remain = FTS_CONTENT_CAP - out.len();
    if text.len() > remain {
        // 按字符边界截断
        let mut end = remain;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        out.push_str(&text[..end]);
    } else {
        out.push_str(text);
    }
}

fn upsert_self_row(conn: &Connection, meta: &SelfMeta, file_size: Option<i64>) -> Result<()> {
    conn.execute(
        r#"INSERT INTO sessions (id, source, engine_id, title, workspace_path, created_at, updated_at,
                                 message_count, file_size, preview, first_user_text)
           VALUES (?1, 'self', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           ON CONFLICT(id) DO UPDATE SET
             source = 'self',
             engine_id = excluded.engine_id,
             title = excluded.title,
             workspace_path = excluded.workspace_path,
             created_at = CASE WHEN sessions.created_at > 0 THEN sessions.created_at ELSE excluded.created_at END,
             updated_at = excluded.updated_at,
             message_count = excluded.message_count,
             file_size = excluded.file_size,
             preview = excluded.preview,
             first_user_text = excluded.first_user_text"#,
        params![
            meta.external_id,
            meta.engine_id,
            meta.title,
            meta.workspace_path,
            meta.created_at,
            meta.updated_at,
            meta.message_count,
            file_size,
            meta.preview,
            meta.first_user_text,
        ],
    )
    .map_err(|e| AppError::StateError(format!("upsert 会话索引失败: {}", e)))?;
    Ok(())
}

fn replace_fts(conn: &Connection, session_id: &str, title: &str, content: &str) -> Result<()> {
    conn.execute("DELETE FROM sessions_fts WHERE session_id = ?1", params![session_id])
        .map_err(|e| AppError::StateError(format!("清理 FTS 失败: {}", e)))?;
    conn.execute(
        "INSERT INTO sessions_fts (session_id, title, content) VALUES (?1, ?2, ?3)",
        params![session_id, title, content],
    )
    .map_err(|e| AppError::StateError(format!("写入 FTS 失败: {}", e)))?;
    Ok(())
}

/// 从 JSONL 全量内容索引一个自有会话（覆写路径 / 重建路径共用）
fn index_self_content(conn: &Connection, content: &str, file_size: Option<i64>) -> Result<()> {
    let first_line = content.lines().next().unwrap_or("");
    let Some(meta) = parse_self_meta(first_line) else {
        return Ok(()); // 无有效 meta：跳过（不视为错误）
    };
    upsert_self_row(conn, &meta, file_size)?;
    let mut text = String::new();
    for line in content.lines().skip(1) {
        extract_line_text(line, &mut text);
        if text.len() >= FTS_CONTENT_CAP {
            break;
        }
    }
    replace_fts(conn, &meta.external_id, &meta.title, &text)?;
    Ok(())
}

/// 扫描 dialogs 目录重建全部自有会话索引（新库/损坏重建时）
fn rebuild_self_index(conn: &Connection) -> Result<()> {
    let dir = data_root().dialogs_dir();
    let start = std::time::Instant::now();
    let mut count = 0usize;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".jsonl") {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            let size = std::fs::metadata(&path).map(|m| m.len() as i64).ok();
            if index_self_content(conn, &content, size).is_ok() {
                count += 1;
            }
        }
    }
    tracing::info!(
        "[DialogIndex] 自有会话索引重建完成: {} 个会话, 耗时 {:?}",
        count,
        start.elapsed()
    );
    Ok(())
}

// ============================================================================
// 写路径挂钩（由 dialog_storage 调用；尽力而为，绝不阻塞主写路径）
// ============================================================================

/// 整体覆写后同步索引
pub fn on_self_write(name: &str, content: &str) {
    let size = Some(content.len() as i64);
    let result = with_conn(|conn| index_self_content(conn, content, size));
    if let Err(e) = result {
        tracing::warn!("[DialogIndex] 覆写索引失败 {}: {}", name, e);
    }
}

/// 增量追加后同步索引（meta 允许陈旧，只推进 updated_at/message_count/FTS 增量）
pub fn on_self_append(name: &str, meta_line: Option<&str>, lines: &[String]) {
    let external_id = name.trim_end_matches(".jsonl").to_string();
    let now_ms = systemtime_to_epoch_ms(SystemTime::now());
    let appended = lines.len() as i64;

    let mut text = String::new();
    for l in lines {
        extract_line_text(l, &mut text);
    }
    let meta = meta_line.and_then(parse_self_meta);

    let result = with_conn(|conn| {
        let updated = conn
            .execute(
                "UPDATE sessions SET updated_at = ?2, message_count = message_count + ?3 WHERE id = ?1",
                params![external_id, now_ms, appended],
            )
            .map_err(|e| AppError::StateError(format!("append 索引失败: {}", e)))?;
        if updated == 0 {
            // 建档路径：用 meta 行插入
            if let Some(m) = &meta {
                upsert_self_row(conn, m, None)?;
                conn.execute(
                    "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
                    params![external_id, now_ms],
                )
                .map_err(|e| AppError::StateError(format!("append 索引失败: {}", e)))?;
            }
        }
        // 更新 preview 为最后一条消息文本（截 160 字）
        if !text.is_empty() {
            let preview: String = text
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("")
                .chars()
                .take(160)
                .collect();
            if !preview.is_empty() {
                let _ = conn.execute(
                    "UPDATE sessions SET preview = ?2 WHERE id = ?1",
                    params![external_id, preview],
                );
            }
            // FTS 增量：追加一行（搜索时 GROUP BY session_id 去重）
            conn.execute(
                "INSERT INTO sessions_fts (session_id, title, content) VALUES (?1, '', ?2)",
                params![external_id, text],
            )
            .map_err(|e| AppError::StateError(format!("FTS 增量失败: {}", e)))?;
        }
        Ok(())
    });
    if let Err(e) = result {
        tracing::warn!("[DialogIndex] 追加索引失败 {}: {}", name, e);
    }
}

/// 删除会话后同步索引
pub fn on_self_delete(name: &str) {
    let external_id = name.trim_end_matches(".jsonl").to_string();
    let result = with_conn(|conn| {
        conn.execute("DELETE FROM sessions WHERE id = ?1 AND source = 'self'", params![external_id])
            .map_err(|e| AppError::StateError(format!("删除索引失败: {}", e)))?;
        conn.execute("DELETE FROM sessions_fts WHERE session_id = ?1", params![external_id])
            .map_err(|e| AppError::StateError(format!("删除 FTS 失败: {}", e)))?;
        Ok(())
    });
    if let Err(e) = result {
        tracing::warn!("[DialogIndex] 删除索引失败 {}: {}", name, e);
    }
}

// ============================================================================
// native 扫描（claude / codex，(mtime,size) 失效增量）
// ============================================================================

struct NativeFile {
    id: String,
    engine_id: &'static str,
    source: &'static str,
    path: PathBuf,
    mtime: i64,
    size: i64,
}

fn collect_claude_files(out: &mut Vec<NativeFile>) {
    let claude_dir = crate::ai::history_claude::ClaudeHistoryProvider::get_claude_dir();
    let Ok(entries) = std::fs::read_dir(&claude_dir) else {
        return;
    };
    for project in entries.flatten() {
        let project_path = project.path();
        if !project_path.is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&project_path) else {
            continue;
        };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                let Ok(md) = std::fs::metadata(&path) else { continue };
                let id = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                if id.is_empty() {
                    continue;
                }
                out.push(NativeFile {
                    id,
                    engine_id: "claude-code",
                    source: "claude-native",
                    path,
                    mtime: md.modified().map(systemtime_to_epoch_ms).unwrap_or(0),
                    size: md.len() as i64,
                });
            }
        }
    }
}

fn collect_codex_files(out: &mut Vec<NativeFile>) {
    let dir = crate::ai::history_codex::CodexHistoryProvider::get_codex_sessions_dir();
    let mut files: Vec<PathBuf> = Vec::new();
    crate::ai::history_codex::CodexHistoryProvider::collect_jsonl_files(&dir, &mut files);
    for path in files {
        let Ok(md) = std::fs::metadata(&path) else { continue };
        let id = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        out.push(NativeFile {
            id,
            engine_id: "codex",
            source: "codex-native",
            path,
            mtime: md.modified().map(systemtime_to_epoch_ms).unwrap_or(0),
            size: md.len() as i64,
        });
    }
}

/// 增量扫描 native 会话进索引（(mtime,size) 未变的文件零解析）。
/// `force` 跳过节流（用户手动刷新）。
pub fn ensure_native_scan(force: bool) {
    let now = systemtime_to_epoch_ms(SystemTime::now()) as u64;
    let last = LAST_NATIVE_SCAN.load(Ordering::Relaxed);
    if !force && now.saturating_sub(last) < NATIVE_SCAN_INTERVAL_SECS * 1000 {
        return;
    }
    LAST_NATIVE_SCAN.store(now, Ordering::Relaxed);

    let start = std::time::Instant::now();
    let mut files: Vec<NativeFile> = Vec::new();
    collect_claude_files(&mut files);
    collect_codex_files(&mut files);

    let result = with_conn(|conn| {
        // 现有 native 行的失效键
        let mut known: HashMap<String, (i64, i64)> = HashMap::new();
        {
            let mut stmt = conn
                .prepare("SELECT id, src_mtime, src_size FROM sessions WHERE source != 'self'")
                .map_err(|e| AppError::StateError(format!("查询 native 索引失败: {}", e)))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                        row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    ))
                })
                .map_err(|e| AppError::StateError(format!("查询 native 索引失败: {}", e)))?;
            for r in rows.flatten() {
                known.insert(r.0, (r.1, r.2));
            }
        }

        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut parsed = 0usize;
        for f in &files {
            seen.insert(f.id.clone());
            if let Some((m, s)) = known.get(&f.id) {
                if *m == f.mtime && *s == f.size {
                    continue; // 未变化，零解析
                }
            }
            // 解析（仅变化的文件）
            parsed += 1;
            let (title, message_count, created_at, workspace_path, git_branch) = match f.source {
                "claude-native" => {
                    let (first_prompt, count, created, cwd, branch) =
                        crate::ai::history_claude::ClaudeHistoryProvider::parse_session_metadata_light(&f.path);
                    (
                        first_prompt.unwrap_or_else(|| "无标题会话".to_string()),
                        count as i64,
                        created.map(|c| iso_to_epoch_ms(&c)).unwrap_or(0),
                        cwd,
                        branch,
                    )
                }
                _ => {
                    let (summary, count, created, cwd, _sid) =
                        crate::ai::history_codex::CodexHistoryProvider::parse_metadata(&f.path);
                    (
                        summary.unwrap_or_else(|| "Codex 对话".to_string()),
                        count as i64,
                        created.map(|c| iso_to_epoch_ms(&c)).unwrap_or(0),
                        cwd,
                        None,
                    )
                }
            };
            let title_short: String = title.chars().take(80).collect();
            conn.execute(
                r#"INSERT INTO sessions (id, source, engine_id, title, workspace_path, created_at, updated_at,
                                         message_count, file_size, first_user_text, git_branch, src_mtime, src_size)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                   ON CONFLICT(id) DO UPDATE SET
                     engine_id = excluded.engine_id,
                     title = excluded.title,
                     workspace_path = excluded.workspace_path,
                     created_at = CASE WHEN sessions.created_at > 0 THEN sessions.created_at ELSE excluded.created_at END,
                     updated_at = excluded.updated_at,
                     message_count = excluded.message_count,
                     file_size = excluded.file_size,
                     first_user_text = excluded.first_user_text,
                     git_branch = excluded.git_branch,
                     src_mtime = excluded.src_mtime,
                     src_size = excluded.src_size"#,
                params![
                    f.id,
                    f.source,
                    f.engine_id,
                    title_short,
                    workspace_path,
                    created_at,
                    f.mtime,
                    message_count,
                    f.size,
                    title,
                    git_branch,
                    f.mtime,
                    f.size,
                ],
            )
            .map_err(|e| AppError::StateError(format!("upsert native 索引失败: {}", e)))?;
            // native FTS：标题 + 首条 prompt（正文全量解析成本高，留给 self 存储覆盖）
            replace_fts(conn, &f.id, &title_short, &title)?;
        }

        // 清理已消失的 native 文件对应行（保留有用户标注的行避免误删标注）
        let vanished: Vec<String> = known
            .keys()
            .filter(|id| !seen.contains(*id))
            .cloned()
            .collect();
        for id in &vanished {
            let _ = conn.execute(
                "DELETE FROM sessions WHERE id = ?1 AND source != 'self' AND starred = 0 AND pinned = 0 AND note IS NULL",
                params![id],
            );
            let _ = conn.execute("DELETE FROM sessions_fts WHERE session_id = ?1", params![id]);
        }

        Ok(parsed)
    });

    match result {
        Ok(parsed) => {
            if parsed > 0 {
                tracing::info!(
                    "[DialogIndex] native 扫描完成: {} 个文件, 解析 {} 个变化文件, 耗时 {:?}",
                    files.len(),
                    parsed,
                    start.elapsed()
                );
            }
        }
        Err(e) => tracing::warn!("[DialogIndex] native 扫描失败: {}", e),
    }
}

// ============================================================================
// 查询 / 搜索 / 标注
// ============================================================================

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HistoryQueryParams {
    /// 工作区路径过滤（None = 全部）
    pub workspace_path: Option<String>,
    /// 引擎过滤（空 = 全部）
    pub engines: Option<Vec<String>>,
    /// 只看星标
    pub starred: Option<bool>,
    /// 只看置顶
    pub pinned: Option<bool>,
    /// 归档过滤：None → 排除归档；Some(true) → 只看归档；Some(false) → 排除归档
    pub archived: Option<bool>,
    /// 来源过滤：'self' | 'claude-native' | 'codex-native'
    pub source: Option<String>,
    /// 强制立即扫描 native（手动刷新）
    pub force_scan: Option<bool>,
    pub page: Option<u32>,
    pub page_size: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySessionRow {
    pub id: String,
    pub source: String,
    pub engine_id: String,
    pub title: String,
    pub workspace_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: i64,
    pub file_size: Option<i64>,
    pub preview: Option<String>,
    pub first_user_text: Option<String>,
    pub git_branch: Option<String>,
    pub starred: bool,
    pub pinned: bool,
    pub archived: bool,
    pub color: Option<String>,
    pub user_tags: Vec<String>,
    pub note: Option<String>,
    /// 搜索命中片段（仅 history_search 返回）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQueryResult {
    pub items: Vec<HistorySessionRow>,
    pub total: i64,
    pub page: u32,
    pub page_size: u32,
}

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistorySessionRow> {
    let user_tags_json: Option<String> = row.get("user_tags")?;
    let user_tags = user_tags_json
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default();
    Ok(HistorySessionRow {
        id: row.get("id")?,
        source: row.get("source")?,
        engine_id: row.get("engine_id")?,
        title: row.get("title")?,
        workspace_path: row.get("workspace_path")?,
        created_at: epoch_ms_to_iso(row.get::<_, i64>("created_at")?),
        updated_at: epoch_ms_to_iso(row.get::<_, i64>("updated_at")?),
        message_count: row.get("message_count")?,
        file_size: row.get("file_size")?,
        preview: row.get("preview")?,
        first_user_text: row.get("first_user_text")?,
        git_branch: row.get("git_branch")?,
        starred: row.get::<_, i64>("starred")? != 0,
        pinned: row.get::<_, i64>("pinned")? != 0,
        archived: row.get::<_, i64>("archived")? != 0,
        color: row.get("color")?,
        user_tags,
        note: row.get("note")?,
        snippet: None,
    })
}

/// 路径归一化：与前端 normalizeWorkspacePath 对齐（小写 + 正斜杠 + 去尾斜杠）
fn normalize_path(p: &str) -> String {
    let mut s = p.replace('\\', "/").to_lowercase();
    while s.ends_with('/') && s.len() > 1 {
        s.pop();
    }
    s
}

pub fn history_query_inner(p: HistoryQueryParams) -> Result<HistoryQueryResult> {
    ensure_native_scan(p.force_scan.unwrap_or(false));

    let page = p.page.unwrap_or(1).max(1);
    let page_size = p.page_size.unwrap_or(20).clamp(1, 200);

    let mut where_clauses: Vec<String> = Vec::new();
    let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    match p.archived {
        Some(true) => where_clauses.push("archived = 1".to_string()),
        _ => where_clauses.push("archived = 0".to_string()),
    }
    if let Some(engines) = &p.engines {
        if !engines.is_empty() {
            let placeholders = vec!["?"; engines.len()].join(",");
            where_clauses.push(format!("engine_id IN ({})", placeholders));
            for e in engines {
                args.push(Box::new(e.clone()));
            }
        }
    }
    if let Some(true) = p.starred {
        where_clauses.push("starred = 1".to_string());
    }
    if let Some(true) = p.pinned {
        where_clauses.push("pinned = 1".to_string());
    }
    if let Some(source) = &p.source {
        where_clauses.push("source = ?".to_string());
        args.push(Box::new(source.clone()));
    }

    let workspace_norm = p.workspace_path.as_deref().map(normalize_path);

    with_conn(move |conn| {
        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };

        // 工作区过滤在行集上做（路径归一化无法直接下推 SQL；行数有限，代价可忽略）
        let sql = format!(
            "SELECT * FROM sessions {} ORDER BY pinned DESC, updated_at DESC",
            where_sql
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| AppError::StateError(format!("查询会话索引失败: {}", e)))?;
        let rows = stmt
            .query_map(params_from_iter(args.iter().map(|b| b.as_ref())), row_to_session)
            .map_err(|e| AppError::StateError(format!("查询会话索引失败: {}", e)))?;

        let mut all: Vec<HistorySessionRow> = Vec::new();
        for r in rows.flatten() {
            if let Some(wn) = &workspace_norm {
                match &r.workspace_path {
                    Some(wp) if normalize_path(wp) == *wn => {}
                    // 自有"自由会话"（无工作区）在任何工作区可见，与旧行为一致
                    None if r.source == "self" => {}
                    _ => continue,
                }
            }
            all.push(r);
        }

        let total = all.len() as i64;
        let start = ((page - 1) * page_size) as usize;
        let items: Vec<HistorySessionRow> = all
            .into_iter()
            .skip(start)
            .take(page_size as usize)
            .collect();

        Ok(HistoryQueryResult {
            items,
            total,
            page,
            page_size,
        })
    })
}

pub fn history_search_inner(
    query: &str,
    workspace_path: Option<&str>,
    limit: u32,
) -> Result<Vec<HistorySessionRow>> {
    ensure_native_scan(false);
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 100);
    let workspace_norm = workspace_path.map(normalize_path);

    // trigram tokenizer：>=3 字符走 MATCH（引号包裹防语法注入）；短查询走 LIKE
    let use_match = q.chars().count() >= 3;
    let q_owned = q.to_string();

    with_conn(move |conn| {
        let sql = if use_match {
            r#"SELECT s.*, snippet(sessions_fts, 2, '[', ']', '…', 16) AS snip
               FROM sessions_fts f JOIN sessions s ON s.id = f.session_id
               WHERE sessions_fts MATCH ?1 AND s.archived = 0
               GROUP BY s.id
               ORDER BY s.pinned DESC, s.updated_at DESC
               LIMIT ?2"#
        } else {
            r#"SELECT s.*, substr(f.content, max(1, instr(lower(f.content), lower(?1)) - 20), 60) AS snip
               FROM sessions_fts f JOIN sessions s ON s.id = f.session_id
               WHERE (f.content LIKE '%' || ?1 || '%' OR f.title LIKE '%' || ?1 || '%') AND s.archived = 0
               GROUP BY s.id
               ORDER BY s.pinned DESC, s.updated_at DESC
               LIMIT ?2"#
        };
        let match_arg = if use_match {
            format!("\"{}\"", q_owned.replace('"', "\"\""))
        } else {
            q_owned.clone()
        };
        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| AppError::StateError(format!("搜索失败: {}", e)))?;
        let rows = stmt
            .query_map(params![match_arg, limit], |row| {
                let mut s = row_to_session(row)?;
                s.snippet = row.get("snip").ok();
                Ok(s)
            })
            .map_err(|e| AppError::StateError(format!("搜索失败: {}", e)))?;

        let mut out: Vec<HistorySessionRow> = Vec::new();
        for r in rows.flatten() {
            if let Some(wn) = &workspace_norm {
                match &r.workspace_path {
                    Some(wp) if normalize_path(wp) == *wn => {}
                    None if r.source == "self" => {}
                    _ => continue,
                }
            }
            out.push(r);
        }
        Ok(out)
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMarks {
    pub starred: Option<bool>,
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
    pub color: Option<String>,
    pub user_tags: Option<Vec<String>>,
    pub note: Option<String>,
}

pub fn history_mark_inner(id: &str, marks: HistoryMarks) -> Result<()> {
    if id.is_empty() {
        return Err(AppError::ValidationError("会话 id 为空".to_string()));
    }
    let id = id.to_string();
    with_conn(move |conn| {
        let mut sets: Vec<String> = Vec::new();
        let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        if let Some(v) = marks.starred {
            sets.push("starred = ?".to_string());
            args.push(Box::new(v as i64));
        }
        if let Some(v) = marks.pinned {
            sets.push("pinned = ?".to_string());
            args.push(Box::new(v as i64));
        }
        if let Some(v) = marks.archived {
            sets.push("archived = ?".to_string());
            args.push(Box::new(v as i64));
        }
        if let Some(v) = &marks.color {
            sets.push("color = ?".to_string());
            args.push(Box::new(if v.is_empty() { None } else { Some(v.clone()) }));
        }
        if let Some(v) = &marks.user_tags {
            sets.push("user_tags = ?".to_string());
            args.push(Box::new(serde_json::to_string(v).unwrap_or_else(|_| "[]".into())));
        }
        if let Some(v) = &marks.note {
            sets.push("note = ?".to_string());
            args.push(Box::new(if v.is_empty() { None } else { Some(v.clone()) }));
        }
        if sets.is_empty() {
            return Ok(());
        }
        args.push(Box::new(id.clone()));
        let sql = format!("UPDATE sessions SET {} WHERE id = ?", sets.join(", "));
        let n = conn
            .execute(&sql, params_from_iter(args.iter().map(|b| b.as_ref())))
            .map_err(|e| AppError::StateError(format!("更新标注失败: {}", e)))?;
        if n == 0 {
            return Err(AppError::ValidationError(format!("会话不在索引中: {}", id)));
        }
        Ok(())
    })
}
