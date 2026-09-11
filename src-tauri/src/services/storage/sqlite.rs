//! 存储层：契约 `Storage`/`Transaction` 的 SQLite 实现（第二步 · 阶段 A）
//!
//! # 借 sky 骨架，不照抄未完成实现
//!
//! 沿用 sky 成熟部分：
//! - 按域分库 `stores/<domain>.db`（不是一个大库，域间隔离）
//! - `domain_audit` 表内嵌各域 DB（同库；审计写走事务连接）
//! - WAL 模式 + `synchronous NORMAL` + busy_timeout（对齐 dialog_index 惯例）
//! - FTS5 外部内容表，可丢弃可重建（绝不做增量索引）
//!
//! 补全 sky 骨架缺失（生产级）：
//! - `query`：sky 只全扫描 + limit 截断，忽略 `q.filter`。
//!   此处把 filter 解析成真实 `WHERE`（`json_extract(data, '$.key')`），
//!   支持字符串/数值/布尔精确匹配与 `limit` 下推。
//! - `begin`：sky 的 commit/rollback 是空操作（事务不真生效）。
//!   此处用真实 `BEGIN IMMEDIATE`：事务持有独立连接（惰性按域开启），
//!   `append_audit` 写入该连接，`commit` 落库 / `rollback` 全回滚（含审计），
//!   Drop 未收尾则自动 ROLLBACK 防悬挂。
//!
//! # 已知缺口（阶段 B 后）→ 已解决
//!
//! - **审计与业务写同库同事务**（裁决1已定）：`Transaction` trait 增加
//!   `store`/`delete`（事务内业务写），`SqliteTransaction` 在同一事务连接上
//!   执行业务写 + 审计写，commit 落库 / rollback 全回滚（含审计）——红线
//!   「同库同事务天然原子」达成。见测试 `txn_business_write_and_audit_commit_together`
//!   与 `txn_rollback_reverts_business_and_audit_together`。
//! - **FTS 无查询路径**：`rebuild_fts` 重建索引但无 `Storage` 查询方法触达 FTS，
//!   后续做全文检索时补（阶段 B 外待办）。

use crate::contracts::{AuditEntry, Id, Item, Query, Storage, Transaction};
use rusqlite::params;
use rusqlite::Connection;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 每域建表 SQL（items + domain_audit 内嵌同库）
const SCHEMA_SQL: &str = "
    CREATE TABLE IF NOT EXISTS items (
        id   TEXT PRIMARY KEY,
        data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS domain_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_ms INTEGER NOT NULL,
        capability TEXT NOT NULL,
        source TEXT NOT NULL,
        action TEXT NOT NULL,
        prev_hash TEXT NOT NULL
    );
";

/// SQLite 存储实现
///
/// 每个域一个 `.db` 文件，`domain_audit` 表内嵌同库。
/// 连接池：`Mutex<HashMap<String, Connection>>`，每域一连接，
/// Phase 0/1 单连接内 Mutex 串行足够；Phase 2 换 async pool 再演进。
pub struct SqliteStorage {
    root_path: PathBuf,
    connections: Mutex<HashMap<String, Connection>>,
}

impl SqliteStorage {
    pub fn new(data_root: &Path) -> Result<Self, String> {
        let stores_dir = data_root.join("stores");
        fs::create_dir_all(&stores_dir).map_err(|e| format!("创建 stores 目录失败: {}", e))?;
        Ok(Self {
            root_path: data_root.to_path_buf(),
            connections: Mutex::new(HashMap::new()),
        })
    }

    fn get_domain_db_path(&self, domain: &str) -> PathBuf {
        self.root_path.join("stores").join(format!("{}.db", domain))
    }

