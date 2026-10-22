//! 遗留存储一次性迁移（数据根红线收口）。
//!
//! 根因（plans/storage-normalization-v1-spec.md F2/F4）：
//! 1. requirement 双落点：桌面命令层历史用 Tauri `app_config_dir()`
//!    （= %APPDATA%\com.polaris.app），而 Web/MCP 写读 DataRoot
//!    （%APPDATA%\Polaris）——同一需求库（SQLite `stores/requirement.db`
//!    + 原型 blob `requirements/prototypes` + `workspaces.json`）分裂。
//! 2. Claude settings 级联曾把 Polaris 管理的 env 写进 `%APPDATA%\claude\settings.json`
//!    （Claude CLI 永不读取的文件），存量垃圾需要惰性归档。
//!
//! 设计纪律（对抗审查补丁，务必保持）：
//! - 只处理 `com.polaris.app` 下的**具名单文件** `stores/requirement.db`，
//!   绝不用整目录扫描——该目录还有活的 `stores/scheduler.db`，整目录迁移会误伤。
//! - SQLite 迁移走 `VACUUM INTO` 一致快照（自动含 WAL 已提交事务），不用文件复制；
//!   复制后再 `PRAGMA integrity_check`，杜绝半截产物进目标位。
//! - 顺序：incoming 复制 → integrity → 原子 rename 进目标位 → 源改名 `.migrated-{ts}`
//!   （保留不删，杜绝跨卷删源的不可逆风险）→ tombstone（`.meta/requirement-migration.json`）
//!   **携带目标根路径**做幂等（防 anchor 切换窗口重复导入）。
//! - `requirements/` 下的 workspaces.json / prototypes 用 source-authoritative
//!   冲突规则（目标存在且不同于源 → 目标改名 `.stale-{ts}` 再落源）。
//!   根因：DataRoot 侧可能存有陈旧中间产物，默认 overwrite=false
//!   会 stale-wins（陈旧内容顶掉鲜活数据）。
//! - dev/test 隔离根（POLARIS_DATA_ROOT env）不吸收正式版遗留数据。
//! - 全程 best-effort：任何失败仅 warn，绝不 panic、绝不阻塞启动。

use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Tauri 遗留配置目录名（data_root.rs 的 legacy 扫描同源语义）。
const LEGACY_APP_DIR_NAME: &str = "com.polaris.app";

/// tombstone 文件名（落 `<DataRoot>/.meta/` 下）。
const REQUIREMENT_MIGRATION_MARKER: &str = "requirement-migration.json";

/// F2 入口：桌面 / web 双冷启动点在 setup 早期调用一次。
///
/// 幂等：tombstone 存在 → 直接返回；源不存在 → 无操作。
/// 只在非隔离根运行（POLARIS_DATA_ROOT 是 dev/test 注入变量）。
pub fn run_legacy_storage_migration() {
    // dev/test 隔离：数据根被 env 显式指定（tauri:dev:web 注入 Polaris-dev 等）
    // 时跳过——不把正式版遗留数据吸进开发根（spec「dev 变体不迁移」承诺）。
    if let Ok(env) = std::env::var("POLARIS_DATA_ROOT") {
        if !env.trim().is_empty() {
            tracing::debug!("[legacy-migrate] POLARIS_DATA_ROOT 隔离根，跳过遗留迁移");
            return;
        }
    }

    let data_root_dir = crate::services::data_root::data_root().config_dir();

    archive_polaris_managed_claude_settings();

    let Some(os_config) = dirs::config_dir() else {
        return; // 无 OS 配置目录（罕见平台），无可迁移
    };
    let legacy_dir = os_config.join(LEGACY_APP_DIR_NAME);
    if !legacy_dir.exists() {
        return;
    }

    if let Err(e) = migrate_legacy_requirement(&legacy_dir, &data_root_dir) {
        tracing::warn!(
            "[legacy-migrate] requirement 遗留迁移中断（best-effort，下次启动重试）: {}",
            e
        );
    }
}

// ============================================================================
// requirement：legacy com.polaris.app → DataRoot
// ============================================================================

