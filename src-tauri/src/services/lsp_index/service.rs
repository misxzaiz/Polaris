/*! IndexService — 工作区索引引擎单例
 *
 * 职责：
 * - 按 workspace 持有 IndexDb
 * - 后台构建任务的提交与状态推送
 * - 文件 watcher（S5）→ 增量更新
 * - 查询接口（被 Tauri 命令直接调用）
 */

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use crate::error::{AppError, Result};

use super::builder;
use super::db::IndexDb;
use super::extractor;
use super::model::{DirtyBuffer, FileIndex, IndexMatch, IndexStatus, ImportEntry};
use super::query;
use super::ranker::{rank_definition, RankContext};

/// 单工作区运行时状态
struct WorkspaceState {
    db: Arc<IndexDb>,
    status: RwLock<IndexStatus>,
    /// 文件 watcher（drop 自动停）。Option 是为了允许"开了 DB 但 watcher 启动失败"的降级场景。
    watcher: Mutex<Option<super::watcher::WatcherHandle>>,
}

impl WorkspaceState {
    fn snapshot(&self) -> IndexStatus {
        self.status.read().unwrap().clone()
    }

    fn set_state(&self, state: &str, error: Option<String>) {
        let mut s = self.status.write().unwrap();
        s.state = state.into();
        s.error = error;
    }

    fn set_progress(&self, done: u32, total: u32) {
        let mut s = self.status.write().unwrap();
        s.progress_done = done;
        s.progress_total = total;
    }

    fn set_counts(&self, files: u32, symbols: u32, refs: u32) {
        let mut s = self.status.write().unwrap();
        s.files = files;
        s.symbols = symbols;
        s.refs = refs;
    }
}

/// 全局服务（线程安全；clone 为 cheap Arc）。
#[derive(Clone, Default)]
pub struct IndexService {
    inner: Arc<Mutex<HashMap<PathBuf, Arc<WorkspaceState>>>>,
    /// 状态变更回调（前端事件桥接，由 lib.rs 注入）
    on_status_change: Arc<RwLock<Option<Arc<dyn Fn(&IndexStatus) + Send + Sync>>>>,
}

impl IndexService {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注入状态变更回调（push 到前端）。
    pub fn set_status_listener<F>(&self, f: F)
    where
        F: Fn(&IndexStatus) + Send + Sync + 'static,
    {
        *self.on_status_change.write().unwrap() = Some(Arc::new(f));
    }

    fn emit_status(&self, status: &IndexStatus) {
        if let Some(cb) = self.on_status_change.read().unwrap().as_ref() {
            cb(status);
        }
    }

    /// 打开 workspace（已存在则复用；schema 不匹配会重建）。
    pub fn open_workspace(&self, workspace: &Path) -> Result<Arc<IndexDb>> {
        let key = canonicalize_or_self(workspace);
        let mut map = self.inner.lock().unwrap();
        if let Some(ws) = map.get(&key) {
            return Ok(ws.db.clone());
        }
        let db = Arc::new(IndexDb::open(&key)?);
        let (files, symbols, refs) = db.stats().unwrap_or((0, 0, 0));
        let last_built_at = db.get_last_built_at();
        let initial_status = IndexStatus {
            workspace: Some(key.to_string_lossy().to_string()),
            state: if files == 0 { "idle".into() } else { "ready".into() },
            progress_done: 0,
            progress_total: 0,
            files,
            symbols,
            refs,
            error: None,
            last_built_at,
        };
        let ws = Arc::new(WorkspaceState {
            db: db.clone(),
            status: RwLock::new(initial_status.clone()),
            watcher: Mutex::new(None),
        });
        map.insert(key.clone(), ws.clone());
        drop(map);
        // 尝试启动 watcher（失败仅记日志，不阻塞 open）
        match self.start_watcher(&key) {
            Ok(handle) => {
                *ws.watcher.lock().unwrap() = Some(handle);
            }
            Err(e) => tracing::warn!("watcher 启动失败 ({}): {}", key.display(), e),
        }
        self.emit_status(&initial_status);
        Ok(db)
    }

