/*! 索引数据库（SQLite）
 *
 * - 每个工作区独立 DB：`<workspace>/.polaris/index.db`
 * - WAL 模式 + NORMAL synchronous（崩溃可能丢最近一两条写入，但索引是可重建的派生数据）
 * - schema_version 不一致 → 触发整库 drop + 重建
 */

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension, Transaction};

use crate::error::{AppError, Result};

use super::model::{
    FileIndex, ImportEntry, IndexStatus, RefKind, SymbolKind,
};

/// schema 版本。修改 schema 必须递增此版本，并在打开时触发重建。
pub const SCHEMA_VERSION: i64 = 1;

/// builder 版本。当 extractor 行为有大改动（影响已有数据可信度）时递增。
pub const BUILDER_VERSION: i64 = 1;

const SCHEMA_SQL: &str = include_str!("schema.sql");

// ── 连接封装 ────────────────────────────────────────────────

/// 工作区索引 DB。线程安全（内部 Mutex 保护连接）。
///
/// SQLite 单写多读，这里所有写都过 Mutex；读也过同一锁——
/// 索引引擎不是热点，简单起见先这样，后期可以分读写连接。
pub struct IndexDb {
    pub workspace: PathBuf,
    pub db_path: PathBuf,
    conn: Arc<Mutex<Connection>>,
}