/// 迁移实施函数（`legacy_dir` 与 `data_root_dir` 均为显式传入，纯隔离可测）。
pub(crate) fn migrate_legacy_requirement(legacy_dir: &Path, data_root_dir: &Path) -> std::io::Result<()> {
    let meta_dir = data_root_dir.join(".meta");
    let marker = meta_dir.join(REQUIREMENT_MIGRATION_MARKER);
    if marker.exists() {
        tracing::debug!(
            "[legacy-migrate] requirement 迁移已完成（tombstone 在 {}）",
            marker.display()
        );
        return Ok(());
    }

    fs::create_dir_all(&meta_dir)?;

    // ── 1) SQLite 主库：VACUUM INTO 快照，绝不触碰同目录的 scheduler.db/kv.db ──
    let legacy_db = legacy_dir.join("stores").join("requirement.db");
    let dst_db = data_root_dir.join("stores").join("requirement.db");

    if legacy_db.exists() {
        migrate_requirement_db(&legacy_db, &dst_db)?;
        rename_source(&legacy_db, "requirement.db.migrated")?;
        tracing::info!(
            "[legacy-migrate] requirement.db 已迁移：{} → {}",
            legacy_db.display(),
            dst_db.display()
        );
    }

    // ── 2) requirements/ 下的 workspaces.json 与 prototypes/（source-authoritative）──
    let legacy_req = legacy_dir.join("requirements");
    if legacy_req.exists() {
        migrate_json_file(
            &legacy_req.join("workspaces.json"),
            &data_root_dir.join("requirements").join("workspaces.json"),
        )?;
        migrate_dir_flat(
            &legacy_req.join("prototypes"),
            &data_root_dir.join("requirements").join("prototypes"),
        )?;
    }

    write_requirement_tombstone(&marker, legacy_dir, data_root_dir)?;
    Ok(())
}

/// SQLite 一致快照迁移：VACUUM INTO → integrity_check → 原子改名进目标位。
///
/// 失败路径：删 incoming、保留源、不建 tombstone（下次启动可幂等重试）。
fn migrate_requirement_db(src: &Path, dst: &Path) -> std::io::Result<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    if dst.exists() {
        tracing::warn!(
            "[legacy-migrate] 目标 {} 已存在，跳过主库迁移（防 stale-wins；源 {} 原样保留）",
            dst.display(),
            src.display()
        );
        return Ok(());
    }

    let ts = epoch_millis();
    let incoming = dst.with_file_name(format!(
        "{}.incoming-{ts}",
        dst.file_name().and_then(|n| n.to_str()).unwrap_or("requirement.db")
    ));
    let _ = fs::remove_file(&incoming); // 上次中断的残片清理

    let copy_result: std::result::Result<(), String> = (|| {
        let conn =
            rusqlite::Connection::open(src).map_err(|e| format!("打开遗留库失败: {}", e))?;
        conn.execute("VACUUM INTO ?1", [incoming.to_string_lossy().as_ref()])
            .map_err(|e| format!("VACUUM INTO 快照失败: {}", e))?;
        drop(conn);

        let copied = rusqlite::Connection::open(&incoming)
            .map_err(|e| format!("打开快照失败: {}", e))?;
        let check: String = copied
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| format!("integrity_check 失败: {}", e))?;
        if check != "ok" {
            return Err(format!("快照完整性校验未通过: {}", check));
        }
        drop(copied);
        Ok(())
    })();

    match copy_result {
        Ok(()) => {
            // 同卷 rename，原子发布——半截产物永远不会出现在目标位
            fs::rename(&incoming, dst).inspect_err(|_| {
                let _ = fs::remove_file(&incoming);
            })?;
            Ok(())
        }
        Err(msg) => {
            let _ = fs::remove_file(&incoming);
            Err(std::io::Error::other(format!(
                "requirement.db 快照迁移失败（源保留，不建 tombstone）: {}",
                msg
            )))
        }
    }
}

/// 源文件改名保留（幂等收据；不删除——旧版本二进制仍可读旧目录）。
fn rename_source(src: &Path, archived_full_name: &str) -> std::io::Result<()> {
    let ts = epoch_millis();
    let archived = src.with_file_name(format!("{}.{ts}", archived_full_name));
    fs::rename(src, &archived)?;
    tracing::info!("[legacy-migrate] 源文件已改名保留: {}", archived.display());
    Ok(())
}

/// 单 JSON 文件迁移（source-authoritative）：
/// - 目标缺失 → 原子写入源内容；
/// - 目标存在且内容相同 → 跳过；
/// - 目标存在且不同 → 目标改名 `.stale-{ts}` 保留后，再落源内容。
fn migrate_json_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !src.exists() {
        return Ok(());
    }
    let src_bytes = fs::read(src)?;
    if dst.exists() {
        let dst_bytes = fs::read(dst)?;
        if dst_bytes == src_bytes {
            return Ok(());
        }
        let ts = epoch_millis();
        let stale = dst.with_file_name(format!(
            "{}.stale-{ts}",
            dst.file_name().and_then(|n| n.to_str()).unwrap_or("workspaces.json")
        ));
        fs::rename(dst, &stale)?;
        tracing::warn!(
            "[legacy-migrate] 目标 {} 与遗留源内容不同（疑似陈旧中间产物），已改名保留为 {}，随后以遗留源落盘",
            dst.display(),
            stale.display()
        );
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    atomic_write(dst, &src_bytes)
}