    /// 关闭 workspace（释放 DB 句柄）。
    pub fn close_workspace(&self, workspace: &Path) {
        let key = canonicalize_or_self(workspace);
        self.inner.lock().unwrap().remove(&key);
    }

    /// 获取 workspace 状态（不存在时返回 idle）。
    pub fn status(&self, workspace: &Path) -> IndexStatus {
        let key = canonicalize_or_self(workspace);
        if let Some(ws) = self.inner.lock().unwrap().get(&key) {
            ws.snapshot()
        } else {
            IndexStatus {
                workspace: Some(key.to_string_lossy().to_string()),
                state: "idle".into(),
                ..Default::default()
            }
        }
    }

    /// 后台启动全量构建。立刻返回；进度通过 status 回调推送。
    pub fn rebuild_full_async(&self, workspace: &Path) -> Result<()> {
        let key = canonicalize_or_self(workspace);
        // 确保已 open
        self.open_workspace(&key)?;
        let svc = self.clone();
        std::thread::Builder::new()
            .name("polaris-index-build".into())
            .spawn(move || {
                if let Err(e) = svc.rebuild_full_blocking(&key) {
                    tracing::error!("rebuild_full failed: {}", e);
                    if let Some(ws) = svc.inner.lock().unwrap().get(&key) {
                        ws.set_state("error", Some(e.to_string()));
                        let snap = ws.snapshot();
                        svc.emit_status(&snap);
                    }
                }
            })
            .map_err(|e| AppError::StateError(format!("启动索引线程失败: {}", e)))?;
        Ok(())
    }

    /// 同步全量构建（阻塞）。一般测试或 CLI 用。
    pub fn rebuild_full_blocking(&self, workspace: &Path) -> Result<()> {
        let key = canonicalize_or_self(workspace);
        let ws = {
            let map = self.inner.lock().unwrap();
            map.get(&key).cloned().ok_or_else(|| {
                AppError::StateError("workspace 未打开，先调用 open_workspace".into())
            })?
        };
        ws.set_state("building", None);
        ws.set_progress(0, 0);
        let snap = ws.snapshot();
        self.emit_status(&snap);

        let svc = self.clone();
        let ws_for_cb = ws.clone();
        let key_for_cb = key.clone();
        let progress: builder::ProgressFn = Arc::new(move |done, total| {
            ws_for_cb.set_progress(done, total);
            // 限频：每 64 文件一次（builder 已限）
            let snap = ws_for_cb.snapshot();
            svc.emit_status(&snap);
            let _ = key_for_cb; // suppress
        });

        let (count, _errs) = builder::build_full(&ws.db, &key, Some(progress))?;
        let (files, symbols, refs) = ws.db.stats().unwrap_or((count, 0, 0));
        ws.set_counts(files, symbols, refs);
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        {
            let mut s = ws.status.write().unwrap();
            s.state = "ready".into();
            s.error = None;
            s.last_built_at = Some(now_ms);
            s.progress_done = files;
            s.progress_total = files;
        }
        self.emit_status(&ws.snapshot());
        Ok(())
    }

    /// 单文件增量更新（被 watcher 调用）。
    pub fn update_file(&self, workspace: &Path, abs_path: &Path) -> Result<()> {
        let key = canonicalize_or_self(workspace);
        let ws = {
            let map = self.inner.lock().unwrap();
            map.get(&key).cloned().ok_or_else(|| {
                AppError::StateError("workspace 未打开".into())
            })?
        };
        builder::build_one(&ws.db, &key, abs_path)?;
        if let Ok((files, symbols, refs)) = ws.db.stats() {
            ws.set_counts(files, symbols, refs);
            self.emit_status(&ws.snapshot());
        }
        Ok(())
    }