    /// 打开一个域的连接（建目录 + 设 WAL/synchronous/busy_timeout + 建表）。
    /// 连接池与事务连接都走这里，保证 schema 一致。
    ///
    /// busy_timeout 设为 5s：事务连接持 `BEGIN IMMEDIATE` 写锁期间，
    /// 连接池对同域写入会等待而非立即 `SQLITE_BUSY`（rusqlite 默认 0）。
    fn open_domain_conn(&self, domain: &str) -> Result<Connection, String> {
        let db_path = self.get_domain_db_path(domain);
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("打开 {} 数据库失败: {}", domain, e))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| format!("设置 WAL 失败: {}", e))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| format!("设置 synchronous=NORMAL 失败: {}", e))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| format!("设置 busy_timeout 失败: {}", e))?;
        conn.execute_batch(SCHEMA_SQL)
            .map_err(|e| format!("建表失败: {}", e))?;
        Ok(conn)
    }

    /// 取得（或懒创建）一个域的连接，并执行操作。
    fn with_conn<F, R>(&self, domain: &str, f: F) -> Result<R, String>
    where
        F: FnOnce(&Connection) -> Result<R, String>,
    {
        let mut map = self
            .connections
            .lock()
            .map_err(|e| format!("锁连接池失败: {}", e))?;
        if !map.contains_key(domain) {
            let conn = self.open_domain_conn(domain)?;
            map.insert(domain.to_string(), conn);
        }
        // 借用 map.get，然后 drop lock 前执行 f（借用 guard 生命周期内）
        let guard = map.get(domain).ok_or("域连接不存在")?;
        f(guard)
    }

    /// 把 `q.filter` 解析成真实 WHERE 子句与 SQL 参数。
    ///
    /// - `{}` / `Null` / 非对象 → 全扫描（`(None, vec![])`）
    /// - 对象字段 `{"status":"open","priority":3}` →
    ///   `WHERE json_extract(data,'$.status') = ?1 AND json_extract(data,'$.priority') = ?2`
    ///
    /// 字段名白名单校验（只允许字母数字下划线，防注入路径）；
    /// 值经 `serde_json::Value` → `rusqlite::types::Value` 参数化绑定。
    fn build_filter_sql(
        filter: &serde_json::Value,
    ) -> Result<(Option<String>, Vec<rusqlite::types::Value>), String> {
        let serde_json::Value::Object(map) = filter else {
            return Ok((None, Vec::new()));
        };
        if map.is_empty() {
            return Ok((None, Vec::new()));
        }

        let mut wheres: Vec<String> = Vec::new();
        let mut args: Vec<rusqlite::types::Value> = Vec::new();
        for (k, v) in map {
            if k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return Err(format!(
                    "Filter 字段名不合法（只允许字母数字下划线）: {}",
                    k
                ));
            }
            wheres.push(format!("json_extract(data, '$.{}') = ?", k));
            args.push(Self::json_to_sql_value(v));
        }
        Ok((Some(wheres.join(" AND ")), args))
    }

    /// serde_json::Value → rusqlite::types::Value（参数绑定用）
    fn json_to_sql_value(v: &serde_json::Value) -> rusqlite::types::Value {
        match v {
            serde_json::Value::Null => rusqlite::types::Value::Null,
            serde_json::Value::Bool(b) => rusqlite::types::Value::Integer(*b as i64),
            serde_json::Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    rusqlite::types::Value::Integer(i)
                } else if let Some(f) = n.as_f64() {
                    rusqlite::types::Value::Real(f)
                } else {
                    rusqlite::types::Value::Null
                }
            }
            serde_json::Value::String(s) => rusqlite::types::Value::Text(s.clone()),
            // 复合值：json_extract 以文本返回；序列化后等值匹配
            serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
                rusqlite::types::Value::Text(v.to_string())
            }
        }
    }

    /// FTS5 重建（启动同步阻塞，可丢弃可重建）
    ///
    /// 绝不做增量索引。重建 = 全量扫描 items 表重建 FTS 索引。
    pub fn rebuild_fts(&self, domain: &str) -> Result<(), String> {
        self.with_conn(domain, |conn| {
            conn.execute("DROP TABLE IF EXISTS fts_items", [])
                .map_err(|e| format!("删 FTS 表失败: {}", e))?;
            conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS fts_items USING fts5(
                    id, data,
                    content='items', content_rowid='rowid'
                )",
                [],
            )
            .map_err(|e| format!("建 FTS 表失败: {}", e))?;
            conn.execute(
                "INSERT INTO fts_items(rowid, id, data) SELECT rowid, id, data FROM items",
                [],
            )
            .map_err(|e| format!("重建 FTS 索引失败: {}", e))?;
            Ok(())
        })
    }

    /// 审计 source 落库用变体名，不存 token 明文（`Remote { token }` 脱敏）
    fn source_kind(source: &crate::contracts::Source) -> &'static str {
        match source {
            crate::contracts::Source::Bootstrap => "Bootstrap",
            crate::contracts::Source::Remote { .. } => "Remote",
            crate::contracts::Source::Plugin { .. } => "Plugin",
        }
    }
}

