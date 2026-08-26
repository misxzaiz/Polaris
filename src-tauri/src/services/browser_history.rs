//! 内置浏览器访问历史持久化
//!
//! 历史存储为 `<DataRoot>/browser/history.json`，原子写入（先写临时文件再 rename）。
//! 结构:
//! ```json
//! { "version": 1, "items": [ { "id": "...", "title": "...", "url": "...", "visitedAt": 1234567890, "visitCount": 3 } ] }
//! ```
//!
//! 相同 URL 去重：重复访问时更新标题、递增计数、刷新时间并移到最前。
//! 本模块不依赖 Tauri，纯函数 + std::fs，可单测。测试时通过 `set_test_store_root`
//! 将存储路径重定向到临时目录，避免污染真实数据目录。

use std::fs;
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::services::data_root::data_root;

const STORE_FILE_NAME: &str = "history.json";
const STORE_VERSION: u32 = 1;
const MAX_HISTORY: usize = 2000;
const MAX_TITLE_CHARS: usize = 300;
const EXPORT_APP: &str = "polaris";
const EXPORT_KIND: &str = "history";

/// 测试用存储根目录覆盖（仅 #[cfg(test)] 时可写）
static TEST_STORE_ROOT: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHistoryEntry {
    pub id: String,
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub visited_at: u64,
    #[serde(default = "default_visit_count")]
    pub visit_count: u32,
}

fn default_visit_count() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserHistoryStore {
    version: u32,
    items: Vec<BrowserHistoryEntry>,
}

impl Default for BrowserHistoryStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            items: Vec::new(),
        }
    }
}

fn store_path() -> PathBuf {
    if let Some(override_root) = TEST_STORE_ROOT
        .get()
        .and_then(|lock| lock.lock().ok())
        .and_then(|guard| guard.clone())
    {
        return override_root.join(STORE_FILE_NAME);
    }
    data_root().root().join("browser").join(STORE_FILE_NAME)
}

/// 测试辅助：将存储路径重定向到给定根目录（None 恢复为真实 data_root）。
/// 跨模块测试（如 browser_mcp_server）也需使用，故为 pub(crate)。
#[cfg(test)]
pub(crate) fn set_test_store_root(root: Option<&Path>) {
    let cell = TEST_STORE_ROOT.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().unwrap();
    *guard = root.map(Path::to_path_buf);
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

fn sanitize_title(title: &str) -> String {
    let mut out = String::new();
    for ch in title.chars().take(MAX_TITLE_CHARS) {
        out.push(ch);
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        out.push('…');
    }
    out.trim().to_string()
}

/// 读取历史列表（按访问时间倒序，最新在前）
pub fn browser_history_list() -> Result<Vec<BrowserHistoryEntry>> {
    let path = store_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path)?;
    let store: BrowserHistoryStore = serde_json::from_str(&raw)?;
    Ok(store.items)
}

/// 记录一次访问。url 为规范化的 http(s)/file 地址；空 title 回退为 url。
/// 相同 url 则更新标题、递增计数、刷新时间并移动至最前。
pub fn browser_history_record(title: &str, url: &str) -> Result<BrowserHistoryEntry> {
    let clean_url = url.trim().to_string();
    if clean_url.is_empty() {
        return Err(AppError::ValidationError("历史 URL 不能为空".to_string()));
    }
    let clean_title = sanitize_title(title);
    let fallback_title = if clean_title.is_empty() {
        clean_url.clone()
    } else {
        clean_title
    };

    let mut store = load_store();

    if let Some(index) = store.items.iter().position(|h| h.url == clean_url) {
        let mut existing = store.items.remove(index);
        existing.title = fallback_title;
        existing.visited_at = now_ms();
        existing.visit_count = existing.visit_count.saturating_add(1);
        store.items.insert(0, existing.clone());
        save_store(&store)?;
        return Ok(existing);
    }

    let entry = BrowserHistoryEntry {
        id: uuid::Uuid::new_v4().to_string(),
        title: fallback_title,
        url: clean_url,
        visited_at: now_ms(),
        visit_count: 1,
    };
    store.items.insert(0, entry.clone());

    // 超出上限时丢弃最旧的（队尾）
    if store.items.len() > MAX_HISTORY {
        store.items.truncate(MAX_HISTORY);
    }

    save_store(&store)?;
    Ok(entry)
}

/// 按关键字搜索历史（标题或 URL 不区分大小写模糊匹配），按访问时间倒序
pub fn browser_history_search(query: &str, limit: usize) -> Result<Vec<BrowserHistoryEntry>> {
    let clean = query.trim().to_lowercase();
    let limit = limit.clamp(1, 200);
    let items = browser_history_list()?;
    if clean.is_empty() {
        return Ok(items.into_iter().take(limit).collect());
    }
    Ok(items
        .into_iter()
        .filter(|h| {
            h.title.to_lowercase().contains(&clean) || h.url.to_lowercase().contains(&clean)
        })
        .take(limit)
        .collect())
}