    /// 删除单文件索引（watcher remove 事件）。
    pub fn remove_file(&self, workspace: &Path, abs_path: &Path) -> Result<()> {
        let key = canonicalize_or_self(workspace);
        let ws = {
            let map = self.inner.lock().unwrap();
            map.get(&key).cloned().ok_or_else(|| {
                AppError::StateError("workspace 未打开".into())
            })?
        };
        let rel = abs_path
            .strip_prefix(&key)
            .unwrap_or(abs_path)
            .to_string_lossy()
            .replace('\\', "/");
        ws.db.delete_file(&rel)?;
        if let Ok((files, symbols, refs)) = ws.db.stats() {
            ws.set_counts(files, symbols, refs);
            self.emit_status(&ws.snapshot());
        }
        Ok(())
    }

    // ── 查询接口 ─────────────────────────────────────────────

    /// 索引模式：跳转定义。返回排序后的候选。
    /// `dirty_buffers` 是前端传入的未保存修改；同 path 的 DB 数据会被替换。
    pub fn find_definition(
        &self,
        workspace: &Path,
        symbol: &str,
        current_file_abs: Option<&str>,
        dirty: &[DirtyBuffer],
    ) -> Result<Vec<IndexMatch>> {
        let workspace_key = canonicalize_or_self(workspace);
        let workspace_str = workspace_key.to_string_lossy().to_string();

        // 准备 dirty 索引（用于排序时的 import / package 上下文 + 覆盖 DB 候选）
        let dirty_indexes = parse_dirty_buffers(dirty, &workspace_key);

        // 当前文件的 import / package（先看 dirty buffer，否则看 DB）
        let current_rel = current_file_abs
            .map(|abs| to_rel(abs, &workspace_key))
            .unwrap_or_default();
        let live_ctx = dirty_indexes
            .iter()
            .find(|fi| fi.rel_path == current_rel)
            .map(|fi| (fi.package.clone(), fi.imports.clone()));

        let ws = {
            let map = self.inner.lock().unwrap();
            map.get(&workspace_key).cloned()
        };

        // 拿候选：DB + dirty
        let mut candidates: Vec<super::db::SymbolRow> = if let Some(ws) = &ws {
            // 排除被 dirty 覆盖的文件
            let dirty_paths: std::collections::HashSet<String> =
                dirty_indexes.iter().map(|fi| fi.rel_path.clone()).collect();
            ws.db
                .find_symbols_by_name(symbol)?
                .into_iter()
                .filter(|r| !dirty_paths.contains(&r.rel_path))
                .collect()
        } else {
            Vec::new()
        };

        // 加上 dirty 中的同名符号
        for fi in &dirty_indexes {
            for sym in &fi.symbols {
                if sym.name == symbol {
                    candidates.push(super::db::SymbolRow {
                        name: sym.name.clone(),
                        fqn: sym.fqn.clone(),
                        kind: sym.kind,
                        parent_fqn: sym.parent_fqn.clone(),
                        line: sym.line,
                        column: sym.column,
                        name_line: sym.name_line,
                        name_column: sym.name_column,
                        signature: sym.signature.clone(),
                        modifiers: sym.modifiers,
                        rel_path: fi.rel_path.clone(),
                        language: fi.language.clone(),
                        package: fi.package.clone(),
                    });
                }
            }
        }

        // 排序上下文
        let imports_owned: Vec<ImportEntry> = if let Some((_, imp)) = live_ctx.as_ref() {
            imp.clone()
        } else if let Some(ws) = &ws {
            ws.db
                .read_query_context(&current_rel)
                .map(|c| c.imports)
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let pkg_owned: Option<String> = live_ctx
            .as_ref()
            .and_then(|(p, _)| p.clone())
            .or_else(|| {
                ws.as_ref()
                    .and_then(|w| w.db.read_query_context(&current_rel).ok())
                    .and_then(|c| c.package)
            });

        let ctx = RankContext {
            current_rel_path: &current_rel,
            package: pkg_owned.as_deref(),
            imports: &imports_owned,
        };

        let ranked = rank_definition(candidates, &ctx);
        Ok(ranked
            .into_iter()
            .map(|(score, row)| query::symbol_to_match(&row, &workspace_str, Some(score)))
            .collect())
    }

    /// 索引模式：查找引用。
    pub fn find_references(
        &self,
        workspace: &Path,
        symbol: &str,
        max: usize,
        dirty: &[DirtyBuffer],
    ) -> Result<Vec<IndexMatch>> {
        let workspace_key = canonicalize_or_self(workspace);
        let workspace_str = workspace_key.to_string_lossy().to_string();

        let dirty_indexes = parse_dirty_buffers(dirty, &workspace_key);

        let ws = {
            let map = self.inner.lock().unwrap();
            map.get(&workspace_key).cloned()
        };

        let mut out: Vec<IndexMatch> = Vec::new();

        if let Some(ws) = &ws {
            let dirty_paths: std::collections::HashSet<String> =
                dirty_indexes.iter().map(|fi| fi.rel_path.clone()).collect();
            let rows = ws.db.find_refs_by_name(symbol, None, max)?;
            for row in rows {
                if dirty_paths.contains(&row.rel_path) {
                    continue;
                }
                out.push(query::ref_to_match(&row, &workspace_str));
            }
        }

        // 加上 dirty 中的引用
        for fi in &dirty_indexes {
            for r in &fi.refs {
                if r.name == symbol {
                    let abs = to_abs(&fi.rel_path, &workspace_key);
                    out.push(IndexMatch {
                        path: abs,
                        line: r.line,
                        column: r.column,
                        preview: r.line_text.clone(),
                        kind: None,
                        fqn: r.target_fqn.clone(),
                        ref_kind: Some(r.ref_kind.as_str()),
                        score: None,
                    });
                    if out.len() >= max {
                        return Ok(out);
                    }
                }
            }
        }

        // 稳定排序：按路径 / 行 / 列
        out.sort_by(|a, b| {
            a.path
                .cmp(&b.path)
                .then(a.line.cmp(&b.line))
                .then(a.column.cmp(&b.column))
        });
        Ok(out)
    }
}

// ── 辅助 ────────────────────────────────────────────────────

fn canonicalize_or_self(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

fn to_rel(abs: &str, workspace: &Path) -> String {
    let abs_p = Path::new(abs);
    abs_p
        .strip_prefix(workspace)
        .unwrap_or(abs_p)
        .to_string_lossy()
        .replace('\\', "/")
}

fn to_abs(rel: &str, workspace: &Path) -> String {
    let mut s = workspace.to_string_lossy().to_string();
    let sep = if s.contains('\\') { '\\' } else { '/' };
    if !s.ends_with(['/', '\\']) {
        s.push(sep);
    }
    s.push_str(&rel.replace('/', &sep.to_string()));
    s
}

/// 解析 dirty buffers 为 FileIndex，给查询层使用。
fn parse_dirty_buffers(dirty: &[DirtyBuffer], workspace: &Path) -> Vec<FileIndex> {
    let mut out = Vec::with_capacity(dirty.len());
    for buf in dirty {
        let abs = Path::new(&buf.path);
        let rel = to_rel(&buf.path, workspace);
        // 仅 java 走 AST；其它语言 dirty 暂不支持索引覆盖
        if buf.language != "java" {
            continue;
        }
        match extractor::extract(&rel, abs, &buf.language, &buf.content) {
            Ok(Some(mut fi)) => {
                if fi.content_hash == 0 {
                    fi.content_hash = xxhash_rust::xxh3::xxh3_64(buf.content.as_bytes());
                }
                fi.size = buf.content.len() as u64;
                out.push(fi);
            }
            _ => {}
        }
    }
    out
}
