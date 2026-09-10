//! 存储层：契约 `Storage`/`Transaction` 的 SQLite 实现
//!
//! 布局：`sqlite.rs` = 按域分库 + 审计内嵌 + 真实 query/事务 + FTS 可丢弃索引。
//! 后续仓库（todo/requirement/scheduler）底层切换即用 `storage::SqliteStorage`。

pub mod sqlite;

pub use sqlite::SqliteStorage;