/// 删除单条历史
pub fn browser_history_delete(id: &str) -> Result<()> {
    let mut store = load_store();
    let before = store.items.len();
    store.items.retain(|h| h.id != id);
    if store.items.len() == before {
        return Err(AppError::ValidationError("历史记录不存在或已删除".to_string()));
    }
    save_store(&store)
}

/// 清空全部历史
pub fn browser_history_clear() -> Result<()> {
    let mut store = load_store();
    store.items.clear();
    save_store(&store)
}

/// 导出历史为可移植 JSON 字符串（含 app/kind/version 信封）
pub fn browser_history_export() -> Result<String> {
    #[derive(Serialize)]
    struct Envelope<'a> {
        app: &'static str,
        kind: &'static str,
        version: u32,
        exported_at: u64,
        items: &'a [BrowserHistoryEntry],
    }
    let envelope = Envelope {
        app: EXPORT_APP,
        kind: EXPORT_KIND,
        version: STORE_VERSION,
        exported_at: now_ms(),
        items: &load_store().items,
    };
    serde_json::to_string_pretty(&envelope)
        .map_err(|e| AppError::IoError(std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())))
}

/// 从导出的 JSON 导入历史。按 URL 去重合并（同 URL 累加 visit_count、取较新时间），
/// 返回实际新增/更新的条数；超过上限时返回错误。
pub fn browser_history_import(raw: &str) -> Result<usize> {
    #[derive(Deserialize)]
    struct Envelope {
        #[serde(default)]
        app: Option<String>,
        #[serde(default)]
        kind: Option<String>,
        #[serde(default)]
        version: Option<u32>,
        items: Vec<BrowserHistoryEntry>,
    }
    let envelope: Envelope = serde_json::from_str(raw).map_err(|e| {
        AppError::ValidationError(format!("历史导入文件格式无效: {e}"))
    })?;
    if let Some(kind) = &envelope.kind {
        if kind != EXPORT_KIND {
            return Err(AppError::ValidationError(format!(
                "文件类型不匹配: 期望 {EXPORT_KIND}，实际 {kind}"
            )));
        }
    }
    if envelope.items.len() > MAX_HISTORY {
        return Err(AppError::ValidationError(format!(
            "导入历史数量超过上限 {MAX_HISTORY}"
        )));
    }

    let mut store = load_store();
    let mut count = 0usize;
    for item in envelope.items {
        let url = item.url.trim().to_string();
        if url.is_empty() {
            continue;
        }
        let title = if item.title.trim().is_empty() {
            url.clone()
        } else {
            sanitize_title(&item.title)
        };
        if let Some(existing) = store.items.iter_mut().find(|h| h.url == url) {
            existing.title = title;
            existing.visit_count = existing.visit_count.saturating_add(item.visit_count.max(1));
            if item.visited_at > existing.visited_at {
                existing.visited_at = item.visited_at;
            }
        } else {
            store.items.push(BrowserHistoryEntry {
                id: uuid::Uuid::new_v4().to_string(),
                title,
                url,
                visited_at: if item.visited_at == 0 { now_ms() } else { item.visited_at },
                visit_count: item.visit_count.max(1),
            });
        }
        count += 1;
    }
    save_store(&store)?;
    Ok(count)
}

fn load_store() -> BrowserHistoryStore {
    let path = store_path();
    if !path.exists() {
        return BrowserHistoryStore::default();
    }
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => BrowserHistoryStore::default(),
    }
}

