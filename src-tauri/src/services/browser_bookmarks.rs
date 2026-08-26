//! 内置浏览器书签持久化
//!
//! 书签存储为 `<DataRoot>/browser/bookmarks.json`，原子写入（先写临时文件再 rename）。
//! 结构:
//! ```json
//! { "version": 1, "items": [ { "id": "...", "title": "...", "url": "...", "createdAt": 1234567890 } ] }
//! ```
//!
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

const STORE_FILE_NAME: &str = "bookmarks.json";
const STORE_VERSION: u32 = 1;
const MAX_BOOKMARKS: usize = 500;
const MAX_TITLE_CHARS: usize = 300;
const EXPORT_APP: &str = "polaris";
const EXPORT_KIND: &str = "bookmarks";

/// 测试用存储根目录覆盖（仅 #[cfg(test)] 时可写）
static TEST_STORE_ROOT: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBookmark {
    pub id: String,
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserBookmarkStore {
    version: u32,
    items: Vec<BrowserBookmark>,
}

impl Default for BrowserBookmarkStore {
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

/// 读取书签列表（按创建时间倒序，最新在前）
pub fn browser_bookmarks_list() -> Result<Vec<BrowserBookmark>> {
    let path = store_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path)?;
    let store: BrowserBookmarkStore = serde_json::from_str(&raw)?;
    Ok(store.items)
}

/// 添加书签。url 已规范化的 http(s)/file 地址；重复 url 则更新标题并移动至最前
pub fn browser_bookmark_add(title: &str, url: &str) -> Result<BrowserBookmark> {
    let clean_title = sanitize_title(title);
    let clean_url = url.trim().to_string();
    if clean_url.is_empty() {
        return Err(AppError::ValidationError("书签 URL 不能为空".to_string()));
    }
    let fallback_title = if clean_title.is_empty() {
        clean_url.clone()
    } else {
        clean_title
    };

    let mut store = load_store();
    if store.items.len() >= MAX_BOOKMARKS && !store.items.iter().any(|b| b.url == clean_url) {
        return Err(AppError::ValidationError(format!(
            "书签数量已达上限 {MAX_BOOKMARKS}"
        )));
    }

    if let Some(index) = store.items.iter().position(|b| b.url == clean_url) {
        let mut existing = store.items.remove(index);
        existing.title = fallback_title;
        existing.created_at = now_ms();
        store.items.push(existing.clone());
        save_store(&store)?;
        return Ok(existing);
    }

    let bookmark = BrowserBookmark {
        id: uuid::Uuid::new_v4().to_string(),
        title: fallback_title,
        url: clean_url,
        created_at: now_ms(),
    };
    store.items.push(bookmark.clone());
    save_store(&store)?;
    Ok(bookmark)
}

/// 删除书签
pub fn browser_bookmark_delete(id: &str) -> Result<()> {
    let mut store = load_store();
    let before = store.items.len();
    store.items.retain(|b| b.id != id);
    if store.items.len() == before {
        return Err(AppError::ValidationError("书签不存在或已删除".to_string()));
    }
    save_store(&store)
}

/// 更新书签标题
pub fn browser_bookmark_set_title(id: &str, title: &str) -> Result<BrowserBookmark> {
    let mut store = load_store();
    let clean_title = sanitize_title(title);
    let Some(bookmark) = store.items.iter_mut().find(|b| b.id == id) else {
        return Err(AppError::ValidationError("书签不存在或已删除".to_string()));
    };
    bookmark.title = if clean_title.is_empty() {
        bookmark.url.clone()
    } else {
        clean_title
    };
    let result = bookmark.clone();
    save_store(&store)?;
    Ok(result)
}

/// 查询某个 URL 是否已收藏，返回书签（若有）
pub fn browser_bookmark_find(url: &str) -> Result<Option<BrowserBookmark>> {
    let clean = url.trim();
    Ok(load_store().items.into_iter().find(|b| b.url == clean))
}

/// 导出书签为可移植 JSON 字符串（含 app/kind/version 信封，供导入校验与跨版本兼容）
pub fn browser_bookmarks_export() -> Result<String> {
    #[derive(Serialize)]
    struct Envelope<'a> {
        app: &'static str,
        kind: &'static str,
        version: u32,
        exported_at: u64,
        items: &'a [BrowserBookmark],
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

/// 从导出的 JSON 导入书签。按 URL 去重合并（同 URL 更新标题并保留原有 created_at），
/// 返回实际新增/更新的条数；超过上限时返回错误。
/// 兼容两种输入：带 app/kind 信封的导出格式，或裸书签数组。
pub fn browser_bookmarks_import(raw: &str) -> Result<usize> {
    #[derive(Deserialize)]
    struct Envelope {
        #[serde(default)]
        app: Option<String>,
        #[serde(default)]
        kind: Option<String>,
        #[serde(default)]
        version: Option<u32>,
        items: Vec<BrowserBookmark>,
    }
    let parsed: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
        AppError::ValidationError(format!("书签导入文件格式无效: {e}"))
    })?;
    let items: Vec<BrowserBookmark> = if let Some(arr) = parsed.as_array() {
        serde_json::from_value(serde_json::Value::Array(arr.clone()))
            .map_err(|e| AppError::ValidationError(format!("书签导入文件格式无效: {e}")))?
    } else {
        let envelope: Envelope = serde_json::from_value(parsed).map_err(|e| {
            AppError::ValidationError(format!("书签导入文件格式无效: {e}"))
        })?;
        // 兼容裸数组（无信封），且校验 kind 匹配
        if let Some(kind) = &envelope.kind {
            if kind != EXPORT_KIND {
                return Err(AppError::ValidationError(format!(
                    "文件类型不匹配: 期望 {EXPORT_KIND}，实际 {kind}"
                )));
            }
        }
        envelope.items
    };
    if items.len() > MAX_BOOKMARKS {
        return Err(AppError::ValidationError(format!(
            "导入书签数量 {EXPORT_KIND} 超过上限 {MAX_BOOKMARKS}"
        )));
    }

    let mut store = load_store();
    let mut count = 0usize;
    for item in items {
        let url = item.url.trim().to_string();
        if url.is_empty() {
            continue;
        }
        let title = if item.title.trim().is_empty() {
            url.clone()
        } else {
            sanitize_title(&item.title)
        };
        if let Some(existing) = store.items.iter_mut().find(|b| b.url == url) {
            existing.title = title;
        } else {
            store.items.push(BrowserBookmark {
                id: uuid::Uuid::new_v4().to_string(),
                title,
                url,
                created_at: if item.created_at == 0 { now_ms() } else { item.created_at },
            });
        }
        count += 1;
    }
    save_store(&store)?;
    Ok(count)
}

