/*! 文件 watcher：保存/修改/删除/重命名 → 增量更新索引
 *
 * 用 notify-debouncer-mini，200ms debounce。
 * 仅监听 .java 文件变更（其它语言后续加）；忽略 .polaris/、.git/ 等。
 */

use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::sync::Arc;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebouncedEvent};

use crate::error::{AppError, Result};

use super::extractor;
use super::service::IndexService;

/// watcher 句柄。drop 时停止监听。
pub struct WatcherHandle {
    /// 保活 debouncer（drop 即停止）。
    _debouncer: notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>,
    /// workspace（用于日志）
    pub workspace: PathBuf,
}

impl IndexService {
    /// 启动 workspace 的文件 watcher。
    /// 调用方负责持有返回的 WatcherHandle；drop 即停止。
    pub fn start_watcher(&self, workspace: &Path) -> Result<WatcherHandle> {
        let workspace_buf = std::fs::canonicalize(workspace)
            .unwrap_or_else(|_| workspace.to_path_buf());

        let svc = self.clone();
        let workspace_clone = workspace_buf.clone();

        let (tx, rx) = channel::<notify::Result<Vec<DebouncedEvent>>>();
        let mut debouncer = new_debouncer(Duration::from_millis(200), tx)
            .map_err(|e| AppError::StateError(format!("watcher 创建失败: {}", e)))?;
        debouncer
            .watcher()
            .watch(&workspace_buf, RecursiveMode::Recursive)
            .map_err(|e| AppError::StateError(format!("watcher 启动失败: {}", e)))?;

        // 后台线程消费事件
        std::thread::Builder::new()
            .name("polaris-index-watcher".into())
            .spawn(move || {
                while let Ok(result) = rx.recv() {
                    let events = match result {
                        Ok(e) => e,
                        Err(err) => {
                            tracing::warn!("watcher 事件错误: {:?}", err);
                            continue;
                        }
                    };
                    for ev in events {
                        if !is_indexable_path(&ev.path) {
                            continue;
                        }
                        // notify-debouncer-mini 的 Kind 只有 Any/AnyContinuous，
                        // 我们用文件存在与否决定 update / remove
                        if ev.path.exists() {
                            if let Err(e) = svc.update_file(&workspace_clone, &ev.path) {
                                tracing::warn!(
                                    "watcher update_file failed for {}: {}",
                                    ev.path.display(),
                                    e
                                );
                            }
                        } else {
                            if let Err(e) = svc.remove_file(&workspace_clone, &ev.path) {
                                tracing::warn!(
                                    "watcher remove_file failed for {}: {}",
                                    ev.path.display(),
                                    e
                                );
                            }
                        }
                    }
                }
            })
            .map_err(|e| AppError::StateError(format!("watcher 线程启动失败: {}", e)))?;

        Ok(WatcherHandle {
            _debouncer: debouncer,
            workspace: workspace_buf,
        })
    }
}

fn is_indexable_path(p: &Path) -> bool {
    // 忽略明显应排除的目录
    let s = p.to_string_lossy();
    if s.contains("\\.polaris\\")
        || s.contains("/.polaris/")
        || s.contains("\\.git\\")
        || s.contains("/.git/")
        || s.contains("\\target\\")
        || s.contains("/target/")
        || s.contains("\\node_modules\\")
        || s.contains("/node_modules/")
        || s.contains("\\.gradle\\")
        || s.contains("/.gradle/")
        || s.contains("\\build\\")
        || s.contains("/build/")
    {
        return false;
    }
    let Some(ext) = p.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    extractor::language_for_ext(ext).is_some()
}

/// 简易包装（解决 IndexService 持有 watcher 让 close_workspace 自动停 watcher 的需要）。
/// 当前由调用方持有句柄即可，未来如果要在 IndexService 内部管理可改为 RwLock<HashMap<...>>.
#[allow(dead_code)]
pub struct ManagedWatcher(pub Arc<WatcherHandle>);