impl Storage for SqliteStorage {
    fn root(&self) -> Result<String, String> {
        self.root_path
            .to_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "DataRoot 路径非 UTF-8".into())
    }

    fn store(&self, domain: &str, item: &Item) -> Result<Id, String> {
        let id_str = &item.id.0;
        let data_json =
            serde_json::to_string(&item.data).map_err(|e| format!("序列化失败: {}", e))?;
        self.with_conn(domain, |conn| {
            conn.execute(
                "INSERT OR REPLACE INTO items (id, data) VALUES (?1, ?2)",
                params![id_str, data_json],
            )
            .map_err(|e| format!("写入失败: {}", e))?;
            Ok(())
        })?;
        Ok(item.id.clone())
    }

    fn load(&self, domain: &str, id: &Id) -> Result<Item, String> {
        self.with_conn(domain, |conn| {
            let mut stmt = conn
                .prepare("SELECT data FROM items WHERE id = ?1")
                .map_err(|e| format!("准备查询失败: {}", e))?;
            let result = stmt.query_row(params![id.0], |row| {
                let data_str: String = row.get(0)?;
                Ok(data_str)
            });
            match result {
                Ok(data_str) => {
                    let data: serde_json::Value = serde_json::from_str(&data_str)
                        .map_err(|e| format!("反序列化失败: {}", e))?;
                    Ok(Item { id: id.clone(), data })
                }
                Err(rusqlite::Error::QueryReturnedNoRows) => {
                    Err(format!("项目不存在: {}", id.0))
                }
                Err(e) => Err(format!("查询失败: {}", e)),
            }
        })
    }

    fn query(&self, domain: &str, q: &Query) -> Result<Vec<Item>, String> {
        self.with_conn(domain, |conn| {
            let (where_sql, filter_args) = Self::build_filter_sql(&q.filter)?;

            let base = match &where_sql {
                Some(w) => format!("SELECT id, data FROM items WHERE {}", w),
                None => "SELECT id, data FROM items".to_string(),
            };
            let sql = match q.limit {
                Some(_) => format!("{} LIMIT ?", base),
                None => base,
            };

            let mut stmt = conn.prepare(&sql).map_err(|e| format!("准备查询失败: {}", e))?;

            // 参数：filter args + 可选 limit
            let mut all_args = filter_args;
            if let Some(limit) = q.limit {
                all_args.push(rusqlite::types::Value::Integer(limit as i64));
            }

            let rows = stmt
                .query_map(rusqlite::params_from_iter(all_args), |row| {
                    let id_str: String = row.get(0)?;
                    let data_str: String = row.get(1)?;
                    Ok((id_str, data_str))
                })
                .map_err(|e| format!("执行查询失败: {}", e))?;

            let mut items = Vec::new();
            for row in rows {
                let (id_str, data_str) = row.map_err(|e| format!("读取行失败: {}", e))?;
                let data: serde_json::Value = serde_json::from_str(&data_str)
                    .map_err(|e| format!("反序列化失败: {}", e))?;
                items.push(Item { id: Id(id_str), data });
            }
            Ok(items)
        })
    }

    fn delete(&self, domain: &str, id: &Id) -> Result<(), String> {
        self.with_conn(domain, |conn| {
            conn.execute("DELETE FROM items WHERE id = ?1", params![id.0])
                .map_err(|e| format!("删除失败: {}", e))?;
            Ok(())
        })
    }

    /// 开启一场真实事务（`BEGIN IMMEDIATE`）。
    ///
    /// 事务连接惰性按域开启（第一个 `append_audit` 时针对该域 `BEGIN IMMEDIATE`）。
    /// commit 落库 / rollback 全回滚（含审计），Drop 未收尾则自动回滚。
    fn begin(&self) -> Result<Box<dyn Transaction + '_>, String> {
        Ok(Box::new(SqliteTransaction {
            storage: self,
            conns: HashMap::new(),
            finished: false,
        }))
    }
}