impl IndexDb {
    /// 打开（不存在则创建）。schema 不匹配会重建。
    pub fn open(workspace: &Path) -> Result<Self> {
        let polaris_dir = workspace.join(".polaris");
        std::fs::create_dir_all(&polaris_dir)
            .map_err(|e| AppError::StateError(format!("创建 .polaris 目录失败: {}", e)))?;
        let db_path = polaris_dir.join("index.db");

        let mut conn = Connection::open(&db_path)
            .map_err(|e| AppError::StateError(format!("打开索引 DB 失败: {}", e)))?;
        Self::tune_pragmas(&conn)?;

        // schema 检查
        let need_rebuild = match Self::read_schema_version(&conn) {
            Ok(Some(v)) => v != SCHEMA_VERSION,
            Ok(None) => true, // 全新 DB
            Err(_) => true,   // 损坏：直接重建
        };
        if need_rebuild {
            // drop 全部用户表，重新建
            drop(conn);
            let _ = std::fs::remove_file(&db_path);
            // 同时清理 -wal/-shm 残留
            let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
            let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
            conn = Connection::open(&db_path)
                .map_err(|e| AppError::StateError(format!("重建索引 DB 失败: {}", e)))?;
            Self::tune_pragmas(&conn)?;
            conn.execute_batch(SCHEMA_SQL)
                .map_err(|e| AppError::StateError(format!("初始化 schema 失败: {}", e)))?;
            Self::write_schema_version(&conn, SCHEMA_VERSION)?;
        }

        Ok(Self {
            workspace: workspace.to_path_buf(),
            db_path,
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn tune_pragmas(conn: &Connection) -> Result<()> {
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| AppError::StateError(format!("WAL 切换失败: {}", e)))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| AppError::StateError(format!("synchronous 设置失败: {}", e)))?;
        // 额外提升大批量写入吞吐
        conn.pragma_update(None, "temp_store", "MEMORY").ok();
        conn.pragma_update(None, "cache_size", -16_000).ok(); // ~16MB cache
        // 启动时清理可能膨胀的 WAL
        conn.pragma_update(None, "wal_checkpoint", "TRUNCATE").ok();
        Ok(())
    }

    fn read_schema_version(conn: &Connection) -> Result<Option<i64>> {
        // 表都不存在时返回 None（被外层走重建分支）
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'",
                [],
                |_| Ok(true),
            )
            .optional()
            .map_err(|e| AppError::StateError(e.to_string()))?
            .unwrap_or(false);
        if !exists {
            return Ok(None);
        }
        let v: Option<String> = conn
            .query_row(
                "SELECT value FROM meta WHERE key='schema_version'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| AppError::StateError(e.to_string()))?;
        Ok(v.and_then(|s| s.parse::<i64>().ok()))
    }

    fn write_schema_version(conn: &Connection, v: i64) -> Result<()> {
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?1)",
            params![v.to_string()],
        )
        .map_err(|e| AppError::StateError(e.to_string()))?;
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES('builder_version', ?1)",
            params![BUILDER_VERSION.to_string()],
        )
        .map_err(|e| AppError::StateError(e.to_string()))?;
        Ok(())
    }

    /// 全量替换：删除全部数据但保留 schema。
    pub fn truncate_all(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "DELETE FROM refs;
             DELETE FROM imports;
             DELETE FROM packages;
             DELETE FROM symbols;
             DELETE FROM files;",
        )
        .map_err(|e| AppError::StateError(e.to_string()))?;
        Ok(())
    }

    /// 批量写入多个文件的索引（单事务）。
    pub fn batch_insert_files(&self, files: &[FileIndex]) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| AppError::StateError(e.to_string()))?;
        for fi in files {
            insert_file_index(&tx, fi)?;
        }
        tx.commit()
            .map_err(|e| AppError::StateError(e.to_string()))?;
        Ok(())
    }

    /// 单文件原子替换（删除旧 → 插入新）。
    pub fn replace_file(&self, fi: &FileIndex) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| AppError::StateError(e.to_string()))?;
        delete_file_by_path(&tx, &fi.rel_path)?;
        insert_file_index(&tx, fi)?;
        tx.commit()
            .map_err(|e| AppError::StateError(e.to_string()))?;
        Ok(())
    }

    /// 删除指定路径的所有数据。
    pub fn delete_file(&self, rel_path: &str) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| AppError::StateError(e.to_string()))?;
        delete_file_by_path(&tx, rel_path)?;
        tx.commit()
            .map_err(|e| AppError::StateError(e.to_string()))?;
        Ok(())
    }

    /// 查询：按 name 找符号定义候选。
    pub fn find_symbols_by_name(&self, name: &str) -> Result<Vec<SymbolRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT s.name, s.fqn, s.kind, s.parent_fqn,
                        s.line, s.column, s.name_line, s.name_column,
                        s.signature, s.modifiers,
                        f.path, f.language,
                        p.fqn AS package_fqn
                 FROM symbols s
                 JOIN files f ON s.file_id = f.id
                 LEFT JOIN packages p ON p.file_id = f.id
                 WHERE s.name = ?1
                 LIMIT 500",
            )
            .map_err(|e| AppError::StateError(e.to_string()))?;
        let rows = stmt
            .query_map(params![name], map_symbol_row)
            .map_err(|e| AppError::StateError(e.to_string()))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 查询：按 fqn 精确找符号。
    pub fn find_symbols_by_fqn(&self, fqn: &str) -> Result<Vec<SymbolRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT s.name, s.fqn, s.kind, s.parent_fqn,
                        s.line, s.column, s.name_line, s.name_column,
                        s.signature, s.modifiers,
                        f.path, f.language,
                        p.fqn AS package_fqn
                 FROM symbols s
                 JOIN files f ON s.file_id = f.id
                 LEFT JOIN packages p ON p.file_id = f.id
                 WHERE s.fqn = ?1
                 LIMIT 100",
            )
            .map_err(|e| AppError::StateError(e.to_string()))?;
        let rows = stmt
            .query_map(params![fqn], map_symbol_row)
            .map_err(|e| AppError::StateError(e.to_string()))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 查询：按 name 找引用（用于查应用）。
    pub fn find_refs_by_name(
        &self,
        name: &str,
        target_fqn: Option<&str>,
        max: usize,
    ) -> Result<Vec<RefRow>> {
        let conn = self.conn.lock().unwrap();
        let limit = max as i64;
        let rows: Vec<RefRow> = if let Some(fqn) = target_fqn {
            let mut stmt = conn
                .prepare(
                    "SELECT r.name, r.line, r.column, r.end_column, r.ref_kind, r.target_fqn, r.line_text,
                            f.path, f.language
                     FROM refs r JOIN files f ON r.file_id = f.id
                     WHERE r.name = ?1 AND (r.target_fqn = ?2 OR r.target_fqn IS NULL)
                     LIMIT ?3",
                )
                .map_err(|e| AppError::StateError(e.to_string()))?;
            let collected: Vec<RefRow> = stmt
                .query_map(params![name, fqn, limit], map_ref_row)
                .map_err(|e| AppError::StateError(e.to_string()))?
                .filter_map(|r| r.ok())
                .collect();
            collected
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT r.name, r.line, r.column, r.end_column, r.ref_kind, r.target_fqn, r.line_text,
                            f.path, f.language
                     FROM refs r JOIN files f ON r.file_id = f.id
                     WHERE r.name = ?1
                     LIMIT ?2",
                )
                .map_err(|e| AppError::StateError(e.to_string()))?;
            let collected: Vec<RefRow> = stmt
                .query_map(params![name, limit], map_ref_row)
                .map_err(|e| AppError::StateError(e.to_string()))?
                .filter_map(|r| r.ok())
                .collect();
            collected
        };
        Ok(rows)
    }

    /// 查询：当前文件的 imports / package（给排序用）。
    pub fn read_query_context(&self, rel_path: &str) -> Result<QueryContextRow> {
        let conn = self.conn.lock().unwrap();
        let file_id: Option<i64> = conn
            .query_row(
                "SELECT id FROM files WHERE path = ?1",
                params![rel_path],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| AppError::StateError(e.to_string()))?;
        let Some(file_id) = file_id else {
            return Ok(QueryContextRow::default());
        };
        let pkg: Option<String> = conn
            .query_row(
                "SELECT fqn FROM packages WHERE file_id = ?1",
                params![file_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| AppError::StateError(e.to_string()))?;
        let mut stmt = conn
            .prepare("SELECT fqn, short_name, is_static, is_wildcard FROM imports WHERE file_id = ?1")
            .map_err(|e| AppError::StateError(e.to_string()))?;
        let imports: Vec<ImportEntry> = stmt
            .query_map(params![file_id], |row| {
                Ok(ImportEntry {
                    fqn: row.get(0)?,
                    short_name: row.get(1)?,
                    is_static: row.get::<_, i64>(2)? != 0,
                    is_wildcard: row.get::<_, i64>(3)? != 0,
                })
            })
            .map_err(|e| AppError::StateError(e.to_string()))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(QueryContextRow {
            package: pkg,
            imports,
        })
    }

    /// 查询：获取所有已索引文件的 mtime（启动时增量校验用）。
    pub fn list_files_mtime(&self) -> Result<Vec<(String, i64, u64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT path, mtime_ns, size FROM files")
            .map_err(|e| AppError::StateError(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)? as u64,
                ))
            })
            .map_err(|e| AppError::StateError(e.to_string()))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 统计信息（写入 IndexStatus）。
    pub fn stats(&self) -> Result<(u32, u32, u32)> {
        let conn = self.conn.lock().unwrap();
        let files: i64 = conn
            .query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))
            .unwrap_or(0);
        let symbols: i64 = conn
            .query_row("SELECT COUNT(*) FROM symbols", [], |r| r.get(0))
            .unwrap_or(0);
        let refs: i64 = conn
            .query_row("SELECT COUNT(*) FROM refs", [], |r| r.get(0))
            .unwrap_or(0);
        Ok((files as u32, symbols as u32, refs as u32))
    }

    /// 设置 last_built_at。
    pub fn set_last_built_at(&self, ms: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES('last_built_at', ?1)",
            params![ms.to_string()],
        )
        .map_err(|e| AppError::StateError(e.to_string()))?;
        Ok(())
    }

    pub fn get_last_built_at(&self) -> Option<i64> {
        let conn = self.conn.lock().unwrap();
        let v: Option<String> = conn
            .query_row(
                "SELECT value FROM meta WHERE key='last_built_at'",
                [],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten();
        v.and_then(|s| s.parse::<i64>().ok())
    }
}