/// 目录内容迁移（source-authoritative，不覆盖：冲突时目标改名归档，源胜出）。
fn migrate_dir_flat(src_dir: &Path, dst_dir: &Path) -> std::io::Result<()> {
    let Ok(entries) = fs::read_dir(src_dir) else {
        return Ok(()); // 源目录不存在 = 无原型可迁
    };
    fs::create_dir_all(dst_dir)?;
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue; // 只处理平铺文件
        }
        let Some(name) = p.file_name() else { continue };
        let dst = dst_dir.join(name);
        let src_bytes = fs::read(&p)?;
        if dst.exists() {
            let dst_bytes = fs::read(&dst)?;
            if dst_bytes == src_bytes {
                continue;
            }
            let ts = epoch_millis();
            let stale = dst.with_file_name(format!(
                "{}.stale-{ts}",
                name.to_str().unwrap_or("prototype.html")
            ));
            fs::rename(&dst, &stale)?;
            tracing::warn!(
                "[legacy-migrate] 原型 {} 冲突，目标改名保留为 {}",
                dst.display(),
                stale.display()
            );
        }
        atomic_write(&dst, &src_bytes)?;
    }
    Ok(())
}

/// tombstone：幂等收据，**携带双方根路径**（防 anchor 切换窗口误判重复导入）。
fn write_requirement_tombstone(
    marker: &Path,
    from: &Path,
    to: &Path,
) -> std::io::Result<()> {
    let payload = serde_json::json!({
        "schemaVersion": 1,
        "kind": "requirement-legacy-migration",
        "from": from.to_string_lossy(),
        "to": to.to_string_lossy(),
        "migratedAt": chrono_now_iso(),
    });
    atomic_write(
        marker,
        serde_json::to_string_pretty(&payload)
            .unwrap_or_default()
            .as_bytes(),
    )
}

fn atomic_write(dst: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let ts = epoch_millis();
    let tmp = dst.with_file_name(format!(
        "{}.tmp-{ts}",
        dst.file_name().and_then(|n| n.to_str()).unwrap_or("file")
    ));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, dst)?;
    Ok(())
}

fn epoch_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn chrono_now_iso() -> String {
    // chrono 已是依赖（unified_requirement_repository 用 Utc）
    chrono::Utc::now().to_rfc3339()
}

// ============================================================================
// F4 收尾：%APPDATA%\claude\settings.json 存量归档（Claude CLI 不读的垃圾）
// ============================================================================

/// Polaris 历史写入该文件的 env 键全集（cascade/clear 与引擎 EnvKeyMapping 联合）。
const POLARIS_MANAGED_ENV_KEYS: [&str; 8] = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_REASONING_MODEL",
    "ANTHROPIC_API_KEY",
];

/// F4 惰性归档：`%APPDATA%\claude\settings.json` 是级联 bug 写出的垃圾
/// （Claude CLI 只读 `~/.claude/settings.json`），但可能是用户手工文件——
/// 仅当其中含 Polaris 管理键时改名归档，**不删除**（防止误伤）。
fn archive_polaris_managed_claude_settings() {
    let Some(base) = dirs::config_dir() else { return };
    let garbage = base.join("claude").join("settings.json");
    if !garbage.exists() {
        return;
    }
    let Ok(raw) = fs::read_to_string(&garbage) else {
        return;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return; // 非 JSON（可能是用户手工内容），不动
    };
    let contains_managed = json
        .get("env")
        .and_then(|v| v.as_object())
        .map(|env| POLARIS_MANAGED_ENV_KEYS.iter().any(|k| env.contains_key(*k)))
        .unwrap_or(false);
    if !contains_managed {
        return;
    }

    let ts = epoch_millis();
    let archived = garbage.with_file_name(format!("settings.json.legacy-polaris-{ts}"));
    match fs::rename(&garbage, &archived) {
        Ok(()) => tracing::info!(
            "[legacy-migrate] 已归档级联 bug 写出的存量（不删除）: {}",
            archived.display()
        ),
        Err(e) => tracing::warn!("[legacy-migrate] 归档存量 Claude settings 失败（不阻塞）: {}", e),
    }
}