/// SQLite 事务（借用生命周期，对齐契约 `Box<dyn Transaction + '_>`）
///
/// 事务连接不与连接池共享：`append_audit` 在独立连接上执行
/// `BEGIN IMMEDIATE` → 写入 `domain_audit`。commit/rollback 控制该连接上
/// 所有写入的同事务原子性。与连接池业务写的隔离由 WAL 快照隔离提供
/// （事务连接开启期间，连接池对该域的并发写仍可见，见测试
/// audit_rollback_reverts_after_writes）。
///
/// 契约红线「审计与业务写同库同事务」：`Transaction::store`/`delete` 在同一
/// 事务连接上执行业务写（`tx_conn` 复用），commit 落库 / rollback 全回滚
/// （含审计）。业务写与审计完全同事务，见测试
/// txn_business_write_and_audit_commit_together 与
/// txn_rollback_reverts_business_and_audit_together。
pub struct SqliteTransaction<'a> {
    storage: &'a SqliteStorage,
    /// 已开启事务的域连接（惰性创建）
    conns: HashMap<String, Connection>,
    /// 是否已 commit/rollback（防 Drop 重复回滚）
    finished: bool,
}

impl SqliteTransaction<'_> {
    /// 按域取得事务连接；首次访问时打开该域库并 `BEGIN IMMEDIATE`。
    fn tx_conn(&mut self, domain: &str) -> Result<&mut Connection, String> {
        if !self.conns.contains_key(domain) {
            let conn = self.storage.open_domain_conn(domain)?;
            conn.execute("BEGIN IMMEDIATE", [])
                .map_err(|e| format!("开始事务失败: {}", e))?;
            self.conns.insert(domain.to_string(), conn);
        }
        self.conns
            .get_mut(domain)
            .ok_or_else(|| format!("事务连接不存在: {}", domain))
    }
}

impl Transaction for SqliteTransaction<'_> {
    fn commit(&mut self) -> Result<(), String> {
        if self.finished {
            return Err("事务已结束".into());
        }
        for (domain, conn) in self.conns.iter_mut() {
            conn.execute("COMMIT", [])
                .map_err(|e| format!("提交事务失败({}): {}", domain, e))?;
        }
        self.finished = true;
        Ok(())
    }

    fn rollback(&mut self) -> Result<(), String> {
        if self.finished {
            return Err("事务已结束".into());
        }
        for (domain, conn) in self.conns.iter_mut() {
            conn.execute("ROLLBACK", [])
                .map_err(|e| format!("回滚事务失败({}): {}", domain, e))?;
        }
        self.finished = true;
        Ok(())
    }

    fn append_audit(&mut self, domain: &str, entry: &AuditEntry) -> Result<(), String> {
        let source_kind = SqliteStorage::source_kind(&entry.source);
        let conn = self.tx_conn(domain)?;
        conn.execute(
            "INSERT INTO domain_audit (timestamp_ms, capability, source, action, prev_hash)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                entry.timestamp_ms as i64,
                entry.capability.0,
                source_kind,
                entry.action,
                entry.prev_hash,
            ],
        )
        .map_err(|e| format!("审计写入失败: {}", e))?;
        Ok(())
    }

    fn store(&mut self, domain: &str, item: &Item) -> Result<Id, String> {
        // 复用 tx_conn：在同一事务连接上写 items 表 → 与 append_audit 同事务
        let conn = self.tx_conn(domain)?;
        let data = serde_json::to_string(&item.data)
            .map_err(|e| format!("序列化业务数据失败: {}", e))?;
        conn.execute(
            "INSERT INTO items (id, data) VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![item.id.0, data],
        )
        .map_err(|e| format!("事务业务写失败: {}", e))?;
        Ok(item.id.clone())
    }

    fn delete(&mut self, domain: &str, id: &Id) -> Result<(), String> {
        // 同一事务连接上的业务删 → 与 append_audit 同事务
        let conn = self.tx_conn(domain)?;
        conn.execute("DELETE FROM items WHERE id = ?1", params![id.0])
            .map_err(|e| format!("事务业务删失败: {}", e))?;
        Ok(())
    }
}