// ── 行映射 / 内部插入 ───────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SymbolRow {
    pub name: String,
    pub fqn: String,
    pub kind: SymbolKind,
    pub parent_fqn: Option<String>,
    pub line: u32,
    pub column: u32,
    pub name_line: u32,
    pub name_column: u32,
    pub signature: Option<String>,
    pub modifiers: u32,
    /// 工作区相对路径
    pub rel_path: String,
    pub language: String,
    pub package: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RefRow {
    pub name: String,
    pub line: u32,
    pub column: u32,
    pub end_column: u32,
    pub ref_kind: RefKind,
    pub target_fqn: Option<String>,
    pub line_text: String,
    pub rel_path: String,
    pub language: String,
}

#[derive(Debug, Clone, Default)]
pub struct QueryContextRow {
    pub package: Option<String>,
    pub imports: Vec<ImportEntry>,
}

fn map_symbol_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SymbolRow> {
    Ok(SymbolRow {
        name: row.get(0)?,
        fqn: row.get(1)?,
        kind: SymbolKind::from_i64(row.get(2)?),
        parent_fqn: row.get(3)?,
        line: row.get::<_, i64>(4)? as u32,
        column: row.get::<_, i64>(5)? as u32,
        name_line: row.get::<_, i64>(6)? as u32,
        name_column: row.get::<_, i64>(7)? as u32,
        signature: row.get(8)?,
        modifiers: row.get::<_, i64>(9)? as u32,
        rel_path: row.get(10)?,
        language: row.get(11)?,
        package: row.get(12)?,
    })
}