fn load_store() -> BrowserBookmarkStore {
    let path = store_path();
    if !path.exists() {
        return BrowserBookmarkStore::default();
    }
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => BrowserBookmarkStore::default(),
    }
}

/// 原子写入：先写 `<file>.tmp` 再 rename，避免崩溃导致 JSON 截断
fn save_store(store: &BrowserBookmarkStore) -> Result<()> {
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
                    format!("书签写入失败: {to}"),
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
        let dir = std::env::temp_dir().join(format!("polaris-bm-{name}-{stamp}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn add_list_find_round_trip() {
        let root = temp_root("add-list");
        set_test_store_root(Some(&root));

        let bookmark = browser_bookmark_add("Example", "https://example.com/").unwrap();
        assert_eq!(bookmark.title, "Example");
        assert_eq!(bookmark.url, "https://example.com/");

        let list = browser_bookmarks_list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, bookmark.id);

        let found = browser_bookmark_find("https://example.com/").unwrap();
        assert_eq!(found.map(|b| b.id), Some(bookmark.id));

        let missing = browser_bookmark_find("https://nope.example/").unwrap();
        assert!(missing.is_none());

        set_test_store_root(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_url_rejected() {
        let root = temp_root("empty-url");
        set_test_store_root(Some(&root));

        let err = browser_bookmark_add("T", "  ").expect_err("empty url must fail");
        assert!(err.to_message().contains("URL"));

        set_test_store_root(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn add_sorts_newest_first() {
        let root = temp_root("sort");
        set_test_store_root(Some(&root));

        // 直接操纵存储文件以保证 created_at 严格递增可控
        let store = BrowserBookmarkStore {
            version: 1,
            items: vec![
                BrowserBookmark {
                    id: "older".into(),
                    title: "Older".into(),
                    url: "https://old.example/".into(),
                    created_at: 100,
                },
                BrowserBookmark {
                    id: "newer".into(),
                    title: "Newer".into(),
                    url: "https://new.example/".into(),
                    created_at: 200,
                },
            ],
        };
        save_store(&store).unwrap();

        let list = browser_bookmarks_list().unwrap();
        assert_eq!(list.len(), 2);
        assert!(list[0].created_at >= list[1].created_at);

        set_test_store_root(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn duplicate_url_updates_title_and_moves_to_front() {
        let root = temp_root("dupe");
        set_test_store_root(Some(&root));

        browser_bookmark_add("First", "https://dup.example/").unwrap();
        browser_bookmark_add("Second", "https://other.example/").unwrap();
        let updated = browser_bookmark_add("Renamed", "https://dup.example/").unwrap();

        assert_eq!(updated.title, "Renamed");
        let list = browser_bookmarks_list().unwrap();
        assert_eq!(list[0].url, "https://dup.example/");
        assert_eq!(list[0].title, "Renamed");

        set_test_store_root(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_and_set_title() {
        let root = temp_root("delete");
        set_test_store_root(Some(&root));

        let bookmark = browser_bookmark_add("Title", "https://del.example/").unwrap();

        let renamed = browser_bookmark_set_title(&bookmark.id, "New Title").unwrap();
        assert_eq!(renamed.title, "New Title");

        browser_bookmark_delete(&bookmark.id).unwrap();
        assert!(browser_bookmarks_list().unwrap().is_empty());

        let err = browser_bookmark_delete(&bookmark.id).expect_err("double delete must fail");
        assert!(err.to_message().contains("不存在"));

        set_test_store_root(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_set_title_returns_error() {
        let root = temp_root("missing-title");
        set_test_store_root(Some(&root));

        let err = browser_bookmark_set_title("missing", "hello").expect_err("must fail");
        assert!(err.to_message().contains("不存在"));

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
    fn limit_imposed_on_large_sets() {
        let store = BrowserBookmarkStore {
            version: 1,
            items: (0..MAX_BOOKMARKS)
                .map(|i| BrowserBookmark {
                    id: format!("id-{i}"),
                    title: format!("T{i}"),
                    url: format!("https://t{i}.example/"),
                    created_at: i as u64,
                })
                .collect(),
        };
        let raw = serde_json::to_string(&store).unwrap();
        let parsed: BrowserBookmarkStore = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.items.len(), MAX_BOOKMARKS);
    }

    #[test]
    fn export_import_round_trip() {
        let root = temp_root("expimp");
        set_test_store_root(Some(&root));

        browser_bookmark_add("Example", "https://example.com/").unwrap();
        browser_bookmark_add("Rust", "https://rust-lang.org/").unwrap();

        let exported = browser_bookmarks_export().unwrap();
        assert!(exported.contains("\"app\": \"polaris\""));
        assert!(exported.contains("\"kind\": \"bookmarks\""));

        // 清空后重新导入
        set_test_store_root(None);
        std::fs::remove_dir_all(&root).unwrap();
        let root2 = temp_root("expimp2");
        set_test_store_root(Some(&root2));

        let count = browser_bookmarks_import(&exported).unwrap();
        assert_eq!(count, 2);
        let list = browser_bookmarks_list().unwrap();
        assert_eq!(list.len(), 2);

        set_test_store_root(None);
        let _ = std::fs::remove_dir_all(&root2);
    }

    #[test]
    fn import_merges_by_url() {
        let root = temp_root("merge");
        set_test_store_root(Some(&root));

        browser_bookmark_add("Old", "https://example.com/").unwrap();
        browser_bookmark_add("Keep", "https://keep.example/").unwrap();

        // 导入含重复 URL 与新增 URL
        let raw = r#"{
          "app": "polaris",
          "kind": "bookmarks",
          "version": 1,
          "items": [
            {"title": "New Title", "url": "https://example.com/", "createdAt": 999},
            {"title": "Fresh", "url": "https://fresh.example/", "createdAt": 100}
          ]
        }"#;
        let count = browser_bookmarks_import(raw).unwrap();
        assert_eq!(count, 2); // 1 更新 + 1 新增

        let list = browser_bookmarks_list().unwrap();
        assert_eq!(list.len(), 3);
        let example = list.iter().find(|b| b.url == "https://example.com/").unwrap();
        assert_eq!(example.title, "New Title");
        assert!(list.iter().any(|b| b.url == "https://fresh.example/"));

        set_test_store_root(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn import_rejects_wrong_kind_and_invalid() {
        let root = temp_root("reject");
        set_test_store_root(Some(&root));

        let wrong = r#"{"app":"polaris","kind":"history","version":1,"items":[]}"#;
        let err = browser_bookmarks_import(wrong).expect_err("wrong kind must fail");
        assert!(err.to_message().contains("类型不匹配"));

        let invalid = "not json at all";
        let err = browser_bookmarks_import(invalid).expect_err("invalid json must fail");
        assert!(err.to_message().contains("格式无效"));

        set_test_store_root(None);
        let _ = std::fs::remove_dir_all(&root);
    }
}