// ============================================================================
// tests（CI 运行；本机 cargo test --lib 不可用，AGENTS 已知边界）
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "polaris-legacy-migrate-{}-{name}-{}",
            std::process::id(),
            epoch_millis()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn assert_table_integrity(db: &Path) {
        let conn = rusqlite::Connection::open(db).unwrap();
        let check: String = conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(check, "ok");
    }

    fn seed_sqlite_db(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE item (id TEXT PRIMARY KEY, data TEXT NOT NULL);
             INSERT INTO item VALUES ('r1', '{\"id\":\"r1\"}');",
        )
        .unwrap();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").ok();
    }

    #[test]
    fn requirement_db_snapshot_copy_is_atomic_and_valid() {
        let dir = tmp_dir("db-copy");
        let src = dir.join("legacy").join("requirement.db");
        seed_sqlite_db(&src);

        let dst = dir.join("data-root").join("stores").join("requirement.db");
        migrate_requirement_db(&src, &dst).unwrap();

        assert!(dst.exists());
        assert!(!dir
            .join("data-root")
            .join("stores")
            .read_dir()
            .unwrap()
            .flatten()
            .any(|e: std::fs::DirEntry| {
                e.file_name().to_string_lossy().contains("incoming")
            }));
        assert_table_integrity(&dst);
        assert!(src.exists(), "源必须保留（best-effort 语义）");

        // 幂等重试：目标已存在 → 跳过不覆盖
        migrate_requirement_db(&src, &dst).unwrap();
        assert_table_integrity(&dst);
    }

    #[test]
    fn poisoned_target_is_never_overwritten() {
        let dir = tmp_dir("poison");
        let src = dir.join("legacy").join("requirement.db");
        seed_sqlite_db(&src);

        // 目标位手工布置坏内容（模拟上次迁移中断的半截库）
        let dst = dir.join("data-root").join("requirement.db");
        fs::write(&dst, b"PK-04 broken half-written db").unwrap();

        migrate_requirement_db(&src, &dst).unwrap();
        // 目标已存在 → 跳过且不覆盖，来源保留
        assert_eq!(fs::read(&dst).unwrap(), b"PK-04 broken half-written db");
        assert!(src.exists());
    }

    #[test]
    fn source_authoritative_json_rule() {
        let dir = tmp_dir("json");
        let data_root = dir.join("data-root");
        fs::create_dir_all(data_root.join("requirements")).unwrap();

        // DataRoot 侧陈旧中间产物 vs legacy 活数据
        let stale_dst = data_root.join("requirements").join("workspaces.json");
        fs::write(&stale_dst, r#"{"version":"1.0.0","workspaces":[{"path":"OLD"}]}"#).unwrap();
        let legacy = dir.join("legacy").join("requirements").join("workspaces.json");
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, r#"{"version":"1.0.0","workspaces":[{"path":"LIVE"}]}"#).unwrap();

        migrate_json_file(&legacy, &stale_dst).unwrap();

        let content = fs::read_to_string(&stale_dst).unwrap();
        assert!(
            content.contains("LIVE"),
            "source-authoritative：遗留源（鲜活）应胜出"
        );
        let stale_archives: Vec<_> = fs::read_dir(stale_dst.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".stale-"))
            .collect();
        assert_eq!(stale_archives.len(), 1, "陈旧目标应改名 .stale 归档而非删除");

        // 幂等：内容一致后重跑零操作
        migrate_json_file(&legacy, &stale_dst).unwrap();
        assert_eq!(fs::read_to_string(&stale_dst).unwrap(), content);
    }

    #[test]
    fn full_migration_is_idempotent_via_tombstone() {
        let dir = tmp_dir("tombstone");
        let data_root = dir.join("data-root");
        let legacy = dir.join("legacy");
        fs::create_dir_all(legacy.join("stores")).unwrap();
        fs::create_dir_all(legacy.join("requirements").join("prototypes")).unwrap();
        seed_sqlite_db(&legacy.join("stores").join("requirement.db"));
        fs::write(
            legacy.join("requirements").join("workspaces.json"),
            r#"{"workspaces":[]}"#,
        )
        .unwrap();

        // 第一次：完整迁移
        migrate_legacy_requirement(&legacy, &data_root).unwrap();
        assert!(data_root.join("stores").join("requirement.db").exists());
        assert!(data_root.join("requirements").join("workspaces.json").exists());
        assert!(
            !legacy.join("stores").join("requirement.db").exists(),
            "源应改为 .migrated-<ts> 归档"
        );
        assert_table_integrity(&data_root.join("stores").join("requirement.db"));

        // tombstone 内容必须携带双方根路径（anchor 切换窗口幂等判据）
        let marker = fs::read_to_string(data_root.join(".meta").join(REQUIREMENT_MIGRATION_MARKER)).unwrap();
        assert!(marker.contains(&legacy.to_string_lossy().to_string()), "tombstone 记 from");
        assert!(marker.contains(&data_root.to_string_lossy().to_string()), "tombstone 记 to");

        // 重建源并再次调用 → tombstone 挡住，零二次导入
        seed_sqlite_db(&legacy.join("stores").join("requirement.db"));
        migrate_legacy_requirement(&legacy, &data_root).unwrap();
        assert_eq!(
            fs::read_to_string(data_root.join(".meta").join(REQUIREMENT_MIGRATION_MARKER)).unwrap(),
            marker
        );
    }
}