fn map_ref_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RefRow> {
    Ok(RefRow {
        name: row.get(0)?,
        line: row.get::<_, i64>(1)? as u32,
        column: row.get::<_, i64>(2)? as u32,
        end_column: row.get::<_, i64>(3)? as u32,
        ref_kind: RefKind::from_i64(row.get(4)?),
        target_fqn: row.get(5)?,
        line_text: row.get(6)?,
        rel_path: row.get(7)?,
        language: row.get(8)?,
    })
}

fn delete_file_by_path(tx: &Transaction<'_>, rel_path: &str) -> Result<()> {
    // ON DELETE CASCADE 会清理 symbols/refs/imports/packages
    tx.execute("DELETE FROM files WHERE path = ?1", params![rel_path])
        .map_err(|e| AppError::StateError(e.to_string()))?;
    Ok(())
}

fn insert_file_index(tx: &Transaction<'_>, fi: &FileIndex) -> Result<()> {
    tx.execute(
        "INSERT INTO files(path, language, mtime_ns, size, content_hash, indexed_at, parse_error)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            fi.rel_path,
            fi.language,
            fi.mtime_ns,
            fi.size as i64,
            fi.content_hash as i64,
            now_ms(),
            fi.parse_error as i64,
        ],
    )
    .map_err(|e| AppError::StateError(format!("插入 files 失败: {}", e)))?;
    let file_id = tx.last_insert_rowid();

    if let Some(pkg) = &fi.package {
        tx.execute(
            "INSERT INTO packages(file_id, fqn) VALUES(?1, ?2)",
            params![file_id, pkg],
        )
        .map_err(|e| AppError::StateError(format!("插入 packages 失败: {}", e)))?;
    }

    if !fi.symbols.is_empty() {
        let mut stmt = tx
            .prepare(
                "INSERT INTO symbols(file_id, name, fqn, kind, parent_fqn,
                                     line, column, end_line, end_column,
                                     name_line, name_column,
                                     signature, modifiers, visibility)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            )
            .map_err(|e| AppError::StateError(e.to_string()))?;
        for s in &fi.symbols {
            stmt.execute(params![
                file_id,
                &s.name,
                &s.fqn,
                s.kind as u8 as i64,
                s.parent_fqn,
                s.line as i64,
                s.column as i64,
                s.end_line as i64,
                s.end_column as i64,
                s.name_line as i64,
                s.name_column as i64,
                s.signature,
                s.modifiers as i64,
                visibility_of(s.modifiers) as i64,
            ])
            .map_err(|e| AppError::StateError(format!("插入 symbols 失败: {}", e)))?;
        }
    }

    if !fi.refs.is_empty() {
        let mut stmt = tx
            .prepare(
                "INSERT INTO refs(file_id, name, line, column, end_column, ref_kind, target_fqn, line_text)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            )
            .map_err(|e| AppError::StateError(e.to_string()))?;
        for r in &fi.refs {
            stmt.execute(params![
                file_id,
                &r.name,
                r.line as i64,
                r.column as i64,
                r.end_column as i64,
                r.ref_kind as u8 as i64,
                r.target_fqn,
                &r.line_text,
            ])
            .map_err(|e| AppError::StateError(format!("插入 refs 失败: {}", e)))?;
        }
    }

    if !fi.imports.is_empty() {
        let mut stmt = tx
            .prepare(
                "INSERT INTO imports(file_id, fqn, short_name, is_static, is_wildcard)
                 VALUES(?1,?2,?3,?4,?5)",
            )
            .map_err(|e| AppError::StateError(e.to_string()))?;
        for i in &fi.imports {
            stmt.execute(params![
                file_id,
                &i.fqn,
                i.short_name,
                i.is_static as i64,
                i.is_wildcard as i64,
            ])
            .map_err(|e| AppError::StateError(format!("插入 imports 失败: {}", e)))?;
        }
    }

    Ok(())
}

fn visibility_of(modifiers: u32) -> u8 {
    use super::model::modifiers::*;
    if modifiers & PRIVATE != 0 {
        1
    } else if modifiers & PROTECTED != 0 {
        2
    } else if modifiers & PUBLIC != 0 {
        3
    } else {
        0
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 当前 IndexStatus 快照（不含 state/error/progress 等运行时字段）
pub fn read_status(db: &IndexDb) -> IndexStatus {
    let (files, symbols, refs) = db.stats().unwrap_or((0, 0, 0));
    IndexStatus {
        workspace: Some(db.workspace.to_string_lossy().to_string()),
        state: "ready".to_string(),
        progress_done: 0,
        progress_total: 0,
        files,
        symbols,
        refs,
        error: None,
        last_built_at: db.get_last_built_at(),
    }
}