/// 原子写入：先写 `<file>.tmp` 再 rename，避免崩溃导致 JSON 截断
fn save_store(store: &BrowserHistoryStore) -> Result<()> {
    let path = store_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let raw = serde_json::to_string_pretty(store)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw)?;
    match fs::rename(&tmp, &path) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Windows 上 rename 目标已存在可能失败，回退为直接覆盖
            let _ = fs::remove_file(&path);
            fs::rename(&tmp, &path).map_err(|to| {
                AppError::IoError(std::io::Error::new(
                    to.kind(),
                    format!("历史写入失败: {to}"),
                ))
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let stamp = now_ms();
        let dir = std::env::temp_dir().join(format!("polaris-hist-{name}-{stamp}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn record_list_round_trip() {
        let root = temp_root("record");
        set_test_store_root(Some(&root));

        let entry = browser_history_record("Example", "https://example.com/").unwrap();
        assert_eq!(entry.title, "Example");
        assert_eq!(entry.url, "https://example.com/");
        assert_eq!(entry.visit_count, 1);

        let list = browser_history_list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, entry.id);

        set_test_store_root(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn duplicate_url_increments_count_and_moves_front() {
        let root = temp_root("dupe");
        set_test_store_root(Some(&root));

        browser_history_record("A", "https://dup.example/").unwrap();
        browser_history_record("B", "https://other.example/").unwrap();
        let updated = browser_history_record("A2", "https://dup.example/").unwrap();

        assert_eq!(updated.visit_count, 2);
        assert_eq!(updated.title, "A2");
        let list = browser_history_list().unwrap();
        assert_eq!(list[0].url, "https://dup.example/");
        assert_eq!(list[0].visit_count, 2);

        set_test_store_root(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_url_rejected() {
        let root = temp_root("empty");
        set_test_store_root(Some(&root));

        let err = browser_history_record("T", "  ").expect_err("empty url must fail");
        assert!(err.to_message().contains("URL"));

        set_test_store_root(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_filters_by_title_and_url_case_insensitive() {
        let root = temp_root("search");
        set_test_store_root(Some(&root));

        browser_history_record("Rust Docs", "https://doc.rust-lang.org/").unwrap();
        browser_history_record("Example", "https://example.com/").unwrap();

        let by_title = browser_history_search("rust", 10).unwrap();
        assert_eq!(by_title.len(), 1);
        assert_eq!(by_title[0].url, "https://doc.rust-lang.org/");

        let by_url = browser_history_search("EXAMPLE.COM", 10).unwrap();
        assert_eq!(by_url.len(), 1);
        assert_eq!(by_url[0].url, "https://example.com/");

        let all = browser_history_search("", 10).unwrap();
        assert_eq!(all.len(), 2);

        let none = browser_history_search("zzz", 10).unwrap();
        assert!(none.is_empty());

        set_test_store_root(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_and_clear() {
        let root = temp_root("del");
        set_test_store_root(Some(&root));

        let entry = browser_history_record("T", "https://del.example/").unwrap();
        let _ = browser_history_record("U", "https://del2.example/").unwrap();

        browser_history_delete(&entry.id).unwrap();
        assert_eq!(browser_history_list().unwrap().len(), 1);

        let err = browser_history_delete(&entry.id).expect_err("double delete must fail");
        assert!(err.to_message().contains("不存在"));

        browser_history_clear().unwrap();
        assert!(browser_history_list().unwrap().is_empty());

        set_test_store_root(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sanitize_title_trims_and_truncates() {
        assert_eq!(sanitize_title("  hello  "), "hello");
        let long = "x".repeat(1000);
        assert!(sanitize_title(&long).chars().count() <= MAX_TITLE_CHARS + 1);
        assert!(sanitize_title(&long).ends_with('…'));
    }

    #[test]
    fn history_caps_at_max() {
        let root = temp_root("cap");
        set_test_store_root(Some(&root));

        for i in 0..(MAX_HISTORY + 50) {
            browser_history_record(&format!("T{i}"), &format!("https://t{i}.example/")).unwrap();
        }
        let list = browser_history_list().unwrap();
        assert_eq!(list.len(), MAX_HISTORY);

        set_test_store_root(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn export_import_round_trip() {
        let root = temp_root("expimp");
        set_test_store_root(Some(&root));

        browser_history_record("Example", "https://example.com/").unwrap();
        browser_history_record("Rust", "https://rust-lang.org/").unwrap();

        let exported = browser_history_export().unwrap();
        assert!(exported.contains("\"app\": \"polaris\""));
        assert!(exported.contains("\"kind\": \"history\""));

        set_test_store_root(None);
        std::fs::remove_dir_all(&root).unwrap();
        let root2 = temp_root("expimp2");
        set_test_store_root(Some(&root2));

        let count = browser_history_import(&exported).unwrap();
        assert_eq!(count, 2);
        let list = browser_history_list().unwrap();
        assert_eq!(list.len(), 2);

        set_test_store_root(None);
        let _ = std::fs::remove_dir_all(&root2);
    }

    #[test]
    fn import_merges_history_by_url() {
        let root = temp_root("merge");
        set_test_store_root(Some(&root));

        browser_history_record("Old", "https://example.com/").unwrap();

        let raw = r#"{
          "app": "polaris",
          "kind": "history",
          "version": 1,
          "items": [
            {"title": "Updated", "url": "https://example.com/", "visitCount": 5, "visitedAt": 9999},
            {"title": "Fresh", "url": "https://fresh.example/", "visitCount": 3, "visitedAt": 8888}
          ]
        }"#;
        let count = browser_history_import(raw).unwrap();
        assert_eq!(count, 2);
        let list = browser_history_list().unwrap();
        assert_eq!(list.len(), 2);
        let example = list.iter().find(|h| h.url == "https://example.com/").unwrap();
        assert_eq!(example.title, "Updated");
        // original 1 visit + imported 5 = 6
        assert_eq!(example.visit_count, 6);
        assert_eq!(example.visited_at, 9999);

        set_test_store_root(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn history_import_rejects_wrong_kind() {
        let root = temp_root("reject");
        set_test_store_root(Some(&root));

        let wrong = r#"{"app":"polaris","kind":"bookmarks","version":1,"items":[]}"#;
        let err = browser_history_import(wrong).expect_err("wrong kind must fail");
        assert!(err.to_message().contains("类型不匹配"));

        let invalid = "bad json";
        let err = browser_history_import(invalid).expect_err("invalid json must fail");
        assert!(err.to_message().contains("格式无效"));

        set_test_store_root(None);
        let _ = std::fs::remove_dir_all(&root);
    }
}