impl Drop for SqliteTransaction<'_> {
    fn drop(&mut self) {
        // 未收尾而丢弃 → 自动回滚（防悬挂事务占用 WAL）
        if !self.finished {
            for (_, conn) in self.conns.iter_mut() {
                let _ = conn.execute("ROLLBACK", []);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{CapabilityId, Source};
    use std::fs;

    /// 每次唯一目录，避免并发测试污染
    fn setup_storage() -> (PathBuf, SqliteStorage) {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let mut name = "polaris-test-storage-sqlite-".to_string();
        name.push_str(&COUNTER.fetch_add(1, Ordering::SeqCst).to_string());
        let tmp = std::env::temp_dir().join(name);
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let storage = SqliteStorage::new(&tmp).unwrap();
        (tmp, storage)
    }

    /// 审计表行数（同文件测试可访问私有方法）
    fn audit_count(storage: &SqliteStorage, domain: &str) -> i64 {
        storage
            .with_conn(domain, |conn| {
                conn.query_row("SELECT COUNT(*) FROM domain_audit", [], |r| r.get(0))
                    .map_err(|e| e.to_string())
            })
            .unwrap()
    }

    fn make_entry() -> AuditEntry {
        AuditEntry {
            timestamp_ms: 1000,
            capability: CapabilityId("cap.echo".into()),
            source: Source::Bootstrap,
            action: "store".into(),
            prev_hash: "0".repeat(64),
        }
    }

    #[test]
    fn store_and_load_roundtrip() {
        let (_tmp, storage) = setup_storage();
        let item = Item {
            id: Id("test-1".into()),
            data: serde_json::Value::String("hello".into()),
        };
        let id = storage.store("test_domain", &item).unwrap();
        assert_eq!(id.0, "test-1");

        let loaded = storage.load("test_domain", &Id("test-1".into())).unwrap();
        assert_eq!(loaded.id.0, "test-1");
        assert_eq!(loaded.data, serde_json::Value::String("hello".into()));
    }

    #[test]
    fn query_with_filter_returns_matching_rows() {
        let (_tmp, storage) = setup_storage();
        storage
            .store(
                "domain_a",
                &Item {
                    id: Id("a1".into()),
                    data: serde_json::json!({"status": "open", "priority": 3}),
                },
            )
            .unwrap();
        storage
            .store(
                "domain_a",
                &Item {
                    id: Id("a2".into()),
                    data: serde_json::json!({"status": "closed", "priority": 1}),
                },
            )
            .unwrap();
        storage
            .store(
                "domain_a",
                &Item {
                    id: Id("a3".into()),
                    data: serde_json::json!({"status": "open", "priority": 5}),
                },
            )
            .unwrap();

        let r = storage
            .query(
                "domain_a",
                &Query {
                    filter: serde_json::json!({ "status": "open" }),
                    limit: None,
                },
            )
            .unwrap();
        assert_eq!(r.len(), 2);
        let ids: Vec<_> = r.iter().map(|i| i.id.0.as_str()).collect();
        assert!(ids.contains(&"a1"));
        assert!(ids.contains(&"a3"));
    }

    #[test]
    fn query_with_numeric_filter() {
        let (_tmp, storage) = setup_storage();
        storage
            .store(
                "domain_n",
                &Item {
                    id: Id("n1".into()),
                    data: serde_json::json!({"priority": 3}),
                },
            )
            .unwrap();
        storage
            .store(
                "domain_n",
                &Item {
                    id: Id("n2".into()),
                    data: serde_json::json!({"priority": 1}),
                },
            )
            .unwrap();
        let r = storage
            .query(
                "domain_n",
                &Query {
                    filter: serde_json::json!({ "priority": 3 }),
                    limit: None,
                },
            )
            .unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id.0, "n1");
    }

    #[test]
    fn query_with_limit() {
        let (_tmp, storage) = setup_storage();
        for i in 0..5 {
            storage
                .store(
                    "limit_domain",
                    &Item {
                        id: Id(format!("l{}", i)),
                        data: serde_json::json!(i),
                    },
                )
                .unwrap();
        }
        let r = storage
            .query(
                "limit_domain",
                &Query {
                    filter: serde_json::Value::Null,
                    limit: Some(3),
                },
            )
            .unwrap();
        assert_eq!(r.len(), 3);
    }

    #[test]
    fn delete_then_load_fails() {
        let (_tmp, storage) = setup_storage();
        storage
            .store(
                "del_domain",
                &Item {
                    id: Id("d1".into()),
                    data: serde_json::Value::String("x".into()),
                },
            )
            .unwrap();
        assert!(storage.delete("del_domain", &Id("d1".into())).is_ok());
        assert!(storage.load("del_domain", &Id("d1".into())).is_err());
    }

    #[test]
    fn audit_commit_persists() {
        let (_tmp, storage) = setup_storage();
        storage
            .store(
                "audit_commit",
                &Item {
                    id: Id("x1".into()),
                    data: serde_json::Value::String("data".into()),
                },
            )
            .unwrap();

        let mut txn = storage.begin().unwrap();
        txn.append_audit("audit_commit", &make_entry()).unwrap();
        drop(txn); // Drop 未收尾 → 自动回滚

        // 事务已 drop（未 commit），不应落库
        assert_eq!(audit_count(&storage, "audit_commit"), 0);

        // 重新开事务并 commit
        let mut txn = storage.begin().unwrap();
        txn.append_audit("audit_commit", &make_entry()).unwrap();
        txn.commit().unwrap();
        assert_eq!(audit_count(&storage, "audit_commit"), 1);
    }

    #[test]
    fn audit_commit_persists_immediately() {
        let (_tmp, storage) = setup_storage();
        let mut txn = storage.begin().unwrap();
        txn.append_audit("audit_c", &make_entry()).unwrap();
        txn.commit().unwrap();
        assert_eq!(audit_count(&storage, "audit_c"), 1);
    }

    #[test]
    fn audit_rollback_reverts() {
        let (_tmp, storage) = setup_storage();
        let mut txn = storage.begin().unwrap();
        txn.append_audit("audit_r", &make_entry()).unwrap();
        txn.rollback().unwrap();
        // 回滚 → 审计不落库（真实事务，非 sky 骨架空操作）
        assert_eq!(audit_count(&storage, "audit_r"), 0);
    }

    #[test]
    fn audit_rollback_reverts_after_writes() {
        let (_tmp, storage) = setup_storage();
        // 先写一条业务数据
        storage
            .store(
                "audit_rw",
                &Item {
                    id: Id("r1".into()),
                    data: serde_json::json!({"status": "open"}),
                },
            )
            .unwrap();

        let mut txn = storage.begin().unwrap();
        txn.append_audit("audit_rw", &make_entry()).unwrap();
        txn.append_audit("audit_rw", &make_entry()).unwrap();
        assert_eq!(audit_count(&storage, "audit_rw"), 0); // 未 commit 看不到
        txn.rollback().unwrap();
        // 两条审计都回滚
        assert_eq!(audit_count(&storage, "audit_rw"), 0);
    }

    #[test]
    fn fts5_rebuild_is_dropable_and_rebuildable() {
        let (_tmp, storage) = setup_storage();
        storage
            .store(
                "fts_domain",
                &Item {
                    id: Id("f1".into()),
                    data: serde_json::Value::String("hello world".into()),
                },
            )
            .unwrap();
        storage
            .store(
                "fts_domain",
                &Item {
                    id: Id("f2".into()),
                    data: serde_json::Value::String("foo bar".into()),
                },
            )
            .unwrap();
        assert!(storage.rebuild_fts("fts_domain").is_ok());
        assert!(storage.rebuild_fts("fts_domain").is_ok());
    }

    #[test]
    fn audit_source_kind_not_token() {
        let (_tmp, storage) = setup_storage();
        let mut txn = storage.begin().unwrap();
        let entry = AuditEntry {
            timestamp_ms: 1000,
            capability: CapabilityId("cap.echo".into()),
            source: Source::Remote { token: "SECRET_TOKEN".into() },
            action: "store".into(),
            prev_hash: "0".repeat(64),
        };
        txn.append_audit("audit_src", &entry).unwrap();
        txn.commit().unwrap();

        let stored: String = storage
            .with_conn("audit_src", |conn| {
                conn.query_row("SELECT source FROM domain_audit", [], |r| r.get(0))
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(stored, "Remote", "审计 source 应存变体名，不存 token");
        assert!(!stored.contains("SECRET_TOKEN"));
    }

    #[test]
    fn filter_field_name_injection_rejected() {
        let (_tmp, storage) = setup_storage();
        storage
            .store(
                "inj_domain",
                &Item {
                    id: Id("i1".into()),
                    data: serde_json::json!({"a\":1;DROP TABLE items": "x"}),
                },
            )
            .unwrap();
        // 字段名含非法字符 → 拒绝而非执行
        let r = storage.query(
            "inj_domain",
            &Query {
                filter: serde_json::json!({"status\"; DROP TABLE items;--": "open"}),
                limit: None,
            },
        );
        assert!(r.is_err());
    }

    // =========================================================================
    // 裁决1：审计与业务写「同事务」（Transaction::store/delete）
    // =========================================================================

    /// 业务数据是否存在于 items 表
    fn item_exists(storage: &SqliteStorage, domain: &str, id: &str) -> bool {
        storage
            .with_conn(domain, |conn| {
                conn.query_row("SELECT COUNT(*) FROM items WHERE id = ?1", params![id], |r| {
                    r.get::<_, i64>(0)
                })
                .map_err(|e| e.to_string())
            })
            .unwrap()
            > 0
    }

    #[test]
    fn txn_business_write_and_audit_commit_together() {
        let (_tmp, storage) = setup_storage();
        let entry = AuditEntry {
            timestamp_ms: 2000,
            capability: CapabilityId("cap.todo.create".into()),
            source: Source::Bootstrap,
            action: "store".into(),
            prev_hash: "0".repeat(64),
        };
        let item = Item {
            id: Id("t1".into()),
            data: serde_json::json!({"content": "一起提交"}),
        };

        // 同一事务：业务写 + 审计写，commit 后都落库
        let mut txn = storage.begin().unwrap();
        txn.store("txn_domain", &item).unwrap();
        txn.append_audit("txn_domain", &entry).unwrap();
        txn.commit().unwrap();

        assert!(item_exists(&storage, "txn_domain", "t1"), "业务写应已落库");
        let audit: i64 = storage
            .with_conn("txn_domain", |conn| {
                conn.query_row("SELECT COUNT(*) FROM domain_audit", [], |r| r.get(0))
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(audit, 1, "审计应已落库");
    }

    #[test]
    fn txn_rollback_reverts_business_and_audit_together() {
        let (_tmp, storage) = setup_storage();
        let entry = make_entry();
        let item = Item {
            id: Id("t2".into()),
            data: serde_json::json!({"content": "一起回滚"}),
        };

        // 同一事务：业务写 + 审计写，rollback 后都消失
        let mut txn = storage.begin().unwrap();
        txn.store("txn_rb", &item).unwrap();
        txn.append_audit("txn_rb", &entry).unwrap();
        txn.rollback().unwrap();

        assert!(!item_exists(&storage, "txn_rb", "t2"), "业务写应已回滚");
        let audit: i64 = storage
            .with_conn("txn_rb", |conn| {
                conn.query_row("SELECT COUNT(*) FROM domain_audit", [], |r| r.get(0))
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(audit, 0, "审计应已回滚（同事务，不留残留）");
    }
}